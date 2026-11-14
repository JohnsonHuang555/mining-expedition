/**
 * Edge Functions（character-create / game-state / game-action）：經由 Supabase Local 的 API gateway
 * 呼叫真正的 Edge Runtime（Deno），以真實 JWT 驗證。
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type GameCommand, type PlayerGameState, createBlockRng, engineInfo, executeRequest, sha256 } from "@mining/game-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUser, env, pool, realBackend, signIn } from "./src/backend.ts";

const HOUR = 3_600_000;

interface Call {
  status: number;
  headers: Headers;
  text: string;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function api(fn: string, opts: { method?: string; token?: string | null; key?: string | null; body?: unknown; query?: string } = {}): Promise<Call> {
  const headers: Record<string, string> = { apikey: env.anonKey, "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.key) headers["Idempotency-Key"] = opts.key;
  const res = await fetch(`${env.functionsUrl}/${fn}${opts.query ?? ""}`, {
    method: opts.method ?? "POST",
    headers,
    body: opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* 非 JSON（例如 gateway 錯誤） */
  }
  return { status: res.status, headers: res.headers, text, body };
}

const act = (token: string, command: GameCommand | Record<string, unknown>, key: string = randomUUID()) =>
  api("game-action", { token, key, body: { command } });

async function newPlayer(): Promise<{ id: string; email: string; token: string }> {
  const u = await createUser();
  const { accessToken } = await signIn(u.email);
  const r = await api("character-create", { token: accessToken });
  expect(r.status).toBe(201);
  return { ...u, token: accessToken };
}

async function load(id: string): Promise<PlayerGameState> {
  const s = await realBackend.db.loadSnapshot(id, null, null);
  if (s.status !== "ok") throw new Error(s.status);
  return s.state as PlayerGameState;
}
async function rewind(id: string, ms: number): Promise<void> {
  await pool.query(`update public.players set created_at_ms = created_at_ms - $2, last_settled_at_ms = last_settled_at_ms - $2 where id = $1`, [id, ms]);
}

/** 不應出現在任何回應中的字串 */
const FORBIDDEN = [env.serviceRoleKey, "service_role", "SERVICE_ROLE", "violates", "relation \"", "syntax error", "private.", "player_secrets", "rng_secret", "rngSecret"];
function expectNoLeak(c: Call): void {
  for (const f of FORBIDDEN) expect(c.text, `response leaked "${f}"`).not.toContain(f);
}

afterAll(async () => pool.end());

describe("Edge Functions：Auth 與輸入驗證", () => {
  let p: Awaited<ReturnType<typeof newPlayer>>;
  beforeAll(async () => {
    p = await newPlayer();
  });

  it("未登入、無效 JWT、用 anon key 當 JWT → 401", async () => {
    for (const fn of ["character-create", "game-state", "game-action"]) {
      const method = fn === "game-state" ? "GET" : "POST";
      for (const token of [null, "not-a-jwt", env.anonKey]) {
        const r = await api(fn, { method, token, key: randomUUID(), body: fn === "game-action" ? { command: { type: "settle" } } : undefined });
        expect(r.status, `${fn} ${String(token).slice(0, 8)}`).toBe(401);
        expectNoLeak(r);
      }
    }
  });

  it("CORS preflight 與方法檢查", async () => {
    const pre = await fetch(`${env.functionsUrl}/game-action`, { method: "OPTIONS", headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "POST" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toContain("idempotency-key");
    expect((await api("game-action", { method: "GET", token: p.token })).status).toBe(405);
    expect((await api("game-state", { method: "POST", token: p.token })).status).toBe(405);
  });

  it("建立角色：201；重複建立 409 CHARACTER_EXISTS；不接受任何參數", async () => {
    const again = await api("character-create", { token: p.token });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ ok: false, error: { code: "CHARACTER_EXISTS" } });
    const u = await createUser();
    const { accessToken } = await signIn(u.email);
    expect((await api("character-create", { token: accessToken, body: { playerId: p.id } })).status).toBe(400);
    expect((await api("game-state", { method: "GET", token: accessToken })).status).toBe(404);
  });

  it("game-action：缺少 / 非 UUID 的 Idempotency-Key、body 帶 playerId 或其他欄位、未知指令 → 400", async () => {
    const cases: [string | null, unknown][] = [
      [null, { command: { type: "settle" } }],
      ["not-a-uuid", { command: { type: "settle" } }],
      [randomUUID(), { command: { type: "settle" }, playerId: p.id }],
      [randomUUID(), { command: { type: "settle" }, serverNow: 0 }],
      [randomUUID(), { command: { type: "sell_items", itemId: "stone", quantity: 1, price: 999 } }],
      [randomUUID(), { command: { type: "hack" } }],
      [randomUUID(), { command: { type: "select_mining_mode", mode: "rework", band: 29 } }],
      [randomUUID(), "not json"],
      [randomUUID(), [1, 2]],
    ];
    for (const [key, body] of cases) {
      const r = await api("game-action", { token: p.token, key, body });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    }
    expect((await api("game-state", { method: "GET", token: p.token, query: `?playerId=${p.id}` })).status).toBe(400);
  });

  it("玩家只能操作自己：A 的 JWT 只會影響 A，B 不受影響", async () => {
    const b = await newPlayer();
    const before = await load(b.id);
    await rewind(b.id, 0);
    const r = await act(p.token, { type: "settle" });
    expect(r.status).toBe(200);
    expect(r.body.state.state.playerId).toBe(p.id);
    expect(await load(b.id)).toEqual(before);
    const view = await api("game-state", { method: "GET", token: b.token });
    expect(view.body.state.state.playerId).toBe(b.id);
  });
});

