import path from "node:path";
import type { NextConfig } from "next";

/**
 * Vercel 的 Root Directory 設為 `apps/web`，build 時的工作目錄就是本資料夾。
 * Monorepo 根目錄在上兩層；告訴 Next.js 從那裡追蹤 workspace packages。
 * 這裡不放任何 Docker 專用設定（D22：開發環境不與正式部署綁定）。
 */
const monorepoRoot = path.resolve(process.cwd(), "../..");

/** `*.dev.tsx` 的頁面（/dev/preview：記憶體後端預覽）只在 next dev 存在，正式 build 不會產生路由或 bundle */
const isDev = process.env.NODE_ENV === "development";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 開發指示器會蓋住手機版畫面左下角（E2E 截圖也在 next dev 拍攝）
  devIndicators: false,
  pageExtensions: isDev ? ["dev.tsx", "tsx", "ts"] : ["tsx", "ts"],
  // 共用 packages 以 TypeScript 原始碼發布，由 Next.js 轉譯
  transpilePackages: ["@mining/game-engine", "@mining/game-data", "@mining/game-server"],
  outputFileTracingRoot: monorepoRoot,
  // next dev 預設只允許 localhost 載入開發資源；README 與 Supabase Auth（site_url）使用 127.0.0.1。
  // 只影響 next dev，正式 build 不使用。
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  turbopack: {
    root: monorepoRoot,
  },
};

export default nextConfig;
