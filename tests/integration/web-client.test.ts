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
import { type ActionLock, memoryActionLock, memoryPendingStore, type PendingStore } from "../../apps/web/src/lib/game/pending.ts";
import { createGameStore } from "../../apps/web/src/lib/game/store.ts";
import { collectionEntries, collectionProgress, setRows } from "../../apps/web/src/lib/game/collection.ts";
import { computeStats, heldCounts } from "@mining/game-engine";
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

function tab(supabase: SupabaseClient, channel: SyncChannel | null = null, opts: { pendingStore?: PendingStore; fetch?: typeof fetch; actionLock?: ActionLock } = {}) {
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
  const controller = new GameController({ api, store, channel, pendingStore: opts.pendingStore, actionLock: opts.actionLock, onSignedOut: () => void out.signedOut++ });
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
    const key = storage.list()[0]!.requestId;
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

  it("經濟循環（真實 Edge Functions）：挖礦 → 出售 → 購買 → 製作 → 強化 → 裝備 → 成長有效；重新登入後一致", async () => {
    const u = await signUp();
    const t = tab(u.supabase);
    await t.controller.createCharacter();
    await rewind(u.userId, 4 * HOUR);
    await t.controller.retryBootstrap();
    expect(await t.controller.claimReport()).toBe(true);
    const s0 = t.store.getState().view!.state;
    expect(s0.inventory.stone ?? 0).toBeGreaterThan(150);
    expect(s0.inventory.iron_ore ?? 0).toBeGreaterThan(10);

    // 出售：金額由伺服器決定（石頭固定 1 金幣）
    expect(await t.controller.perform({ type: "sell_items", itemId: "stone", quantity: 50 })).toBe("ok");
    const sold = t.store.getState().lastAction!.events.find((e) => e.type === "items_sold");
    expect(sold).toMatchObject({ itemId: "stone", quantity: 50, coins: 50 });

    // 購買（自動裝備）→ 製作強化石 → 強化
    expect(await t.controller.perform({ type: "purchase_pickaxe", pickaxeId: "pick_stone" })).toBe("ok");
    expect(t.store.getState().view!.state.equippedPickaxe).toBe("pick_stone");
    expect(await t.controller.perform({ type: "craft", materialId: "reinforce_stone", times: 1 })).toBe("ok");
    expect(t.store.getState().view!.state.inventory.reinforce_stone).toBe(1);
    expect(await t.controller.perform({ type: "upgrade_pickaxe", pickaxeId: "pick_stone" })).toBe("ok");
    expect(t.store.getState().view!.state.pickaxes.pick_stone).toBe(2);
    expect(t.store.getState().view!.stats.power10).toBe(55);

    // 裝備切換：能力值跟著改變
    expect(await t.controller.perform({ type: "equip_pickaxe", pickaxeId: "pick_wood" })).toBe("ok");
    expect(t.store.getState().view!.stats.power10).toBe(20);
    expect(await t.controller.perform({ type: "equip_pickaxe", pickaxeId: "pick_stone" })).toBe("ok");

    // 不合法的操作由伺服器拒絕，畫面數值不變
    const before = t.store.getState().view!.state;
    expect(await t.controller.perform({ type: "purchase_pickaxe", pickaxeId: "pick_gold" })).toBe("rejected");
    expect(await t.controller.perform({ type: "craft", materialId: "refined_crystal", times: 999 })).toBe("rejected");
    expect(t.store.getState().view!.state.coins).toBe(before.coins);

    // 成長有效：木製十字鎬在 50 m 卡關（Power 2.0 < 4.0），石製 Lv2（5.5）可以繼續挖
    await pool.query(`update public.players set frontier_block_index = 500, dig_counter = dig_counter + 500 - frontier_block_index, block_work = 0, block_ms = 0 where id = $1`, [u.userId]);
    await t.controller.retryBootstrap();
    expect(t.store.getState().view!.status).toBe("mining");
    await new Promise((r) => setTimeout(r, 4_000)); // Hardness 較高的方塊：等一段時間後同步
    await t.controller.sync();
    expect(t.store.getState().view!.state.mining.blockWork + t.store.getState().view!.state.mining.frontierBlockIndex).toBeGreaterThan(500);

    // 重新登入：伺服器狀態一致
    const again = browser();
    await again.auth.signInWithPassword({ email: u.email, password: PASSWORD });
    const t2 = tab(again);
    await t2.controller.bootstrap();
    const s1 = t2.store.getState().view!.state;
    expect(s1.pickaxes).toMatchObject({ pick_wood: 1, pick_stone: 2 });
    expect(s1.equippedPickaxe).toBe("pick_stone");
    const db = await pool.query(`select coins from public.players where id = $1`, [u.userId]);
    expect(String(s1.coins)).toBe(String(db.rows[0].coins));
  });

  it("同帳號兩個分頁同時不同交易（A 出售的回應遺失、B 購買）：A 的紀錄不被覆蓋，兩筆在 action_log 各只有一次", async () => {
    const u = await signUp();
    await tab(u.supabase).controller.createCharacter();
    await pool.query(`update public.players set coins = 1000 where id = $1`, [u.userId]);
    await pool.query(`insert into public.player_inventory values ($1, 'stone', 200)`, [u.userId]);
    const storage = memoryPendingStore(); // 兩個分頁共用的 localStorage
    const lock = memoryActionLock(); // 兩個分頁共用的 Web Locks
    const lossy: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (String(init?.body).includes("sell_items")) throw new TypeError("response lost");
      return res;
    };
    const a = tab(u.supabase, null, { pendingStore: storage, actionLock: lock, fetch: lossy });
    const b = tab(browser(u.storage), null, { pendingStore: storage, actionLock: lock });
    await a.controller.bootstrap();
    await b.controller.bootstrap();
    const [oa, ob] = await Promise.all([
      a.controller.perform({ type: "sell_items", itemId: "stone", quantity: 10 }),
      b.controller.perform({ type: "purchase_pickaxe", pickaxeId: "pick_stone" }),
    ]);
    expect(oa).toBe("uncertain");
    expect(ob).toBe("ok"); // B 先以 A 的 Request ID 確認了出售，再購買
    expect(storage.list()).toEqual([]);
    const log = await pool.query(`select command, count(*)::int as n from public.action_log where player_id = $1 and command in ('sell_items', 'purchase_pickaxe') group by command order by command`, [u.userId]);
    expect(log.rows).toEqual([
      { command: "purchase_pickaxe", n: 1 },
      { command: "sell_items", n: 1 },
    ]);
    // A 重新整理：沒有剩下的未確認交易，不會再送出
    const a2 = tab(browser(u.storage), null, { pendingStore: storage, actionLock: lock });
    await a2.controller.bootstrap();
    expect(a2.store.getState().pendingCount).toBe(0);
    expect(a2.store.getState().view!.state.pickaxes).toMatchObject({ pick_stone: 1 });
  });

  it("圖鑑與套組（真實資料庫）：挖到寶物 → 圖鑑 → 集齊套組 → 伺服器能力值含加成 → 出售一件 → 加成失效、圖鑑保留；重新登入一致", async () => {
    const u = await signUp();
    const t = tab(u.supabase);
    await t.controller.createCharacter();
    // 1. 挖礦取得寶物：離線 5 小時，有效挖掘超過 4 小時 → 首次寶物保護保證至少一件（D18）
    await rewind(u.userId, 5 * HOUR);
    await t.controller.retryBootstrap();
    const report = t.store.getState().view!.state.pendingOfflineReport!;
    expect(report.rewards.artifacts.length).toBeGreaterThan(0);
    // 領取前：寶物還不是正式持有，圖鑑也還沒更新
    expect(t.store.getState().view!.state.heldArtifacts).toHaveLength(0);
    expect(collectionProgress(collectionEntries(t.store.getState().view!.state)).overall.found).toBe(0);
    expect(await t.controller.claimReport()).toBe(true);
    const s1 = t.store.getState().view!.state;
    expect(s1.heldArtifacts.length).toBe(report.rewards.artifacts.length);
    const db1 = await pool.query(`select artifact_id, total_found from public.artifact_discoveries where player_id = $1 order by artifact_id`, [u.userId]);
    const fromView = collectionEntries(s1)
      .filter((e) => e.discovery)
      .map((e) => ({ artifact_id: e.id, total_found: String(e.discovery!.totalFound) }))
      .sort((a, b) => a.artifact_id.localeCompare(b.artifact_id));
    expect(db1.rows.map((r) => ({ artifact_id: r.artifact_id, total_found: String(r.total_found) }))).toEqual(fromView);

    // 2. 取得老礦工套組的其餘成員（測試準備：寫入資料庫，與正常掉落相同的資料列）
    const held = new Set(s1.heldArtifacts.map((a) => a.artifactId));
    const missing = ["a_z1_lantern", "a_z1_badge", "a_z1_map"].filter((a) => !held.has(a as never));
    const base = Number((await pool.query(`update public.players set dig_counter = dig_counter + 10 where id = $1 returning dig_counter - 10 as dc`, [u.userId])).rows[0].dc);
    for (const [k, a] of missing.entries()) {
      await pool.query(
        `insert into public.artifact_instances (player_id, instance_id, artifact_id, obtained_at_ms, mode, band, frontier_block_index, dig_counter, source) values ($1, $2, $3, 0, 'frontier', 0, 0, $4, 'drop')`,
        [u.userId, `d${base + k}`, a, base + k],
      );
      await pool.query(`insert into public.artifact_discoveries values ($1, $2, 0, 0, 1) on conflict (player_id, artifact_id) do update set total_found = artifact_discoveries.total_found + 1`, [u.userId, a]);
    }
    await t.controller.retryBootstrap();
    const v2 = t.store.getState().view!;
    expect(setRows(v2.state).find((x) => x.id === "old_miner")).toMatchObject({ heldMembers: 3, ownedNow: true, active: true, allDiscovered: true });
    // 3. 伺服器回傳的能力值包含套組加成（UI 不自行套用）；與引擎規則一致
    expect(v2.stats.speed1000).toBe(1_030);
    expect(v2.stats).toEqual(computeStats(v2.state.equippedPickaxe, v2.state.pickaxes[v2.state.equippedPickaxe]!, heldCounts(v2.state)));

    // 4. 出售一個成員（伺服器既有的 sell_artifacts；測試準備當日市場倍率，UI 本階段不開放寶物出售）
    await pool.query(
      `insert into public.market_prices (price_date, artifact_id, multiplier_ppm) values ((now() at time zone 'Asia/Taipei')::date, 'a_z1_badge', 1000000) on conflict do nothing`,
    );
    // 離線掉落可能已經有不只一件徽章：全部出售，才是「不再持有這個成員」
    const badges = v2.state.heldArtifacts.filter((a) => a.artifactId === "a_z1_badge").map((a) => a.instanceId);
    expect(await t.controller.perform({ type: "sell_artifacts", instanceIds: badges })).toBe("ok");
    const v3 = t.store.getState().view!;
    const row = setRows(v3.state).find((x) => x.id === "old_miner")!;
    expect(row).toMatchObject({ active: false, ownedNow: false, allDiscovered: true });
    expect(v3.stats.speed1000).toBe(1_000);
    expect(collectionEntries(v3.state).find((e) => e.id === "a_z1_badge")).toMatchObject({ held: 0, discovery: expect.objectContaining({ totalFound: expect.any(Number) }) });

    // 5. 重新登入：圖鑑與套組狀態一致
    const again = browser();
    await again.auth.signInWithPassword({ email: u.email, password: PASSWORD });
    const t2 = tab(again);
    await t2.controller.bootstrap();
    const v4 = t2.store.getState().view!;
    expect(collectionProgress(collectionEntries(v4.state)).overall.found).toBe(collectionProgress(collectionEntries(v3.state)).overall.found);
    expect(setRows(v4.state)).toEqual(setRows(v3.state));
    expect(v4.stats.speed1000).toBe(1_000);
  });
});