describe("Edge Functions：冪等與並行（HTTP）", () => {
  it("同一個 key 重送：回應相同（Idempotent-Replayed: true），只扣款一次；不同指令 → 409", async () => {
    const p = await newPlayer();
    await pool.query(`update public.players set coins = 1000 where id = $1`, [p.id]);
    await pool.query(`insert into public.player_inventory values ($1, 'stone', 100)`, [p.id]);
    const key = randomUUID();
    const a = await act(p.token, { type: "purchase_pickaxe", pickaxeId: "pick_stone" }, key);
    const b = await act(p.token, { type: "purchase_pickaxe", pickaxeId: "pick_stone" }, key);
    expect(a.status).toBe(200);
    expect(a.headers.get("idempotent-replayed")).toBe("false");
    expect(b.headers.get("idempotent-replayed")).toBe("true");
    expect(b.body).toEqual(a.body);
    const c = await act(p.token, { type: "sell_items", itemId: "stone", quantity: 1 }, key);
    expect(c.status).toBe(409);
    expect(c.body).toMatchObject({ error: { code: "IDEMPOTENCY_MISMATCH" } });
    expect((await load(p.id)).inventory.stone).toBe(60);
  });

  it("同一個 key 同時送出 6 次：只套用一次", async () => {
    const p = await newPlayer();
    await pool.query(`insert into public.player_inventory values ($1, 'ruby', 10)`, [p.id]);
    const key = randomUUID();
    const rs = await Promise.all(Array.from({ length: 6 }, () => act(p.token, { type: "sell_items", itemId: "ruby", quantity: 3 }, key)));
    for (const r of rs) expect(r.body).toEqual(rs[0]!.body);
    expect((await load(p.id)).inventory.ruby).toBe(7);
  });

  it("兩個裝置同時領取同一份報告：只入帳一次", async () => {
    const p = await newPlayer();
    await rewind(p.id, 5 * HOUR);
    const s = await act(p.token, { type: "settle" });
    const reportId = s.body.report.reportId;
    const rs = await Promise.all(Array.from({ length: 3 }, () => act(p.token, { type: "claim_report", reportId })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    for (const r of rs.filter((x) => x.status !== 200)) expect(r.body).toMatchObject({ error: { code: "REPORT_ALREADY_CLAIMED" } });
    expect((await load(p.id)).coins).toBe(s.body.report.rewards.coins);
  });
});

describe("Edge Functions：遊戲邏輯", () => {
  it("初始角色、操作流程、重新登入後狀態一致", async () => {
    const p = await newPlayer();
    const st = await api("game-state", { method: "GET", token: p.token });
    expect(st.status).toBe(200);
    expect(st.body.state.state).toMatchObject({ playerId: p.id, coins: 0, pickaxes: { pick_wood: 1 }, equippedPickaxe: "pick_wood" });
    await pool.query(`update public.players set coins = 5000 where id = $1`, [p.id]);
    await pool.query(`insert into public.player_inventory values ($1, 'stone', 200), ($1, 'iron_ore', 50), ($1, 'coal', 20)`, [p.id]);
    for (const command of [
      { type: "purchase_pickaxe", pickaxeId: "pick_stone" },
      { type: "craft", materialId: "reinforce_stone", times: 2 },
      { type: "upgrade_pickaxe", pickaxeId: "pick_stone" },
      { type: "craft", materialId: "iron_ingot", times: 4 },
      { type: "sell_items", itemId: "stone", quantity: 5 },
    ] as GameCommand[]) {
      const r = await act(p.token, command);
      expect(r.status, JSON.stringify(r.body?.error)).toBe(200);
      expect(r.body.state.state).toEqual(await load(p.id));
    }
    // 重新登入（新的 JWT）後讀到完全相同的狀態
    const relogin = await signIn(p.email);
    const after = await api("game-state", { method: "GET", token: relogin.accessToken });
    expect(after.body.state.state).toEqual(await load(p.id));
    expect(after.body.state.state).toMatchObject({ pickaxes: { pick_wood: 1, pick_stone: 2 }, inventory: { iron_ingot: 4 } });
  });

  it("Edge（Deno）的計算與 Node 上相同快照的純引擎計算完全相同；引擎版本一致", async () => {
    const p = await newPlayer();
    await rewind(p.id, 3 * HOUR);
    const snap = await realBackend.db.loadSnapshot(p.id, null, null);
    if (snap.status !== "ok") throw new Error("load");
    const key = randomUUID();
    const r = await act(p.token, { type: "settle" }, key);
    expect(r.headers.get("x-engine-version")).toBe(engineInfo().engineVersion);
    const pure = executeRequest(snap.state as PlayerGameState, { requestId: key, command: { type: "settle" } }, {
      serverNow: r.body.state.state.lastSettledAt,
      rng: createBlockRng(Buffer.from(snap.rngSecret, "base64")),
    });
    expect(r.body.state.state).toEqual(pure.commit!.state);
    expect(r.body.events).toEqual(pure.events);
  });

  it("挖掘結果與 golden fixture 一致（經由 Edge Runtime）", async () => {
    const p = await newPlayer();
    const secret = sha256(new TextEncoder().encode("mining-expedition golden v1"));
    await pool.query(`update private.player_secrets set rng_secret = $2 where player_id = $1`, [p.id, Buffer.from(secret)]);
    await rewind(p.id, 12 * 7_500);
    const r = await act(p.token, { type: "settle" });
    expect(r.status).toBe(200);
    const golden = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../packages/game-engine/test/fixtures/golden-v1.json"), "utf8"));
    const first12 = golden.blocks.find((x: { label: string }) => x.label === "zone1 frontier 5m wood").first12;
    const blocks = r.body.events.filter((e: { type: string }) => e.type === "block_completed");
    expect(blocks).toHaveLength(12);
    blocks.forEach((b: Record<string, unknown>, i: number) => {
      expect({ items: b.items, coins: b.coins, layer2: b.layer2, layer4: b.layer4, artifact: b.artifact }).toEqual({
        items: first12[i].items, coins: first12[i].coins, layer2: first12[i].layer2, layer4: first12[i].layer4, artifact: first12[i].artifact,
      });
    });
  });

  it("D23：沒有完成方塊時不建立報告、不阻擋；D24：領取使用資料庫時間、不補算", async () => {
    const p = await newPlayer();
    await pool.query(`update public.players set frontier_block_index = 500, dig_counter = 500 where id = $1`, [p.id]);
    await rewind(p.id, 6 * HOUR);
    const r = await act(p.token, { type: "settle" });
    expect(r.body.settlement).toMatchObject({ kind: "offline", blocksMined: 0 });
    expect(r.body.report).toBeNull();
    expect((await act(p.token, { type: "select_mining_mode", mode: "rework" })).status).toBe(200);

    const q = await newPlayer();
    await rewind(q.id, 5 * HOUR);
    const settled = await act(q.token, { type: "settle" });
    const pending = await load(q.id);
    await new Promise((x) => setTimeout(x, 1_200));
    const claim = await act(q.token, { type: "claim_report", reportId: settled.body.report.reportId });
    expect(claim.status).toBe(200);
    const s = await load(q.id);
    expect(s.lastSettledAt).toBeGreaterThanOrEqual(pending.lastSettledAt + 1_000);
    expect(s.mining).toEqual(pending.mining);
    expect(s.pendingOfflineReport).toBeNull();
    const blocked = await act(q.token, { type: "claim_report", reportId: settled.body.report.reportId });
    expect(blocked.status).toBe(422);
    expect(blocked.body).toMatchObject({ error: { code: "REPORT_ALREADY_CLAIMED" } });
  });

  it("伺服器狀態異常時只回傳通用錯誤，不洩漏內部資訊", async () => {
    const p = await newPlayer();
    // 資料庫約束允許、但引擎不變式不允許的狀態：擁有鐵製卻沒有石製（十字鎬必須依序）
    await pool.query(`insert into public.player_pickaxes values ($1, 'pick_iron', 1)`, [p.id]);
    const r = await act(p.token, { type: "settle" });
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ ok: false, requestId: expect.any(String), command: "settle", error: { code: "INTERNAL_ERROR", message: "server state error" } });
    expectNoLeak(r);
    const st = await api("game-state", { method: "GET", token: p.token });
    expectNoLeak(st);
  });
});

