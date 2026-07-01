import { NextResponse } from "next/server";
import { requireSql } from "@/lib/db";
import { isLive, type ShareRow } from "@/lib/share";
import { clientIp, rateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ token: string }> };

/** GET /api/share/[token]/comments?eventId=... */
export async function GET(req: Request, { params }: Ctx) {
  const { token } = await params;
  const eventId = new URL(req.url).searchParams.get("eventId");

  try {
    const sql = requireSql();
    const links = (await sql`
      select revoked, expires_at from share_links where token = ${token}
    `) as Pick<ShareRow, "revoked" | "expires_at">[];
    if (!links[0])
      return NextResponse.json({ error: "not found" }, { status: 404 });
    if (!isLive(links[0]))
      return NextResponse.json({ error: "gone" }, { status: 410 });

    const rows = eventId
      ? await sql`
          select id, event_id, author_name, body, created_at
          from comments where token = ${token} and event_id = ${eventId}
          order by created_at asc`
      : await sql`
          select id, event_id, author_name, body, created_at
          from comments where token = ${token}
          order by created_at asc`;

    return NextResponse.json({ comments: rows });
  } catch (err) {
    console.error("[GET comments]", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}

/** POST /api/share/[token]/comments  body: { eventId, authorName, body } */
export async function POST(req: Request, { params }: Ctx) {
  const { token } = await params;

  // Spam guard: per-IP+token, 5 / minute (STEP 5).
  if (!rateLimit(`cmt:${token}:${clientIp(req)}`, 5, 60_000)) {
    return NextResponse.json(
      { error: "잠시 후 다시 시도해 주세요." },
      { status: 429 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const eventId = String(body.eventId || "").slice(0, 64);
  const authorName = String(body.authorName || "").trim().slice(0, 40);
  const text = String(body.body || "").trim().slice(0, 2000);
  if (!eventId || !authorName || !text) {
    return NextResponse.json(
      { error: "이름과 내용을 입력해 주세요." },
      { status: 400 }
    );
  }

  try {
    const sql = requireSql();
    const links = (await sql`
      select revoked, expires_at, allow_comments
      from share_links where token = ${token}
    `) as (Pick<ShareRow, "revoked" | "expires_at"> & {
      allow_comments: boolean;
    })[];
    const link = links[0];
    if (!link)
      return NextResponse.json({ error: "not found" }, { status: 404 });
    if (!isLive(link))
      return NextResponse.json({ error: "gone" }, { status: 410 });
    if (!link.allow_comments)
      return NextResponse.json(
        { error: "이 링크는 코멘트를 받지 않아요." },
        { status: 403 }
      );

    const rows = await sql`
      insert into comments (token, event_id, author_name, body)
      values (${token}, ${eventId}, ${authorName}, ${text})
      returning id, event_id, author_name, body, created_at
    `;
    return NextResponse.json({ comment: rows[0] }, { status: 201 });
  } catch (err) {
    console.error("[POST comments]", err);
    return NextResponse.json({ error: "server error" }, { status: 500 });
  }
}
