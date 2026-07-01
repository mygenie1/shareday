import { NextResponse } from "next/server";
import { requireSql } from "@/lib/db";
import {
  isLive,
  resolveExpiry,
  sanitizeCategories,
  sanitizeEvents,
  shareUrl,
  type ShareRow,
} from "@/lib/share";
import { clientIp, rateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ token: string }> };

/** GET /api/share/[token] — public snapshot, only if live. */
export async function GET(_req: Request, { params }: Ctx) {
  const { token } = await params;
  try {
    const sql = requireSql();
    const rows = (await sql`
      select token, events, categories, allow_comments, expires_at, revoked
      from share_links where token = ${token}
    `) as ShareRow[];
    const row = rows[0];
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (!isLive(row))
      return NextResponse.json({ error: "gone" }, { status: 410 });
    return NextResponse.json({
      token: row.token,
      events: row.events,
      categories: row.categories,
      allowComments: row.allow_comments,
      expiresAt: row.expires_at,
    });
  } catch (err) {
    console.error("[GET /api/share/:token]", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}

/**
 * PUT /api/share/[token] — update the snapshot for an EXISTING token.
 * This is what keeps the product promise truthful: one link, live-updated —
 * flipping an event to private removes it from the already-shared link.
 */
export async function PUT(req: Request, { params }: Ctx) {
  const { token } = await params;
  if (!rateLimit(`share:${clientIp(req)}`, 40, 60_000)) {
    return NextResponse.json({ error: "too many requests" }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const events = sanitizeEvents(body.events);
  const categories = sanitizeCategories(body.categories);
  const allowComments = body.allowComments !== false;
  const expiresAt = resolveExpiry(body);

  try {
    const sql = requireSql();
    const rows = (await sql`
      update share_links
         set events = ${JSON.stringify(events)},
             categories = ${JSON.stringify(categories)},
             allow_comments = ${allowComments},
             expires_at = ${expiresAt ? expiresAt.toISOString() : null},
             updated_at = now()
       where token = ${token} and revoked = false
       returning token
    `) as { token: string }[];
    if (!rows[0])
      return NextResponse.json({ error: "not found" }, { status: 404 });
  } catch (err) {
    console.error("[PUT /api/share/:token]", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }

  return NextResponse.json({
    token,
    url: shareUrl(req, token),
    count: events.length,
  });
}

/** DELETE /api/share/[token] — revoke immediately (link stops opening). */
export async function DELETE(_req: Request, { params }: Ctx) {
  const { token } = await params;
  try {
    const sql = requireSql();
    await sql`update share_links set revoked = true, updated_at = now() where token = ${token}`;
  } catch (err) {
    console.error("[DELETE /api/share/:token]", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
