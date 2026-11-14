/**
 * 資料庫介面（supabase/migrations/20261114000100_player_rpc.sql）。
 *
 * `GameDb` 是協調層唯一依賴的介面；正式環境用 `supabaseGameDb`（經 PostgREST 呼叫 RPC，必須是 service_role），
 * 測試可以用其他實作（例如 PGlite）。
 */

import type { OfflineReport, PlayerGameState } from "@mining/game-engine";
import type { ApiResponse } from "./response.ts";

export type CreateResult =
  | { status: "created" | "exists"; state: PlayerGameState }
  | { status: "no_auth_user" };

export type LoadResult =
  | { status: "ok"; state: unknown; rngSecret: string; serverNow: number; market: Record<string, number> }
  | { status: "replay"; response: ApiResponse }
  | { status: "mismatch" }
  | { status: "not_found" };

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
  | { status: "mismatch" }
  | { status: "version_conflict"; stateVersion: number }
  | { status: "not_found" };

export interface GameDb {
  createPlayer(playerId: string, state: PlayerGameState): Promise<CreateResult>;
  loadSnapshot(playerId: string, idempotencyKey: string | null, requestHash: string | null): Promise<LoadResult>;
  commit(args: CommitArgs): Promise<CommitResult>;
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
    loadSnapshot: (playerId, idempotencyKey, requestHash) =>
      call(client, "game_load_snapshot", { p_player_id: playerId, p_idempotency_key: idempotencyKey, p_request_hash: requestHash }),
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
