import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// iOS home-screen icon — brand mark only (no text → no font needed).
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#EFFBF3" }}>
        <div style={{ position: "relative", width: "100%", height: "100%", display: "flex" }}>
          <div style={{ position: "absolute", left: 36, top: 42, width: 78, height: 78, borderRadius: 26, background: "#34D399" }} />
          <div style={{ position: "absolute", right: 36, bottom: 42, width: 78, height: 78, borderRadius: 26, background: "#0EA271" }} />
        </div>
      </div>
    ),
    { ...size }
  );
}
