import { ImageResponse } from "next/og";
import { OG_FONT_B64 } from "./og-font";

export const alt = "셰어데이 — 친구·가족과 나누는 일정 공유 캘린더";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// KakaoTalk / OG / Twitter thumbnail. Rendered server-side with a tiny
// base64-inlined Pretendard subset so Hangul renders instead of tofu.
export default async function OpengraphImage() {
  const font = Buffer.from(OG_FONT_B64, "base64");

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "0 100px",
          background: "linear-gradient(135deg,#EFFBF3 0%,#CFEEDD 100%)",
          fontFamily: "Pretendard",
        }}
      >
        <div style={{ display: "flex", marginBottom: 44 }}>
          <div style={{ position: "relative", width: 128, height: 128, display: "flex" }}>
            <div style={{ position: "absolute", left: 4, top: 8, width: 80, height: 80, borderRadius: 26, background: "#34D399" }} />
            <div style={{ position: "absolute", right: 4, bottom: 8, width: 80, height: 80, borderRadius: 26, background: "#0EA271" }} />
          </div>
        </div>
        <div style={{ display: "flex", fontSize: 108, fontWeight: 700, color: "#0F241A", letterSpacing: "-0.04em" }}>
          셰어데이
        </div>
        <div style={{ display: "flex", fontSize: 46, color: "#3B7A5E", marginTop: 22 }}>
          친구·가족과 나누는 달력
        </div>
        <div style={{ display: "flex", marginTop: 48 }}>
          <div
            style={{
              display: "flex",
              fontSize: 30,
              color: "#0B6B4F",
              background: "#FFFFFF",
              border: "2px solid #B8E6CE",
              borderRadius: 999,
              padding: "14px 32px",
            }}
          >
            일정 공유 캘린더 · shareday.app
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [{ name: "Pretendard", data: font, weight: 700, style: "normal" }],
    }
  );
}
