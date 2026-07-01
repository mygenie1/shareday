import { NextResponse } from "next/server";
import { requireSql } from "@/lib/db";

export const runtime = "nodejs";

type Holiday = { date: string; name: string; isHoliday: boolean };

const DATA_GO_KR_ENDPOINT =
  "https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo";

/** "20260101" → "2026-01-01" */
function fmtLocdate(locdate: string | number): string {
  const s = String(locdate);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/**
 * Friendlier display names than the raw 특일 정보 labels.
 * Applied on both the upstream parse (so new rows store the nice name) AND the
 * cache-read path (so already-cached rows like "기독탄신일" are fixed on the fly).
 */
const NAME_FIX: Record<string, string> = { 기독탄신일: "크리스마스" };
const displayName = (n: string): string => NAME_FIX[n] ?? n;

/**
 * data.go.kr issues the "일반 인증키" in two forms:
 *   Encoding (URL-encoded, e.g. ...%2B%2F%3D)  /  Decoding (raw, e.g. ...+/=).
 * We normalize to the RAW form, then let URLSearchParams encode it exactly once —
 * so it works no matter which form was pasted into DATA_GO_KR_KEY. (Base64 keys
 * never contain '%', so seeing "%XX" reliably means it's the Encoded form.)
 */
function rawServiceKey(k: string): string {
  if (/%[0-9A-Fa-f]{2}/.test(k)) {
    try {
      return decodeURIComponent(k);
    } catch {
      return k;
    }
  }
  return k;
}

/**
 * Throttle upstream retries for a year that yields nothing (e.g. future years
 * with no published data, or a transient error). Successful years are cached in
 * Postgres permanently, so this only bounds the empty/error path within a warm
 * instance — keeps external calls at ~once/year as intended.
 */
const lastTried = new Map<number, number>();
const RETRY_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * GET /api/holidays?year=YYYY
 * Serves from the `holidays` cache; on a miss, fetches the public-data API
 * (server-side, key never exposed), upserts, then returns. Empty/failed
 * upstream degrades gracefully to [] so the calendar still renders.
 */
export async function GET(req: Request) {
  const yearParam = new URL(req.url).searchParams.get("year");
  const year = Number(yearParam);
  if (!Number.isInteger(year) || year < 1900 || year > 2200) {
    return NextResponse.json({ error: "invalid year" }, { status: 400 });
  }

  let sql;
  try {
    sql = requireSql();
  } catch {
    return NextResponse.json({ year, holidays: [] });
  }

  // 1) cache hit?
  try {
    const cached = (await sql`
      select to_char(date, 'YYYY-MM-DD') as date, name, is_holiday
      from holidays
      where date >= ${`${year}-01-01`} and date <= ${`${year}-12-31`}
      order by date asc
    `) as { date: string; name: string; is_holiday: boolean }[];
    if (cached.length > 0) {
      return NextResponse.json({
        year,
        cached: true,
        holidays: cached.map((r) => ({
          date: r.date,
          name: displayName(r.name),
          isHoliday: r.is_holiday,
        })),
      });
    }
  } catch (err) {
    console.error("[holidays cache read]", err);
  }

  // 2) cache miss → fetch upstream
  const key = process.env.DATA_GO_KR_KEY;
  if (!key) {
    return NextResponse.json({ year, holidays: [], note: "DATA_GO_KR_KEY unset" });
  }

  const prev = lastTried.get(year);
  if (prev && Date.now() - prev < RETRY_MS) {
    return NextResponse.json({
      year,
      holidays: [],
      note: "recently attempted; upstream had no data (throttled)",
    });
  }
  lastTried.set(year, Date.now());

  let holidays: Holiday[] = [];
  try {
    const url = new URL(DATA_GO_KR_ENDPOINT);
    url.searchParams.set("serviceKey", rawServiceKey(key)); // works for Encoding or Decoding key
    url.searchParams.set("solYear", String(year));
    url.searchParams.set("numOfRows", "50");
    url.searchParams.set("_type", "json");

    const res = await fetch(url, { cache: "no-store" });
    const text = await res.text();

    // data.go.kr returns XML (not JSON) on auth/key errors even with _type=json.
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      const reason = (text.match(/<returnAuthMsg>([^<]*)<\/returnAuthMsg>/) ||
        text.match(/<errMsg>([^<]*)<\/errMsg>/) ||
        [])[1];
      console.error("[holidays upstream non-JSON]", res.status, text.slice(0, 300));
      return NextResponse.json({
        year,
        holidays: [],
        note: `upstream auth/key error${reason ? ": " + reason : ""}`,
      });
    }

    const header = json?.response?.header;
    if (header?.resultCode && header.resultCode !== "00") {
      console.error("[holidays upstream result]", header.resultCode, header.resultMsg);
      return NextResponse.json({
        year,
        holidays: [],
        note: `upstream ${header.resultCode}: ${header.resultMsg || ""}`.trim(),
      });
    }

    const rawItems = json?.response?.body?.items?.item ?? [];
    const items = Array.isArray(rawItems) ? rawItems : [rawItems];
    holidays = items
      .filter((it: unknown) => it && typeof it === "object" && "locdate" in it)
      .map((it: { locdate: string | number; dateName?: string; isHoliday?: string }) => ({
        date: fmtLocdate(it.locdate),
        name: displayName(String(it.dateName ?? "공휴일")),
        isHoliday: it.isHoliday !== "N",
      }));
  } catch (err) {
    console.error("[holidays upstream]", err);
    return NextResponse.json({ year, holidays: [], note: "upstream error" });
  }

  // 3) upsert into cache (few rows/year → simple per-row upsert is fine)
  if (holidays.length) {
    try {
      for (const h of holidays) {
        await sql`
          insert into holidays (date, name, is_holiday)
          values (${h.date}, ${h.name}, ${h.isHoliday})
          on conflict (date) do update
            set name = excluded.name, is_holiday = excluded.is_holiday
        `;
      }
      lastTried.delete(year); // cached now; future reads hit Postgres, not upstream
    } catch (err) {
      console.error("[holidays cache write]", err);
    }
  }

  return NextResponse.json({ year, cached: false, holidays });
}
