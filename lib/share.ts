import { randomBytes } from "node:crypto";

export type ShareEvent = {
  id: string;
  date: string;
  time?: string;
  end?: string;
  title: string;
  catId?: string;
  memo?: string;
  isPrivate: false;
};

export type ShareCategory = {
  id: string;
  name: string;
  color?: string;
};

/** 192-bit URL-safe random token — unguessable, never sequential. */
export function genToken(): string {
  return randomBytes(24).toString("base64url");
}

const str = (v: unknown, max: number) =>
  typeof v === "string" ? v.slice(0, max) : "";

/**
 * SERVER-SIDE re-filter. Never trust the client: drop anything with
 * isPrivate=true and whitelist fields so no stray/private data leaks into the
 * public snapshot. Force isPrivate:false on every survivor.
 */
export function sanitizeEvents(input: unknown): ShareEvent[] {
  if (!Array.isArray(input)) return [];
  const out: ShareEvent[] = [];
  for (const raw of input.slice(0, 2000)) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    if (e.isPrivate === true) continue; // the guard the whole product depends on
    const date = str(e.date, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    out.push({
      id: str(e.id, 64) || genToken().slice(0, 8),
      date,
      time: str(e.time, 5),
      end: str(e.end, 5),
      title: str(e.title, 200),
      catId: str(e.catId, 64),
      memo: str(e.memo, 2000),
      isPrivate: false,
    });
  }
  return out;
}

export function sanitizeCategories(input: unknown): ShareCategory[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 100).flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const c = raw as Record<string, unknown>;
    const id = str(c.id, 64);
    if (!id) return [];
    return [
      {
        id,
        name: str(c.name, 60),
        color: str(c.color, 32),
      },
    ];
  });
}

/** null → 무기한; a number of days → timestamp; ISO string passes through. */
export function resolveExpiry(body: {
  expiresDays?: unknown;
  expiresAt?: unknown;
}): Date | null {
  if (typeof body.expiresDays === "number") {
    if (body.expiresDays <= 0) return null;
    return new Date(Date.now() + body.expiresDays * 86400_000);
  }
  if (typeof body.expiresAt === "string" && body.expiresAt) {
    const d = new Date(body.expiresAt);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

export type ShareRow = {
  token: string;
  events: unknown;
  categories: unknown;
  allow_comments: boolean;
  expires_at: string | null;
  revoked: boolean;
};

/** revoked=false AND (expires_at IS NULL OR expires_at > now) */
export function isLive(row: Pick<ShareRow, "revoked" | "expires_at">): boolean {
  if (row.revoked) return false;
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now())
    return false;
  return true;
}

/** Build absolute share URL from the incoming request. */
export function shareUrl(req: Request, token: string): string {
  const env = process.env.NEXT_PUBLIC_BASE_URL;
  if (env) return `${env.replace(/\/$/, "")}/s/${token}`;
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host =
    req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
  return `${proto}://${host}/s/${token}`;
}
