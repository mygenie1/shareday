"use client";

import Script from "next/script";
import { MARKUP } from "./calendar-markup";

/**
 * The calendar UI is the Claude Design export, mounted verbatim.
 * All personal-calendar logic (events + categories) lives in the browser and
 * is persisted to IndexedDB by /calendar.js — it is never sent to the server.
 * Only the share/holidays features talk to the backend Route Handlers.
 */
export default function Home() {
  return (
    <div className="wrap-root">
      <div dangerouslySetInnerHTML={{ __html: MARKUP }} />
      <Script src="/calendar.js" strategy="afterInteractive" />
    </div>
  );
}
