/**
 * API 回應（Edge Function 回傳給 Client，也原樣保存在 action_log.response）。
 * 只含公開資料：沒有 RNG 密鑰、沒有 SQL 或內部錯誤訊息。
 */

import type { GameEvent, MarketQuote, OfflineReport, PlayerStateView, SettleSummary } from "@mining/game-engine";

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
  | "MARKET_QUOTE_EXPIRED" //  報價的市場日已過：以回應附上的新報價重新確認
  | "MARKET_UNAVAILABLE" //    當日價格無法取得（暫時性，不保存；可用同一個 key 重試）
  | "CHARACTER_NOT_FOUND"
  | "CHARACTER_EXISTS"
  | "IDEMPOTENCY_MISMATCH"
  | "VERSION_CONFLICT" //   重試 3 次仍衝突（可用同一個 key 再試）
  | "RATE_LIMITED" //       請求太頻繁（未執行、未保存）；Retry-After 之後以同一個 key 重試
  | "REQUEST_EXPIRED" //    這個 key 已處理過但詳細結果已過保存期限，或已確認作廢；絕不重新執行（見 expired）
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
      /** 交易當下的市場報價（唯讀；成交價由伺服器在交易時決定）。舊版保存的回應沒有這個欄位 */
      market?: MarketQuote;
    }
  | {
      ok: false;
      requestId: string | null;
      command: string | null;
      error: ApiError;
      /** 遊戲規則拒絕時附上目前的公開狀態（例如 REPORT_PENDING 時讓 Client 顯示報告） */
      state?: PlayerStateView;
      stateVersion?: number;
      market?: MarketQuote;
      /** RATE_LIMITED：建議等待的毫秒（也在 Retry-After header） */
      retryAfterMs?: number;
      /**
       * REQUEST_EXPIRED：processed = 伺服器當初確實處理過這個 key（ok = 當初是否成功）；
       * processed = false = 已確認作廢（從未執行，之後也不會執行）。Client 應重新讀取狀態。
       */
      expired?: { processed: boolean; ok: boolean | null; processedAt: number | null };
    };

/** 錯誤是否可以用同一個 Idempotency-Key 重試（這類回應不保存在 action_log） */
export const RETRYABLE: ReadonlySet<ApiErrorCode> = new Set(["VERSION_CONFLICT", "SERVER_BUSY", "INTERNAL_ERROR", "MARKET_UNAVAILABLE", "RATE_LIMITED"]);

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
    case "MARKET_QUOTE_EXPIRED":
    case "CHARACTER_EXISTS":
      return 409;
    case "SERVER_BUSY":
    case "MARKET_UNAVAILABLE":
      return 503;
    case "RATE_LIMITED":
      return 429;
    case "REQUEST_EXPIRED":
      return 410;
    case "INTERNAL_ERROR":
      return 500;
    default:
      return 422; // 遊戲規則拒絕（金幣不足、有待領取報告、已領取等）
  }
}
