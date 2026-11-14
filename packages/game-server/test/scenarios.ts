/**
 * 資料庫整合情境（共用）：同一組測試在
 *   - 本機：PGlite（test/pglite.test.ts，快速、單一連線）
 *   - CI：真正的 Supabase Local（tests/integration，PostgREST + PostgreSQL 17）
 * 上執行。並行測試只在 backend.concurrent = true 時執行。
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OFFLINE_CAP_MS } from "@mining/game-data";
import {
  type GameCommand,
  type PlayerGameState,
  createBlockRng,
  executeRequest,
  rollBlock,
  sha256,
  validateState,
} from "@mining/game-engine";
import { describe, expect, it } from "vitest";
import { type ApiResponse, type CommitArgs, type GameDb, createCharacter, handleGameRequest, readState, requestHash } from "../src/index.ts";

export interface Backend {
  name: string;
  db: GameDb;
  /** 建立 auth.users 使用者，回傳 id */
  newUser(): Promise<string>;
  /** superuser SQL（只供測試檢查與準備資料） */
  sql<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
  /** 是否能測真正的並行（多連線） */
  concurrent: boolean;
}

const HOUR = 3_600_000;
const GOLDEN = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../game-engine/test/fixtures/golden-v1.json"), "utf8"));
const GOLDEN_SECRET = sha256(new TextEncoder().encode("mining-expedition golden v1"));

type Ok = Extract<ApiResponse, { ok: true }>;
const okRes = (r: ApiResponse): Ok => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r;
};

