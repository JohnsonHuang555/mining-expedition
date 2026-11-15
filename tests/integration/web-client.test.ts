/**
 * apps/web 的 API Client 與同步控制器（GameController）直接對真正的 Supabase Local：
 * 真正的 Auth（註冊 / 登入 / Session 恢復 / 登出後 token 失效）、Edge Functions、資料庫。
 * 瀏覽器端的完整流程另見 tests/e2e（Playwright）。
 */
import { randomUUID } from "node:crypto";
import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { createGameApi, newRequestId } from "../../apps/web/src/lib/game/api.ts";
import { GameController, type SyncChannel } from "../../apps/web/src/lib/game/controller.ts";
import { memoryPendingStore, type PendingStore } from "../../apps/web/src/lib/game/pending.ts";
import { createGameStore } from "../../apps/web/src/lib/game/store.ts";
import { PASSWORD, env, pool } from "./src/backend.ts";

const HOUR = 3_600_000;

/** 瀏覽器 localStorage 的替代品：同一個 storage = 同一個瀏覽器 */
function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

function browser(storage = memoryStorage()): SupabaseClient {
  return createClient(env.apiUrl, env.anonKey, { auth: { persistSession: true, autoRefreshToken: false, storage, storageKey: "sb-test" } });
}

function tab(supabase: SupabaseClient, channel: SyncChannel | null = null, opts: { pendingStore?: PendingStore; fetch?: typeof fetch } = {}) {
  const store = createGameStore();
  const out = { signedOut: 0 };
  const api = createGameApi({
    functionsUrl: env.functionsUrl,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    anonKey: env.anonKey,
    getAccessToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
    refreshAccessToken: async () => {
      const { data, error } = await supabase.auth.refreshSession();
      return error ? null : (data.session?.access_token ?? null);
    },
    retryDelaysMs: [200, 400],
  });
  const controller = new GameController({ api, store, channel, pendingStore: opts.pendingStore, onSignedOut: () => void out.signedOut++ });
  return { api, store, controller, out };
}

async function signUp(): Promise<{ supabase: SupabaseClient; email: string; userId: string; storage: ReturnType<typeof memoryStorage> }> {
  const storage = memoryStorage();
  const supabase = browser(storage);
  const email = `web-${randomUUID()}@example.test`;
  const { data, error } = await supabase.auth.signUp({ email, password: PASSWORD });
  if (error || !data.session || !data.user) throw new Error(`signUp: ${error?.message ?? "no session (email confirmation enabled?)"}`);
  return { supabase, email, userId: data.user.id, storage };
}

async function rewind(id: string, ms: number) {
  await pool.query(`update public.players set created_at_ms = created_at_ms - $2, last_settled_at_ms = last_settled_at_ms - $2 where id = $1`, [id, ms]);
}

afterAll(async () => pool.end());

