/**
 * 引擎回傳的錯誤（TECHNICAL_SPEC §10.3）。引擎只回傳錯誤值，不丟出例外；
 * 例外只用於「程式或資料錯誤」（例如溢位），代表不能提交。
 */

export type GameErrorCode =
  | "INVALID_REQUEST" //       參數不合法（型別、範圍、未知 ID、負數、超大整數）
  | "INVALID_STATE" //         載入的狀態違反不變式（不應發生；不可提交）
  | "INVALID_TIME" //          serverNow 早於 lastSettledAt（或領取時未提供）
  | "RNG_VERSION_MISMATCH" //  狀態的 rngVersion 與引擎不同
  | "DATA_VERSION_UNSUPPORTED" // 狀態的 dataVersion 比引擎新
  | "REPORT_PENDING" //        有待領取的離線報告（D20）
  | "REPORT_NOT_FOUND"
  | "REPORT_ALREADY_CLAIMED"
  | "INSUFFICIENT_COINS"
  | "INSUFFICIENT_ITEMS"
  | "PREREQUISITE_MISSING" //  未擁有、未依序、未到達、Power 不足、不可重挖等
  | "MAX_LEVEL"
  | "ZONE_LOCKED";

export interface GameError {
  code: GameErrorCode;
  message: string;
}

export const gameError = (code: GameErrorCode, message: string): GameError => ({ code, message });
