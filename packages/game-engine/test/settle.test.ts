import { FIRST_TREASURE_PROTECT_MS, OFFLINE_CAP_MS } from "@mining/game-data";
import { describe, expect, it } from "vitest";
import {
  type PlayerGameState,
  SequenceSource,
  applyAction,
  blockMs as blockMsFor,
  createBlockRng,
  currentStats,
  frontierSpot,
  settle,
  sha256,
  validateState,
} from "../src/index.ts";
import { HOUR, MIN, T0, deepFreeze, giveArtifact, makeState, rng } from "./support/fixtures.ts";

const ok = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify((r as { error?: unknown }).error)}`);
  return r as Extract<T, { ok: true }>;
};
const settleAt = (s: PlayerGameState, now: number, options?: Parameters<typeof settle>[1]["options"]) => ok(settle(s, { serverNow: now, rng, options }));
/** 在線：每段 ≤ 300 秒 */
function settleOnlineInSteps(s: PlayerGameState, end: number, steps: (i: number) => number): PlayerGameState {
  let i = 0;
  while (s.lastSettledAt < end) {
    const next = Math.min(end, s.lastSettledAt + steps(i++));
    s = settleAt(s, next).state;
  }
  return s;
}

describe("時間與挖掘", () => {
  it("同一段時間一次結算與分段結算的結果一致（在線，含套組變化與未完成方塊）", () => {
    const start = makeState({ tier: 1, level: 3, frontier: 120 });
    const end = T0 + 4 * HOUR;
    const a = settleOnlineInSteps(start, end, () => 300_000);
    let x = 7;
    const b = settleOnlineInSteps(start, end, () => ((x = (x * 48_271) % 2_147_483_647), 1 + (x % 300_000)));
    expect(b).toEqual(a);
    expect(a.mining.digCounter).toBeGreaterThan(500);
    expect(validateState(a)).toEqual([]);
  });

  it("未完成方塊的工作量與時間保留到下一次結算", () => {
    const s = makeState({ frontier: 200 }); // band 2：Hardness 85，木製 Lv1 需要 42.5 秒
    const part = settleAt(s, T0 + 20_000).state;
    expect(part.mining).toMatchObject({ frontierBlockIndex: 200, blockMs: 20_000, blockWork: 20_000 * 20_000 });
    const done = settleAt(part, T0 + 42_500).state;
    expect(done.mining).toMatchObject({ frontierBlockIndex: 201, blockMs: 0, blockWork: 0 });
    expect(settleAt(s, T0 + 42_500).state.mining).toEqual(done.mining);
  });

  it("中途換裝備：已累積的工作量保留，只改變之後的速率（P5）", () => {
    let s = makeState({ tier: 1, frontier: 200 }); // 擁有木製、石製；裝備石製
    s = ok(applyAction(s, { type: "equip_pickaxe", pickaxeId: "pick_wood" })).state;
    s = settleAt(s, T0 + 21_250).state; // 木製挖到一半：425,000,000 / 850,000,000
    expect(s.mining.blockWork).toBe(425_000_000);
    s = ok(applyAction(s, { type: "equip_pickaxe", pickaxeId: "pick_stone" })).state;
    expect(s.mining.blockWork).toBe(425_000_000);
    // 剩餘 425,000,000 / (50 × 1200) = 7,083.33 → 7,084 ms
    const before = settleAt(s, T0 + 21_250 + 7_083).state;
    expect(before.mining.frontierBlockIndex).toBe(200);
    const after = settleAt(s, T0 + 21_250 + 7_084);
    expect(after.state.mining.frontierBlockIndex).toBe(201);
    expect(after.events.find((e) => e.type === "block_completed")).toMatchObject({ blockMs: 21_250 + 7_084 });
  });

  it("Power 不足時停止：不產生掉落、不推進、不累積有效挖掘時間", () => {
    const s = makeState({ frontier: 500 }); // 50m 需要 4.0，木製 2.0
    for (const now of [T0 + 200_000, T0 + 5 * HOUR]) {
      const r = settleAt(s, now);
      expect(r.summary).toMatchObject({ blocksMined: 0, minedMs: 0, stopReason: "blocked_power" });
      expect(r.summary.idleMs).toBe(r.summary.simulatedMs);
      const st = r.report ? { ...r.state, pendingOfflineReport: null } : r.state;
      expect(st.mining).toEqual(s.mining);
      expect(st.coins).toBe(0);
      expect(st.inventory).toEqual({});
      expect(st.firstTreasure.effectiveMiningMs).toBe(0);
      expect(r.report?.rewards ?? { coins: 0, items: {}, artifacts: [] }).toEqual({ coins: 0, items: {}, artifacts: [] });
    }
    expect(settleAt(s, T0 + 200_000).events).toEqual([{ type: "mining_stopped", status: "blocked_power" }]);
  });

  it("挖到門檻當下停止：剩餘時間不會多產生方塊", () => {
    const s = makeState({ frontier: 495 }); // 再挖 5 個方塊就到 50m
    const r = settleAt(s, T0 + 6 * HOUR);
    expect(r.summary.blocksMined).toBe(5);
    expect(r.state.mining.frontierBlockIndex).toBe(500);
    expect(r.summary.minedMs + r.summary.idleMs).toBe(r.summary.simulatedMs);
    expect(r.summary.stopReason).toBe("blocked_power");
  });

  it("礦區未解鎖時停止；解鎖後才繼續", () => {
    const s = makeState({ tier: 2, frontier: 995, unlockedZone: 0, coins: 800 });
    const r = settleAt(s, T0 + HOUR);
    expect(r.state.mining.frontierBlockIndex).toBe(1000);
    expect(r.summary.stopReason).toBe("blocked_unlock");
    const claimed = ok(applyAction(r.state, { type: "claim_report", reportId: r.report!.reportId })).state;
    const unlocked = ok(applyAction(claimed, { type: "unlock_zone", zone: 1 })).state;
    expect(settleAt(unlocked, unlocked.lastSettledAt + 200_000).state.mining.frontierBlockIndex).toBeGreaterThan(1000);
  });

  it("主線完成後前線停止", () => {
    const s = makeState({ tier: 4, level: 5, frontier: 3000, unlockedZone: 2 });
    expect(settleAt(s, T0 + HOUR).summary.stopReason).toBe("frontier_complete");
  });

  it("回訪 / 重挖不增加最大深度，但 digCounter 照常增加", () => {
    let s = makeState({ tier: 2, frontier: 1000, unlockedZone: 0 });
    for (const action of [
      { type: "select_mining_mode", mode: "revisit", zone: 0 },
      { type: "select_mining_mode", mode: "rework" },
    ] as const) {
      const t = ok(applyAction(s, action)).state;
      const r = settleAt(t, T0 + 3 * HOUR);
      expect(r.state.mining.frontierBlockIndex).toBe(1000);
      expect(r.state.mining.digCounter).toBe(1000 + r.summary.blocksMined);
      expect(r.summary.blocksMined).toBeGreaterThan(100);
      expect(r.report!.frontierTo).toBe(1000);
    }
  });

  it("超過 12 小時：只模擬 12 小時，其餘捨棄且不會再被結算（D9）", () => {
    const s = makeState({ tier: 1, frontier: 100 });
    const r12 = settleAt(s, T0 + OFFLINE_CAP_MS);
    const r30 = settleAt(s, T0 + 30 * HOUR);
    expect(r30.summary).toMatchObject({ simulatedMs: OFFLINE_CAP_MS, discardedMs: 18 * HOUR, stopReason: "offline_cap" });
    expect(r30.report!.rewards).toEqual(r12.report!.rewards);
    expect(r30.state.mining).toEqual(r12.state.mining);
    expect(r30.state.lastSettledAt).toBe(T0 + 30 * HOUR);
    // 領取後再結算：只處理領取之後的時間
    const claimed = ok(applyAction(r30.state, { type: "claim_report", reportId: r30.report!.reportId })).state;
    const after = settleAt(claimed, claimed.lastSettledAt + 1000);
    expect(after.summary.simulatedMs).toBe(1000);
  });

  it("在線 / 離線分界：300,000 ms 在線、300,001 ms 離線（P28）", () => {
    const s = makeState({ frontier: 100 });
    expect(settleAt(s, T0 + 300_000).summary.kind).toBe("online");
    expect(settleAt(s, T0 + 300_000).report).toBeNull();
    expect(settleAt(s, T0 + 300_001).summary.kind).toBe("offline");
    expect(settleAt(s, T0).summary.kind).toBe("noop");
  });

  it("serverNow 早於 lastSettledAt、有待領取報告、RNG 版本不同時拒絕結算", () => {
    const s = makeState();
    expect(settle(s, { serverNow: T0 - 1, rng })).toMatchObject({ ok: false, error: { code: "INVALID_TIME" } });
    expect(settle({ ...s, rngVersion: 2 }, { serverNow: T0 + 1, rng })).toMatchObject({ ok: false, error: { code: "RNG_VERSION_MISMATCH" } });
    expect(settle({ ...s, dataVersion: 99 }, { serverNow: T0 + 1, rng })).toMatchObject({ ok: false, error: { code: "DATA_VERSION_UNSUPPORTED" } });
    const pending = settleAt(s, T0 + HOUR).state;
    expect(settle(pending, { serverNow: T0 + 2 * HOUR, rng })).toMatchObject({ ok: false, error: { code: "REPORT_PENDING" } });
  });

  it("不修改傳入的狀態", () => {
    const s = deepFreeze(makeState({ tier: 1, frontier: 300 }));
    expect(() => settle(s, { serverNow: T0 + 2 * HOUR, rng })).not.toThrow();
    expect(() => settle(s, { serverNow: T0 + 200_000, rng })).not.toThrow();
  });
});

describe("獎勵", () => {
  it("同樣的狀態、時間與亂數得到完全相同的結果", () => {
    const s = makeState({ tier: 2, level: 4, frontier: 1100, unlockedZone: 1 });
    const other = createBlockRng(sha256(new TextEncoder().encode("settlement-tests")));
    expect(settle(s, { serverNow: T0 + 7 * HOUR, rng })).toEqual(settle(s, { serverNow: T0 + 7 * HOUR, rng: other }));
    const diff = createBlockRng(sha256(new TextEncoder().encode("another-player")));
    expect(settle(s, { serverNow: T0 + 7 * HOUR, rng: diff })).not.toEqual(settle(s, { serverNow: T0 + 7 * HOUR, rng }));
  });

  it("同一段時間不能重複取得掉落：再次結算到同一時間沒有任何產出", () => {
    const s = settleAt(makeState({ tier: 1, frontier: 100 }), T0 + 250_000).state;
    const again = settleAt(s, T0 + 250_000);
    expect(again.summary.kind).toBe("noop");
    expect(again.changed).toBe(false);
    expect(again.state).toEqual(s);
  });

  it("每個 digCounter 只使用一次；掉落的寶物 ID 由方塊序號決定", () => {
    const s = makeState({ tier: 2, frontier: 1000, unlockedZone: 1 });
    const r = settleAt(s, T0 + 12 * HOUR, { recordBlocks: true });
    const digs = r.blocks.map((b) => b.digCounter);
    expect(digs).toEqual(Array.from({ length: digs.length }, (_, i) => 1000 + i));
    for (const a of r.report!.rewards.artifacts) expect(a.instanceId).toBe(`d${a.digCounter}`);
  });

  it("離線獎勵進入待領取報告，不進可使用的背包", () => {
    const s = makeState({ tier: 1, frontier: 100, coins: 50, inventory: { stone: 3 } });
    const r = settleAt(s, T0 + 5 * HOUR);
    expect(r.state.coins).toBe(50);
    expect(r.state.inventory).toEqual({ stone: 3 });
    expect(r.state.heldArtifacts).toEqual([]);
    expect(r.report!.rewards.coins).toBeGreaterThan(0);
    expect(r.state.pendingOfflineReport).toEqual(r.report);
    // 報告裡的物品不能出售
    expect(applyAction(r.state, { type: "sell_items", itemId: "stone", quantity: 1 })).toMatchObject({ ok: false, error: { code: "REPORT_PENDING" } });
  });

  it("首次寶物保護：4 小時有效挖掘、最多一次、不消耗亂數、離線發放時與報告一致", () => {
    const s = makeState({ frontier: 0 });
    const withP = settleAt(s, T0 + 12 * HOUR, { recordBlocks: true });
    const noP = settleAt(s, T0 + 12 * HOUR, { recordBlocks: true, firstTreasureProtectMs: null });
    // 不消耗亂數：每個方塊的四層結果完全相同
    expect(withP.blocks.map(({ protection: _p, instanceId: _i, isNewDiscovery: _n, ...b }) => b)).toEqual(
      noP.blocks.map(({ protection: _p, instanceId: _i, isNewDiscovery: _n, ...b }) => b),
    );
    const granted = withP.blocks.filter((b) => b.protection !== null);
    const firstNatural = noP.blocks.find((b) => b.artifact !== null);
    if (granted.length === 1) {
      const g = granted[0]!;
      expect(g.protection).toBe("a_z1_lantern");
      expect(firstNatural === undefined || firstNatural.digCounter > g.digCounter).toBe(true);
      const ft = withP.state.firstTreasure;
      expect(ft).toMatchObject({ status: "granted", artifactInstanceId: `d${g.digCounter}`, reportId: withP.report!.reportId });
      // 狀態已更新、獎勵在報告中：背包裡沒有，報告裡有
      expect(withP.state.heldArtifacts).toEqual([]);
      expect(withP.report!.rewards.artifacts.find((a) => a.instanceId === ft.artifactInstanceId)?.source).toBe("first_treasure_protection");
      expect(withP.report!.firstTreasureGranted).toBe(true);
      expect(validateState(withP.state)).toEqual([]);
      // 有效時間 = 到發放那個方塊為止的完成方塊時間總和 ≥ 4 小時
      const effAtGrant = withP.blocks.filter((b) => b.digCounter <= g.digCounter).reduce((a, b) => a + b.blockMs, 0);
      expect(effAtGrant).toBeGreaterThanOrEqual(FIRST_TREASURE_PROTECT_MS);
      expect(effAtGrant - g.blockMs).toBeLessThan(FIRST_TREASURE_PROTECT_MS);
    } else {
      expect(firstNatural!.completedAt - T0).toBeLessThan(FIRST_TREASURE_PROTECT_MS + 10 * MIN);
    }
    expect(granted.length).toBeLessThanOrEqual(1);
  });

  it("首次保護在多次離線 / 領取 / 在線 / 出售後仍最多發放一次", () => {
    // 找一個前 4 小時沒有自然寶物的密鑰，確保保護一定會觸發
    let secret = 0;
    let r = createBlockRng(sha256(new TextEncoder().encode(`ft-${secret}`)));
    const probe = (g: typeof r) => ok(settle(makeState(), { serverNow: T0 + 5 * HOUR, rng: g, options: { recordBlocks: true } }));
    while (!probe(r).blocks.some((b) => b.protection)) r = createBlockRng(sha256(new TextEncoder().encode(`ft-${++secret}`)));
    let s = makeState();
    let grants = 0;
    for (let cycle = 0; cycle < 6; cycle++) {
      const res = ok(settle(s, { serverNow: s.lastSettledAt + 3 * HOUR, rng: r, options: { recordBlocks: true } }));
      grants += res.blocks.filter((b) => b.protection).length;
      s = ok(applyAction(res.state, { type: "claim_report", reportId: res.report!.reportId })).state;
      expect(s.firstTreasure.reportId).toBeNull();
      // 出售保護寶物後也不會再發放
      const lantern = s.heldArtifacts.find((a) => a.source === "first_treasure_protection");
      if (lantern) s = ok(applyAction(s, { type: "sell_artifacts", instanceIds: [lantern.instanceId] }, { marketMultiplierPpm: { a_z1_lantern: 1_000_000 } })).state;
      s = ok(settle(s, { serverNow: s.lastSettledAt + 200_000, rng: r })).state;
    }
    expect(grants).toBe(1);
    expect(s.firstTreasure.status).toBe("granted");
    expect(s.discoveredArtifacts.a_z1_lantern?.totalFound).toBeGreaterThanOrEqual(1);
  });

  it("自然取得第一件寶物後永久取消保護", () => {
    const s = makeState({ frontier: 0 });
    const r = settleAt(s, T0 + 12 * HOUR, { recordBlocks: true });
    const first = r.blocks.find((b) => b.artifact || b.protection)!;
    if (first.artifact) {
      expect(r.state.firstTreasure.status).toBe("obtained");
      expect(r.blocks.some((b) => b.protection)).toBe(false);
    }
    const obtained = makeState({ frontier: 0, firstTreasure: "obtained" });
    expect(settleAt(obtained, T0 + 12 * HOUR, { recordBlocks: true }).blocks.some((b) => b.protection)).toBe(false);
  });

  it("在線入帳後下一個方塊套組生效：途中掉落第三件套組寶物，之後的方塊變快", () => {
    const s = makeState({ tier: 1, frontier: 300, artifacts: ["a_z1_lantern", "a_z1_badge"] });
    const D = s.mining.digCounter; // 這個方塊掉落 a_z1_map（第四層 Epic，第 3 件）
    const forced = (dig: number) =>
      dig === D ? new SequenceSource([0, 999_999, 999_999, 1_000, 2]) : new SequenceSource([0, 999_999, 999_999, 999_999]);
    const r = ok(settle(s, { serverNow: T0 + 300_000, rng: forced }));
    const blocks = r.events.filter((e) => e.type === "block_completed");
    expect(blocks[0]).toMatchObject({ digCounter: D, artifact: "a_z1_map" });
    expect(r.events).toContainEqual({ type: "set_changed", setId: "old_miner", active: true });
    const st = currentStats(s);
    const slow = blockMsFor(frontierSpot(300).hardness, st.power10, st.speed1000);
    const fast = blockMsFor(frontierSpot(300).hardness, st.power10, Math.floor((st.speed1000 * 103) / 100));
    expect(blocks[0]).toMatchObject({ blockMs: slow });
    expect(blocks[1]).toMatchObject({ blockMs: fast });
    expect(fast).toBeLessThan(slow);
    // 同一段時間改為離線：數值整段不變（報告未領取）
    const off = ok(settle(s, { serverNow: T0 + 300_001, rng: forced, options: { recordBlocks: true } }));
    expect(off.blocks[1]!.blockMs).toBe(slow);
  });

  it("領取報告後套組加成啟動", () => {
    const s = makeState({ tier: 1, frontier: 100, artifacts: ["a_z1_lantern", "a_z1_badge"] });
    const r = settleAt(s, T0 + HOUR);
    const pending = structuredClone(r.state);
    // 在報告中放入第三件（模擬離線期間取得）
    const extra = { instanceId: `d${pending.mining.digCounter - 1}`, artifactId: "a_z1_map" as const, obtainedAt: T0 + HOUR, mode: "frontier" as const, band: 1, frontierBlockIndex: 150, digCounter: pending.mining.digCounter - 1, source: "drop" as const, isNewDiscovery: true };
    pending.pendingOfflineReport!.rewards.artifacts = [extra];
    const before = currentStats(pending).speed1000;
    const claimed = ok(applyAction(pending, { type: "claim_report", reportId: r.report!.reportId }));
    expect(claimed.events).toContainEqual({ type: "set_changed", setId: "old_miner", active: true });
    expect(currentStats(claimed.state).speed1000).toBe(Math.floor((before * 103) / 100));
    expect(claimed.state.discoveredArtifacts.a_z1_map).toMatchObject({ totalFound: 1, firstDiscoveredAt: T0 + HOUR });
  });

  it("blockMs 計算與引擎 blockMs 一致", () => {
    const s = makeState({ tier: 1, level: 2, frontier: 750 });
    const st = currentStats(s);
    const ms = blockMsFor(frontierSpot(750).hardness, st.power10, st.speed1000);
    const r = settleAt(s, T0 + ms);
    expect(r.summary.blocksMined).toBe(1);
    expect(settleAt(s, T0 + ms - 1).summary.blocksMined).toBe(0);
  });
});
