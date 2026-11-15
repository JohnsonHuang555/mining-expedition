/**
 * 資料庫介面（supabase/migrations/20261114000100_player_rpc.sql）。
 *
 * `GameDb` 是協調層唯一依賴的介面；正式環境用 `supabaseGameDb`（經 PostgREST 呼叫 RPC，必須是 service_role），
 * 測試可以用其他實作（例如 PGlite）。
 */

import type { MarketQuote, OfflineReport, PlayerGameState } from "@mining/game-engine";
import type { ApiResponse } from "./response.ts";

export type CreateResult =
  | { status: "created" | "exists"; state: PlayerGameState }
  | { status: "no_auth_user" };

/** 同一個 key 已處理過，但詳細回應已超過保存期限（action_log compaction）：不可重新執行 */
export interface ExpiredRecord {
  status: "expired";
  /** 當初的結果是否成功（ok: true） */
  ok: boolean;
  committed: boolean;
  processedAt: number;
}

/** 每位使用者、每個 API 的固定視窗限制（只在伺服器端，由資料庫計數） */
export interface RateLimit {
  bucket: "game-action" | "game-state" | "character-create";
  limit: number;
  windowMs: number;
}

export type LoadResult =
  | { status: "ok"; state: unknown; rngSecret: string; serverNow: number; market: MarketSnapshot }
  | { status: "replay"; response: ApiResponse }
  | ExpiredRecord
  | { status: "rate_limited"; retryAfterMs: number }
  | { status: "mismatch" }
  | { status: "not_found" };

/**
 * 交易當下的市場（同一個資料庫交易內、與 serverNow 同一個時間點決定）。
 * multipliersPpm 缺少的寶物 = 當日價格無法產生（例如密鑰遺失）；只影響寶物出售，其他操作照常。
 */
export type MarketSnapshot = Required<Pick<MarketQuote, "date" | "nextRefreshAt" | "multipliersPpm">> & Pick<MarketQuote, "history">;

export interface CommitArgs {
  playerId: string;
  expectedVersion: number;
  idempotencyKey: string;
  requestHash: string;
  command: string;
  /** null = 沒有狀態變化（只保存回應） */
  state: PlayerGameState | null;
  reportCreated: OfflineReport | null;
  reportClaimed: string | null;
  response: ApiResponse;
}

export type CommitResult =
  | { status: "committed" | "recorded"; stateVersion: number }
  | { status: "replay"; response: ApiResponse }
  | ExpiredRecord
  | { status: "mismatch" }
  | { status: "version_conflict"; stateVersion: number }
  | { status: "not_found" };

export interface GameDb {
  createPlayer(playerId: string, state: PlayerGameState): Promise<CreateResult>;
  /** rate：只在新請求（不是重送）時計數；重送與已過期的 key 不受限 */
  loadSnapshot(playerId: string, idempotencyKey: string | null, requestHash: string | null, rate?: RateLimit): Promise<LoadResult>;
  commit(args: CommitArgs): Promise<CommitResult>;
  /** character-create 用；回傳 0 = 允許，> 0 = 要等待的毫秒 */
  rateLimit(playerId: string, rate: RateLimit): Promise<number>;
}

/** 資料庫錯誤（連線、約束違反、交易失敗）。訊息只用於伺服器端紀錄，不回傳給 Client */
export class GameDbError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "GameDbError";
    this.code = code;
  }
}

/** supabase-js 的最小介面（`createClient(url, serviceRoleKey)`）。不直接依賴 supabase-js */
export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
}

async function call<T>(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new GameDbError(`${fn}: ${error.message}`, error.code);
  if (data === null || typeof data !== "object") throw new GameDbError(`${fn}: unexpected response`);
  return data as T;
}

export function supabaseGameDb(client: RpcClient): GameDb {
  return {
    createPlayer: (playerId, state) => call(client, "game_create_player", { p_player_id: playerId, p_state: state }),
    loadSnapshot: (playerId, idempotencyKey, requestHash, rate) =>
      call(client, "game_load_snapshot", {
        p_player_id: playerId,
        p_idempotency_key: idempotencyKey,
        p_request_hash: requestHash,
        ...(rate ? { p_rate_bucket: rate.bucket, p_rate_limit: rate.limit, p_rate_window_ms: rate.windowMs } : {}),
      }),
    rateLimit: async (playerId, rate) => {
      const r = await call<{ status: string; retryAfterMs?: number }>(client, "game_rate_limit", {
        p_user: playerId,
        p_bucket: rate.bucket,
        p_limit: rate.limit,
        p_window_ms: rate.windowMs,
      });
      return r.status === "rate_limited" ? Math.max(1, Number(r.retryAfterMs ?? 1000)) : 0;
    },
    commit: (a) =>
      call(client, "game_commit", {
        p_player_id: a.playerId,
        p_expected_version: a.expectedVersion,
        p_idempotency_key: a.idempotencyKey,
        p_request_hash: a.requestHash,
        p_command: a.command,
        p_state: a.state,
        p_report_created: a.reportCreated,
        p_report_claimed: a.reportClaimed,
        p_response: a.response,
      }),
  };
}

/**
 * 預設的 rate limit（每位使用者；固定視窗）。依「合法使用的上限」設定：
 * - 自動同步約每 5–20 秒一次（多分頁時各自同步）、玩家連續點擊交易每秒 1–2 次；
 * - 網路不穩時 API Client 以同一個 key 重送：重送（replay）不計數。
 * Edge Function 可用環境變數覆寫（GAME_RATE_LIMIT_ACTION 等，格式 "次數/毫秒"）。
 */
export const DEFAULT_RATE_LIMITS: Readonly<Record<RateLimit["bucket"], RateLimit>> = {
  "game-action": { bucket: "game-action", limit: 30, windowMs: 10_000 },
  "game-state": { bucket: "game-state", limit: 20, windowMs: 10_000 },
  "character-create": { bucket: "character-create", limit: 5, windowMs: 60_000 },
};

/** "30/10000" → { limit: 30, windowMs: 10000 }；格式錯誤時回傳預設值 */
export function parseRateLimit(bucket: RateLimit["bucket"], raw: string | undefined | null): RateLimit {
  const m = /^(\d{1,5})\/(\d{4,7})$/.exec(raw ?? "");
  if (!m) return DEFAULT_RATE_LIMITS[bucket];
  return { bucket, limit: Math.max(1, Number(m[1])), windowMs: Number(m[2]) };
}
