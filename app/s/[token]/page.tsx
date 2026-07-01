import { requireSql } from "@/lib/db";
import { isLive, type ShareRow } from "@/lib/share";
import Recipient, {
  type RecipientCategory,
  type RecipientComment,
  type RecipientEvent,
} from "./Recipient";
import "./recipient.css";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ token: string }> };

function GoneCard({ title, msg }: { title: string; msg: string }) {
  return (
    <main className="rc-wrap">
      <div className="rc-brand">
        <span className="rc-mark" />
        <span className="rc-word">셰어데이</span>
      </div>
      <div className="rc-empty-card">
        <h1>{title}</h1>
        <p>{msg}</p>
      </div>
    </main>
  );
}

export default async function SharePage({ params }: Props) {
  const { token } = await params;

  let sql;
  try {
    sql = requireSql();
  } catch {
    return (
      <GoneCard
        title="아직 준비 중이에요"
        msg="서버 데이터베이스가 연결되지 않았습니다."
      />
    );
  }

  let row: ShareRow | undefined;
  let comments: RecipientComment[] = [];
  try {
    const rows = (await sql`
      select token, events, categories, allow_comments, expires_at, revoked
      from share_links where token = ${token}
    `) as ShareRow[];
    row = rows[0];
    if (row && isLive(row)) {
      comments = (await sql`
        select id, event_id, author_name, body,
               to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') as created_at
        from comments where token = ${token}
        order by created_at asc
      `) as RecipientComment[];
    }
  } catch (err) {
    console.error("[share page]", err);
    return (
      <GoneCard title="문제가 생겼어요" msg="잠시 후 다시 시도해 주세요." />
    );
  }

  if (!row) {
    return (
      <GoneCard
        title="링크를 찾을 수 없어요"
        msg="주소가 정확한지 확인해 주세요."
      />
    );
  }
  if (!isLive(row)) {
    return (
      <GoneCard
        title="만료되었거나 폐기된 링크예요"
        msg="공유한 사람에게 새 링크를 요청해 주세요."
      />
    );
  }

  const events = (Array.isArray(row.events) ? row.events : []) as RecipientEvent[];
  const categories = (Array.isArray(row.categories)
    ? row.categories
    : []) as RecipientCategory[];

  return (
    <Recipient
      token={token}
      events={events}
      categories={categories}
      allowComments={row.allow_comments}
      initialComments={comments}
    />
  );
}
