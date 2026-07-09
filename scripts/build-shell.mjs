/**
 * Builds capacitor-www/ — the app shell that ships INSIDE the native app.
 *
 * Why not the Next.js build? The calendar is a plain markup export + one script,
 * and every route the app needs at runtime (share, comments, holidays) is an API
 * call, not a page. So the shell is just index.html + globals.css + calendar.js.
 * Bundling it means the app opens with no network and renders my events straight
 * from IndexedDB; only the server-backed features need connectivity.
 *
 * The three sources are copied verbatim, so the native app and the web app always
 * run the same UI. Run via `npm run build:shell` (cap:sync does it for you).
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "capacitor-www");
mkdirSync(out, { recursive: true });

// app/calendar-markup.ts is `export const MARKUP = "<json string literal>";`
const src = readFileSync(join(root, "app", "calendar-markup.ts"), "utf8");
const m = src.match(/export const MARKUP\s*=\s*("(?:\\.|[^"\\])*")/s);
if (!m) throw new Error("build-shell: could not read MARKUP from app/calendar-markup.ts");
const markup = JSON.parse(m[1]);

copyFileSync(join(root, "app", "globals.css"), join(out, "globals.css"));
copyFileSync(join(root, "public", "calendar.js"), join(out, "calendar.js"));

// Mirrors app/layout.tsx: same pre-paint theme script (no dark-mode flash), same
// viewport-fit=cover (env(safe-area-inset-*) must report real values for the sheet).
const themeScript =
  "(function(){try{var t=localStorage.getItem('shareday-theme');if(t!=='dark'&&t!=='light'){t=(window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light';}document.documentElement.setAttribute('data-theme',t);var m=document.createElement('meta');m.name='theme-color';m.content=t==='dark'?'#000000':'#EFFBF3';document.head.appendChild(m);}catch(e){}})();";

const html = `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>셰어데이</title>
    <script>${themeScript}</script>
    <!-- Webfont is a progressive enhancement: offline it simply falls back to the
         system stack declared in globals.css. Never block first paint on it. -->
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@latest/dist/web/static/pretendard.css" />
    <link rel="stylesheet" href="./globals.css" />
  </head>
  <body>
    <div class="wrap-root">${markup}</div>
    <script src="./calendar.js"></script>
  </body>
</html>
`;

writeFileSync(join(out, "index.html"), html, "utf8");
console.log("build-shell: wrote capacitor-www/{index.html,globals.css,calendar.js}");
