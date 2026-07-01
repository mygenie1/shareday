import { NextResponse } from "next/server";
import { requireSql } from "@/lib/db";
import {
  genToken,
  resolveExpiry,
  sanitizeCategories,
  sanitizeEvents,
  shareUrl,
} from "@/lib/share";
import { clientIp, rateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";

/**
 * POST /api/share
 * body: { events, categories?, allowComments?, expiresDays? | expiresAt? }
 * Creates a public snapshot under a fresh random token.
 */
export async function POST(req: Request) {
  if (!rateLimit(`share:${clientIp(req)}`, 20, 60_000)) {
    return NextResponse.json({ error: "too many requests" }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  // Server re-filters: private events can never enter the snapshot.
  const events = sanitizeEvents(body.events);
  const categories = sanitizeCategories(body.categories);
  const allowComments = body.allowComments !== false;
  const expiresAt = resolveExpiry(body);
  const token = genToken();

  try {
    const sql = requireSql();
    await sql`
      insert into share_links (token, events, categories, allow_comments, expires_at)
      values (${token}, ${JSON.stringify(events)}, ${JSON.stringify(
        categories
      )}, ${allowComments}, ${expiresAt ? expiresAt.toISOString() : null})
    `;
  } catch (err) {
    console.error("[POST /api/share]", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }

  return NextResponse.json(
    { token, url: shareUrl(req, token), count: events.length },
    { status: 201 }
  );
}
