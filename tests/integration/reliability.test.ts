/**
 * PR #15 Reliability & Security × 真實 Supabase Local（Edge Functions、PostgREST、PostgreSQL）。
 * 1 建立角色 / 2 未登入被拒 / 3 跨玩家隔離 / 4 正常同步 / 5 大量請求觸發限流 / 6 合法重試恢復
 * 7–8 出售成功但回應遺失 → 原 Request ID 調和 / 9 Action Log 壓縮與期限邊界、作廢探詢
 * 10 多分頁同時出售 / 11 資料庫失敗（交易逾時）/ 13 待領報告領取與重試 / 14 不重複扣款或發放
 * （12 Market Unavailable：伺服器邏輯在 PGlite + 真實 migration 驗證；在共用的 Supabase Local 上刪除當日價格會影響其他平行測試）
 */
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { createGameApi } from "../../apps/web/src/lib/game/api.ts";
import { GameController } from "../../apps/web/src/lib/game/controller.ts";
import { memoryPendingStore } from "../../apps/web/src/lib/game/pending.ts";
import { createGameStore } from "../../apps/web/src/lib/game/store.ts";
import { PASSWORD, createUser, env, pool, signIn } from "./src/backend.ts";

const HOUR = 3_600_000;
afterAll(async () => pool.end());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;
interface Call {
  status: number;
  headers: Headers;
  body: Body;
}
/** 單次呼叫（不自動重試：測試要看到每個回應） */
async function api(fn: string, token: string | null, opts: { method?: string; key?: string; body?: unknown; expire?: boolean } = {}): Promise<Call> {
  const headers: Record<string, string> = { apikey: env.anonKey, "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.key) headers["Idempotency-Key"] = opts.key;
  if (opts.expire) headers["Idempotency-Expire"] = "true";
  const res = await fetch(`${env.functionsUrl}/${fn}`, { method: opts.method ?? "POST", headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let body: Body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: res.status, headers: res.headers, body };
}
/** Supabase Local 的 Edge Runtime 在負載下偶爾回傳沒有內容的 503（不是遊戲 API 的回應）；只對唯讀請求重試這種情況 */
const gatewayFlake = (c: Call) => c.status >= 502 && c.status <= 504 && !(c.body && typeof c.body === "object" && "error" in c.body);
async function readOnce(token: string): Promise<Call> {
  for (let i = 0; ; i++) {
    const r = await api("game-state", token, { method: "GET" });
    if (!gatewayFlake(r) || i >= 3) return r;
    await new Promise((x) => setTimeout(x, 300));
  }
}
const act = (token: string, command: Record<string, unknown>, key = randomUUID(), expire = false) => api("game-action", token, { key, body: { command }, expire });

async function newPlayer() {
  const u = await createUser();
  const { accessToken, client } = await signIn(u.email);
  const r = await api("character-create", accessToken, { body: {} });
  expect(r.status).toBe(201); // 1. 正常建立角色
  return { ...u, token: accessToken, client };
}
const stoneOf = async (id: string) => Number((await pool.query(`select quantity from public.player_inventory where player_id = $1 and item_id = 'stone'`, [id])).rows[0]?.quantity ?? 0);
const logs = async (id: string, command: string) => Number((await pool.query(`select count(*)::int as n from public.action_log where player_id = $1 and command = $2`, [id, command])).rows[0].n);

describe("身分與隔離", () => {
  it("2. 未登入 / 無效 JWT → 401；3. 玩家 A 讀不到也改不了玩家 B", async () => {
    for (const token of [null, "not-a-jwt"]) {
      expect((await api("game-state", token, { method: "GET" })).status).toBe(401);
      expect((await act(token as string, { type: "settle" })).status).toBe(401);
    }
    const a = await newPlayer();
    const b = await newPlayer();
    expect((await a.client.from("players").select("id").eq("id", b.id)).data).toEqual([]);
    await a.client.from("players").update({ coins: 999_999 }).eq("id", b.id);
    await a.client.from("artifact_instances").delete().eq("player_id", b.id);
    expect(Number((await pool.query(`select coins from public.players where id = $1`, [b.id])).rows[0].coins)).toBe(0);
    // body 帶 playerId（試圖操作別人）→ 400
    expect((await api("game-action", a.token, { key: randomUUID(), body: { command: { type: "settle" }, playerId: b.id } })).status).toBe(400);
    // 4. 正常挖礦同步
    const s = await act(a.token, { type: "settle" });
    expect(s.status).toBe(200);
    expect(s.body.state.state.playerId).toBe(a.id);
  });
});

describe("Rate limit（伺服器端）", () => {
  it("5. 大量請求 → 429 RATE_LIMITED + Retry-After；6. 等待後恢復；重送原 Request ID 不受限", async () => {
    const p = await newPlayer();
    const done = randomUUID();
    expect((await act(p.token, { type: "settle" }, done)).status).toBe(200);
    // game-state 上限 20 / 10 秒：連續 41 次必定有一個視窗超過
    let limited: Call | null = null;
    for (let i = 0; i < 41 && !limited; i++) {
      const r = await readOnce(p.token);
      if (r.status === 429) limited = r;
      else expect(r.status).toBe(200);
    }
    expect(limited).not.toBeNull();
    expect(limited!.body.error.code).toBe("RATE_LIMITED");
    const retryAfter = Number(limited!.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(10);
    // 不同 API 各自計數；重送已處理的 key 不受限
    const replay = await act(p.token, { type: "settle" }, done);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    await new Promise((r) => setTimeout(r, retryAfter * 1000 + 200));
    expect((await readOnce(p.token)).status).toBe(200);
  });
});

describe("Action Log 分層保存與 Request ID", () => {
  it("9. 壓縮後以原 Request ID 重送 → 410 REQUEST_EXPIRED（當初成功），不重新執行；期限內的紀錄照常重送", async () => {
    const p = await newPlayer();
    await pool.query(`insert into public.player_inventory values ($1, 'stone', 100)`, [p.id]);
    const oldKey = randomUUID();
    const recentKey = randomUUID();
    expect((await act(p.token, { type: "sell_items", itemId: "stone", quantity: 10 }, oldKey)).status).toBe(200);
    expect((await act(p.token, { type: "sell_items", itemId: "stone", quantity: 5 }, recentKey)).status).toBe(200);
    // 邊界：只有超過保存期限的紀錄被壓縮（把一筆的建立時間移到 31 天前）
    await pool.query(`alter table public.action_log disable trigger action_log_guard`);
    try {
      await pool.query(`update public.action_log set created_at = now() - interval '31 days' where player_id = $1 and idempotency_key = $2`, [p.id, oldKey]);
    } finally {
      await pool.query(`alter table public.action_log enable trigger action_log_guard`);
    }
    const c = await pool.query(`select private.action_log_compact(interval '30 days', $1::uuid) as r`, [p.id]);
    expect(c.rows[0].r).toMatchObject({ compacted: 1 });
    const stone = await stoneOf(p.id);
    const expired = await act(p.token, { type: "sell_items", itemId: "stone", quantity: 10 }, oldKey);
    expect(expired.status).toBe(410);
    expect(expired.body.error.code).toBe("REQUEST_EXPIRED");
    expect(expired.body.expired).toMatchObject({ processed: true, ok: true });
    expect(await stoneOf(p.id)).toBe(stone); // 14. 沒有再賣一次
    const recent = await act(p.token, { type: "sell_items", itemId: "stone", quantity: 5 }, recentKey);
    expect(recent.status).toBe(200);
    expect(recent.headers.get("idempotent-replayed")).toBe("true");
    // 不同內容使用同一個 key：409
    expect((await act(p.token, { type: "sell_items", itemId: "stone", quantity: 1 }, oldKey)).status).toBe(409);
  });

  it("9b. 積壓清除：pg_cron 每小時執行 drain；> 5,000 筆過期 settle 與交易分批（每批 commit）清完，交易只壓縮", async () => {
    const job = await pool.query(`select schedule, command, active from cron.job where jobname = 'action-log-compact'`);
    expect(job.rows).toEqual([{ schedule: "17 * * * *", command: "call private.action_log_drain(interval '30 days')", active: true }]);
    const p = await newPlayer();
    const N = 6_000;
    for (const command of ["settle", "purchase_pickaxe"]) {
      await pool.query(
        `insert into public.action_log (player_id, idempotency_key, request_hash, command, committed, state_version_after, response, created_at)
         select $1::uuid, gen_random_uuid(), repeat('b', 64), $2::text, false, null, jsonb_build_object('ok', true), now() - interval '45 days'
         from generate_series(1, $3::int)`,
        [p.id, command, N],
      );
    }
    await pool.query(`call private.action_log_drain(interval '30 days', 2000, 500)`); // 與排程相同的指令（較小的批次）
    const rows = await pool.query(
      `select command, count(*)::int as n, count(*) filter (where response is null)::int as compacted from public.action_log where player_id = $1 and created_at < now() - interval '30 days' group by command`,
      [p.id],
    );
    expect(rows.rows).toEqual([{ command: "purchase_pickaxe", n: N, compacted: N }]);
    const backlog = (await pool.query(`select private.action_log_backlog() as b`)).rows[0].b;
    expect(backlog).toMatchObject({ settleToDelete: 0, responsesToCompact: 0 });
  }, 120_000);

  it("作廢探詢：從未到達的 Request ID 不執行、寫下作廢紀錄；原始請求晚到也不執行", async () => {
    const p = await newPlayer();
    await pool.query(`insert into public.player_inventory values ($1, 'stone', 30)`, [p.id]);
    const key = randomUUID();
    const probe = await act(p.token, { type: "sell_items", itemId: "stone", quantity: 10 }, key, true);
    expect(probe.status).toBe(410);
    expect(probe.body.expired).toEqual({ processed: false, ok: null, processedAt: null });
    const late = await act(p.token, { type: "sell_items", itemId: "stone", quantity: 10 }, key);
    expect(late.status).toBe(410);
    expect(late.headers.get("idempotent-replayed")).toBe("true");
    expect(await stoneOf(p.id)).toBe(30);
    expect((await api("game-action", p.token, { key: randomUUID(), body: { command: { type: "settle" } }, expire: false })).status).toBe(200);
  });

  it("7–8. 出售成功但回應遺失 → Client 以原 Request ID 調和，只入帳一次；10. 兩個分頁同時出售同一件", async () => {
    const storage = new Map<string, string>();
    const supabase = createClient(env.apiUrl, env.anonKey, {
      auth: { persistSession: true, autoRefreshToken: false, storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, v), removeItem: (k) => void storage.delete(k) } },
    });
    const { data } = await supabase.auth.signUp({ email: `rel-${randomUUID()}@example.test`, password: PASSWORD });
    const id = data.user!.id;
    let lose = true;
    const lossy: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (lose && String(init?.body).includes("sell_items")) throw new TypeError("response lost");
      return res;
    };
    const tab = (f?: typeof fetch) => {
      const store = createGameStore();
      const gameApi = createGameApi({
        functionsUrl: env.functionsUrl,
        anonKey: env.anonKey,
        getAccessToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
        refreshAccessToken: async () => null,
        retryDelaysMs: [100, 200],
        ...(f ? { fetch: f } : {}),
      });
      return { store, c: new GameController({ api: gameApi, store, channel: null, pendingStore: memoryPendingStore() }) };
    };
    const a = tab(lossy);
    await a.c.createCharacter();
    await pool.query(`insert into public.player_inventory values ($1, 'stone', 40)`, [id]);
    await a.c.retryBootstrap();
    expect(await a.c.perform({ type: "sell_items", itemId: "stone", quantity: 10 })).toBe("uncertain");
    lose = false;
    await a.c.sync();
    expect(a.store.getState().pending).toBeNull();
    expect(await logs(id, "sell_items")).toBe(1);
    // 10. 兩個分頁同時出售（數量只夠一次）
    const b = tab();
    await b.c.bootstrap();
    const have = await stoneOf(id);
    const [ra, rb] = await Promise.all([
      a.c.perform({ type: "sell_items", itemId: "stone", quantity: have }),
      b.c.perform({ type: "sell_items", itemId: "stone", quantity: have }),
    ]);
    expect([ra, rb].sort()).toEqual(["ok", "rejected"]);
    expect(await logs(id, "sell_items")).toBe(3);
    a.c.dispose();
    b.c.dispose();
  });
});

