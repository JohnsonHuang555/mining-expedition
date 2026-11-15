/**
 * 寶物市場 × 真實 Supabase Local（PostgreSQL、pg_cron、Edge Functions、PostgREST）。
 * - 價格產生：首次 / 重複 / 多個 Worker 並行 / 跨日補齊 / 時區邊界 / 排程 / Client 不能觸發或修改。
 * - 出售：伺服器定價、重複出售、Request ID 重送、回應遺失後調和、跨日報價、套組失效、圖鑑保留、待領報告、多分頁、多玩家。
 */
import { randomUUID } from "node:crypto";
import { ARTIFACT_IDS, type ArtifactId } from "@mining/game-data";
import { addMarketDays, artifactSalePrice, marketMultiplierFor } from "@mining/game-engine";
import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGameApi } from "../../apps/web/src/lib/game/api.ts";
import { GameController } from "../../apps/web/src/lib/game/controller.ts";
import { createGameStore } from "../../apps/web/src/lib/game/store.ts";
import { PASSWORD, createUser, env, pool, signIn } from "./src/backend.ts";

const HOUR = 3_600_000;
afterAll(async () => pool.end());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;
async function api(fn: string, token: string, opts: { method?: string; key?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { apikey: env.anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  if (opts.key) headers["Idempotency-Key"] = opts.key;
  const res = await fetch(`${env.functionsUrl}/${fn}`, { method: opts.method ?? "POST", headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  return { status: res.status, replayed: res.headers.get("idempotent-replayed"), body: (await res.json()) as Body };
}
const act = (token: string, command: Record<string, unknown>, key = randomUUID()) => api("game-action", token, { key, body: { command } });
const state = (token: string) => api("game-state", token, { method: "GET" });

async function newPlayer() {
  const u = await createUser();
  const { accessToken, client } = await signIn(u.email);
  expect((await api("character-create", accessToken)).status).toBe(201);
  return { ...u, token: accessToken, client };
}

/** 測試準備：寫入與正常掉落相同的寶物資料列 */
async function giveArtifacts(playerId: string, ids: ArtifactId[]): Promise<string[]> {
  const base = Number((await pool.query(`update public.players set dig_counter = dig_counter + $2 where id = $1 returning dig_counter - $2 as dc`, [playerId, ids.length + 1])).rows[0].dc);
  const out: string[] = [];
  for (const [k, a] of ids.entries()) {
    await pool.query(
      `insert into public.artifact_instances (player_id, instance_id, artifact_id, obtained_at_ms, mode, band, frontier_block_index, dig_counter, source) values ($1, $2, $3, 0, 'frontier', 0, 0, $4, 'drop')`,
      [playerId, `d${base + k}`, a, base + k],
    );
    await pool.query(
      `insert into public.artifact_discoveries values ($1, $2, 0, 0, 1) on conflict (player_id, artifact_id) do update set total_found = public.artifact_discoveries.total_found + 1`,
      [playerId, a],
    );
    out.push(`d${base + k}`);
  }
  return out;
}

const dbToday = async (): Promise<string> => (await pool.query(`select to_char(private.market_date(now()), 'YYYY-MM-DD') as d`)).rows[0].d;
async function pricesOn(date: string): Promise<Record<string, number>> {
  const r = await pool.query(`select artifact_id, multiplier_ppm from public.market_prices where price_date = $1::date`, [date]);
  return Object.fromEntries(r.rows.map((x) => [x.artifact_id, x.multiplier_ppm]));
}
const secret = async () => new Uint8Array((await pool.query(`select secret from private.market_secret`)).rows[0].secret);

describe("每日市場價格（PostgreSQL）", () => {
  it("首次讀取產生當日 12 件；game-state 的報價與資料庫一致；下一次刷新是台灣 00:00", async () => {
    const p = await newPlayer();
    const r = await state(p.token);
    expect(r.status).toBe(200);
    const today = await dbToday();
    expect(r.body.market.date).toBe(today);
    expect(r.body.market.multipliersPpm).toEqual(await pricesOn(today));
    expect(Object.keys(r.body.market.multipliersPpm)).toHaveLength(12);
    expect(r.body.market.nextRefreshAt).toBe(Date.parse(`${addMarketDays(today, 1)}T00:00:00+08:00`));
    for (const h of r.body.market.history) expect(h.date < today).toBe(true);
  });

  it("同日重複產生不改變；多個 Worker 並行產生之後的日期：每天每件只有一筆、與引擎參考實作逐位元一致", async () => {
    const today = await dbToday();
    const before = await pricesOn(today);
    expect((await pool.query(`select private.market_ensure($1::date) as n`, [today])).rows[0].n).toBe(0);
    expect(await pricesOn(today)).toEqual(before);

    // 之後的日期（值是確定的：提前產生與當天再產生結果相同）
    const target = addMarketDays(today, 2);
    const workers = await Promise.all(Array.from({ length: 8 }, () => pool.query(`select private.market_ensure($1::date) as n`, [target])));
    const inserted = workers.reduce((s, w) => s + Number(w.rows[0].n), 0);
    const existing = Number((await pool.query(`select count(*)::int as n from public.market_prices where price_date in ($1::date, $2::date)`, [addMarketDays(today, 1), target])).rows[0].n);
    expect(existing).toBe(24);
    expect(inserted).toBeLessThanOrEqual(24);
    const key = await secret();
    for (const id of ARTIFACT_IDS) {
      let m = before[id]!;
      for (const d of [addMarketDays(today, 1), target]) {
        m = marketMultiplierFor(key, d, id, m);
        expect((await pricesOn(d))[id], `${id} ${d}`).toBe(m);
      }
    }
  });

  it("市場日的時區邊界（Asia/Taipei 00:00 = UTC 16:00）", async () => {
    const r = await pool.query(
      `select to_char(private.market_date('2026-11-15T15:59:59.999Z'), 'YYYY-MM-DD') as a, to_char(private.market_date('2026-11-15T16:00:00Z'), 'YYYY-MM-DD') as b, private.market_next_refresh_ms('2026-11-16') as n`,
    );
    expect(r.rows[0]).toMatchObject({ a: "2026-11-15", b: "2026-11-16" });
    expect(Number(r.rows[0].n)).toBe(Date.parse("2026-11-16T16:00:00Z"));
  });

  it("pg_cron 每天台灣 00:01 預先產生（排程沒跑到也會在讀取 / 交易時延遲產生）", async () => {
    const job = await pool.query(`select schedule, command, active from cron.job where jobname = 'market-daily-prices'`);
    expect(job.rows).toEqual([{ schedule: "1 16 * * *", command: "select private.market_ensure(private.market_date(now()))", active: true }]);
    // 重試排程的指令：冪等
    expect((await pool.query(job.rows[0].command)).rows).toHaveLength(1);
  });

  it("Client 不能觸發產生、重新抽價或修改價格", async () => {
    const p = await newPlayer();
    const c: SupabaseClient = p.client;
    expect((await c.rpc("market_ensure", { p_date: "2030-01-01" })).error).not.toBeNull();
    expect((await c.rpc("game_load_snapshot", { p_player_id: p.id, p_idempotency_key: null, p_request_hash: null })).error).not.toBeNull();
    expect((await c.from("market_prices").insert({ price_date: "2030-01-01", artifact_id: "a_z1_map", multiplier_ppm: 1_300_000 })).error).not.toBeNull();
    const today = await dbToday();
    await c.from("market_prices").update({ multiplier_ppm: 1_300_000 }).eq("price_date", today);
    await c.from("market_prices").delete().eq("price_date", today);
    expect(Object.keys(await pricesOn(today))).toHaveLength(12);
    // 指令集沒有市場相關的寫入指令；出售也不接受價格
    expect((await act(p.token, { type: "market_refresh" })).status).toBe(400);
    expect((await act(p.token, { type: "sell_artifacts", instanceIds: ["d1"], marketDate: today, multiplierPpm: 1_500_000 })).status).toBe(400);
    // service_role 經 PostgREST 也呼叫不到 private 函式
    const svc = createClient(env.apiUrl, env.serviceRoleKey, { auth: { persistSession: false } });
    expect((await svc.rpc("market_ensure", { p_date: "2030-01-01" })).error).not.toBeNull();
  });
});

describe("出售寶物（Edge Function game-action）", () => {
  let today: string;
  beforeAll(async () => {
    today = await dbToday();
  });

  it("成交價 = floor(BaseValue × 當日倍率)（伺服器計算）；同一實例不能再賣；圖鑑保留；套組立即失效", async () => {
    const p = await newPlayer();
    const [lantern, badge, map] = await giveArtifacts(p.id, ["a_z1_lantern", "a_z1_badge", "a_z1_map"]);
    const s0 = await state(p.token);
    expect(s0.body.state.stats.speed1000).toBe(1_030); // 老礦工套組
    const mult = s0.body.market.multipliersPpm.a_z1_badge;
    const r = await act(p.token, { type: "sell_artifacts", instanceIds: [badge], marketDate: s0.body.market.date });
    expect(r.status).toBe(200);
    expect(r.body.events).toContainEqual({ type: "artifacts_sold", instanceIds: [badge], coins: artifactSalePrice("a_z1_badge", mult) });
    expect(r.body.events).toContainEqual({ type: "set_changed", setId: "old_miner", active: false });
    expect(r.body.state.stats.speed1000).toBe(1_000); // D3：立即失效
    expect(r.body.state.state.heldArtifacts.map((a: { instanceId: string }) => a.instanceId).sort()).toEqual([lantern, map].sort());
    expect(r.body.state.state.discoveredArtifacts.a_z1_badge).toBeDefined();
    const again = await act(p.token, { type: "sell_artifacts", instanceIds: [badge], marketDate: today });
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe("INSUFFICIENT_ITEMS");
    const row = await pool.query(`select status from public.artifact_instances where player_id = $1 and instance_id = $2`, [p.id, badge]);
    expect(row.rows[0].status).toBe("sold");
    // 下一次結算的能力值與伺服器一致（沒有套組）
    const settle = await act(p.token, { type: "settle" });
    expect(settle.body.state.stats.speed1000).toBe(1_000);
  });

  it("同一個 Request ID 重送：Idempotent-Replayed，只入帳一次", async () => {
    const p = await newPlayer();
    const [id] = await giveArtifacts(p.id, ["a_z1_heart"]);
    const key = randomUUID();
    const cmd = { type: "sell_artifacts", instanceIds: [id], marketDate: today };
    const a = await act(p.token, cmd, key);
    const b = await act(p.token, cmd, key);
    expect(a.status).toBe(200);
    expect(b.replayed).toBe("true");
    expect(b.body).toEqual(a.body);
    const n = await pool.query(`select count(*)::int as n from public.action_log where player_id = $1 and command = 'sell_artifacts'`, [p.id]);
    expect(n.rows[0].n).toBe(1);
  });

  it("報價市場日已過（跨日、舊頁面）：409 MARKET_QUOTE_EXPIRED，不出售、附上新報價", async () => {
    const p = await newPlayer();
    const [id] = await giveArtifacts(p.id, ["a_z1_map"]);
    const r = await act(p.token, { type: "sell_artifacts", instanceIds: [id], marketDate: addMarketDays(today, -1) });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("MARKET_QUOTE_EXPIRED");
    expect(r.body.market.date).toBe(today);
    expect(r.body.state.state.heldArtifacts.map((a: { instanceId: string }) => a.instanceId)).toContain(id);
    // 以新報價重新確認（新的 Request ID）
    const ok = await act(p.token, { type: "sell_artifacts", instanceIds: [id], marketDate: r.body.market.date });
    expect(ok.status).toBe(200);
  });

  it("有待領取的離線報告時不可出售（D24）", async () => {
    const p = await newPlayer();
    const [id] = await giveArtifacts(p.id, ["a_z1_map"]);
    await pool.query(`update public.players set created_at_ms = created_at_ms - $2, last_settled_at_ms = last_settled_at_ms - $2 where id = $1`, [p.id, 3 * HOUR]);
    const r = await act(p.token, { type: "sell_artifacts", instanceIds: [id], marketDate: today });
    expect(r.body.error.code).toBe("REPORT_PENDING");
    expect(r.body.state.state.pendingOfflineReport).not.toBeNull();
    expect(r.body.state.state.heldArtifacts.map((a: { instanceId: string }) => a.instanceId)).toContain(id);
  });

  it("兩個分頁同時出售同一件：只有一個成功、只入帳一次", async () => {
    const p = await newPlayer();
    const [id] = await giveArtifacts(p.id, ["a_z1_badge"]);
    const coins0 = Number((await pool.query(`select coins from public.players where id = $1`, [p.id])).rows[0].coins);
    const cmd = { type: "sell_artifacts", instanceIds: [id], marketDate: today };
    const rs = await Promise.all([act(p.token, cmd), act(p.token, cmd)]);
    const ok = rs.filter((r) => r.status === 200);
    expect(ok).toHaveLength(1);
    expect(rs.find((r) => r.status !== 200)!.body.error.code).toBe("INSUFFICIENT_ITEMS");
    const coins1 = Number((await pool.query(`select coins from public.players where id = $1`, [p.id])).rows[0].coins);
    const price = ok[0]!.body.events.find((e: { type: string }) => e.type === "artifacts_sold").coins;
    expect(coins1 - coins0).toBeGreaterThanOrEqual(price);
    expect(coins1 - coins0).toBeLessThan(2 * price);
  });

  it("兩位玩家同時出售同種寶物：各自成交、同一個市場價格", async () => {
    const [a, b] = await Promise.all([newPlayer(), newPlayer()]);
    const [ia] = await giveArtifacts(a.id, ["a_z1_heart"]);
    const [ib] = await giveArtifacts(b.id, ["a_z1_heart"]);
    const [ra, rb] = await Promise.all([
      act(a.token, { type: "sell_artifacts", instanceIds: [ia], marketDate: today }),
      act(b.token, { type: "sell_artifacts", instanceIds: [ib], marketDate: today }),
    ]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    const price = (r: typeof ra) => r.body.events.find((e: { type: string }) => e.type === "artifacts_sold").coins;
    expect(price(ra)).toBe(price(rb));
    expect(price(ra)).toBe(artifactSalePrice("a_z1_heart", (await pricesOn(today)).a_z1_heart!));
  });

  it("回應遺失：Client 以同一個 Request ID 調和，只出售、入帳一次", async () => {
    const storage = new Map<string, string>();
    const supabase = createClient(env.apiUrl, env.anonKey, {
      auth: { persistSession: true, autoRefreshToken: false, storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, v), removeItem: (k) => void storage.delete(k) } },
    });
    const email = `market-${randomUUID()}@example.test`;
    const { data } = await supabase.auth.signUp({ email, password: PASSWORD });
    const id = data.user!.id;
    let lose = true;
    const lossy: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (lose && String(init?.body).includes("sell_artifacts")) throw new TypeError("response lost");
      return res;
    };
    const store = createGameStore();
    const gameApi = createGameApi({
      functionsUrl: env.functionsUrl,
      anonKey: env.anonKey,
      getAccessToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
      refreshAccessToken: async () => null,
      retryDelaysMs: [100, 200],
      fetch: lossy,
    });
    const c = new GameController({ api: gameApi, store, channel: null });
    await c.createCharacter();
    const [inst] = await giveArtifacts(id, ["a_z1_lantern"]);
    await c.retryBootstrap();
    const marketDate = store.getState().market!.date;
    expect(await c.perform({ type: "sell_artifacts", instanceIds: [inst!], marketDate })).toBe("uncertain");
    expect((await pool.query(`select status from public.artifact_instances where player_id = $1 and instance_id = $2`, [id, inst])).rows[0].status).toBe("sold");
    lose = false;
    await c.sync(); // 先以同一個 key 調和
    expect(store.getState().pending).toBeNull();
    expect(store.getState().view!.state.heldArtifacts).toEqual([]);
    const n = await pool.query(`select count(*)::int as n, count(distinct idempotency_key)::int as k from public.action_log where player_id = $1 and command = 'sell_artifacts'`, [id]);
    expect(n.rows[0]).toEqual({ n: 1, k: 1 });
    c.dispose();
  });
});
