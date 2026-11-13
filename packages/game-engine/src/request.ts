/**
 * 請求入口（TECHNICAL_SPEC §10.1、§10.4、§10.6）：Edge Function 只需要
 *   1. 載入狀態快照與 serverNow（load_player_snapshot）
 *   2. executeRequest(...)
 *   3. 若 result.commit 非 null：以 expectedStateVersion 做 CAS 提交（commit_player_state）
 *
 * 規則：
 * - 每個操作都先結算到 serverNow，再執行操作（「購買」發生在確定的時間點）。
 * - 領取報告不先結算（有待領取報告時不能結算，D20）。
 * - 操作失敗時操作本身不產生任何效果；但若先前的結算有變化（例如剛產生離線報告），
 *   結算結果仍可提交（`commit.actionApplied = false`），否則報告會在下一次請求才出現。
 * - stateVersion 只在這裡改變：每次提交 +1。
 */

import { type ActionContext, type GameAction, applyAction, parseAction } from "./actions.ts";
import { type GameError, gameError } from "./errors.ts";
import type { GameEvent } from "./events.ts";
import { type SettleContext, type SettleSummary, checkLoadedState, settle } from "./settle.ts";
import type { OfflineReport, PlayerGameState } from "./state.ts";

export type GameCommand = GameAction | { type: "settle" };

export interface GameRequest {
  /** Idempotency-Key（Client 產生的 uuid；重試沿用同一個）。純函式不去重，由 action_log 處理 */
  requestId: string;
  command: GameCommand;
}

export interface RequestContext extends SettleContext, Omit<ActionContext, "serverNow"> {}

export interface CommitPlan {
  /** 要寫入的新狀態；stateVersion = expectedStateVersion + 1 */
  state: PlayerGameState;
  /** 這次提交新產生的離線報告（寫入 offline_reports，status = pending） */
  reportCreated: OfflineReport | null;
  /** 這次提交領取的報告（同一交易內 pending → claimed） */
  reportClaimed: string | null;
  /** false = 只有結算結果，操作被拒絕 */
  actionApplied: boolean;
}

export interface RequestResult {
  ok: boolean;
  requestId: string;
  command: GameCommand["type"] | null;
  error: GameError | null;
  /** CAS 條件：資料庫中的 stateVersion 必須等於這個值才能提交 */
  expectedStateVersion: number;
  /** null = 不需要寫入（沒有任何變化，或請求無效） */
  commit: CommitPlan | null;
  /** 回傳給玩家的狀態：有提交時為新狀態，否則為原狀態 */
  state: PlayerGameState;
  events: GameEvent[];
  settlement: SettleSummary | null;
}

export const MAX_REQUEST_ID_LENGTH = 128;

/** 解析 Client 的指令（不信任任何欄位） */
export function parseCommand(raw: unknown): { ok: true; command: GameCommand } | { ok: false; error: GameError } {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw) && (raw as { type?: unknown }).type === "settle") {
    if (Object.keys(raw).length !== 1) return { ok: false, error: gameError("INVALID_REQUEST", "settle takes no parameters") };
    return { ok: true, command: { type: "settle" } };
  }
  const p = parseAction(raw);
  return p.ok ? { ok: true, command: p.action } : p;
}

/** 動作請求的標準化 JSON（Integration 階段計算 request_hash，偵測同一 key 不同內容：IDEMPOTENCY_MISMATCH） */
export function canonicalCommandJson(command: GameCommand): string {
  const sortKeys = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(sortKeys(command));
}

export function executeRequest(input: PlayerGameState, request: GameRequest, ctx: RequestContext): RequestResult {
  const loadErr = checkLoadedState(input); // 不可信的快照：先驗證，任何結構錯誤都回傳 INVALID_STATE
  const malformed = loadErr?.code === "INVALID_STATE";
  const expectedStateVersion = malformed ? -1 : input.stateVersion;
  const base = { requestId: request?.requestId, expectedStateVersion, state: input, events: [] as GameEvent[], settlement: null };
  const reject = (error: GameError, command: GameCommand["type"] | null = null): RequestResult => ({ ...base, ok: false, command, error, commit: null });
  if (malformed) return reject(loadErr!);

  if (typeof request?.requestId !== "string" || request.requestId.length === 0 || request.requestId.length > MAX_REQUEST_ID_LENGTH) {
    return reject(gameError("INVALID_REQUEST", "requestId must be a non-empty string"));
  }
  const parsed = parseCommand(request.command);
  if (!parsed.ok) return reject(parsed.error);
  const command = parsed.command;
  const withVersion = (s: PlayerGameState): PlayerGameState => ({ ...s, stateVersion: input.stateVersion + 1 });

  // 領取報告：不先結算
  if (command.type === "claim_report") {
    const r = applyAction(input, command, ctx);
    if (!r.ok) return reject(r.error, command.type);
    const state = withVersion(r.state);
    return {
      ...base,
      ok: true,
      command: command.type,
      error: null,
      commit: { state, reportCreated: null, reportClaimed: command.reportId, actionApplied: true },
      state,
      events: r.events,
    };
  }

  // 其他：先結算到現在
  const s = settle(input, ctx);
  if (!s.ok) return reject(s.error, command.type);
  const settled = s.state;
  const settleCommit = (actionApplied: boolean): CommitPlan | null =>
    s.changed ? { state: withVersion(settled), reportCreated: s.report, reportClaimed: null, actionApplied } : null;

  if (command.type === "settle") {
    const commit = settleCommit(true);
    return { ...base, ok: true, command: "settle", error: null, commit, state: commit?.state ?? input, events: s.events, settlement: s.summary };
  }

  const a = applyAction(settled, command, ctx);
  if (!a.ok) {
    const commit = settleCommit(false);
    return { ...base, ok: false, command: command.type, error: a.error, commit, state: commit?.state ?? input, events: s.events, settlement: s.summary };
  }
  const changed = s.changed || a.changed;
  const state = changed ? withVersion(a.state) : input;
  return {
    ...base,
    ok: true,
    command: command.type,
    error: null,
    commit: changed ? { state, reportCreated: s.report, reportClaimed: null, actionApplied: true } : null,
    state,
    events: [...s.events, ...a.events],
    settlement: s.summary,
  };
}
