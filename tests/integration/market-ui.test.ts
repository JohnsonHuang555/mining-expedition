/**
 * 市場 UI 的資料流 × 真實 Supabase Local（Edge Functions + PostgreSQL）：
 * 畫面使用的 GameController / 計算函式（planSale、pickInstances）直接對真實伺服器操作。
 * 1 登入建立角色 → 2 當日報價 → 3 多件寶物 → 4 單件 / 多件出售 → 5 依伺服器價格入帳 → 6 套組失效、圖鑑保留
 * → 7 過期市場日拒絕 → 8 新報價重新確認 → 9 同一 Request ID 重送 → 10 回應遺失 → 11 多分頁同時出售 → 12 重新登入一致
 */
import { randomUUID } from "node:crypto";
import type { ArtifactId } from "@mining/game-data";
import { type GameCommand, addMarketDays, artifactSalePrice } from "@mining/game-engine";
import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { createGameApi } from "../../apps/web/src/lib/game/api.ts";
import { GameController } from "../../apps/web/src/lib/game/controller.ts";
import { marketRows, pickInstances, planSale } from "../../apps/web/src/lib/game/market.ts";
import { createGameStore } from "../../apps/web/src/lib/game/store.ts";
import { PASSWORD, env, pool } from "./src/backend.ts";

afterAll(async () => pool.end());

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

