// 健康檢查 Edge Function。
//
// 正式環境（預設）：只回傳 {"ok": true|false}，不含版本、錯誤訊息或延遲。
// 本地診斷（EDGE_DIAGNOSTICS=true，只在 supabase/config.toml 的 [edge_runtime.secrets] 設定）：
//   另外回傳共用引擎資訊、DEV_MARKER（Hot Reload 驗證）與資料庫檢查細節。
//
// 只使用 anon key（SUPABASE_ANON_KEY）呼叫 health_ping，不使用 service role。
// 同時驗證 T15：Edge Runtime 能否匯入 supabase/ 以外的 packages/（見 deno.json）。

import { createClient } from "@supabase/supabase-js";
import { DEV_MARKER, blockMs, engineInfo } from "@mining/game-engine";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const diagnostics = Deno.env.get("EDGE_DIAGNOSTICS") === "true";

async function pingDatabase(): Promise<{ ok: boolean; ms: number; error?: string }> {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const started = Date.now();
  if (!url || !anonKey) return { ok: false, ms: 0, error: "SUPABASE_URL / SUPABASE_ANON_KEY missing" };
  try {
    const db = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await db.rpc("health_ping");
    if (error) return { ok: false, ms: Date.now() - started, error: error.message };
    return { ok: data?.pong === true, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  }
}

Deno.serve(async (req) => {
  if (req.method !== "GET") return json({ ok: false }, 405);

  const database = await pingDatabase();
  const status = database.ok ? 200 : 503;

  if (!diagnostics) {
    if (!database.ok) console.error("health: database check failed", database.error);
    return json({ ok: database.ok }, status);
  }

  return json(
    {
      ok: database.ok,
      diagnostics: true,
      engine: { ...engineInfo(), devMarker: DEV_MARKER, sampleBlockMs: blockMs(15, 20, 1000) },
      database,
    },
    status,
  );
});