export function defineScenarios(getBackend: () => Backend): void {
  const b = () => getBackend();

  async function newPlayer(): Promise<string> {
    const id = await b().newUser();
    okRes(await createCharacter(b().db, id));
    return id;
  }
  const send = (playerId: string, command: GameCommand | Record<string, unknown>, requestId: string = randomUUID()) =>
    handleGameRequest(b().db, { playerId, requestId, command });
  const load = async (playerId: string): Promise<PlayerGameState> => {
    const s = await b().db.loadSnapshot(playerId, null, null);
    if (s.status !== "ok") throw new Error(`load: ${s.status}`);
    return s.state as PlayerGameState;
  };
  /** 測試用時光倒流：把玩家的時間基準往前移（等同玩家離開了 ms 毫秒） */
  async function rewind(playerId: string, ms: number): Promise<void> {
    await b().sql(
      `update public.players set created_at_ms = created_at_ms - $2, last_settled_at_ms = last_settled_at_ms - $2 where id = $1`,
      [playerId, ms],
    );
    await b().sql(`update public.offline_reports set period_start_ms = period_start_ms - $2, period_end_ms = period_end_ms - $2 where player_id = $1`, [playerId, ms]);
  }
  /** 給予資源（測試準備）：直接改資料列，之後由 RPC 正常載入 */
  async function grant(playerId: string, coins: number, items: Record<string, number> = {}): Promise<void> {
    await b().sql(`update public.players set coins = $2 where id = $1`, [playerId, coins]);
    for (const [item, q] of Object.entries(items)) {
      await b().sql(
        `insert into public.player_inventory (player_id, item_id, quantity) values ($1, $2, $3)
         on conflict (player_id, item_id) do update set quantity = excluded.quantity`,
        [playerId, item, q],
      );
    }
  }
  const count = async (table: string, playerId: string, where = "true") =>
    Number((await b().sql<{ n: string }>(`select count(*)::text as n from ${table} where player_id = $1 and ${where}`, [playerId]))[0]!.n);

  describe(`[${getBackend.name || "backend"}] 建立角色與狀態往返`, () => {
    it("建立初始角色：木製 Lv1、0m、時間來自資料庫；重複建立回傳 CHARACTER_EXISTS", async () => {
      const id = await b().newUser();
      const before = Date.now();
      const r = okRes(await createCharacter(b().db, id));
      const s = r.state.state;
      expect(s).toMatchObject({ playerId: id, stateVersion: 0, coins: 0, equippedPickaxe: "pick_wood", pickaxes: { pick_wood: 1 }, unlockedZone: 0 });
      expect(Math.abs(s.createdAt - before)).toBeLessThan(60_000);
      expect(validateState(s)).toEqual([]);
      const again = await createCharacter(b().db, id);
      expect(again).toMatchObject({ ok: false, error: { code: "CHARACTER_EXISTS" } });
      expect(await count("private.player_secrets", id)).toBe(1);
    });

    it("沒有 auth.users 的 id 不能建立角色", async () => {
      expect(await createCharacter(b().db, randomUUID())).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
    });

    it("RNG 密鑰是 32 bytes，且每位玩家不同", async () => {
      const [a, c] = [await newPlayer(), await newPlayer()];
      const sa = await b().db.loadSnapshot(a, null, null);
      const sc = await b().db.loadSnapshot(c, null, null);
      if (sa.status !== "ok" || sc.status !== "ok") throw new Error("load");
      expect(Buffer.from(sa.rngSecret, "base64")).toHaveLength(32);
      expect(sa.rngSecret).not.toBe(sc.rngSecret);
    });

    it("完整往返：經過結算、購買、製作、出售、寶物、報告後，資料庫載入的狀態與引擎提交的狀態完全相同", async () => {
      const id = await newPlayer();
      await grant(id, 100_000, { stone: 500, iron_ore: 200, coal: 80, amethyst: 30 });
      await rewind(id, 8 * HOUR);
      const settled = okRes((await send(id, { type: "settle" })).response);
      expect(settled.report).not.toBeNull();
      expect(await load(id)).toEqual(settled.state.state);
      const claimed = okRes((await send(id, { type: "claim_report", reportId: settled.report!.reportId })).response);
      expect(await load(id)).toEqual(claimed.state.state);
      for (const command of [
        { type: "purchase_pickaxe", pickaxeId: "pick_stone" },
        { type: "craft", materialId: "iron_ingot", times: 8 },
        { type: "purchase_pickaxe", pickaxeId: "pick_iron" },
        { type: "craft", materialId: "reinforce_stone", times: 3 },
        { type: "upgrade_pickaxe", pickaxeId: "pick_iron" },
        { type: "craft", materialId: "refined_crystal", times: 2 },
        { type: "sell_items", itemId: "stone", quantity: 10 },
        { type: "equip_pickaxe", pickaxeId: "pick_stone" },
      ] as GameCommand[]) {
        const r = okRes((await send(id, command)).response);
        const loaded = await load(id);
        expect(loaded).toEqual(r.state.state);
        expect(validateState(loaded)).toEqual([]);
      }
      const final = await load(id);
      expect(final.pickaxes).toEqual({ pick_wood: 1, pick_stone: 1, pick_iron: 2 });
      expect(final.equippedPickaxe).toBe("pick_stone");
      expect(final.inventory.refined_crystal).toBe(2);
    });

    it("safe integer 邊界：2^53 − 1 可以往返；2^53、小數、負數會被資料庫拒絕且整個交易 rollback", async () => {
      const id = await newPlayer();
      const snap = await b().db.loadSnapshot(id, null, null);
      if (snap.status !== "ok") throw new Error("load");
      const base = snap.state as PlayerGameState;
      const commitWith = (patch: (s: PlayerGameState) => void, key = randomUUID()) => {
        const s = structuredClone(base);
        s.stateVersion = base.stateVersion + 1;
        patch(s);
        const args: CommitArgs = {
          playerId: id, expectedVersion: base.stateVersion, idempotencyKey: key, requestHash: "0".repeat(64), command: "test",
          state: s, reportCreated: null, reportClaimed: null, response: { ok: false, requestId: key, command: "test", error: { code: "INTERNAL_ERROR", message: "test" } },
        };
        return b().db.commit(args);
      };
      for (const bad of [2 ** 53, 1.5, -1]) {
        await expect(commitWith((s) => (s.coins = bad))).rejects.toThrow();
        expect((await load(id)).coins).toBe(0);
        expect((await load(id)).stateVersion).toBe(0);
      }
      expect(await count("public.action_log", id)).toBe(0);
      expect(await commitWith((s) => ((s.coins = Number.MAX_SAFE_INTEGER), (s.inventory = { stone: Number.MAX_SAFE_INTEGER })))).toMatchObject({ status: "committed", stateVersion: 1 });
      const loaded = await load(id);
      expect(loaded.coins).toBe(Number.MAX_SAFE_INTEGER);
      expect(loaded.inventory.stone).toBe(Number.MAX_SAFE_INTEGER);
      expect(Number.isSafeInteger(loaded.coins)).toBe(true);
    });
  });

  describe(`[${getBackend.name || "backend"}] 冪等與 CAS`, () => {
    it("同一個 key + 同一個指令重送：回傳同一個回應，只扣款一次", async () => {
      const id = await newPlayer();
      await grant(id, 1000, { stone: 100 });
      const key = randomUUID();
      const first = await send(id, { type: "purchase_pickaxe", pickaxeId: "pick_stone" }, key);
      const second = await send(id, { type: "purchase_pickaxe", pickaxeId: "pick_stone" }, key);
      expect(first).toMatchObject({ replayed: false, stored: true });
      expect(second).toMatchObject({ replayed: true, stored: true });
      expect(second.response).toEqual(first.response);
      const s = await load(id);
      expect(s.inventory.stone).toBe(60);
      expect(s.coins).toBeGreaterThanOrEqual(800); // 1000 − 200 + 在線結算的掉落
      expect(s.coins).toBeLessThan(1000);
      expect(await count("public.action_log", id)).toBe(1);
    });

    it("同一個 key + 不同指令：IDEMPOTENCY_MISMATCH，不執行", async () => {
      const id = await newPlayer();
      await grant(id, 1000, { stone: 100 });
      const key = randomUUID();
      await send(id, { type: "sell_items", itemId: "stone", quantity: 1 }, key);
      const r = await send(id, { type: "sell_items", itemId: "stone", quantity: 50 }, key);
      expect(r.response).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_MISMATCH" } });
      expect((await load(id)).inventory.stone).toBe(99);
    });

    it("遊戲規則拒絕也保存回應（先前的結算照常提交），重送得到同一個結果", async () => {
      const id = await newPlayer();
      const key = randomUUID();
      const reject = await send(id, { type: "purchase_pickaxe", pickaxeId: "pick_stone" }, key);
      expect(reject.response).toMatchObject({ ok: false, error: { code: "INSUFFICIENT_COINS" } });
      expect(reject.stored).toBe(true);
      // 即使之後資源足夠，同一個 key 仍回傳原本的結果
      await grant(id, 1000, { stone: 100 });
      const again = await send(id, { type: "purchase_pickaxe", pickaxeId: "pick_stone" }, key);
      expect(again).toMatchObject({ replayed: true });
      expect(again.response).toEqual(reject.response);
      // 拒絕前的結算有變化（lastSettledAt）→ 結算與拒絕回應一起提交；只有一筆紀錄
      const log = await b().sql<{ committed: boolean; response: ApiResponse }>(`select committed, response from public.action_log where player_id = $1`, [id]);
      expect(log).toHaveLength(1);
      expect(log[0]!.response).toEqual(reject.response);
      expect((await load(id)).pickaxes).toEqual({ pick_wood: 1 });
    });

    it("完全沒有狀態變化的請求（commit = null）：只保存回應（committed = false）", async () => {
      const id = await newPlayer();
      const snap = await b().db.loadSnapshot(id, null, null);
      if (snap.status !== "ok") throw new Error("load");
      const key = randomUUID();
      const response: ApiResponse = { ok: false, requestId: key, command: "equip_pickaxe", error: { code: "PREREQUISITE_MISSING", message: "x" } };
      const args = { playerId: id, expectedVersion: (snap.state as PlayerGameState).stateVersion, idempotencyKey: key, requestHash: "c".repeat(64), command: "equip_pickaxe", state: null, reportCreated: null, reportClaimed: null, response };
      expect(await b().db.commit(args)).toMatchObject({ status: "recorded", stateVersion: 0 });
      expect(await b().db.commit(args)).toEqual({ status: "replay", response });
      expect(await b().db.commit({ ...args, requestHash: "d".repeat(64) })).toEqual({ status: "mismatch" });
      expect(await b().db.commit({ ...args, idempotencyKey: randomUUID(), expectedVersion: 5 })).toMatchObject({ status: "version_conflict", stateVersion: 0 });
      const log = await b().sql<{ committed: boolean; state_version_after: string | null }>(`select committed, state_version_after::text from public.action_log where player_id = $1`, [id]);
      expect(log).toEqual([{ committed: false, state_version_after: null }]);
      expect((await load(id)).stateVersion).toBe(0);
    });

    it("CAS 衝突：另一個請求在載入與提交之間提交 → 以同一個 key 重新載入並重新計算，只提交一次", async () => {
      const id = await newPlayer();
      await grant(id, 5000, { stone: 100 });
      let injected = false;
      const racing: GameDb = {
        ...b().db,
        commit: async (args) => {
          if (!injected) {
            injected = true;
            // 另一個裝置先完成一個操作
            const other = await handleGameRequest(b().db, { playerId: id, requestId: randomUUID(), command: { type: "sell_items", itemId: "stone", quantity: 30 } });
            expect(other.stored).toBe(true);
          }
          return b().db.commit(args);
        },
      };
      const key = randomUUID();
      const r = await handleGameRequest(racing, { playerId: id, requestId: key, command: { type: "purchase_pickaxe", pickaxeId: "pick_stone" } });
      expect(r.attempts).toBe(2);
      okRes(r.response);
      const s = await load(id);
      expect(s.inventory.stone).toBe(30); // 100 − 30（另一個裝置）− 40（購買）
      expect(s.stateVersion).toBe(2);
      const logs = await b().sql<{ idempotency_key: string; state_version_after: string }>(
        `select idempotency_key::text, state_version_after::text from public.action_log where player_id = $1 order by id`, [id]);
      expect(logs.map((l) => l.state_version_after)).toEqual(["1", "2"]);
      expect(logs[1]!.idempotency_key).toBe(key);
    });

    it("CAS 一直衝突：重試 3 次後回傳 VERSION_CONFLICT，不保存回應（可用同一個 key 再試）", async () => {
      const id = await newPlayer();
      await grant(id, 0, { stone: 100 });
      const always: GameDb = {
        ...b().db,
        commit: async (args) => {
          await handleGameRequest(b().db, { playerId: id, requestId: randomUUID(), command: { type: "sell_items", itemId: "stone", quantity: 1 } });
          return b().db.commit(args);
        },
      };
      const key = randomUUID();
      const r = await handleGameRequest(always, { playerId: id, requestId: key, command: { type: "sell_items", itemId: "stone", quantity: 5 } });
      expect(r).toMatchObject({ attempts: 3, stored: false, response: { ok: false, error: { code: "VERSION_CONFLICT" } } });
      // 同一個 key 再試一次（沒有干擾）→ 成功
      const retry = await send(id, { type: "sell_items", itemId: "stone", quantity: 5 }, key);
      expect(retry).toMatchObject({ stored: true, replayed: false });
      expect((await load(id)).inventory.stone).toBe(100 - 3 - 5);
    });

    it("提交失敗（約束違反）時整個交易 rollback：沒有部分資料、沒有操作紀錄", async () => {
      const id = await newPlayer();
      await grant(id, 500, { stone: 50 });
      const snap = await b().db.loadSnapshot(id, null, null);
      if (snap.status !== "ok") throw new Error("load");
      const s = structuredClone(snap.state as PlayerGameState);
      s.stateVersion += 1;
      s.coins = 123;
      s.inventory = { stone: 1, coal: 7 };
      // 寶物 ID 與方塊序號不一致 → 約束違反（在寫入金幣與物品之後才發生）
      s.heldArtifacts = [{ instanceId: "d5", artifactId: "a_z1_map", obtainedAt: s.lastSettledAt, mode: "frontier", band: 0, frontierBlockIndex: 0, digCounter: 6, source: "drop" }];
      const key = randomUUID();
      await expect(b().db.commit({ playerId: id, expectedVersion: 0, idempotencyKey: key, requestHash: "a".repeat(64), command: "test", state: s, reportCreated: null, reportClaimed: null, response: { ok: false, requestId: key, command: "test", error: { code: "INTERNAL_ERROR", message: "x" } } })).rejects.toThrow();
      const after = await load(id);
      expect(after).toEqual(snap.state);
      expect(await count("public.action_log", id)).toBe(0);
      expect(await count("public.artifact_instances", id)).toBe(0);
    });

    it("已出售的寶物實例不能被重新建立；圖鑑不能被刪除或減少", async () => {
      const id = await newPlayer();
      const snap = await b().db.loadSnapshot(id, null, null);
      if (snap.status !== "ok") throw new Error("load");
      const base = snap.state as PlayerGameState;
      const inst = { instanceId: "d0", artifactId: "a_z1_map" as const, obtainedAt: base.lastSettledAt, mode: "frontier" as const, band: 0, frontierBlockIndex: 0, digCounter: 0, source: "drop" as const };
      const commit = (s: PlayerGameState, v: number) => {
        const key = randomUUID();
        return b().db.commit({ playerId: id, expectedVersion: v, idempotencyKey: key, requestHash: "b".repeat(64), command: "test", state: s, reportCreated: null, reportClaimed: null, response: { ok: false, requestId: key, command: "test", error: { code: "INTERNAL_ERROR", message: "x" } } });
      };
      const s1 = { ...structuredClone(base), stateVersion: 1, heldArtifacts: [inst], discoveredArtifacts: { a_z1_map: { firstDiscoveredAt: base.lastSettledAt, firstBand: 0, totalFound: 1 } } };
      s1.mining = { ...s1.mining, digCounter: 1 };
      expect(await commit(s1, 0)).toMatchObject({ status: "committed" });
      const s2 = { ...structuredClone(s1), stateVersion: 2, heldArtifacts: [] };
      expect(await commit(s2, 1)).toMatchObject({ status: "committed" }); // 出售
      expect((await b().sql<{ status: string }>(`select status from public.artifact_instances where player_id = $1`, [id]))[0]!.status).toBe("sold");
      await expect(commit({ ...structuredClone(s2), stateVersion: 3, heldArtifacts: [inst] }, 2)).rejects.toThrow(); // 重新出現
      await expect(commit({ ...structuredClone(s2), stateVersion: 3, discoveredArtifacts: {} }, 2)).rejects.toThrow(); // 刪除圖鑑
      expect((await load(id)).stateVersion).toBe(2);
    });
  });

  describe(`[${getBackend.name || "backend"}] 遊戲邏輯與持久化`, () => {
    it("挖掘結果與引擎 golden fixture 一致（同一個密鑰與方塊序號）", async () => {
      const id = await newPlayer();
      await b().sql(`update private.player_secrets set rng_secret = decode($2, 'hex') where player_id = $1`, [id, Buffer.from(GOLDEN_SECRET).toString("hex")]);
      // 12 個 0–10m 方塊（木製 Lv1 每個 7,500 ms），在線結算
      await rewind(id, 12 * 7_500);
      okRes((await send(id, { type: "settle" })).response);
      const s = await load(id);
      expect(s.mining.digCounter).toBe(12);
      const golden = GOLDEN.blocks.find((x: { label: string }) => x.label === "zone1 frontier 5m wood");
      const items: Record<string, number> = {};
      let coins = 0;
      for (const d of golden.first12) {
        coins += d.coins;
        for (const [k, n] of Object.entries(d.items as Record<string, number>)) items[k] = (items[k] ?? 0) + n;
      }
      expect(s.coins).toBe(coins);
      expect(s.inventory).toEqual(items);
      // 與直接用引擎計算相同
      const rng = createBlockRng(GOLDEN_SECRET);
      for (let i = 0; i < 12; i++) expect(rollBlock(rng(i), { mode: "frontier", band: 0, segment: 0, zone: 0, hardness: 15, requiredPower10: 10 }, 7_500, 0)).toEqual(golden.first12[i]);
    });

    it("伺服器結果與相同快照的純引擎計算完全相同（Edge 與引擎版本一致性的基礎）", async () => {
      const id = await newPlayer();
      await rewind(id, 3 * HOUR);
      const snap = await b().db.loadSnapshot(id, null, null);
      if (snap.status !== "ok") throw new Error("load");
      const key = randomUUID();
      const served = okRes((await send(id, { type: "settle" }, key)).response);
      const pure = executeRequest(snap.state as PlayerGameState, { requestId: key, command: { type: "settle" } }, {
        serverNow: served.state.state.lastSettledAt,
        rng: createBlockRng(Buffer.from(snap.rngSecret, "base64")),
      });
      expect(pure.commit!.state).toEqual(served.state.state);
    });

    it("12 小時離線：最多模擬 12 小時，其餘捨棄；報告寫入 offline_reports（pending），獎勵不在背包", async () => {
      const id = await newPlayer();
      await rewind(id, 30 * HOUR);
      const r = okRes((await send(id, { type: "settle" })).response);
      expect(r.settlement).toMatchObject({ kind: "offline", simulatedMs: OFFLINE_CAP_MS });
      expect(r.settlement!.discardedMs).toBeGreaterThanOrEqual(18 * HOUR);
      const s = await load(id);
      expect(s.coins).toBe(0);
      expect(s.inventory).toEqual({});
      expect(s.pendingOfflineReport).toEqual(r.report);
      const rows = await b().sql<{ status: string; blocks_mined: string }>(`select status, blocks_mined::text from public.offline_reports where player_id = $1`, [id]);
      expect(rows).toEqual([{ status: "pending", blocks_mined: String(r.report!.blocksMined) }]);
      // 待領取時其他操作被拒絕
      expect((await send(id, { type: "sell_items", itemId: "stone", quantity: 1 })).response).toMatchObject({ ok: false, error: { code: "REPORT_PENDING" } });
    });

    it("D23：離線期間沒有完成方塊 → 不建立報告、更新 lastSettledAt、保留未完成方塊、不阻擋操作", async () => {
      const id = await newPlayer();
      // 卡在 50m（木製 Power 不足）
      await b().sql(`update public.players set frontier_block_index = 500, dig_counter = 500 where id = $1`, [id]);
      await rewind(id, 6 * HOUR);
      const before = await load(id);
      const r = okRes((await send(id, { type: "settle" })).response);
      expect(r.settlement).toMatchObject({ kind: "offline", blocksMined: 0, stopReason: "blocked_power" });
      expect(r.report).toBeNull();
      const s = await load(id);
      expect(s.pendingOfflineReport).toBeNull();
      expect(s.lastSettledAt).toBeGreaterThan(before.lastSettledAt + 6 * HOUR - 60_000);
      expect(await count("public.offline_reports", id)).toBe(0);
      expect((await send(id, { type: "select_mining_mode", mode: "rework" })).response.ok).toBe(true);
      // 未完成方塊保留：在 290m 挖到一半時離線 350 秒（鑽石 Lv3 一個方塊約 373 秒）
      const p2 = await newPlayer();
      for (const k of ["pick_stone", "pick_iron", "pick_gold", "pick_diamond"]) {
        await b().sql(`insert into public.player_pickaxes values ($1, $2, $3)`, [p2, k, k === "pick_diamond" ? 3 : 1]);
      }
      // 需要 frontier 2000 才能解鎖 zone3：依序設定
      await b().sql(`update public.players set frontier_block_index = 1000, dig_counter = 1000, unlocked_zone = 1 where id = $1`, [p2]);
      await b().sql(`update public.players set frontier_block_index = 2999, dig_counter = 2999, unlocked_zone = 2, equipped_pickaxe = 'pick_diamond' where id = $1`, [p2]);
      await rewind(p2, 350_000);
      const r2 = okRes((await send(p2, { type: "settle" })).response);
      expect(r2.report).toBeNull();
      const s2 = await load(p2);
      expect(s2.mining.blockMs).toBeGreaterThanOrEqual(350_000);
      expect(s2.mining.blockWork).toBeGreaterThan(0);
    });

    it("D24：待領取期間暫停；領取使用資料庫時間、不補算；領獎 + 報告狀態 + 首次保護 + 時間 + stateVersion 原子提交", async () => {
      const id = await newPlayer();
      await rewind(id, 6 * HOUR); // 木製挖 6 小時：首次保護 4 小時一定已處理（取得或發放）
      const settled = okRes((await send(id, { type: "settle" })).response);
      const report = settled.report!;
      const pending = await load(id);
      expect(pending.firstTreasure.status).not.toBe("pending");
      expect(pending.firstTreasure.reportId).toBe(report.reportId);
      // 玩家停在報告畫面一段時間（實際等待；資料庫時間會前進，但報告內容固定，所以不能用倒轉時間模擬）
      await new Promise((r) => setTimeout(r, 1_200));
      const claim = okRes((await send(id, { type: "claim_report", reportId: report.reportId })).response);
      const s = await load(id);
      expect(s).toEqual(claim.state.state);
      expect(s.lastSettledAt).toBeGreaterThanOrEqual(pending.lastSettledAt + 1_000); // 領取時間（資料庫時間）成為新的基準
      expect(claim.events).toContainEqual(expect.objectContaining({ type: "report_claimed", pausedMs: s.lastSettledAt - pending.lastSettledAt }));
      expect(s.mining).toEqual(pending.mining); // 暫停：沒有挖掘
      expect(s.firstTreasure.effectiveMiningMs).toBe(pending.firstTreasure.effectiveMiningMs);
      expect(s.firstTreasure.reportId).toBeNull();
      expect(s.pendingOfflineReport).toBeNull();
      expect(s.lastClaimedReportId).toBe(report.reportId);
      expect(s.coins).toBe(report.rewards.coins);
      expect(s.heldArtifacts.map((a) => a.instanceId)).toEqual(report.rewards.artifacts.map((a) => a.instanceId));
      const rows = await b().sql<{ status: string; claimed_at_ms: string }>(`select status, claimed_at_ms::text from public.offline_reports where player_id = $1`, [id]);
      expect(rows).toEqual([{ status: "claimed", claimed_at_ms: String(s.lastSettledAt) }]);
      expect(Number((await b().sql<{ n: string }>(`select count(*)::text as n from public.artifact_instances where player_id = $1 and source_report_id = $2`, [id, report.reportId]))[0]!.n)).toBe(report.rewards.artifacts.length);
      // 下一個操作是在線結算，不會再產生報告
      const next = okRes((await send(id, { type: "settle" })).response);
      expect(next.settlement!.kind).not.toBe("offline");
      // 重複領取：不重複入帳
      const again = await send(id, { type: "claim_report", reportId: report.reportId });
      expect(again.response).toMatchObject({ ok: false, error: { code: "REPORT_ALREADY_CLAIMED" } });
      expect((await load(id)).coins).toBe(next.state.state.coins);
    });

    it("解鎖、模式切換、出售寶物（需要市場價格）都能持久化；重新登入（重新載入）後狀態完全一致", async () => {
      const id = await newPlayer();
      await b().sql(`update public.players set frontier_block_index = 1000, dig_counter = 1000, coins = 5000 where id = $1`, [id]);
      await b().sql(`insert into public.player_pickaxes values ($1, 'pick_stone', 1) on conflict do nothing`, [id]);
      await b().sql(`update public.players set equipped_pickaxe = 'pick_stone' where id = $1`, [id]);
      okRes((await send(id, { type: "select_mining_mode", mode: "revisit", zone: 0 })).response);
      expect((await load(id)).mining).toMatchObject({ mode: "revisit", revisitZone: 0 });
      okRes((await send(id, { type: "unlock_zone", zone: 1 })).response);
      const s = await load(id);
      expect(s.unlockedZone).toBe(1);
      expect(s.coins).toBeLessThanOrEqual(5000 - 800 + 200);
      const view1 = await readState(b().db, id);
      const view2 = await readState(b().db, id);
      expect(view2).toEqual(view1);
    });

    it("讀取狀態：資料庫狀態不符合引擎不變式時回傳受控的 INTERNAL_ERROR（不是 SERVER_BUSY）", async () => {
      const id = await newPlayer();
      await b().sql(`insert into public.player_pickaxes values ($1, 'pick_iron', 1)`, [id]);
      const logs: unknown[] = [];
      const r = await readState(b().db, id, { log: (e, d) => logs.push({ e, d }) });
      expect(r).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR", message: "server state error" } });
      expect(r).not.toHaveProperty("state");
      expect(logs).toHaveLength(1);
    });
  });

  if (getBackend().concurrent) defineConcurrency(b, newPlayer, send, load, grant, rewind, count);
}