function tab(supabase: SupabaseClient, fetchImpl?: typeof fetch) {
  const store = createGameStore();
  const api = createGameApi({
    functionsUrl: env.functionsUrl,
    anonKey: env.anonKey,
    getAccessToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
    refreshAccessToken: async () => null,
    retryDelaysMs: [100, 200],
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  const controller = new GameController({ api, store, channel: null });
  return { store, controller, api };
}

async function signedIn(email: string, signUp: boolean) {
  const supabase = createClient(env.apiUrl, env.anonKey, { auth: { persistSession: true, autoRefreshToken: false, storage: memoryStorage(), storageKey: "sb-market" } });
  const { data, error } = signUp ? await supabase.auth.signUp({ email, password: PASSWORD }) : await supabase.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.user) throw new Error(`auth: ${error?.message}`);
  return { supabase, id: data.user.id };
}

async function giveArtifacts(playerId: string, ids: ArtifactId[]) {
  const base = Number((await pool.query(`update public.players set dig_counter = dig_counter + $2 where id = $1 returning dig_counter - $2 as dc`, [playerId, ids.length + 1])).rows[0].dc);
  for (const [k, a] of ids.entries()) {
    await pool.query(
      `insert into public.artifact_instances (player_id, instance_id, artifact_id, obtained_at_ms, mode, band, frontier_block_index, dig_counter, source) values ($1, $2, $3, 0, 'frontier', 0, 0, $4, 'drop')`,
      [playerId, `d${base + k}`, a, base + k],
    );
    await pool.query(
      `insert into public.artifact_discoveries values ($1, $2, 0, 0, 1) on conflict (player_id, artifact_id) do update set total_found = public.artifact_discoveries.total_found + 1`,
      [playerId, a],
    );
  }
}

const dbPrices = async (date: string): Promise<Record<string, number>> =>
  Object.fromEntries((await pool.query(`select artifact_id, multiplier_ppm from public.market_prices where price_date = $1::date`, [date])).rows.map((r) => [r.artifact_id, r.multiplier_ppm]));
const coinsOf = async (id: string) => Number((await pool.query(`select coins from public.players where id = $1`, [id])).rows[0].coins);
const sellLogs = async (id: string) => (await pool.query(`select count(*)::int as n, count(distinct idempotency_key)::int as k from public.action_log where player_id = $1 and command = 'sell_artifacts'`, [id])).rows[0];

describe("市場 UI 資料流（真實 Supabase Local）", () => {
  it("報價 → 單件 / 多件出售 → 伺服器價格入帳 → 套組失效、圖鑑保留 → 過期拒絕 → 新報價重新確認 → 重新登入一致", async () => {
    // 1. 登入並建立角色
    const email = `market-ui-${randomUUID()}@example.test`;
    const { supabase, id } = await signedIn(email, true);
    const t = tab(supabase);
    expect(await t.controller.createCharacter()).toBe(true);

    // 2. 當日報價（與資料庫一致）
    await t.controller.refreshMarket();
    const m = t.store.getState().market!;
    expect(m.date).toBe((await pool.query(`select to_char(private.market_date(now()), 'YYYY-MM-DD') as d`)).rows[0].d);
    expect(m.multipliersPpm).toEqual(await dbPrices(m.date));
    expect(Array.isArray(m.history)).toBe(true);

    // 3. 多件寶物（含重複）
    await giveArtifacts(id, ["a_z1_lantern", "a_z1_lantern", "a_z1_badge", "a_z1_map", "a_z1_heart"]);
    await t.controller.retryBootstrap();
    const s0 = t.store.getState().view!;
    expect(s0.stats.speed1000).toBe(1_030);

    // 4–5. 單件（重複的提燈：不影響套組）
    const rows = () => marketRows(t.store.getState().view!.state, t.store.getState().market);
    const lantern = rows().find((r) => r.id === "a_z1_lantern")!;
    const one = planSale(s0.state, m, pickInstances(lantern, 1));
    expect(one.lostSets).toEqual([]);
    const c0 = await coinsOf(id);
    expect(await t.controller.perform({ type: "sell_artifacts", instanceIds: one.instanceIds, marketDate: m.date })).toBe("ok");
    const sold1 = t.store.getState().lastAction!.events.find((e) => e.type === "artifacts_sold")!;
    expect(sold1).toMatchObject({ coins: artifactSalePrice("a_z1_lantern", (await dbPrices(m.date)).a_z1_lantern!) });
    expect(await coinsOf(id)).toBeGreaterThanOrEqual(c0 + one.total!);
    expect(t.store.getState().view!.stats.speed1000).toBe(1_030);

    // 多件、多種：最後一件提燈 + 礦脈之心 → 老礦工套組失效
    const multi = planSale(t.store.getState().view!.state, m, [...pickInstances(rows().find((r) => r.id === "a_z1_lantern")!, 1), ...pickInstances(rows().find((r) => r.id === "a_z1_heart")!, 1)]);
    expect(multi.count).toBe(2);
    expect(multi.lostSets.map((s) => s.id)).toEqual(["old_miner"]);

    // 7. 過期的市場日：拒絕，沒有出售；未確認紀錄清除；報價更新
    expect(await t.controller.perform({ type: "sell_artifacts", instanceIds: multi.instanceIds, marketDate: addMarketDays(m.date, -1) })).toBe("rejected");
    expect(t.store.getState().lastAction!.code).toBe("MARKET_QUOTE_EXPIRED");
    expect(t.store.getState().pending).toBeNull();
    expect(t.store.getState().view!.state.heldArtifacts).toHaveLength(4);

    // 8. 以伺服器回應附帶的報價重新確認
    const fresh = t.store.getState().market!;
    const c1 = await coinsOf(id);
    expect(await t.controller.perform({ type: "sell_artifacts", instanceIds: multi.instanceIds, marketDate: fresh.date })).toBe("ok");
    const sold2 = t.store.getState().lastAction!.events.find((e) => e.type === "artifacts_sold")!;
    const prices = await dbPrices(fresh.date);
    expect(sold2).toMatchObject({ coins: artifactSalePrice("a_z1_lantern", prices.a_z1_lantern!) + artifactSalePrice("a_z1_heart", prices.a_z1_heart!) });
    expect(await coinsOf(id)).toBeGreaterThanOrEqual(c1 + (sold2 as { coins: number }).coins);

    // 6. 套組失效（伺服器能力值）、圖鑑保留
    const v = t.store.getState().view!;
    expect(v.stats.speed1000).toBe(1_000);
    expect(v.state.discoveredArtifacts.a_z1_lantern).toBeDefined();
    expect(v.state.discoveredArtifacts.a_z1_heart).toBeDefined();
    expect(await sellLogs(id)).toEqual({ n: 3, k: 3 }); // 單件、過期（保存的拒絕）、多件

    // 12. 登出 → 重新登入：狀態一致
    t.controller.dispose();
    await supabase.auth.signOut();
    const again = await signedIn(email, false);
    const t2 = tab(again.supabase);
    await t2.controller.bootstrap();
    const v2 = t2.store.getState().view!;
    expect(v2.state.heldArtifacts.map((a) => a.artifactId).sort()).toEqual(["a_z1_badge", "a_z1_map"]);
    expect(v2.state.discoveredArtifacts.a_z1_lantern).toBeDefined();
    expect(v2.stats.speed1000).toBe(1_000);
    expect(v2.state.coins).toBe(await coinsOf(id));
    expect(t2.store.getState().market!.date).toBe(fresh.date);
    t2.controller.dispose();
  });

  it("9. 同一個 Request ID 重送：只入帳一次", async () => {
    const { supabase, id } = await signedIn(`market-ui-${randomUUID()}@example.test`, true);
    const t = tab(supabase);
    await t.controller.createCharacter();
    await giveArtifacts(id, ["a_z1_map"]);
    await t.controller.retryBootstrap();
    const command: GameCommand = { type: "sell_artifacts", instanceIds: [t.store.getState().view!.state.heldArtifacts[0]!.instanceId], marketDate: t.store.getState().market!.date };
    const key = randomUUID();
    const a = await t.api.action(command, key);
    const c = await coinsOf(id);
    const b = await t.api.action(command, key);
    expect(a.ok && b.ok).toBe(true);
    expect(b.ok && b.replayed).toBe(true);
    expect(await coinsOf(id)).toBe(c);
    expect(await sellLogs(id)).toEqual({ n: 1, k: 1 });
    t.controller.dispose();
  });

  it("10. 出售成功但 HTTP 回應遺失：結果未確認 → 以同一個 Request ID 調和，只入帳一次", async () => {
    const { supabase, id } = await signedIn(`market-ui-${randomUUID()}@example.test`, true);
    let lose = true;
    const lossy: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (lose && String(init?.body).includes("sell_artifacts")) throw new TypeError("response lost");
      return res;
    };
    const t = tab(supabase, lossy);
    await t.controller.createCharacter();
    await giveArtifacts(id, ["a_z1_badge"]);
    await t.controller.retryBootstrap();
    const inst = t.store.getState().view!.state.heldArtifacts[0]!.instanceId;
    expect(await t.controller.perform({ type: "sell_artifacts", instanceIds: [inst], marketDate: t.store.getState().market!.date })).toBe("uncertain");
    expect(t.store.getState().pending).not.toBeNull();
    lose = false;
    await t.controller.sync();
    expect(t.store.getState().pending).toBeNull();
    expect(t.store.getState().view!.state.heldArtifacts).toEqual([]);
    expect(await sellLogs(id)).toEqual({ n: 1, k: 1 });
    t.controller.dispose();
  });

  it("11. 兩個分頁同時出售同一件：只有一個成功、只入帳一次；另一個分頁更新持有狀態", async () => {
    const { supabase, id } = await signedIn(`market-ui-${randomUUID()}@example.test`, true);
    const a = tab(supabase);
    await a.controller.createCharacter();
    await giveArtifacts(id, ["a_z1_heart"]);
    await a.controller.retryBootstrap();
    const b = tab(supabase);
    await b.controller.bootstrap();
    const inst = a.store.getState().view!.state.heldArtifacts[0]!.instanceId;
    const date = a.store.getState().market!.date;
    const c0 = await coinsOf(id);
    const [ra, rb] = await Promise.all([
      a.controller.perform({ type: "sell_artifacts", instanceIds: [inst], marketDate: date }),
      b.controller.perform({ type: "sell_artifacts", instanceIds: [inst], marketDate: date }),
    ]);
    expect([ra, rb].sort()).toEqual(["ok", "rejected"]);
    const loser = ra === "rejected" ? a : b;
    expect(loser.store.getState().lastAction!.code).toBe("INSUFFICIENT_ITEMS");
    expect(loser.store.getState().view!.state.heldArtifacts).toEqual([]); // 拒絕回應附帶的最新狀態
    const price = artifactSalePrice("a_z1_heart", (await dbPrices(date)).a_z1_heart!);
    const gained = (await coinsOf(id)) - c0;
    expect(gained).toBeGreaterThanOrEqual(price);
    expect(gained).toBeLessThan(2 * price);
    a.controller.dispose();
    b.controller.dispose();
  });
});
