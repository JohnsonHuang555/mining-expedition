/**
 * 每位登入使用者一組 { API Client, Store, Controller }。
 *
 * 生命週期（不在 render 中產生副作用）：
 * - 只在 effect 中呼叫 acquireRuntime / releaseRuntime（見 useGameRuntime）。
 * - 以參考計數管理；最後一個使用者 release 後「延後」到下一個 macrotask 才 dispose：
 *   React Strict Mode 的 mount → unmount → mount 會在 dispose 前重新 acquire，沿用同一組（不會重複 bootstrap）。
 * - 換帳號：舊使用者的 runtime 被 release → dispose（不再寫入 store、關閉 BroadcastChannel、清除計時器）；
 *   新使用者取得全新的 store。舊請求晚到也只會被丟棄。
 * - 未確認操作依 userId 保存在 localStorage，換帳號不會混用。
 */

import { getSupabase, publicSupabaseEnv } from "../auth/supabase";
import { type GameApi, createGameApi } from "./api";
import { GameController } from "./controller";
import { browserPendingStore } from "./pending";
import { type GameStore, createGameStore } from "./store";

export interface GameRuntime {
  userId: string;
  api: GameApi;
  store: GameStore;
  controller: GameController;
}

export type RuntimeFactory = (userId: string, onSignedOut: () => void) => GameRuntime | null;

interface Entry {
  runtime: GameRuntime;
  refs: number;
  disposeTimer: ReturnType<typeof setTimeout> | null;
  onSignedOut: Set<() => void>;
}

const entries = new Map<string, Entry>();

export const browserRuntimeFactory: RuntimeFactory = (userId, onSignedOut) => {
  const supabase = getSupabase();
  const env = publicSupabaseEnv();
  if (!supabase || !env) return null;
  const api = createGameApi({
    functionsUrl: `${env.url}/functions/v1`,
    anonKey: env.anonKey,
    // getSession 在 token 即將到期時會先更新
    getAccessToken: async () => {
      const s = (await supabase.auth.getSession()).data.session;
      // 換帳號後舊 runtime 的請求不得帶著新使用者的 token 送出
      return s && s.user.id === userId ? s.access_token : null;
    },
    refreshAccessToken: async () => {
      const { data, error } = await supabase.auth.refreshSession();
      return error || data.session?.user.id !== userId ? null : (data.session?.access_token ?? null);
    },
    onUnauthorized: () => void supabase.auth.signOut({ scope: "local" }),
  });
  const store = createGameStore();
  const controller = new GameController({
    api,
    store,
    pendingStore: browserPendingStore(userId),
    onSignedOut,
    isVisible: () => typeof document === "undefined" || document.visibilityState === "visible",
  });
  return { userId, api, store, controller };
};

/** 取得（必要時建立）這位使用者的 runtime；必須與 releaseRuntime 成對呼叫 */
export function acquireRuntime(userId: string, onSignedOut: () => void, factory: RuntimeFactory = browserRuntimeFactory): GameRuntime | null {
  // 同時只保留一位使用者：其他使用者的 runtime 立即 dispose
  for (const [id, e] of entries) {
    if (id !== userId) disposeEntry(id, e);
  }
  let e = entries.get(userId);
  if (!e) {
    const listeners = new Set<() => void>();
    const runtime = factory(userId, () => listeners.forEach((fn) => fn()));
    if (!runtime) return null;
    e = { runtime, refs: 0, disposeTimer: null, onSignedOut: listeners };
    entries.set(userId, e);
  }
  if (e.disposeTimer !== null) {
    clearTimeout(e.disposeTimer);
    e.disposeTimer = null;
  }
  e.refs++;
  e.onSignedOut.add(onSignedOut);
  return e.runtime;
}

export function releaseRuntime(runtime: GameRuntime, onSignedOut?: () => void): void {
  const e = entries.get(runtime.userId);
  if (!e || e.runtime !== runtime) return;
  e.refs = Math.max(0, e.refs - 1);
  if (onSignedOut) e.onSignedOut.delete(onSignedOut);
  if (e.refs === 0 && e.disposeTimer === null) {
    e.disposeTimer = setTimeout(() => {
      if (e.refs === 0) disposeEntry(runtime.userId, e);
    }, 0);
  }
}

function disposeEntry(userId: string, e: Entry): void {
  if (e.disposeTimer !== null) clearTimeout(e.disposeTimer);
  e.runtime.controller.dispose();
  entries.delete(userId);
}

/** 登出時：立即丟棄所有 runtime */
export function disposeAllRuntimes(): void {
  for (const [id, e] of entries) disposeEntry(id, e);
}

/** 測試用 */
export function activeRuntimeCount(): number {
  return entries.size;
}
