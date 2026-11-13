import { describe, expect, it } from "vitest";
import {
  STATE_SCHEMA_VERSION,
  canonicalCommandJson,
  createInitialState,
  executeRequest,
  toPlayerView,
  validateState,
} from "../src/index.ts";
import { HOUR, T0, makeState, rng, run } from "./support/fixtures.ts";

describe("executeRequest：先結算再操作、stateVersion、提交計畫", () => {
  it("成功的操作：stateVersion + 1、expectedStateVersion = 原版本", () => {
    const s = makeState({ coins: 300, inventory: { stone: 40 } });
    const r = executeRequest(s, { requestId: "k1", command: { type: "purchase_pickaxe", pickaxeId: "pick_stone" } }, { serverNow: T0 + 60_000, rng });
    expect(r.ok).toBe(true);
    expect(r.expectedStateVersion).toBe(0);
    expect(r.commit!.state.stateVersion).toBe(1);
    expect(r.commit!.actionApplied).toBe(true);
    expect(r.settlement!.kind).toBe("online");
    // 結算的掉落與購買都在同一個新狀態中
    expect(r.state.lastSettledAt).toBe(T0 + 60_000);
    expect(r.state.equippedPickaxe).toBe("pick_stone");
  });

  it("沒有變化時不需要提交", () => {
    const s = makeState();
    const r = executeRequest(s, { requestId: "k", command: { type: "settle" } }, { serverNow: T0, rng });
    expect(r).toMatchObject({ ok: true, commit: null });
    expect(r.state).toBe(s);
  });

  it("操作失敗：操作不產生效果；結算有變化時（例如產生報告）仍可提交", () => {
    const s = makeState({ tier: 1, frontier: 100 });
    const r = executeRequest(s, { requestId: "k", command: { type: "sell_items", itemId: "stone", quantity: 1 } }, { serverNow: T0 + 2 * HOUR, rng });
    expect(r.ok).toBe(false);
    expect(r.error!.code).toBe("REPORT_PENDING");
    expect(r.commit).toMatchObject({ actionApplied: false, reportClaimed: null });
    expect(r.commit!.reportCreated!.reportId).toBe(`r${T0}`);
    expect(r.commit!.state.pendingOfflineReport).toEqual(r.commit!.reportCreated);
    // 在線結算、操作失敗：結算仍可提交，但操作沒有效果
    const r2 = executeRequest(s, { requestId: "k", command: { type: "sell_items", itemId: "ruby", quantity: 1 } }, { serverNow: T0 + 100_000, rng });
    expect(r2).toMatchObject({ ok: false, error: { code: "INSUFFICIENT_ITEMS" }, commit: { actionApplied: false } });
    expect(r2.commit!.state.inventory.ruby).toBeUndefined();
  });

  it("有待領取報告時：一般操作回傳 REPORT_PENDING 且不需要提交；領取不先結算", () => {
    let { s } = run(makeState({ tier: 1, frontier: 100 }), T0 + 3 * HOUR, { type: "settle" });
    const id = s.pendingOfflineReport!.reportId;
    const blocked = executeRequest(s, { requestId: "x", command: { type: "settle" } }, { serverNow: T0 + 4 * HOUR, rng });
    expect(blocked).toMatchObject({ ok: false, error: { code: "REPORT_PENDING" }, commit: null });
    const claim = executeRequest(s, { requestId: "c1", command: { type: "claim_report", reportId: id } }, { serverNow: T0 + 4 * HOUR, rng });
    expect(claim.commit).toMatchObject({ reportClaimed: id, reportCreated: null });
    expect(claim.state.lastSettledAt).toBe(T0 + 3 * HOUR); // 等待領取的時間在領取後才結算
    s = claim.commit!.state;
    // 同一個 key 重送由 action_log 處理；不同 key 再領一次：已領取，不重複入帳
    const again = executeRequest(s, { requestId: "c2", command: { type: "claim_report", reportId: id } }, { serverNow: T0 + 4 * HOUR, rng });
    expect(again).toMatchObject({ ok: false, error: { code: "REPORT_ALREADY_CLAIMED" }, commit: null });
    expect(again.state.coins).toBe(s.coins);
  });

  it("同一個請求從同一個狀態重算，結果完全相同（重試安全）", () => {
    const s = makeState({ tier: 2, frontier: 1000, unlockedZone: 1, coins: 5000 });
    const req = { requestId: "same", command: { type: "settle" as const } };
    expect(executeRequest(s, req, { serverNow: T0 + 9 * HOUR, rng })).toEqual(executeRequest(s, req, { serverNow: T0 + 9 * HOUR, rng }));
  });

  it("不合法的 requestId 或指令", () => {
    const s = makeState();
    for (const requestId of ["", 5, null, "x".repeat(129)]) {
      expect(executeRequest(s, { requestId, command: { type: "settle" } } as never, { serverNow: T0, rng }).error!.code).toBe("INVALID_REQUEST");
    }
    expect(executeRequest(s, { requestId: "k", command: { type: "settle", extra: 1 } } as never, { serverNow: T0, rng }).error!.code).toBe("INVALID_REQUEST");
  });

  it("canonicalCommandJson 與欄位順序無關（request_hash 用）", () => {
    expect(canonicalCommandJson({ type: "craft", materialId: "iron_ingot", times: 2 })).toBe(
      canonicalCommandJson({ times: 2, materialId: "iron_ingot", type: "craft" } as never),
    );
  });
});

