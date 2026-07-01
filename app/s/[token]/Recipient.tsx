"use client";

import { useEffect, useMemo, useState } from "react";

export type RecipientEvent = {
  id: string;
  date: string;
  time?: string;
  end?: string;
  title: string;
  catId?: string;
  memo?: string;
};
export type RecipientCategory = {
  id: string;
  name?: string;
  emoji?: string;
  color?: string;
};
export type RecipientComment = {
  id: number | string;
  event_id: string;
  author_name: string;
  body: string;
  created_at: string;
};

const DOW = ["일", "월", "화", "수", "목", "금", "토"];

function fmtDayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return `${m}월 ${d}일 (${DOW[dt.getDay()]})`;
}

export default function Recipient({
  token,
  events,
  categories,
  allowComments,
  initialComments,
}: {
  token: string;
  events: RecipientEvent[];
  categories: RecipientCategory[];
  allowComments: boolean;
  initialComments: RecipientComment[];
}) {
  // respect system dark mode
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      document.documentElement.setAttribute(
        "data-theme",
        mq.matches ? "dark" : "light"
      );
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  const catMap = useMemo(() => {
    const m = new Map<string, RecipientCategory>();
    for (const c of categories) m.set(c.id, c);
    return m;
  }, [categories]);

  const byDate = useMemo(() => {
    const groups = new Map<string, RecipientEvent[]>();
    for (const e of [...events].sort((a, b) =>
      (a.date + (a.time || "")).localeCompare(b.date + (b.time || ""))
    )) {
      if (!groups.has(e.date)) groups.set(e.date, []);
      groups.get(e.date)!.push(e);
    }
    return [...groups.entries()];
  }, [events]);

  const [comments, setComments] =
    useState<RecipientComment[]>(initialComments);
  const commentsFor = (eventId: string) =>
    comments.filter((c) => c.event_id === eventId);

  return (
    <main className="rc-wrap">
      <div className="rc-head">
        <div className="rc-brand">
          <span className="rc-mark" />
          <span className="rc-word">셰어데이</span>
        </div>
        <span className="rc-sub">공유받은 일정 · 공개된 항목만 보여요</span>
      </div>

      {byDate.length === 0 && (
        <div className="rc-empty-card">
          <h1>표시할 일정이 없어요</h1>
          <p>아직 공개된 일정이 없습니다.</p>
        </div>
      )}

      {byDate.map(([date, evs]) => (
        <section className="rc-day" key={date}>
          <div className="rc-daylabel">{fmtDayLabel(date)}</div>
          {evs.map((e) => {
            const c = catMap.get(e.catId || "");
            const color = c?.color || "#64748B";
            return (
              <article className="rc-ev" key={e.id} style={{ borderLeftColor: color }}>
                <div className="rc-ev-top">
                  <span className="rc-time">
                    {e.time ? e.time + (e.end ? "–" + e.end : "") : "종일"}
                  </span>
                  <span className="rc-title">
                    {c?.emoji ? <span className="rc-em">{c.emoji}</span> : null}
                    {e.title}
                  </span>
                </div>
                {c?.name ? <div className="rc-cat">{c.name}</div> : null}
                {e.memo ? <div className="rc-memo">{e.memo}</div> : null}

                <CommentBlock
                  token={token}
                  eventId={e.id}
                  allowComments={allowComments}
                  comments={commentsFor(e.id)}
                  onAdd={(c) => setComments((prev) => [...prev, c])}
                />
              </article>
            );
          })}
        </section>
      ))}

      <footer className="rc-foot">
        셰어데이로 만든 공유 캘린더 · 받는 사람은 로그인 없이 볼 수 있어요
      </footer>
    </main>
  );
}

function CommentBlock({
  token,
  eventId,
  allowComments,
  comments,
  onAdd,
}: {
  token: string;
  eventId: string;
  allowComments: boolean;
  comments: RecipientComment[];
  onAdd: (c: RecipientComment) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit() {
    if (!name.trim() || !body.trim() || busy) return;
    setBusy(true);
    setErr("");
    try {
      const res = await fetch(`/api/share/${token}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId, authorName: name, body }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.error || "전송에 실패했어요.");
      } else {
        onAdd(data.comment);
        setBody("");
      }
    } catch {
      setErr("네트워크 오류예요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rc-cmt">
      {comments.length > 0 &&
        comments.map((c) => (
          <div className="rc-cmt-row" key={c.id}>
            <b>{c.author_name}</b>
            <span>{c.body}</span>
          </div>
        ))}

      {allowComments ? (
        open ? (
          <div className="rc-cmt-form">
            <input
              className="rc-inp"
              placeholder="이름"
              maxLength={40}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <textarea
              className="rc-inp rc-ta"
              placeholder="코멘트를 남겨보세요"
              maxLength={2000}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            {err && <div className="rc-err">{err}</div>}
            <div className="rc-cmt-actions">
              <button className="rc-btn ghost" onClick={() => setOpen(false)}>
                닫기
              </button>
              <button
                className="rc-btn solid"
                disabled={busy || !name.trim() || !body.trim()}
                onClick={submit}
              >
                {busy ? "보내는 중…" : "코멘트 남기기"}
              </button>
            </div>
          </div>
        ) : (
          <button className="rc-cmt-toggle" onClick={() => setOpen(true)}>
            💬 코멘트 {comments.length > 0 ? comments.length : "남기기"}
          </button>
        )
      ) : null}
    </div>
  );
}
