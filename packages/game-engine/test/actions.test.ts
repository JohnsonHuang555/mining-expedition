import { describe, expect, it } from "vitest";
import {
  type GameAction,
  type PlayerGameState,
  applyAction,
  currentStats,
  parseAction,
  settle,
  validateState,
} from "../src/index.ts";
import { BASE_MARKET, HOUR, T0, deepFreeze, makeState, rng } from "./support/fixtures.ts";

const act = (s: PlayerGameState, a: GameAction | Record<string, unknown>, market = BASE_MARKET) =>
  applyAction(deepFreeze(s), a as GameAction, { marketMultiplierPpm: market, serverNow: s.lastSettledAt });
const okState = (s: PlayerGameState, a: GameAction | Record<string, unknown>, market = BASE_MARKET): PlayerGameState => {
  const r = act(s, a, market);
  if (!r.ok) throw new Error(`expected ok: ${r.error.code} ${r.error.message}`);
  expect(validateState(r.state)).toEqual([]);
  return r.state;
};
const errCode = (s: PlayerGameState, a: GameAction | Record<string, unknown>, market = BASE_MARKET) => {
  const r = act(s, a, market);
  return r.ok ? "OK" : r.error.code;
};

describe("購買十字鎬（D10、P21）", () => {
  it("金幣與素材足夠：扣除、擁有 Lv1、自動裝備", () => {
    const s = makeState({ coins: 250, inventory: { stone: 45 } });
    const n = okState(s, { type: "purchase_pickaxe", pickaxeId: "pick_stone" });
    expect(n.coins).toBe(50);
    expect(n.inventory).toEqual({ stone: 5 });
    expect(n.pickaxes).toEqual({ pick_wood: 1, pick_stone: 1 });
    expect(n.equippedPickaxe).toBe("pick_stone");
  });

  it("金幣不足或素材不足：失敗且完全不扣除（不會自動製作，P22）", () => {
    expect(errCode(makeState({ coins: 199, inventory: { stone: 40 } }), { type: "purchase_pickaxe", pickaxeId: "pick_stone" })).toBe("INSUFFICIENT_COINS");
    expect(errCode(makeState({ coins: 200, inventory: { stone: 39 } }), { type: "purchase_pickaxe", pickaxeId: "pick_stone" })).toBe("INSUFFICIENT_ITEMS");
    // 有原料但沒有鐵錠
    expect(errCode(makeState({ tier: 1, coins: 5000, inventory: { iron_ore: 100, coal: 100 } }), { type: "purchase_pickaxe", pickaxeId: "pick_iron" })).toBe("INSUFFICIENT_ITEMS");
  });

  it("必須依序購買；不能重複購買", () => {
    const rich = makeState({ coins: 1e9, inventory: { iron_ingot: 99, stone: 99, refined_crystal: 99, reinforce_stone: 99 } });
    expect(errCode(rich, { type: "purchase_pickaxe", pickaxeId: "pick_iron" })).toBe("PREREQUISITE_MISSING");
    expect(errCode(rich, { type: "purchase_pickaxe", pickaxeId: "pick_wood" })).toBe("PREREQUISITE_MISSING");
  });
});

describe("強化與裝備", () => {
  it("強化成本依 GBS §10；Lv5 後拒絕", () => {
    let s = makeState({ tier: 1, coins: 10_000, inventory: { reinforce_stone: 20 } });
    const costs = [250, 450, 810, 1460];
    for (let lv = 2; lv <= 5; lv++) {
      const before = s.coins;
      s = okState(s, { type: "upgrade_pickaxe", pickaxeId: "pick_stone" });
      expect(before - s.coins).toBe(costs[lv - 2]);
      expect(s.pickaxes.pick_stone).toBe(lv);
    }
    expect(s.inventory.reinforce_stone).toBe(20 - (1 + 2 + 3 + 4));
    expect(errCode(s, { type: "upgrade_pickaxe", pickaxeId: "pick_stone" })).toBe("MAX_LEVEL");
    expect(errCode(s, { type: "upgrade_pickaxe", pickaxeId: "pick_iron" })).toBe("PREREQUISITE_MISSING");
  });

  it("強化素材不足時金幣不扣", () => {
    const s = makeState({ coins: 100 });
    expect(errCode(s, { type: "upgrade_pickaxe", pickaxeId: "pick_wood" })).toBe("INSUFFICIENT_ITEMS");
  });

  it("只能裝備已擁有的十字鎬；裝備同一把不改變狀態", () => {
    const s = makeState({ tier: 1 });
    expect(errCode(s, { type: "equip_pickaxe", pickaxeId: "pick_iron" })).toBe("PREREQUISITE_MISSING");
    const r = act(s, { type: "equip_pickaxe", pickaxeId: "pick_stone" });
    expect(r).toMatchObject({ ok: true, changed: false });
    expect(okState(s, { type: "equip_pickaxe", pickaxeId: "pick_wood" }).equippedPickaxe).toBe("pick_wood");
  });
});

