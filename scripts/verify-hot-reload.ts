/**
 * Hot Reload 驗收（在 dev 容器內執行，前置同 verify:env）：
 *
 *   pnpm verify:hot-reload
 *
 * 暫時改寫 packages/game-engine/src/dev-marker.ts，確認：
 * 1. Next.js dev server（web 容器）重新載入共用 package
 * 2. Supabase Edge Runtime 重新載入 supabase/ 以外的 packages/
 * 結束時（含失敗）一律還原檔案。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const markerFile = resolve(import.meta.dirname, "../packages/game-engine/src/dev-marker.ts");
const timeoutMs = Number(process.env.HOT_RELOAD_TIMEOUT_MS ?? 60_000);

function loadEnvFile(path: string): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && m[1]) out[m[1]] = m[2] ?? "";
    }
    return out;
  } catch {
    return {};
  }
}
const fileEnv = loadEnvFile(resolve(import.meta.dirname, "../apps/web/.env.local"));
const env = (k: string) => process.env[k] ?? fileEnv[k] ?? "";
const webUrl = env("WEB_URL") || "http://127.0.0.1:3000";
const supabaseUrl = env("VERIFY_SUPABASE_URL") || env("NEXT_PUBLIC_SUPABASE_URL");
const anonKey = env("NEXT_PUBLIC_SUPABASE_ANON_KEY");

async function readMarkers(): Promise<{ web?: string; edge?: string }> {
  const out: { web?: string; edge?: string } = {};
  try {
    const r = await fetch(`${webUrl}/api/dev/diagnostics`, { signal: AbortSignal.timeout(10_000) });
    out.web = ((await r.json()) as any).web?.devMarker;
  } catch {
    // 重新編譯中
  }
  try {
    const r = await fetch(`${supabaseUrl}/functions/v1/health`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    out.edge = ((await r.json()) as any).engine?.devMarker;
  } catch {
    // 重新載入中
  }
  return out;
}

const original = readFileSync(markerFile, "utf8");
const marker = `hot-reload-${Date.now()}`;
const results = { web: { ok: false, ms: 0 }, edge: { ok: false, ms: 0 } };

try {
  const before = await readMarkers();
  console.log(`改寫前：web=${before.web ?? "（無回應）"}, edge=${before.edge ?? "（無回應）"}`);
  writeFileSync(markerFile, original.replace(/DEV_MARKER = "[^"]*"/, `DEV_MARKER = "${marker}"`));
  const started = Date.now();
  while (Date.now() - started < timeoutMs && !(results.web.ok && results.edge.ok)) {
    await new Promise((r) => setTimeout(r, 1000));
    const now = await readMarkers();
    if (!results.web.ok && now.web === marker) results.web = { ok: true, ms: Date.now() - started };
    if (!results.edge.ok && now.edge === marker) results.edge = { ok: true, ms: Date.now() - started };
  }
} finally {
  writeFileSync(markerFile, original);
}

const line = (name: string, r: { ok: boolean; ms: number }) =>
  console.log(r.ok ? `✅ ${name}：${r.ms} ms 後生效` : `❌ ${name}：${timeoutMs / 1000} 秒內沒有重新載入`);
line("Next.js（web）重新載入 packages/game-engine", results.web);
line("Edge Runtime 重新載入 packages/game-engine", results.edge);
if (!results.web.ok) console.log("  web：在 .env 設 WATCHPACK_POLLING=true 後 `docker compose up -d web` 再試");
if (!results.edge.ok) console.log("  edge：檢查 `pnpm diagnose` 的 Edge Runtime 掛載；必要時用 `docker compose --profile functions up functions`");
process.exit(results.web.ok && results.edge.ok ? 0 : 1);
