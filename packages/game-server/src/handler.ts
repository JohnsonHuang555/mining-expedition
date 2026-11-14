/**
 * 伺服器協調層：載入快照 → executeRequest → 原子提交 → CAS 衝突時重試（TECHNICAL_SPEC §10.4、§10.6）。
 *
 * - 純 TypeScript，只依賴 `GameDb` 介面：Edge Function（Deno）與整合測試（Node）共用同一份程式碼。
 * - playerId 必須來自「已驗證的 JWT」，不能來自 request body（Edge Function 負責）。
 * - 冪等不依賴記憶體或前端：同一個 Idempotency-Key 的結果只由資料庫的 action_log 決定。
 */

import {
  type GameCommand,
  type GameError,
  type PlayerGameState,
  type RequestResult,
  canonicalCommandJson,
  createBlockRng,
  createInitialState,
  executeRequest,
  parseCommand,
  sha256,
  toPlayerView,
  validateState,
} from "@mining/game-engine";
import { type GameDb, GameDbError } from "./db.ts";
import { base64ToBytes, bytesToHex, utf8 } from "./encoding.ts";
import { type ApiErrorCode, type ApiResponse, RETRYABLE } from "./response.ts";

export const MAX_COMMIT_ATTEMPTS = 3;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** request_hash = SHA-256(canonicalCommandJson(command))：同一個 key 對應不同內容時偵測 IDEMPOTENCY_MISMATCH */
export function requestHash(command: GameCommand): string {
  return bytesToHex(sha256(utf8(canonicalCommandJson(command))));
}

export interface HandleResult {
  response: ApiResponse;
  /** true = 回傳的是 action_log 中保存的回應（重送） */
  replayed: boolean;
  /** 實際執行 executeRequest 的次數（CAS 衝突會重試） */
  attempts: number;
  /** 回應是否已保存在 action_log（false 的錯誤可以用同一個 key 重試） */
  stored: boolean;
}

export interface HandleOptions {
  /** 伺服器端紀錄（錯誤細節只寫在這裡，不回傳給 Client） */
  log?: (event: string, detail: Record<string, unknown>) => void;
  maxAttempts?: number;
}

const fail = (requestId: string | null, command: string | null, code: ApiErrorCode, message: string): ApiResponse => ({
  ok: false,
  requestId,
  command,
  error: { code, message },
});

/** 引擎錯誤中屬於「伺服器狀態異常」的：不保存、不回傳細節 */
const SERVER_SIDE: ReadonlySet<GameError["code"]> = new Set(["INVALID_STATE", "RNG_VERSION_MISMATCH", "DATA_VERSION_UNSUPPORTED"]);

function buildResponse(requestId: string, result: RequestResult): ApiResponse {
  const state = result.commit?.state ?? result.state;
  const view = toPlayerView(state);
  if (result.ok) {
    return {
      ok: true,
      requestId,
      command: result.command!,
      stateVersion: state.stateVersion,
      state: view,
      events: result.events,
      settlement: result.settlement,
      report: state.pendingOfflineReport,
    };
  }
  return {
    ok: false,
    requestId,
    command: result.command,
    error: { code: result.error!.code as ApiErrorCode, message: result.error!.message },
    state: view,
    stateVersion: state.stateVersion,
  };
}

/**
 * 處理一個改變狀態的請求。
 *
 * 規則（TECHNICAL_SPEC §10.6）：
 * - 同一個 key + 同一個指令：回傳 action_log 中的回應（不重新計算、不重複入帳）。
 * - 同一個 key + 不同指令：IDEMPOTENCY_MISMATCH（不保存）。
 * - 有狀態變化（commit ≠ null）：狀態、報告與回應在同一個交易提交。
 * - 沒有狀態變化（commit = null）：成功的無變化請求與遊戲規則拒絕都保存回應（committed = false）；
 *   保存前同樣做 CAS，確保回應根據最新狀態計算。
 * - 操作失敗但結算成功（actionApplied = false）：提交結算結果，並保存失敗回應。
 * - VERSION_CONFLICT：以同一個 key 重新載入最新快照與資料庫時間、重新計算，最多 3 次；只會成功提交一次。
 * - 資料庫錯誤 / 伺服器狀態異常：不保存（可用同一個 key 重試），細節只寫伺服器紀錄。
 */