describe("Edge Functions：12 小時離線最壞情境實測", () => {
  it("回訪 zone1、鑽石 Lv5、三套套組、離線 18 小時 → 模擬 12 小時（3,384 個方塊）", async () => {
    const p = await newPlayer();
    const id = p.id;
    // 準備最壞情境（PR #4 benchmark 窮舉的結果）
    for (const k of ["pick_stone", "pick_iron", "pick_gold", "pick_diamond"]) await pool.query(`insert into public.player_pickaxes values ($1, $2, 5)`, [id, k]);
    await pool.query(`update public.player_pickaxes set level = 5 where player_id = $1`, [id]);
    await pool.query(`update public.players set frontier_block_index = 1000, dig_counter = 1000, unlocked_zone = 1 where id = $1`, [id]);
    await pool.query(`update public.players set frontier_block_index = 2000, dig_counter = 2000, unlocked_zone = 2 where id = $1`, [id]);
    await pool.query(`update public.players set frontier_block_index = 3000, dig_counter = 3000, equipped_pickaxe = 'pick_diamond', mining_mode = 'revisit', revisit_zone = 0 where id = $1`, [id]);
    const sets = ["a_z1_lantern", "a_z1_badge", "a_z1_map", "a_z2_orb", "a_z2_crown", "a_z2_mural", "a_z3_emblem", "a_z3_ring", "a_z3_tablet"];
    for (const [i, a] of sets.entries()) {
      await pool.query(`insert into public.artifact_instances (player_id, instance_id, artifact_id, obtained_at_ms, mode, band, frontier_block_index, dig_counter, source) values ($1, $2, $3, 0, 'frontier', 0, 0, $4, 'drop')`, [id, `d${i}`, a, i]);
      await pool.query(`insert into public.artifact_discoveries values ($1, $2, 0, 0, 1)`, [id, a]);
    }
    await pool.query(`update public.first_treasure set status = 'obtained', resolved_at_ms = 0, artifact_instance_id = 'd0' where player_id = $1`, [id]);

    const runs: Record<string, number | string>[] = [];
    for (let i = 0; i < 3; i++) {
      await rewind(id, 18 * HOUR);
      const started = performance.now();
      const r = await act(p.token, { type: "settle" });
      const wall = performance.now() - started;
      expect(r.status, JSON.stringify(r.body?.error)).toBe(200);
      expect(r.body.settlement).toMatchObject({ kind: "offline", simulatedMs: 12 * HOUR, blocksMined: 3384 });
      const timing = Object.fromEntries((r.headers.get("server-timing") ?? "").split(",").map((x) => {
        const [name, ...rest] = x.trim().split(";");
        const dur = rest.find((y) => y.startsWith("dur="));
        return [name, dur ? Number(dur.slice(4)) : rest.join(";")];
      }));
      runs.push({ run: i + 1, clientWallMs: Math.round(wall), ...timing, memory: r.headers.get("x-diagnostics-memory") ?? "n/a", responseKB: Math.round(r.text.length / 1024) });
      // 領取報告，讓下一輪可以再次倒轉時間
      const c = await act(p.token, { type: "claim_report", reportId: r.body.report.reportId });
      expect(c.status).toBe(200);
    }
    console.log(`EDGE_BENCHMARK ${JSON.stringify(runs)}`);
    for (const r of runs) {
      // Supabase 託管限制：CPU 2 s / 請求（不含非同步 I/O）、記憶體 256 MB、請求閒置逾時 150 s
      expect(Number(r.compute)).toBeLessThan(500);
      expect(Number(r.clientWallMs)).toBeLessThan(10_000);
    }
  });
});
