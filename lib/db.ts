import { neon } from "@neondatabase/serverless";

/**
 * Neon serverless SQL client (HTTP driver — ideal for Vercel functions).
 * DATABASE_URL is injected by the Vercel↔Neon integration in production and
 * read from .env.local in dev. We fail loudly if it's missing so misconfig
 * surfaces immediately instead of as a confusing runtime error.
 */
if (!process.env.DATABASE_URL) {
  // Only a warning at import time; routes throw a clean 500 via requireSql().
  console.warn("[db] DATABASE_URL is not set — database routes will fail.");
}

export const sql = process.env.DATABASE_URL
  ? neon(process.env.DATABASE_URL)
  : null;

export function requireSql() {
  if (!sql) {
    throw new Error("DATABASE_URL is not configured");
  }
  return sql;
}