describe("Web Client × 真實 Supabase Local", () => {
  it("註冊 → 沒有角色 → 建立角色 → 進入遊戲（初始狀態正確）", async () => {
    const u = await signUp();
    const t = tab(u.supabase);
    await t.controller.bootstrap();
    expect(t.store.getState().phase).toBe("no_character");
    expect(await t.controller.createCharacter()).toBe(true);
    const s = t.store.getState();
    expect(s.phase).toBe("ready");
    expect(s.view!.state).toMatchObject({ playerId: u.userId, coins: 0, equippedPickaxe: "pick_wood", pickaxes: { pick_wood: 1 }, unlockedZone: 0 });
    expect(s.view!.status).toBe("mining");
    // 已存在：再建立一次仍然進入遊戲（409 CHARACTER_EXISTS）
    const t2 = tab(u.supabase);
    expect(await t2.controller.createCharacter()).toBe(true);
    expect(t2.store.getState().view!.state.playerId).toBe(u.userId);
  });

  it("Session 恢復：同一個瀏覽器（storage）重新開啟，不需要再登入就能讀到同一個角色", async () => {
    const u = await signUp();
    await tab(u.supabase).controller.createCharacter();
    const reopened = browser(u.storage);
    expect((await reopened.auth.getSession()).data.session?.user.id).toBe(u.userId);
    const t = tab(reopened);
    await t.controller.bootstrap();
    expect(t.store.getState().view!.state.playerId).toBe(u.userId);
  });

  it("登出（token 失效）→ API 401 → 更新失敗 → signed_out；重新登入後狀態相同", async () => {
    const u = await signUp();
    const t = tab(u.supabase);
    await t.controller.createCharacter();
    const before = t.store.getState().view!.state;
    // 從「另一個裝置」把所有 session 登出：這個瀏覽器保存的 access / refresh token 都失效
    const other = browser();
    await other.auth.signInWithPassword({ email: u.email, password: PASSWORD });
    await other.auth.signOut({ scope: "global" });
    await t.controller.sync();
    expect(t.store.getState().phase).toBe("signed_out");
    expect(t.out.signedOut).toBe(1);
    // 重新登入
    const again = browser();
    await again.auth.signInWithPassword({ email: u.email, password: PASSWORD });
    const t2 = tab(again);
    await t2.controller.bootstrap();
    expect(t2.store.getState().view!.state.playerId).toBe(u.userId);
    expect(t2.store.getState().view!.state.coins).toBeGreaterThanOrEqual(before.coins);
  });

  it("同一個 Idempotency-Key 重試：回應相同（Idempotent-Replayed），只套用一次", async () => {
    const u = await signUp();
    const t = tab(u.supabase);
    await t.controller.createCharacter();
    const key = newRequestId();
    const a = await t.api.action({ type: "select_mining_mode", mode: "frontier" }, key);
    const b = await t.api.action({ type: "select_mining_mode", mode: "frontier" }, key);
    expect(a).toMatchObject({ ok: true, replayed: false });
    expect(b).toMatchObject({ ok: true, replayed: true });
    expect(b.ok && b.body).toEqual(a.ok && a.body);
  });

  it("離線報告：登入後出現待領報告；一般操作被阻擋；領取後更新；另一個分頁重複領取可恢復", async () => {
    const u = await signUp();
    const a = tab(u.supabase);
    await a.controller.createCharacter();
    await rewind(u.userId, 3 * HOUR);
    await a.controller.retryBootstrap();
    const report = a.store.getState().view!.state.pendingOfflineReport!;
    expect(report.blocksMined).toBeGreaterThan(0);
    expect(await a.controller.selectMode("rework")).toBe(false);
    expect(a.store.getState().notice).toBe("請先領取探險報告");

    const b = tab(browser(u.storage));
    await b.controller.bootstrap();
    expect(await b.controller.claimReport()).toBe(true);
    expect(b.store.getState().view!.state.coins).toBe(report.rewards.coins);

    expect(await a.controller.claimReport()).toBe(false); // REPORT_ALREADY_CLAIMED
    expect(a.store.getState().view!.state.pendingOfflineReport).toBeNull();
    expect(a.store.getState().view!.state.coins).toBe(report.rewards.coins);
  });

  it("D23：卡關期間離線沒有完成方塊 → 沒有報告", async () => {
    const u = await signUp();
    const t = tab(u.supabase);
    await t.controller.createCharacter();
    // 木製十字鎬（Power 2.0）在 50 m 卡關（門檻段 1 需要 Power 4.0）
    await pool.query(`update public.players set frontier_block_index = 500, dig_counter = 500 where id = $1`, [u.userId]);
    await rewind(u.userId, 6 * HOUR);
    await t.controller.retryBootstrap();
    const s = t.store.getState();
    expect(s.view!.state.pendingOfflineReport).toBeNull();
    expect(s.view!.status).toBe("blocked_power");
  });

  it("多分頁：一個分頁提交後，另一個分頁重新取得伺服器狀態", async () => {
    const subs = new Set<(v: number) => void>();
    const channel = (): SyncChannel => {
      const mine = new Set<(v: number) => void>();
      return {
        post: (v) => subs.forEach((s) => !mine.has(s) && s(v)),
        subscribe: (fn) => (subs.add(fn), mine.add(fn), () => subs.delete(fn)),
        close: () => mine.forEach((fn) => subs.delete(fn)),
      };
    };
    const u = await signUp();
    const a = tab(u.supabase, channel());
    await a.controller.createCharacter();
    const b = tab(browser(u.storage), channel());
    await b.controller.bootstrap();
    b.controller.start();
    a.controller.start();
    const vB = b.store.getState().view!.state.stateVersion;
    await new Promise((r) => setTimeout(r, 1_100));
    await a.controller.sync();
    await expect.poll(() => b.store.getState().view!.state.stateVersion, { timeout: 5_000 }).toBeGreaterThan(vB);
    a.controller.dispose();
    b.controller.dispose();
  });

  it("已提交但回應全部遺失 → 未確認；重新整理後以同一個 Request ID 調和，只扣款一次（真實 action_log）", async () => {
    const u = await signUp();
    await tab(u.supabase).controller.createCharacter();
    await pool.query(`update public.players set coins = 1000 where id = $1`, [u.userId]);
    await pool.query(`insert into public.player_inventory values ($1, 'stone', 200)`, [u.userId]);
    const storage = memoryPendingStore();
    // 伺服器收到並提交，但回應在網路上遺失（含 API Client 的自動重試）
    let drops = 0;
    const lossy: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (String(input).endsWith("/game-action") && String(init?.body).includes("purchase_pickaxe")) {
        drops++;
        throw new TypeError("response lost");
      }
      return res;
    };
    const a = tab(u.supabase, null, { pendingStore: storage, fetch: lossy });
    await a.controller.bootstrap();
    expect(await a.controller.perform({ type: "purchase_pickaxe", pickaxeId: "pick_stone" })).toBe("uncertain");
    expect(drops).toBe(3);
    const key = storage.value!.requestId;
    const committed = await pool.query(`select count(*)::int as n from public.action_log where player_id = $1 and idempotency_key = $2`, [u.userId, key]);
    expect(committed.rows[0].n).toBe(1);
    const coinsAfter = (await pool.query(`select coins from public.players where id = $1`, [u.userId])).rows[0].coins;
    a.controller.dispose();

    // 重新整理：新的 Controller 從 storage 恢復未確認操作並調和
    const b = tab(browser(u.storage), null, { pendingStore: storage });
    await b.controller.bootstrap();
    expect(b.store.getState().pending).toBeNull();
    expect(b.store.getState().view!.state.pickaxes).toMatchObject({ pick_wood: 1, pick_stone: 1 });
    expect((await pool.query(`select coins from public.players where id = $1`, [u.userId])).rows[0].coins).toBe(coinsAfter);
    const purchases = await pool.query(`select count(*)::int as n from public.action_log where player_id = $1 and command = 'purchase_pickaxe'`, [u.userId]);
    expect(purchases.rows[0].n).toBe(1);
  });
});