describe("製作（P22）", () => {
  it("一次 N 份，素材守恆：不會憑空增加", () => {
    const s = makeState({ inventory: { iron_ore: 52, coal: 21, stone: 7 } });
    const n = okState(s, { type: "craft", materialId: "iron_ingot", times: 10 });
    expect(n.inventory).toEqual({ iron_ore: 2, coal: 1, stone: 7, iron_ingot: 10 });
  });

  it("素材不足時全部失敗（不會只做一部分）", () => {
    const s = makeState({ inventory: { iron_ore: 52, coal: 21 } });
    expect(errCode(s, { type: "craft", materialId: "iron_ingot", times: 11 })).toBe("INSUFFICIENT_ITEMS");
    expect(errCode(makeState({ inventory: { amethyst: 2 } }), { type: "craft", materialId: "refined_crystal", times: 1 })).toBe("INSUFFICIENT_ITEMS");
  });

  it("不合法的數量：0、負數、小數、超大整數、字串", () => {
    const s = makeState({ inventory: { iron_ore: 1e6, coal: 1e6 } });
    for (const times of [0, -1, 1.5, 1e7, Number.MAX_SAFE_INTEGER, 2 ** 60, "3", Number.NaN, null]) {
      expect(errCode(s, { type: "craft", materialId: "iron_ingot", times })).toBe("INVALID_REQUEST");
    }
    expect(errCode(s, { type: "craft", materialId: "diamond", times: 1 })).toBe("INVALID_REQUEST");
  });
});

describe("出售", () => {
  it("礦物以固定售價出售", () => {
    const n = okState(makeState({ inventory: { ruby: 3, stone: 10 } }), { type: "sell_items", itemId: "ruby", quantity: 2 });
    expect(n.coins).toBe(1000);
    expect(n.inventory).toEqual({ ruby: 1, stone: 10 });
    const all = okState(makeState({ inventory: { stone: 10 } }), { type: "sell_items", itemId: "stone", quantity: 10 });
    expect(all.inventory).toEqual({});
  });

  it("數量不足、製作素材、未知物品、非法數量都拒絕", () => {
    const s = makeState({ inventory: { stone: 10, iron_ingot: 5 } });
    expect(errCode(s, { type: "sell_items", itemId: "stone", quantity: 11 })).toBe("INSUFFICIENT_ITEMS");
    expect(errCode(s, { type: "sell_items", itemId: "iron_ingot", quantity: 1 })).toBe("INVALID_REQUEST"); // P16
    expect(errCode(s, { type: "sell_items", itemId: "gem", quantity: 1 })).toBe("INVALID_REQUEST");
    for (const quantity of [0, -5, 0.5, 2 ** 53, "1"]) expect(errCode(s, { type: "sell_items", itemId: "stone", quantity })).toBe("INVALID_REQUEST");
  });

  it("出售寶物：依市場倍率計價；套組立即失效；圖鑑保留", () => {
    const s = makeState({ tier: 1, artifacts: ["a_z1_lantern", "a_z1_badge", "a_z1_map"] });
    const speedWithSet = currentStats(s).speed1000;
    const r = act(s, { type: "sell_artifacts", instanceIds: ["seed1"] }, { ...BASE_MARKET, a_z1_badge: 1_250_000 });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.state.coins).toBe(375); // floor(300 × 1.25)
    expect(r.events).toContainEqual({ type: "set_changed", setId: "old_miner", active: false });
    expect(currentStats(r.state).speed1000).toBeLessThan(speedWithSet);
    expect(r.state.discoveredArtifacts.a_z1_badge).toEqual(s.discoveredArtifacts.a_z1_badge);
    expect(r.state.heldArtifacts.map((a) => a.instanceId)).toEqual(["seed0", "seed2"]);
  });

  it("出售寶物：未持有、重複 ID、缺少或超出範圍的市場價格都拒絕且不部分出售", () => {
    const s = makeState({ artifacts: ["a_z1_lantern", "a_z1_heart"] });
    expect(errCode(s, { type: "sell_artifacts", instanceIds: ["seed0", "nope"] })).toBe("INSUFFICIENT_ITEMS");
    expect(errCode(s, { type: "sell_artifacts", instanceIds: ["seed0", "seed0"] })).toBe("INVALID_REQUEST");
    expect(errCode(s, { type: "sell_artifacts", instanceIds: [] })).toBe("INVALID_REQUEST");
    expect(errCode(s, { type: "sell_artifacts", instanceIds: ["seed0"] }, {})).toBe("INVALID_REQUEST");
    expect(errCode(s, { type: "sell_artifacts", instanceIds: ["seed1"] }, { a_z1_heart: 1_600_000 })).toBe("INVALID_REQUEST");
    expect(errCode(s, { type: "sell_artifacts", instanceIds: ["seed0"] }, { a_z1_lantern: 700_000 })).toBe("INVALID_REQUEST"); // Epic 最低 0.80
    expect(errCode(s, { type: "sell_artifacts", instanceIds: ["seed1"] }, { a_z1_heart: 700_000 })).toBe("OK"); // Legendary 最低 0.70
  });
});

