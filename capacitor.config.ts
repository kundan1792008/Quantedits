import type { CapacitorConfig } from "@capacitor/cli";

// For native apps to reach server-rendered API routes, set CAPACITOR_SERVER_URL
// to the deployed Next.js origin (e.g. https://app.quantedits.io) before
// running `npx cap sync`.  When the variable is absent the app falls back to
// bundled static assets (requires `next build && next export`).
const capacitorServerUrl = process.env.CAPACITOR_SERVER_URL;

const config: CapacitorConfig = {
  appId: "com.quantedits.app",
  appName: "Quantedits",
  // webDir is used only when server.url is not set (static-export builds).
  webDir: "out",
  server: {
    androidScheme: "https",
    // When a server URL is provided, the native WebView loads the live Next.js
    // app so that all API routes (/api/v1/*) remain reachable from the device.
    ...(capacitorServerUrl ? { url: capacitorServerUrl } : {}),
  },
  plugins: {
    Camera: {
      // Use QuantneonCamera for reel recording with face detection
    },
  },
};

export default config;
