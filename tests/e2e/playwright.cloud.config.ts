import { defineConfig, devices } from "@playwright/test";

/**
 * Cloud Staging 的瀏覽器 Smoke Test（docs/CLOUD_SMOKE_TEST.md）。
 * 只連到 STAGING_WEB_URL（Vercel Preview），只用專用的 Staging 測試帳號；不連資料庫、不改資料。
 * 若 Preview 開啟了 Vercel Deployment Protection，提供 VERCEL_AUTOMATION_BYPASS_SECRET（不要寫進 Git）。
 */
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

export default defineConfig({
  testDir: "cloud",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report-cloud" }]],
  use: {
    baseURL: process.env.STAGING_WEB_URL,
    trace: "off", // trace 會包含輸入的密碼與 token：Cloud 測試不保存
    screenshot: "off",
    extraHTTPHeaders: bypass ? { "x-vercel-protection-bypass": bypass, "x-vercel-set-bypass-cookie": "true" } : {},
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 860 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
});
