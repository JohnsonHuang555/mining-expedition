/**
 * 遊戲 API Client（Edge Functions：character-create / game-state / game-action，TECHNICAL_SPEC §10）。
 *
 * - 純 TypeScript，不依賴 React / Next.js：瀏覽器與 Node 整合測試共用同一份程式碼。
 * - 身分只由 Authorization: Bearer <access token> 決定；不傳任何 playerId。
 * - 同一個操作的所有重試都使用同一個 Idempotency-Key（呼叫端傳入，見 newRequestId）；冪等由伺服器的 action_log 保證。
 * - 401：先更新一次 token 再用同一個 key 重送；仍然 401 時呼叫 onUnauthorized 並回傳 auth 錯誤。
 * - 網路錯誤、逾時、503 / 502 / 504、VERSION_CONFLICT / SERVER_BUSY：以同一個 key 退避重試。
 *   逾時的請求可能已經提交；以同一個 key 重送會拿到伺服器保存的同一個回應，不會重複套用。
 */

import type { GameCommand } from "@mining/game-engine";
import type { ApiErrorCode, ApiResponse } from "@mining/game-server";
import { apiResponseIssue } from "./validate";

export type OkResponse = Extract<ApiResponse, { ok: true }>;
export type ErrResponse = Extract<ApiResponse, { ok: false }>;

export type ClientErrorCode = ApiErrorCode | "UNAUTHORIZED" | "NETWORK" | "BAD_RESPONSE";

export type ApiResult =
  | { ok: true; status: number; body: OkResponse; replayed: boolean }
  | { ok: false; status: number | null; code: ClientErrorCode; message: string; body: ErrResponse | null };

export interface GameApiOptions {
  /** `${SUPABASE_URL}/functions/v1` */
  functionsUrl: string;
  anonKey: string;
  /** 目前的 access token（必要時由 Supabase client 自動更新）；未登入回傳 null */
  getAccessToken(): Promise<string | null>;
  /** 強制更新 token（收到 401 時呼叫一次）；失敗回傳 null */
  refreshAccessToken(): Promise<string | null>;
  /** 更新後仍然 401：登入已失效 */
  onUnauthorized?(): void;
  fetch?: typeof fetch;
  sleep?(ms: number): Promise<void>;
  /** 每次請求的逾時（毫秒） */
  timeoutMs?: number;
  /** 退避間隔；長度 = 最多重試次數 */
  retryDelaysMs?: readonly number[];
}

const RETRYABLE_CODES = new Set<ClientErrorCode>(["NETWORK", "SERVER_BUSY", "VERSION_CONFLICT"]);
const RETRYABLE_STATUS = new Set([502, 503, 504]);

/** 新的獨立操作使用新的 UUID；同一個操作的重試沿用 */
export function newRequestId(): string {
  return crypto.randomUUID();
}

export interface GameApi {
  getState(): Promise<ApiResult>;
  createCharacter(): Promise<ApiResult>;
  action(command: GameCommand, requestId: string): Promise<ApiResult>;
}

export function createGameApi(opts: GameApiOptions): GameApi {
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const delays = opts.retryDelaysMs ?? [500, 1_500, 3_500];
  const timeoutMs = opts.timeoutMs ?? 15_000;

  async function once(fn: string, method: string, token: string, body: unknown, key: string | null): Promise<ApiResult> {
    const headers: Record<string, string> = { apikey: opts.anonKey, Authorization: `Bearer ${token}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (key) headers["Idempotency-Key"] = key;
    let res: Response;
    try {
      res = await doFetch(`${opts.functionsUrl}/${fn}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { ok: false, status: null, code: "NETWORK", message: "network error", body: null };
    }
    let raw: unknown = null;
    try {
      raw = await res.json();
    } catch {
      raw = null;
    }
    if (res.status === 401) return { ok: false, status: 401, code: "UNAUTHORIZED", message: "sign in required", body: null };
    // 寫入 store 前驗證結構：不合法 → BAD_RESPONSE（結果不確定，交由呼叫端重試 / 調和），不讓畫面解構 undefined
    const issue = apiResponseIssue(raw);
    if (issue !== null) {
      if (RETRYABLE_STATUS.has(res.status)) return { ok: false, status: res.status, code: "SERVER_BUSY", message: `unexpected response (${res.status})`, body: null };
      return { ok: false, status: res.status, code: "BAD_RESPONSE", message: `invalid response: ${issue}`, body: null };
    }
    const parsed = raw as ApiResponse;
    // 成功狀態碼與 ok 必須一致（例如 200 + ok:false 或 4xx + ok:true 都視為不合法）
    if (parsed.ok !== (res.status >= 200 && res.status < 300)) {
      return { ok: false, status: res.status, code: "BAD_RESPONSE", message: `status ${res.status} does not match ok=${parsed.ok}`, body: null };
    }
    if (parsed.ok) return { ok: true, status: res.status, body: parsed, replayed: res.headers.get("Idempotent-Replayed") === "true" };
    return { ok: false, status: res.status, code: parsed.error.code, message: parsed.error.message, body: parsed };
  }

  async function request(fn: string, method: string, body: unknown, key: string | null): Promise<ApiResult> {
    let token = await opts.getAccessToken();
    if (!token) {
      opts.onUnauthorized?.();
      return { ok: false, status: null, code: "UNAUTHORIZED", message: "sign in required", body: null };
    }
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const r = await once(fn, method, token, body, key);
      if (!r.ok && r.code === "UNAUTHORIZED") {
        const next = refreshed ? null : await opts.refreshAccessToken();
        refreshed = true;
        if (!next) {
          opts.onUnauthorized?.();
          return r;
        }
        token = next;
        attempt--; // 更新 token 不算一次重試
        continue;
      }
      // 只有帶 Idempotency-Key 的請求（或唯讀請求）才自動重試
      const retryable = !r.ok && RETRYABLE_CODES.has(r.code) && (key !== null || method === "GET");
      if (!retryable || attempt >= delays.length) return r;
      await sleep(delays[attempt]!);
    }
  }

  return {
    getState: () => request("game-state", "GET", undefined, null),
    // 建立角色本身是冪等的（已存在 → 409 CHARACTER_EXISTS），所以網路錯誤時可以安全重送
    createCharacter: async () => {
      for (let attempt = 0; ; attempt++) {
        const r = await request("character-create", "POST", {}, null);
        if (r.ok || !RETRYABLE_CODES.has(r.code) || attempt >= delays.length) return r;
        await sleep(delays[attempt]!);
      }
    },
    action: (command, requestId) => request("game-action", "POST", { command }, requestId),
  };
}