describe("PlayerGameState", () => {
  it("初始角色：木製 Lv1、zone1、0m、首次保護 pending；可 JSON 往返，不含 Date / Map / Set", () => {
    const s = createInitialState("u1", T0);
    expect(validateState(s)).toEqual([]);
    expect(s).toMatchObject({ schemaVersion: STATE_SCHEMA_VERSION, equippedPickaxe: "pick_wood", pickaxes: { pick_wood: 1 }, unlockedZone: 0, coins: 0 });
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    const walk = (v: unknown): void => {
      expect(v instanceof Date || v instanceof Map || v instanceof Set).toBe(false);
      if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(s);
  });

  it("狀態與公開 view 不含 RNG 密鑰", () => {
    let { s } = run(makeState({ tier: 1, frontier: 100 }), T0 + 200_000, { type: "settle" });
    const json = JSON.stringify(toPlayerView(s));
    expect(json).not.toMatch(/secret/i);
    expect(json).not.toContain("settlement-tests");
    s = { ...s };
  });

  it("驗證會拒絕各種不合法的狀態", () => {
    const bad: [string, (s: ReturnType<typeof makeState>) => void][] = [
      ["負金幣", (s) => (s.coins = -1)],
      ["小數金幣", (s) => (s.coins = 1.5)],
      ["超大金幣", (s) => (s.coins = 2 ** 53)],
      ["物品 0", (s) => (s.inventory = { stone: 0 })],
      ["未知物品", (s) => ((s.inventory as Record<string, number>).gem = 1)],
      ["跳級擁有十字鎬", (s) => (s.pickaxes = { pick_wood: 1, pick_iron: 1 })],
      ["裝備未擁有", (s) => (s.equippedPickaxe = "pick_diamond")],
      ["等級 6", (s) => ((s.pickaxes as Record<string, number>).pick_wood = 6)],
      ["前線超過 3000", (s) => (s.mining.frontierBlockIndex = 3001)],
      ["越過未解鎖礦區", (s) => ((s.mining.frontierBlockIndex = 1500), (s.mining.digCounter = 1500))],
      ["未到達就解鎖", (s) => (s.unlockedZone = 1)],
      ["digCounter 小於前線", (s) => ((s.mining.frontierBlockIndex = 10), (s.mining.digCounter = 5))],
      ["回訪沒有 zone", (s) => (s.mining.mode = "revisit")],
      ["前線卻有 reworkBand", (s) => (s.mining.reworkBand = 3)],
      ["只有 blockWork", (s) => (s.mining.blockWork = 10)],
      ["工作量超過方塊", (s) => ((s.mining.blockWork = 10 ** 12), (s.mining.blockMs = 1))],
      ["pending 卻有實例", (s) => (s.firstTreasure.artifactInstanceId = "d1")],
      ["保護指向不存在的報告", (s) => (s.firstTreasure = { status: "granted", effectiveMiningMs: 1, resolvedAt: T0, artifactInstanceId: "d1", reportId: "r1" })],
      ["lastSettledAt 早於建立", (s) => (s.lastSettledAt = T0 - 1)],
    ];
    for (const [name, mutate] of bad) {
      const s = structuredClone(makeState());
      mutate(s);
      expect(validateState(s).length, name).toBeGreaterThan(0);
    }
  });

  it("載入不合法的狀態時，結算與操作回傳 INVALID_STATE", () => {
    const s = structuredClone(makeState());
    s.coins = -5;
    expect(executeRequest(s, { requestId: "k", command: { type: "settle" } }, { serverNow: T0 + 1, rng }).error!.code).toBe("INVALID_STATE");
    expect(executeRequest(s, { requestId: "k", command: { type: "claim_report", reportId: "r1" } }, { serverNow: T0 + 1, rng }).error!.code).toBe("INVALID_STATE");
  });
});
