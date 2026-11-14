import { defineConfig, devices } from "@playwright/test";

/**
 * 瀏覽器端到端測試：真正的 Next.js（docker compose 的 web，next dev）+ 真正的 Supabase Local（Auth、Edge Functions、Postgres）。
 * CI 以 Playwright 官方 Docker image 執行（--network host），不需要在宿主安裝瀏覽器。
 */
export default defineConfig({
  testDir: "tests",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 860 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
});