describe("失敗與恢復", () => {
  it("11. 資料庫失敗（交易鎖住超過 RPC 逾時）→ 503 SERVER_BUSY（結果不確定）→ 恢復後以原 Request ID 重送，只扣款一次", async () => {
    const p = await newPlayer();
    await pool.query(`update public.players set coins = 1000 where id = $1`, [p.id]);
    await pool.query(`insert into public.player_inventory values ($1, 'stone', 200)`, [p.id]);
    const key = randomUUID();
    const locker = await pool.connect();
    let first: Call;
    try {
      await locker.query("begin");
      await locker.query(`select 1 from public.players where id = $1 for update`, [p.id]);
      first = await act(p.token, { type: "purchase_pickaxe", pickaxeId: "pick_stone" }, key);
    } finally {
      await locker.query("commit");
      locker.release();
    }
    expect(first.status).toBe(503);
    expect(first.body.error.code).toBe("SERVER_BUSY");
    expect(JSON.stringify(first.body)).not.toMatch(/lock|timeout|players|postgres/i); // 不洩漏內部細節
    await new Promise((r) => setTimeout(r, 500));
    const again = await act(p.token, { type: "purchase_pickaxe", pickaxeId: "pick_stone" }, key);
    expect(again.status).toBe(200);
    expect(await logs(p.id, "purchase_pickaxe")).toBe(1);
    const row = (await pool.query(`select coins from public.players where id = $1`, [p.id])).rows[0];
    expect(Number(row.coins)).toBeLessThanOrEqual(1000 - 200 + 50); // 只扣一次（結算可能另外加少量金幣）
    expect(Number(row.coins)).toBeGreaterThanOrEqual(800);
  }, 60_000);

  it("13. 待領報告：領取請求重送（同一個 Request ID）只領一次；領取前其他操作被擋", async () => {
    const p = await newPlayer();
    await pool.query(`update public.players set created_at_ms = created_at_ms - $2, last_settled_at_ms = last_settled_at_ms - $2 where id = $1`, [p.id, 3 * HOUR]);
    const s = await act(p.token, { type: "settle" });
    const reportId = s.body.report.reportId;
    expect((await act(p.token, { type: "sell_items", itemId: "stone", quantity: 1 })).body.error.code).toBe("REPORT_PENDING");
    const key = randomUUID();
    const [x, y] = await Promise.all([act(p.token, { type: "claim_report", reportId }, key), act(p.token, { type: "claim_report", reportId }, key)]);
    expect([x.status, y.status]).toEqual([200, 200]);
    expect(await logs(p.id, "claim_report")).toBe(1);
    const claimed = await pool.query(`select count(*)::int as n from public.offline_reports where player_id = $1 and status = 'claimed'`, [p.id]);
    expect(claimed.rows[0].n).toBe(1);
  });
});
