import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor wraps the existing web app in a native shell. The app body is loaded
 * straight from the deployed Vercel URL (server.url) so all API/share features work
 * unchanged and a web deploy updates the app instantly — the only native parts are
 * the home-screen widgets + the WidgetBridge plugin (see WIDGETS.md).
 *
 * To point at a different environment (staging, local LAN dev), change server.url.
 */
const config: CapacitorConfig = {
  appId: "com.shareday.app",
  appName: "셰어데이",
  // Required by the CLI even in server.url mode; `capacitor-www` holds only an
  // offline fallback page shown if the remote URL can't be reached.
  webDir: "capacitor-www",
  server: {
    url: "https://shareday-seven.vercel.app",
    cleartext: false,
  },
  ios: {
    contentInset: "always",
  },
  android: {
    // custom scheme used by the widget deep link (shareday://calendar?token=…)
    allowMixedContent: false,
  },
};

export default config;
