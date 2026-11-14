// 遊戲 API 的共用部分（character-create / game-state / game-action）。
//
// 安全原則（TECHNICAL_SPEC §10、§11）：
// - 玩家身分只來自已驗證的 JWT（auth.getUser）；request body 中任何 playerId 都會被拒絕。
// - Service Role Key 只在這裡（伺服器端）讀取，用來呼叫 service_role 專用的 RPC；不會出現在任何回應中。
// - 錯誤回應只含錯誤碼與遊戲規則訊息；資料庫錯誤、SQL、堆疊只寫伺服器紀錄。
// - 本地診斷（EDGE_DIAGNOSTICS=true，只在 supabase/config.toml 設定）時附上 Server-Timing 與記憶體資訊。

import { createClient } from "@supabase/supabase-js";
import { type ApiResponse, type GameDb, type HandleResult, httpStatus, supabaseGameDb } from "@mining/game-server";
import { engineInfo } from "@mining/game-engine";
import { readJsonBody } from "./body.ts";

const diagnostics = Deno.env.get("EDGE_DIAGNOSTICS") === "true";
export const MAX_BODY_BYTES = 16 * 1024;

const CORS = {
  "Access-Control-Allow-Origin": Deno.env.get("GAME_API_ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, idempotency-key, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Expose-Headers": "idempotent-replayed, x-engine-version, server-timing",
};

export function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Engine-Version": engineInfo().engineVersion, ...CORS, ...headers },
  });
}

const errorBody = (code: string, message: string): ApiResponse => ({ ok: false, requestId: null, command: null, error: { code: code as never, message } });
export const errorResponse = (status: number, code: string, message: string) => json(errorBody(code, message), status);

/** 伺服器紀錄：結構化 JSON，不含 JWT、金鑰或密鑰 */
export function log(event: string, detail: Record<string, unknown>): void {
  console.error(JSON.stringify({ event, ...detail }));
}

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing ${name}`);
  return v;
}

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };

/** 驗證 JWT，回傳使用者 id；失敗回傳 401 回應 */
export async function authenticate(req: Request, timing: Timing): Promise<string | Response> {
  const header = req.headers.get("Authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return errorResponse(401, "UNAUTHORIZED", "sign in required");
  const started = performance.now();
  try {
    const auth = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), clientOptions);
    const { data, error } = await auth.auth.getUser(m[1]);
    timing.authMs += performance.now() - started;
    if (error || !data.user) return errorResponse(401, "UNAUTHORIZED", "sign in required");
    return data.user.id;
  } catch (e) {
    timing.authMs += performance.now() - started;
    log("auth_error", { error: e instanceof Error ? e.message : String(e) });
    return errorResponse(503, "SERVER_BUSY", "try again");
  }
}

export interface Timing {
  startedAt: number;
  authMs: number;
  dbMs: number;
  dbCalls: number;
}
export const newTiming = (): Timing => ({ startedAt: performance.now(), authMs: 0, dbMs: 0, dbCalls: 0 });

/** service_role 的資料庫介面；每個 RPC 計時（只用於 Server-Timing） */
export function gameDb(timing: Timing): GameDb {
  const service = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), clientOptions);
  const db = supabaseGameDb(service);
  const timed = <A extends unknown[], R>(f: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
    const s = performance.now();
    try {
      return await f(...a);
    } finally {
      timing.dbMs += performance.now() - s;
      timing.dbCalls += 1;
    }
  };
  return { createPlayer: timed(db.createPlayer), loadSnapshot: timed(db.loadSnapshot), commit: timed(db.commit) };
}

/** 回應：狀態碼依錯誤碼；診斷模式附上分段時間與記憶體 */
export function respond(response: ApiResponse, timing: Timing, extra: Partial<HandleResult> = {}, statusOverride?: number): Response {
  const headers: Record<string, string> = {};
  if (extra.replayed !== undefined) headers["Idempotent-Replayed"] = String(extra.replayed);
  if (diagnostics) {
    const total = performance.now() - timing.startedAt;
    const compute = Math.max(0, total - timing.authMs - timing.dbMs);
    headers["Server-Timing"] = [
      `total;dur=${total.toFixed(1)}`,
      `auth;dur=${timing.authMs.toFixed(1)}`,
      `db;dur=${timing.dbMs.toFixed(1)};desc="${timing.dbCalls} rpc"`,
      `compute;dur=${compute.toFixed(1)}`,
      `attempts;desc="${extra.attempts ?? 0}"`,
    ].join(", ");
    const mem = (Deno as unknown as { memoryUsage?: () => { heapUsed: number; rss: number } }).memoryUsage?.();
    if (mem) headers["X-Diagnostics-Memory"] = `heapUsed=${mem.heapUsed};rss=${mem.rss}`;
  }
  return json(response, statusOverride ?? httpStatus(response), headers);
}

/** 讀取 JSON body（大小上限、必須是物件） */
/** 讀取 JSON body（逐段讀取，超過 MAX_BODY_BYTES 立即停止並回 413；見 body.ts） */
export async function readJson(req: Request): Promise<Record<string, unknown> | Response> {
  const r = await readJsonBody(req, MAX_BODY_BYTES);
  if (r.kind === "too_large") return errorResponse(413, "INVALID_REQUEST", "request body too large");
  if (r.kind === "invalid") return errorResponse(400, "INVALID_REQUEST", r.message);
  return r.value;
}

/** 共通的請求包裝：CORS preflight、方法檢查、未預期錯誤遮蔽 */
export function serve(methods: string[], handler: (req: Request, timing: Timing) => Promise<Response>): void {
  Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (!methods.includes(req.method)) return errorResponse(405, "INVALID_REQUEST", "method not allowed");
    const timing = newTiming();
    try {
      return await handler(req, timing);
    } catch (e) {
      log("unhandled_error", { error: e instanceof Error ? e.message : String(e) });
      return errorResponse(500, "INTERNAL_ERROR", "internal error");
    }
  });
}
