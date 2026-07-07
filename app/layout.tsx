import type { Metadata, Viewport } from "next";
import "./globals.css";

const BASE_URL =
  process.env.NEXT_PUBLIC_BASE_URL || "https://shareday-seven.vercel.app";

const TITLE = "셰어데이 — 일정 공유 캘린더";
const DESCRIPTION =
  "친구·가족과 나누는 달력. 공개한 일정만 링크로 공유하고, 프라이빗 일정은 내 기기에만 남습니다.";

export const metadata: Metadata = {
  metadataBase: new URL(BASE_URL), // makes the OG image URL absolute (KakaoTalk requires it)
  title: TITLE,
  description: DESCRIPTION,
  applicationName: "셰어데이",
  openGraph: {
    type: "website",
    siteName: "셰어데이",
    locale: "ko_KR",
    title: TITLE,
    description: DESCRIPTION,
    url: "/",
    // og:image is generated automatically from app/opengraph-image.tsx
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // The mobile browser chrome bar stays neutral (matches the app background) instead
  // of brand green, so category colors lead. The deep-green logo is unchanged.
  // The exact per-theme color is set by the head script below (honors a saved theme).
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <head>
        {/* Set the saved theme before first paint so a dark user never sees a
            light flash on load/refresh. Mirrors the key used in calendar.js. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('shareday-theme');if(t!=='dark'&&t!=='light'){t=(window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light';}document.documentElement.setAttribute('data-theme',t);var m=document.createElement('meta');m.name='theme-color';m.content=t==='dark'?'#000000':'#EFFBF3';document.head.appendChild(m);}catch(e){}})();",
          }}
        />
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@latest/dist/web/static/pretendard.css"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
