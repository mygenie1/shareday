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
          name: r.name,
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

  let holidays: Holiday[] = [];
  try {
    const url = new URL(DATA_GO_KR_ENDPOINT);
    url.searchParams.set("serviceKey", key); // decoded key; URL encodes it once
    url.searchParams.set("solYear", String(year));
    url.searchParams.set("numOfRows", "50");
    url.searchParams.set("_type", "json");

    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const json = await res.json();

    const rawItems = json?.response?.body?.items?.item ?? [];
    const items = Array.isArray(rawItems) ? rawItems : [rawItems];
    holidays = items
      .filter((it: unknown) => it && typeof it === "object" && "locdate" in it)
      .map((it: { locdate: string | number; dateName?: string; isHoliday?: string }) => ({
        date: fmtLocdate(it.locdate),
        name: String(it.dateName ?? "공휴일"),
        isHoliday: it.isHoliday !== "N",
      }));
  } catch (err) {
    console.error("[holidays upstream]", err);
    return NextResponse.json({ year, holidays: [], note: "upstream error" });
  }

  // 3) upsert into cache (few rows/year → simple per-row upsert is fine)
  try {
    for (const h of holidays) {
      await sql`
        insert into holidays (date, name, is_holiday)
        values (${h.date}, ${h.name}, ${h.isHoliday})
        on conflict (date) do update
          set name = excluded.name, is_holiday = excluded.is_holiday
      `;
    }
  } catch (err) {
    console.error("[holidays cache write]", err);
  }

  return NextResponse.json({ year, cached: false, holidays });
}
