/**
 * API 回應（Edge Function 回傳給 Client，也原樣保存在 action_log.response）。
 * 只含公開資料：沒有 RNG 密鑰、沒有 SQL 或內部錯誤訊息。
 */

import type { GameEvent, OfflineReport, PlayerStateView, SettleSummary } from "@mining/game-engine";

/** 引擎錯誤碼（TECHNICAL_SPEC §10.3）＋ 伺服器層錯誤碼 */
export type ApiErrorCode =
  | "INVALID_REQUEST"
  | "REPORT_PENDING"
  | "REPORT_NOT_FOUND"
  | "REPORT_ALREADY_CLAIMED"
  | "INSUFFICIENT_COINS"
  | "INSUFFICIENT_ITEMS"
  | "PREREQUISITE_MISSING"
  | "MAX_LEVEL"
  | "ZONE_LOCKED"
  | "CHARACTER_NOT_FOUND"
  | "CHARACTER_EXISTS"
  | "IDEMPOTENCY_MISMATCH"
  | "VERSION_CONFLICT" //   重試 3 次仍衝突（可用同一個 key 再試）
  | "SERVER_BUSY" //        暫時性錯誤（資料庫錯誤、時間倒退）；可用同一個 key 再試
  | "INTERNAL_ERROR"; //    伺服器狀態異常（不應發生）；細節只記在伺服器端

export interface ApiError {
  code: ApiErrorCode;
  message: string;
}

export type ApiResponse =
  | {
      ok: true;
      requestId: string;
      command: string;
      stateVersion: number;
      state: PlayerStateView;
      events: GameEvent[];
      settlement: SettleSummary | null;
      report: OfflineReport | null;
    }
  | {
      ok: false;
      requestId: string | null;
      command: string | null;
      error: ApiError;
      /** 遊戲規則拒絕時附上目前的公開狀態（例如 REPORT_PENDING 時讓 Client 顯示報告） */
      state?: PlayerStateView;
      stateVersion?: number;
    };

/** 錯誤是否可以用同一個 Idempotency-Key 重試（這類回應不保存在 action_log） */
export const RETRYABLE: ReadonlySet<ApiErrorCode> = new Set(["VERSION_CONFLICT", "SERVER_BUSY", "INTERNAL_ERROR"]);

/** 對應的 HTTP 狀態碼（Edge Function 使用） */
export function httpStatus(r: ApiResponse): number {
  if (r.ok) return 200;
  switch (r.error.code) {
    case "INVALID_REQUEST":
      return 400;
    case "CHARACTER_NOT_FOUND":
    case "REPORT_NOT_FOUND":
      return 404;
    case "IDEMPOTENCY_MISMATCH":
    case "VERSION_CONFLICT":
    case "CHARACTER_EXISTS":
      return 409;
    case "SERVER_BUSY":
      return 503;
    case "INTERNAL_ERROR":
      return 500;
    default:
      return 422; // 遊戲規則拒絕（金幣不足、有待領取報告、已領取等）
  }
}
