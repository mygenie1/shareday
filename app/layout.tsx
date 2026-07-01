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
  themeColor: "#10B981",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <head>
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@latest/dist/web/static/pretendard.css"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