export async function handleGameRequest(
  db: GameDb,
  input: { playerId: string; requestId: unknown; command: unknown },
  options: HandleOptions = {},
): Promise<HandleResult> {
  const log = options.log ?? (() => {});
  const maxAttempts = options.maxAttempts ?? MAX_COMMIT_ATTEMPTS;
  const out = (response: ApiResponse, extra: Partial<HandleResult> = {}): HandleResult => ({
    response,
    replayed: false,
    attempts: 0,
    stored: false,
    ...extra,
  });

  if (!isUuid(input.playerId)) return out(fail(null, null, "INTERNAL_ERROR", "invalid player identity"));
  if (!isUuid(input.requestId)) return out(fail(null, null, "INVALID_REQUEST", "Idempotency-Key must be a UUID"));
  const requestId = input.requestId.toLowerCase();
  const parsed = parseCommand(input.command);
  if (!parsed.ok) return out(fail(requestId, null, "INVALID_REQUEST", parsed.error.message));
  const command = parsed.command;
  const hash = requestHash(command);

  let attempts = 0;
  try {
    while (attempts < maxAttempts) {
      attempts++;
      const snap = await db.loadSnapshot(input.playerId, requestId, hash);
      if (snap.status === "replay") return out(snap.response, { replayed: true, attempts, stored: true });
      if (snap.status === "mismatch") return out(fail(requestId, command.type, "IDEMPOTENCY_MISMATCH", "this Idempotency-Key was used for a different request"), { attempts });
      if (snap.status === "not_found") return out(fail(requestId, command.type, "CHARACTER_NOT_FOUND", "create a character first"), { attempts });

      const result = executeRequest(snap.state as PlayerGameState, { requestId, command }, {
        serverNow: snap.serverNow,
        rng: createBlockRng(base64ToBytes(snap.rngSecret)),
        marketMultiplierPpm: snap.market,
      });
      if (!result.ok && result.error && SERVER_SIDE.has(result.error.code)) {
        log("server_state_error", { playerId: input.playerId, requestId, code: result.error.code, message: result.error.message });
        return out(fail(requestId, command.type, "INTERNAL_ERROR", "server state error"), { attempts });
      }
      if (!result.ok && result.error?.code === "INVALID_TIME") {
        log("server_time_error", { playerId: input.playerId, requestId, message: result.error.message });
        return out(fail(requestId, command.type, "SERVER_BUSY", "try again"), { attempts });
      }

      const response = buildResponse(requestId, result);
      const c = await db.commit({
        playerId: input.playerId,
        expectedVersion: result.expectedStateVersion,
        idempotencyKey: requestId,
        requestHash: hash,
        command: command.type,
        state: result.commit?.state ?? null,
        reportCreated: result.commit?.reportCreated ?? null,
        reportClaimed: result.commit?.reportClaimed ?? null,
        response,
      });
      switch (c.status) {
        case "committed":
        case "recorded":
          return out(response, { attempts, stored: true });
        case "replay": // 同一個 key 並行送出：另一個請求先提交了
          return out(c.response, { replayed: true, attempts, stored: true });
        case "mismatch":
          return out(fail(requestId, command.type, "IDEMPOTENCY_MISMATCH", "this Idempotency-Key was used for a different request"), { attempts });
        case "not_found":
          return out(fail(requestId, command.type, "CHARACTER_NOT_FOUND", "create a character first"), { attempts });
        case "version_conflict":
          log("version_conflict", { playerId: input.playerId, requestId, attempt: attempts, current: c.stateVersion });
          continue;
      }
    }
    return out(fail(requestId, command.type, "VERSION_CONFLICT", "too many concurrent updates; retry with the same Idempotency-Key"), { attempts });
  } catch (e) {
    // 交易失敗 → 已整個 rollback；不保存回應，Client 可以用同一個 key 重試
    log("db_error", { playerId: input.playerId, requestId, attempts, error: e instanceof Error ? e.message : String(e), code: e instanceof GameDbError ? e.code : undefined });
    return out(fail(requestId, command.type, "SERVER_BUSY", "try again"), { attempts });
  }
}

/**
 * 建立角色（TECHNICAL_SPEC §10.2 character-create）。初始狀態由引擎產生，時間與 RNG 密鑰由資料庫決定。
 * 已存在時回傳 CHARACTER_EXISTS 與目前狀態（不覆寫）。
 */
export async function createCharacter(db: GameDb, playerId: string, options: HandleOptions = {}): Promise<ApiResponse> {
  const log = options.log ?? (() => {});
  if (!isUuid(playerId)) return fail(null, "character_create", "INTERNAL_ERROR", "invalid player identity");
  try {
    const r = await db.createPlayer(playerId, createInitialState(playerId, 0));
    if (r.status === "no_auth_user") return fail(null, "character_create", "INTERNAL_ERROR", "unknown user");
    const view = toPlayerView(r.state);
    if (r.status === "exists") {
      return { ok: false, requestId: null, command: "character_create", error: { code: "CHARACTER_EXISTS", message: "character already exists" }, state: view, stateVersion: r.state.stateVersion };
    }
    return { ok: true, requestId: "character_create", command: "character_create", stateVersion: r.state.stateVersion, state: view, events: [], settlement: null, report: null };
  } catch (e) {
    log("db_error", { playerId, op: "create", error: e instanceof Error ? e.message : String(e) });
    return fail(null, "character_create", "SERVER_BUSY", "try again");
  }
}

/** 唯讀查詢目前狀態（不結算、不改變任何資料） */
export async function readState(db: GameDb, playerId: string, options: HandleOptions = {}): Promise<ApiResponse> {
  const log = options.log ?? (() => {});
  if (!isUuid(playerId)) return fail(null, "state", "INTERNAL_ERROR", "invalid player identity");
  try {
    const snap = await db.loadSnapshot(playerId, null, null);
    if (snap.status !== "ok") return fail(null, "state", "CHARACTER_NOT_FOUND", "create a character first");
    // 輸出前先驗證：資料庫中的狀態不符合引擎不變式時，回傳受控的 INTERNAL_ERROR（細節只寫 log）
    const issues = validateState(snap.state);
    if (issues.length > 0) {
      log("server_state_error", { playerId, op: "read", issues: issues.slice(0, 5) });
      return fail(null, "state", "INTERNAL_ERROR", "server state error");
    }
    const state = snap.state as PlayerGameState;
    return { ok: true, requestId: "state", command: "state", stateVersion: state.stateVersion, state: toPlayerView(state), events: [], settlement: null, report: state.pendingOfflineReport };
  } catch (e) {
    log("db_error", { playerId, op: "read", error: e instanceof Error ? e.message : String(e) });
    return fail(null, "state", "SERVER_BUSY", "try again");
  }
}

export { RETRYABLE };
