/**
 * 每位登入使用者一組 { API Client, Store, Controller }（模組層級單例：React Strict Mode 重複掛載也不會重複建立）。
 * 換使用者或登出時丟棄舊的一組，不會把上一位玩家的狀態帶到下一位。
 */

import { getSupabase, publicSupabaseEnv } from "../auth/supabase";
import { type GameApi, createGameApi } from "./api";
import { GameController } from "./controller";
import { type GameStore, createGameStore } from "./store";

export interface GameRuntime {
  userId: string;
  api: GameApi;
  store: GameStore;
  controller: GameController;
}

let current: GameRuntime | null = null;

export function gameRuntime(userId: string, onSignedOut: () => void): GameRuntime | null {
  if (current?.userId === userId) return current;
  current?.controller.dispose();
  current = null;
  const supabase = getSupabase();
  const env = publicSupabaseEnv();
  if (!supabase || !env) return null;
  const api = createGameApi({
    functionsUrl: `${env.url}/functions/v1`,
    anonKey: env.anonKey,
    // getSession 在 token 即將到期時會先更新
    getAccessToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
    refreshAccessToken: async () => {
      const { data, error } = await supabase.auth.refreshSession();
      return error ? null : (data.session?.access_token ?? null);
    },
    onUnauthorized: () => void supabase.auth.signOut({ scope: "local" }),
  });
  const store = createGameStore();
  const controller = new GameController({
    api,
    store,
    onSignedOut,
    isVisible: () => typeof document === "undefined" || document.visibilityState === "visible",
  });
  current = { userId, api, store, controller };
  return current;
}

export function disposeGameRuntime(): void {
  current?.controller.dispose();
  current = null;
}