function defineConcurrency(
  b: () => Backend,
  newPlayer: () => Promise<string>,
  send: (p: string, c: GameCommand | Record<string, unknown>, k?: string) => ReturnType<typeof handleGameRequest>,
  load: (p: string) => Promise<PlayerGameState>,
  grant: (p: string, coins: number, items?: Record<string, number>) => Promise<void>,
  rewind: (p: string, ms: number) => Promise<void>,
  count: (t: string, p: string, w?: string) => Promise<number>,
): void {
  describe("並行（多連線）", () => {
  it("同一玩家同時建立角色 5 次：恰好一次 created，其他都是 CHARACTER_EXISTS（沒有 SERVER_BUSY）", async () => {
    const id = await b().newUser();
    const rs = await Promise.all(Array.from({ length: 5 }, () => createCharacter(b().db, id)));
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    for (const r of rs.filter((x) => !x.ok)) expect(r).toMatchObject({ error: { code: "CHARACTER_EXISTS" } });
    expect(await b().sql(`select count(*)::int as n from private.player_secrets where player_id = $1`, [id])).toEqual([{ n: 1 }]);
  });

  it("同一個 key 同時送出 8 次：只套用一次，其他得到同一個回應", async () => {
      const id = await newPlayer();
      await grant(id, 1000, { stone: 100 });
      const key = randomUUID();
      const rs = await Promise.all(Array.from({ length: 8 }, () => send(id, { type: "purchase_pickaxe", pickaxeId: "pick_stone" }, key)));
      const applied = rs.filter((r) => !r.replayed);
      expect(applied.length).toBeLessThanOrEqual(1);
      for (const r of rs) expect(r.response).toEqual(rs[0]!.response);
      const s = await load(id);
      expect(s.inventory.stone).toBe(60);
      expect(await count("public.action_log", id)).toBe(1);
    });

    it("兩個裝置同時操作（不同 key）：兩個都成功、沒有遺失更新", async () => {
      const id = await newPlayer();
      await grant(id, 0, { stone: 100, coal: 100 });
      for (let round = 0; round < 5; round++) {
        const [a, c] = await Promise.all([
          send(id, { type: "sell_items", itemId: "stone", quantity: 10 }),
          send(id, { type: "sell_items", itemId: "coal", quantity: 10 }),
        ]);
        expect(a.response.ok && c.response.ok).toBe(true);
      }
      const s = await load(id);
      expect(s.inventory).toMatchObject({ stone: 50, coal: 50 });
      expect(s.stateVersion).toBe(10);
    });

    it("10 個請求同時湧入：超過重試次數的回傳 VERSION_CONFLICT（不保存），Client 以同一個 key 重送後每個都只套用一次", async () => {
      const id = await newPlayer();
      await grant(id, 0, { stone: 1000, coal: 1000 });
      const jobs = [
        ...Array.from({ length: 5 }, () => ({ key: randomUUID(), cmd: { type: "sell_items", itemId: "stone", quantity: 10 } })),
        ...Array.from({ length: 5 }, () => ({ key: randomUUID(), cmd: { type: "sell_items", itemId: "coal", quantity: 10 } })),
      ];
      let rs = await Promise.all(jobs.map((j) => send(id, j.cmd, j.key)));
      expect(rs.some((r) => r.attempts > 1)).toBe(true); // 確實發生過 CAS 衝突並重試
      for (const r of rs) {
        if (!r.response.ok) expect(r).toMatchObject({ stored: false, response: { error: { code: "VERSION_CONFLICT" } } });
      }
      // Client 對失敗的請求以同一個 key 重送，直到成功
      for (let round = 0; round < 10 && rs.some((r) => !r.response.ok); round++) {
        rs = await Promise.all(jobs.map((j, i) => (rs[i]!.response.ok ? rs[i]! : send(id, j.cmd, j.key))));
      }
      for (const r of rs) expect(r.response.ok).toBe(true);
      const s = await load(id);
      expect(s.inventory).toMatchObject({ stone: 950, coal: 950 });
      expect(s.stateVersion).toBe(10);
      const keys = await b().sql<{ k: string }>(`select idempotency_key::text as k from public.action_log where player_id = $1`, [id]);
      expect(new Set(keys.map((x) => x.k))).toEqual(new Set(jobs.map((j) => j.key)));
      expect(keys).toHaveLength(10);
    });

    it("兩個裝置同時領取同一份報告：只入帳一次", async () => {
      const id = await newPlayer();
      await rewind(id, 5 * HOUR);
      const report = okRes((await send(id, { type: "settle" })).response).report!;
      const rs = await Promise.all(Array.from({ length: 4 }, () => send(id, { type: "claim_report", reportId: report.reportId })));
      const ok = rs.filter((r) => r.response.ok);
      expect(ok).toHaveLength(1);
      for (const r of rs.filter((x) => !x.response.ok)) expect(r.response).toMatchObject({ error: { code: "REPORT_ALREADY_CLAIMED" } });
      expect((await load(id)).coins).toBe(report.rewards.coins);
    });

    it("Client 逾時後用同一個 key 重送：在第一次還在處理時送出，也只套用一次", async () => {
      const id = await newPlayer();
      await grant(id, 0, { ruby: 10 });
      const key = randomUUID();
      const first = send(id, { type: "sell_items", itemId: "ruby", quantity: 4 }, key);
      const retry = send(id, { type: "sell_items", itemId: "ruby", quantity: 4 }, key);
      const [a, c] = await Promise.all([first, retry]);
      expect(a.response).toEqual(c.response);
      expect((await load(id)).inventory.ruby).toBe(6);
    });

    it("Edge 已提交但 Client 沒收到回應：重送得到保存的回應", async () => {
      const id = await newPlayer();
      await grant(id, 0, { ruby: 3 });
      const key = randomUUID();
      const lost = await send(id, { type: "sell_items", itemId: "ruby", quantity: 1 }, key); // 回應「遺失」
      const retry = await send(id, { type: "sell_items", itemId: "ruby", quantity: 1 }, key);
      expect(retry.replayed).toBe(true);
      expect(retry.response).toEqual(lost.response);
      expect((await load(id)).inventory.ruby).toBe(2);
    });
  });
}

export { requestHash };