describe("解鎖礦區（D10、GBS §12）", () => {
  it("前線挖完上一區並付費", () => {
    const s = makeState({ tier: 2, frontier: 1000, coins: 900 });
    const n = okState(s, { type: "unlock_zone", zone: 1 });
    expect(n.unlockedZone).toBe(1);
    expect(n.coins).toBe(100);
  });

  it("未到達、跳級、重複、金幣不足、非法 zone", () => {
    expect(errCode(makeState({ frontier: 999, coins: 1e6 }), { type: "unlock_zone", zone: 1 })).toBe("PREREQUISITE_MISSING");
    expect(errCode(makeState({ frontier: 1000, coins: 1e6 }), { type: "unlock_zone", zone: 2 })).toBe("PREREQUISITE_MISSING");
    expect(errCode(makeState({ frontier: 1000, unlockedZone: 1, coins: 1e6 }), { type: "unlock_zone", zone: 1 })).toBe("PREREQUISITE_MISSING");
    expect(errCode(makeState({ frontier: 1000, coins: 799 }), { type: "unlock_zone", zone: 1 })).toBe("INSUFFICIENT_COINS");
    for (const zone of [0, 3, -1, "1", 1.5]) expect(errCode(makeState({ frontier: 1000, coins: 1e6 }), { type: "unlock_zone", zone })).toBe("INVALID_REQUEST");
  });
});

