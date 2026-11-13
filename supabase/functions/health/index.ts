// Phase 1 連線檢查：Edge Function → 共用遊戲引擎、Edge Function → Postgres。
// 驗證項目 T15：Edge Function 能否匯入 supabase/ 以外的 packages/game-engine（見 deno.json）。

import { createClient } from "@supabase/supabase-js";
import { blockMs, engineInfo } from "@mining/game-engine";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async () => {
  const engine = { ...engineInfo(), sampleBlockMs: blockMs(15, 20, 1000) };

  // 本地 `supabase functions serve` 與 Supabase Cloud 都會自動注入這兩個變數
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    return json({ ok: false, engine, database: { ok: false, error: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing" } }, 500);
  }

  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const started = Date.now();
  const { data, error } = await db.rpc("health_check");
  const database = error
    ? { ok: false, ms: Date.now() - started, error: error.message }
    : { ok: true, ms: Date.now() - started, result: data };

  return json({ ok: database.ok, function: "health", engine, database }, database.ok ? 200 : 503);
});
