import { defineConfig } from "@playwright/test";
// Disable automatic DOM snapshots as well as media artifacts for restricted live sources.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
export default defineConfig({ testDir: "tests/e2e", fullyParallel: false, workers: 1, timeout: 45000,
  use: { baseURL: process.env.LIVE_BASE_URL ?? "http://localhost:3100", trace: "off", screenshot: "off", video: "off" },
  webServer: process.env.LIVE_BASE_URL ? undefined : { command: "pnpm exec tsx tests/support/e2e-server.ts", url: "http://localhost:3100", reuseExistingServer: false, timeout: 120000 },
});
