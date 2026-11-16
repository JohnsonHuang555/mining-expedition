import { defineConfig, devices } from "@playwright/test";

/**
 * Cloud 的瀏覽器 Smoke Test（選用；docs/CLOUD_SMOKE_TEST.md）。
 * 只連到 CLOUD_WEB_URL（Vercel），只用測試帳號；不連資料庫。
 * 若開啟了 Vercel Deployment Protection，提供 VERCEL_AUTOMATION_BYPASS_SECRET（只在終端機臨時設定，不要寫進 Git）。
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
    baseURL: process.env.CLOUD_WEB_URL,
    trace: "off", // trace 會包含輸入的密碼與 token：Cloud 測試不保存
    screenshot: "off",
    extraHTTPHeaders: bypass ? { "x-vercel-protection-bypass": bypass, "x-vercel-set-bypass-cookie": "true" } : {},
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 860 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
});
