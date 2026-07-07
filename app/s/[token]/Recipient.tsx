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

/* ── received-link store: the SAME device-only IndexedDB the main app uses.
   No accounts, so holding the token is the access grant; we save only the token
   (+ owner name / timestamps) and the storehouse re-fetches the snapshot each
   time, so expiry/revocation is always reflected. ── */
const IDB_NAME = "shareday";
const IDB_STORE = "kv";
type SavedLink = {
  token: string;
  ownerName: string | null;
  savedAt: number;
  lastOpenedAt: number;
};
function idbOpen(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(IDB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(IDB_STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function idbGet<T>(key: string): Promise<T | undefined> {
  return idbOpen()
    .then(
      (db) =>
        new Promise<T | undefined>((res, rej) => {
          const rq = db
            .transaction(IDB_STORE, "readonly")
            .objectStore(IDB_STORE)
            .get(key);
          rq.onsuccess = () => res(rq.result as T | undefined);
          rq.onerror = () => rej(rq.error);
        })
    )
    .catch(() => undefined);
}
function idbSet(key: string, val: unknown): Promise<void> {
  return idbOpen()
    .then(
      (db) =>
        new Promise<void>((res, rej) => {
          const tx = db.transaction(IDB_STORE, "readwrite");
          tx.objectStore(IDB_STORE).put(val, key);
          tx.oncomplete = () => res();
          tx.onerror = () => rej(tx.error);
        })
    )
    .catch(() => {});
}

function SaveButton({
  token,
  ownerName,
}: {
  token: string;
  ownerName?: string | null;
}) {
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let live = true;
    idbGet<SavedLink[]>("savedLinks").then((list) => {
      if (live && Array.isArray(list) && list.some((l) => l.token === token))
        setSaved(true);
    });
    return () => {
      live = false;
    };
  }, [token]);
  async function save() {
    if (saved) return;
    const list = (await idbGet<SavedLink[]>("savedLinks")) || [];
    if (!list.some((l) => l.token === token)) {
      list.push({
        token,
        ownerName: ownerName ?? null,
        savedAt: Date.now(),
        lastOpenedAt: Date.now(),
      });
      await idbSet("savedLinks", list);
    }
    setSaved(true);
  }
  return (
    <button
      className={`rc-save ${saved ? "on" : ""}`}
      onClick={save}
      disabled={saved}
    >
      {saved ? "저장됨 ✓" : "＋ 이 캘린더 저장"}
    </button>
  );
}

/* ── date helpers (all local-time; snapshot dates are YYYY-MM-DD) ── */
function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function toYmd(dt: Date): string {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function startOfWeek(dt: Date): Date {
  const s = new Date(dt);
  s.setDate(dt.getDate() - dt.getDay()); // back to Sunday
  s.setHours(0, 0, 0, 0);
  return s;
}
function addDays(dt: Date, n: number): Date {
  const r = new Date(dt);
  r.setDate(dt.getDate() + n);
  return r;
}
function fmtMonthDay(dt: Date): string {
  return `${dt.getMonth() + 1}.${dt.getDate()}`;
}
function fmtDayLabel(date: string): string {
  const dt = parseYmd(date);
  return `${dt.getMonth() + 1}월 ${dt.getDate()}일 (${DOW[dt.getDay()]})`;
}
function fmtExpiry(iso: string): string {
  const dt = new Date(iso);
  return `${dt.getFullYear()}년 ${dt.getMonth() + 1}월 ${dt.getDate()}일`;
}

export default function Recipient({
  token,
  events,
  categories,
  allowComments,
  initialComments,
  expiresAt,
  ownerName,
}: {
  token: string;
  events: RecipientEvent[];
  categories: RecipientCategory[];
  allowComments: boolean;
  initialComments: RecipientComment[];
  expiresAt: string | null;
  ownerName?: string | null;
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

  const colorOf = (catId?: string) =>
    catMap.get(catId || "")?.color || "#64748B";

  // legend of the owner's categories that actually appear here (color = name),
  // so a recipient reads meaning, not just colors
  const usedCategories = useMemo(() => {
    const ids = new Set(events.map((e) => e.catId).filter(Boolean) as string[]);
    return categories.filter((c) => ids.has(c.id) && c.name);
  }, [events, categories]);

  // events grouped by date, each list sorted by time
  const byDate = useMemo(() => {
    const groups = new Map<string, RecipientEvent[]>();
    const sorted = [...events].sort((a, b) =>
      (a.date + (a.time || "")).localeCompare(b.date + (b.time || ""))
    );
    for (const e of sorted) {
      if (!groups.has(e.date)) groups.set(e.date, []);
      groups.get(e.date)!.push(e);
    }
    return groups;
  }, [events]);

  // where the calendar first lands: today's week, else the nearest event week
  const initialAnchor = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (events.length === 0) return today;
    const times = events.map((e) => parseYmd(e.date).getTime());
    const min = Math.min(...times);
    const max = Math.max(...times);
    const t = today.getTime();
    if (t >= min && t <= max) return today;
    let best = times[0];
    for (const d of times)
      if (Math.abs(d - t) < Math.abs(best - t)) best = d;
    return new Date(best);
  }, [events]);

  const [cursor, setCursor] = useState(() => ({
    y: initialAnchor.getFullYear(),
    m: initialAnchor.getMonth(),
  }));
  const [weekStart, setWeekStart] = useState(() => startOfWeek(initialAnchor));

  const [comments, setComments] =
    useState<RecipientComment[]>(initialComments);
  const commentsFor = (eventId: string) =>
    comments.filter((c) => c.event_id === eventId);

  // 6-week grid starting from the Sunday on/ before the 1st of the shown month
  const weeks = useMemo(() => {
    const first = new Date(cursor.y, cursor.m, 1);
    const gridStart = startOfWeek(first);
    const out: Date[][] = [];
    for (let w = 0; w < 6; w++) {
      const row: Date[] = [];
      for (let d = 0; d < 7; d++) row.push(addDays(gridStart, w * 7 + d));
      out.push(row);
    }
    return out;
  }, [cursor]);

  const todayYmd = toYmd(new Date());
  const weekStartYmd = toYmd(weekStart);
  const weekEnd = addDays(weekStart, 6);

  // events falling inside the selected week, in day/time order
  const weekEvents = useMemo(() => {
    const startS = weekStartYmd;
    const endS = toYmd(weekEnd);
    return [...events]
      .filter((e) => e.date >= startS && e.date <= endS)
      .sort((a, b) =>
        (a.date + (a.time || "")).localeCompare(b.date + (b.time || ""))
      );
  }, [events, weekStartYmd]);

  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const toggleOpen = (id: string) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  function selectDay(d: Date) {
    setWeekStart(startOfWeek(d));
    if (d.getMonth() !== cursor.m || d.getFullYear() !== cursor.y)
      setCursor({ y: d.getFullYear(), m: d.getMonth() });
    setOpenIds(new Set());
  }
  function moveMonth(delta: number) {
    setCursor((c) => {
      const dt = new Date(c.y, c.m + delta, 1);
      return { y: dt.getFullYear(), m: dt.getMonth() };
    });
  }

  const title = ownerName ? `${ownerName}님의 공유 캘린더` : "공유 캘린더";

  return (
    <main className="rc-wrap">
      {/* ── 1. header ── */}
      <div className="rc-head">
        <div className="rc-brand">
          <span className="rc-mark" />
          <span className="rc-word">셰어데이</span>
        </div>
        <h1 className="rc-title">{title}</h1>
        <span className="rc-sub">
          {expiresAt
            ? `${fmtExpiry(expiresAt)}까지 볼 수 있어요 · 공개된 일정만 보여요`
            : "공개된 일정만 보여요"}
        </span>
        <SaveButton token={token} ownerName={ownerName} />
      </div>

      {/* ── category legend (color = name) ── */}
      {usedCategories.length > 0 && (
        <div className="rc-legend">
          <span className="rc-legend-lbl">카테고리</span>
          {usedCategories.map((c) => (
            <span className="rc-legend-tag" key={c.id}>
              <span
                className="rc-legend-dot"
                style={{ background: c.color || "#64748B" }}
              />
              {c.name}
            </span>
          ))}
        </div>
      )}

      {/* ── 2. month calendar ── */}
      <section className="rc-cal card">
        <div className="rc-cal-head">
          <button
            className="rc-nav"
            aria-label="이전 달"
            onClick={() => moveMonth(-1)}
          >
            ‹
          </button>
          <div className="rc-cal-title">
            {cursor.y}년 {cursor.m + 1}월
          </div>
          <button
            className="rc-nav"
            aria-label="다음 달"
            onClick={() => moveMonth(1)}
          >
            ›
          </button>
        </div>
        <div className="rc-dow-row">
          {DOW.map((d, i) => (
            <div
              key={d}
              className={`rc-dow ${i === 0 ? "sun" : ""} ${
                i === 6 ? "sat" : ""
              }`}
            >
              {d}
            </div>
          ))}
        </div>
        <div className="rc-grid">
          {weeks.map((row, wi) => {
            const rowSel = toYmd(row[0]) === weekStartYmd;
            return (
              <div
                key={wi}
                className={`rc-week ${rowSel ? "sel" : ""}`}
              >
                {row.map((d) => {
                  const ymd = toYmd(d);
                  const dayEvs = byDate.get(ymd) || [];
                  const dim = d.getMonth() !== cursor.m;
                  const dots = Array.from(
                    new Set(dayEvs.map((e) => colorOf(e.catId)))
                  ).slice(0, 3);
                  return (
                    <button
                      key={ymd}
                      className={`rc-cell ${dim ? "dim" : ""} ${
                        ymd === todayYmd ? "today" : ""
                      } ${d.getDay() === 0 ? "sun" : ""} ${
                        d.getDay() === 6 ? "sat" : ""
                      }`}
                      onClick={() => selectDay(d)}
                    >
                      <span className="rc-dn">{d.getDate()}</span>
                      <span className="rc-dots">
                        {dots.map((c, i) => (
                          <span
                            key={i}
                            className="rc-dot"
                            style={{ background: c }}
                          />
                        ))}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </section>

      {/* ── 3. selected week's events ── */}
      <div className="rc-week-head">
        <span className="rc-week-tag">이 주</span>
        <span className="rc-week-range">
          {fmtMonthDay(weekStart)} – {fmtMonthDay(weekEnd)}
        </span>
      </div>

      {weekEvents.length === 0 ? (
        <div className="rc-empty">이 주엔 공개된 일정이 없어요.</div>
      ) : (
        <div className="rc-cards">
          {weekEvents.map((e) => {
            const list = commentsFor(e.id);
            const open = openIds.has(e.id);
            const color = colorOf(e.catId);
            const cat = catMap.get(e.catId || "");
            return (
              <article
                className={`rc-card ${open ? "open" : ""}`}
                key={e.id}
              >
                <button
                  className="rc-card-top"
                  onClick={() => toggleOpen(e.id)}
                >
                  <span className="rc-card-dot" style={{ background: color }} />
                  <span className="rc-card-main">
                    <span className="rc-card-title">{e.title}</span>
                    <span className="rc-card-when">
                      {fmtDayLabel(e.date)}
                      {e.time
                        ? ` · ${e.time}${e.end ? "–" + e.end : ""}`
                        : " · 종일"}
                    </span>
                  </span>
                  {list.length > 0 && (
                    <span className="rc-card-cmt">💬 {list.length}</span>
                  )}
                  <span className="rc-card-chev">{open ? "▲" : "▼"}</span>
                </button>

                {open && (
                  <div className="rc-card-body">
                    {cat?.name ? (
                      <span
                        className="rc-card-cat"
                        style={{ color }}
                      >
                        {cat.name}
                      </span>
                    ) : null}
                    {e.memo ? <p className="rc-card-memo">{e.memo}</p> : null}

                    <CommentBlock
                      token={token}
                      eventId={e.id}
                      allowComments={allowComments}
                      comments={list}
                      onAdd={(c) => setComments((prev) => [...prev, c])}
                    />
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

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
      {comments.length > 0 && (
        <div className="rc-cmt-list">
          {comments.map((c) => (
            <div className="rc-cmt-row" key={c.id}>
              <b>{c.author_name}</b>
              <span>{c.body}</span>
            </div>
          ))}
        </div>
      )}

      {allowComments ? (
        <div className="rc-cmt-form">
          {comments.length === 0 && (
            <div className="rc-cmt-none">
              아직 코멘트가 없어요. 첫 코멘트를 남겨보세요.
            </div>
          )}
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
        <div className="rc-cmt-off">댓글이 꺼진 링크예요.</div>
      )}
    </div>
  );
}
