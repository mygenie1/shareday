/**
 * Dead-simple in-memory rate limiter. Good enough to start (STEP 5 says
 * "간단히 시작하고 필요 시 강화"). Note: serverless instances are ephemeral and
 * not shared, so this is best-effort. Swap for Upstash/Redis when you need
 * hard guarantees across instances.
 */
const hits = new Map<string, number[]>();

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) {
    hits.set(key, arr);
    return false; // blocked
  }
  arr.push(now);
  hits.set(key, arr);
  // opportunistic cleanup to bound memory
  if (hits.size > 5000) {
    for (const [k, v] of hits) {
      if (v.every((t) => now - t >= windowMs)) hits.delete(k);
    }
  }
  return true; // allowed
}

export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}
