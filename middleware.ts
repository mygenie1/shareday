import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * CORS for the native app. The Capacitor shell now serves its UI from inside the
 * app (so it opens offline), which means its API calls are cross-origin: the shell
 * runs at capacitor://localhost on iOS and https://localhost on Android.
 *
 * Only those fixed origins are allowed — the browser app is same-origin and never
 * sends an Origin header we'd have to reflect. No credentials are involved (access
 * is by share token), so no Allow-Credentials.
 */
const ALLOWED_ORIGINS = new Set([
  "capacitor://localhost",
  "ionic://localhost",
  "https://localhost",
  "http://localhost",
]);

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

export function middleware(req: NextRequest) {
  const origin = req.headers.get("origin");
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : null;

  // Preflight for the JSON POST/PUT/DELETE calls.
  if (req.method === "OPTIONS" && allowed) {
    const res = new NextResponse(null, { status: 204, headers: corsHeaders(allowed) });
    res.headers.set("Vary", "Origin");
    return res;
  }

  const res = NextResponse.next();
  if (allowed) {
    for (const [k, v] of Object.entries(corsHeaders(allowed))) res.headers.set(k, v);
  }
  res.headers.set("Vary", "Origin"); // responses differ by Origin → don't let a CDN mix them
  return res;
}

export const config = { matcher: "/api/:path*" };
