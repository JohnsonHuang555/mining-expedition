import path from "node:path";
import type { NextConfig } from "next";

/**
 * Vercel 的 Root Directory 設為 `apps/web`，build 時的工作目錄就是本資料夾。
 * Monorepo 根目錄在上兩層；告訴 Next.js 從那裡追蹤 workspace packages。
 * 這裡不放任何 Docker 專用設定（D22：開發環境不與正式部署綁定）。
 */
const monorepoRoot = path.resolve(process.cwd(), "../..");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 共用 packages 以 TypeScript 原始碼發布，由 Next.js 轉譯
  transpilePackages: ["@mining/game-engine", "@mining/game-data"],
  outputFileTracingRoot: monorepoRoot,
  turbopack: {
    root: monorepoRoot,
  },
};

export default nextConfig;
