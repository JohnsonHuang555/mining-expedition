/**
 * Phase 1 環境驗證（在 dev 容器內執行）：
 *
 *   pnpm verify:env
 *
 * 1. Web（compose 服務 web:3000）→ /api/health
 *    - Web → Edge Function → Postgres
 *    - Web → PostgREST → Postgres
 * 2. 直接呼叫 Edge Function（確認不經過 Web 也能連到 Postgres，並匯入共用引擎）
 * 3. 直接呼叫 PostgREST
 *
 * 任一項失敗時以非 0 結束。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

const webUrl = env("WEB_URL") || "http://web:3000";
const supabaseUrl = env("SUPABASE_INTERNAL_URL") || env("NEXT_PUBLIC_SUPABASE_URL");
const anonKey = env("NEXT_PUBLIC_SUPABASE_ANON_KEY");

interface Check {
  name: string;
  run: () => Promise<string>;
}

async function getJson(url: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // 非 JSON
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${typeof body === "string" ? body.slice(0, 200) : JSON.stringify(body)}`);
  return { status: res.status, body };
}

const headers = { apikey: anonKey, Authorization: `Bearer ${anonKey}` };

const checks: Check[] = [
  {
    name: "環境變數（apps/web/.env.local）",
    run: async () => {
      if (!supabaseUrl || !anonKey) throw new Error("缺少 Supabase URL 或 anon key，先執行 `pnpm env:sync`");
      return `supabase=${supabaseUrl}`;
    },
  },
  {
    name: "Edge Function → 共用引擎 + Postgres",
    run: async () => {
      const { body } = await getJson(`${supabaseUrl}/functions/v1/health`, { headers });
      if (!body.engine?.dataVersion) throw new Error("回應沒有 engine 資訊（packages/game-engine 匯入失敗？）");
      if (!body.database?.ok) throw new Error(`資料庫失敗：${JSON.stringify(body.database)}`);
      return `engine v${body.engine.engineVersion}, DATA_VERSION ${body.engine.dataVersion}, postgres ${body.database.result?.postgres}`;
    },
  },
  {
    name: "PostgREST → Postgres",
    run: async () => {
      const { body } = await getJson(`${supabaseUrl}/rest/v1/rpc/health_ping`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: "{}",
      });
      if (!body.pong) throw new Error(`非預期回應：${JSON.stringify(body)}`);
      return `server_now=${body.server_now}`;
    },
  },
  {
    name: `Web（${webUrl}）→ Edge Function / PostgREST`,
    run: async () => {
      const { body } = await getJson(`${webUrl}/api/health`);
      if (!body.ok) throw new Error(JSON.stringify(body));
      return `edge ${body.edgeFunction.ms} ms, postgrest ${body.postgrest.ms} ms`;
    },
  },
];

let failed = 0;
for (const c of checks) {
  try {
    console.log(`✅ ${c.name}：${await c.run()}`);
  } catch (err) {
    failed++;
    console.log(`❌ ${c.name}：${err instanceof Error ? err.message : String(err)}`);
  }
}
process.exit(failed ? 1 : 0);