describe("切換挖掘模式（GBS §2.3、§2.4、§2.6）", () => {
  it("切換時目前方塊進度歸零，digCounter 不變（P3）；選同一個模式不重置", () => {
    let s = makeState({ tier: 2, frontier: 1000 });
    s = okState(s, { type: "select_mining_mode", mode: "revisit", zone: 0 });
    s = settle(s, { serverNow: T0 + 10_000, rng }).ok ? (settle(s, { serverNow: T0 + 10_000, rng }) as { state: PlayerGameState }).state : s;
    expect(s.mining.blockMs).toBe(10_000);
    const same = act(s, { type: "select_mining_mode", mode: "revisit", zone: 0 });
    expect(same).toMatchObject({ ok: true, changed: false });
    const switched = okState(s, { type: "select_mining_mode", mode: "rework" });
    expect(switched.mining).toMatchObject({ mode: "rework", reworkBand: 9, blockWork: 0, blockMs: 0, digCounter: s.mining.digCounter, frontierBlockIndex: 1000 });
  });

  it("回訪：只能選比前線所在礦區淺、已解鎖、Power 足夠的礦區", () => {
    const s = makeState({ tier: 1, frontier: 1000 }); // 石製 Power 5 ≥ zone1 最深帶 4
    expect(errCode(s, { type: "select_mining_mode", mode: "revisit", zone: 1 })).toBe("ZONE_LOCKED");
    expect(errCode(makeState({ frontier: 900 }), { type: "select_mining_mode", mode: "revisit", zone: 0 })).toBe("PREREQUISITE_MISSING");
    expect(errCode(makeState({ frontier: 1000 }), { type: "select_mining_mode", mode: "revisit", zone: 0 })).toBe("PREREQUISITE_MISSING"); // 木製 Power 2 < 4
    expect(errCode(s, { type: "select_mining_mode", mode: "revisit", zone: 0 })).toBe("OK");
  });

  it("重挖：只在前線卡關時可用；深度帶由伺服器計算，不接受 Client 指定", () => {
    expect(errCode(makeState({ frontier: 300 }), { type: "select_mining_mode", mode: "rework" })).toBe("PREREQUISITE_MISSING");
    expect(okState(makeState({ frontier: 500 }), { type: "select_mining_mode", mode: "rework" }).mining.reworkBand).toBe(4);
    expect(errCode(makeState({ frontier: 500 }), { type: "select_mining_mode", mode: "rework", band: 29 })).toBe("INVALID_REQUEST");
    expect(errCode(makeState({ frontier: 500 }), { type: "select_mining_mode", mode: "frontier", blockIndex: 2999 })).toBe("INVALID_REQUEST");
    for (const mode of ["dig", "", 1, null, "REVISIT"]) expect(errCode(makeState(), { type: "select_mining_mode", mode })).toBe("INVALID_REQUEST");
  });

  it("重挖中前線解除卡關 → 自動回到前線；Power 改變 → 重新計算深度帶", () => {
    // 木製 Lv1 停在 50m（需要 4）→ 重挖 band 4
    let s = makeState({ frontier: 500, coins: 1000, inventory: { stone: 40, reinforce_stone: 10 } });
    s = okState(s, { type: "select_mining_mode", mode: "rework" });
    // 購買石製（Power 5 ≥ 4）→ 前線解除卡關
    const r = act(s, { type: "purchase_pickaxe", pickaxeId: "pick_stone" });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.state.mining).toMatchObject({ mode: "frontier", reworkBand: null, blockWork: 0 });
    expect(r.events).toContainEqual({ type: "mining_mode_changed", mode: "frontier", revisitZone: null, reworkBand: null, reason: "rework_ended" });
    // 鐵製 Lv1 停在 150m（需要 16）重挖 band 14；換回較弱的木製 → 深度帶變淺
    let t = makeState({ tier: 2, frontier: 1500, unlockedZone: 1 });
    t = okState(t, { type: "select_mining_mode", mode: "rework" });
    expect(t.mining.reworkBand).toBe(14);
    const weaker = act(t, { type: "equip_pickaxe", pickaxeId: "pick_wood" });
    if (!weaker.ok) throw new Error(weaker.error.message);
    expect(weaker.state.mining.reworkBand).toBe(4);
  });
});

describe("領取離線報告（D20）", () => {
  const withReport = () => {
    const r = settle(makeState({ tier: 1, frontier: 100, coins: 10 }), { serverNow: T0 + 6 * HOUR, rng });
    if (!r.ok) throw new Error("settle failed");
    return r;
  };

  it("一次入帳；重複領取不重複入帳；錯誤 ID 拒絕", () => {
    const r = withReport();
    const id = r.report!.reportId;
    expect(errCode(r.state, { type: "claim_report", reportId: "r123" })).toBe("REPORT_NOT_FOUND");
    const claimed = okState(r.state, { type: "claim_report", reportId: id });
    expect(claimed.coins).toBe(10 + r.report!.rewards.coins);
    expect(claimed.inventory).toEqual(r.report!.rewards.items);
    expect(claimed.pendingOfflineReport).toBeNull();
    expect(claimed.lastClaimedReportId).toBe(id);
    expect(errCode(claimed, { type: "claim_report", reportId: id })).toBe("REPORT_ALREADY_CLAIMED");
    expect(errCode(claimed, { type: "claim_report", reportId: "r999" })).toBe("REPORT_NOT_FOUND");
  });

  it("未領取時拒絕所有一般操作", () => {
    const { state } = withReport();
    const actions: Record<string, unknown>[] = [
      { type: "purchase_pickaxe", pickaxeId: "pick_iron" },
      { type: "equip_pickaxe", pickaxeId: "pick_wood" },
      { type: "upgrade_pickaxe", pickaxeId: "pick_stone" },
      { type: "craft", materialId: "iron_ingot", times: 1 },
      { type: "sell_items", itemId: "stone", quantity: 1 },
      { type: "sell_artifacts", instanceIds: ["d1"] },
      { type: "unlock_zone", zone: 1 },
      { type: "select_mining_mode", mode: "frontier" },
    ];
    for (const a of actions) expect(errCode(state, a)).toBe("REPORT_PENDING");
  });
});

describe("請求驗證", () => {
  it("拒絕未知欄位、未知類型與非物件", () => {
    for (const raw of [null, 1, "x", [], {}, { type: "hack" }, { type: "craft", materialId: "iron_ingot", times: 1, cost: 0 }, { type: "sell_items", itemId: "stone", quantity: 1, price: 999 }]) {
      expect(parseAction(raw).ok).toBe(false);
    }
  });
});
