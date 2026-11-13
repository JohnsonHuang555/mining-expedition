/**
 * 從 `supabase status -o env` 產生 apps/web/.env.local（只用於本地開發）。
 *
 *   pnpm env:sync
 *
 * 正式環境（Vercel）不使用這個檔案，環境變數在 Vercel 專案設定中填寫（README「部署」）。
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const internalHost = process.env.SUPABASE_INTERNAL_HOST ?? "host.docker.internal";
const target = resolve(import.meta.dirname, "../apps/web/.env.local");

function readStatus(): Record<string, string> {
  const raw = execFileSync("supabase", ["status", "-o", "env"], { encoding: "utf8" });
  const vars: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = /^([A-Z0-9_]+)="?(.*?)"?$/.exec(line.trim());
    if (m && m[1] && m[2] !== undefined) vars[m[1]] = m[2];
  }
  return vars;
}

const status = readStatus();
const apiUrl = status.API_URL;
// 新版 CLI 同時提供 publishable key 與舊的 anon key；兩者都可用於前端
const anonKey = status.PUBLISHABLE_KEY || status.ANON_KEY;
if (!apiUrl || !anonKey) {
  console.error("找不到 API_URL 或 ANON_KEY。先執行 `pnpm supabase:start`。");
  console.error(`supabase status 輸出的變數：${Object.keys(status).join(", ")}`);
  process.exit(1);
}

const port = new URL(apiUrl).port || "54321";
const content = [
  "# 由 `pnpm env:sync` 產生（本地開發專用，不要提交）",
  `NEXT_PUBLIC_SUPABASE_URL=${apiUrl}`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY=${anonKey}`,
  "# Next.js 伺服器端在容器內，要透過宿主的埠存取 Supabase",
  `SUPABASE_INTERNAL_URL=http://${internalHost}:${port}`,
  "",
].join("\n");

writeFileSync(target, content, { mode: 0o600 });
console.log(`已寫入 ${target}`);
