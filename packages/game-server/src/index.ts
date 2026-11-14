/**
 * 《挖礦探險隊》伺服器協調層：把 @mining/game-engine 接上資料庫（Supabase RPC）。
 * 純 TypeScript：Edge Function（Deno）與整合測試（Node）共用。
 */
export { type CommitArgs, type CommitResult, type CreateResult, type GameDb, GameDbError, type LoadResult, type RpcClient, supabaseGameDb } from "./db.ts";
export { type ApiError, type ApiErrorCode, type ApiResponse, RETRYABLE, httpStatus } from "./response.ts";
export { type HandleOptions, type HandleResult, MAX_COMMIT_ATTEMPTS, createCharacter, handleGameRequest, isUuid, readState, requestHash } from "./handler.ts";
export { base64ToBytes, bytesToHex } from "./encoding.ts";
