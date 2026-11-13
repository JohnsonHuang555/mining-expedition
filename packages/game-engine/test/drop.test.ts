import { PPM } from "@mining/game-data";
import { describe, expect, it } from "vitest";
import {
  type BlockDrops,
  SequenceSource,
  coinRange,
  computeStats,
  createBlockRng,
  dropOdds,
  expectedBlock,
  frontierSpot,
  mulDivFloor,
  rarePpm,
  revisitSpot,
  reworkSpot,
  rollBlock,
  sha256,
  spotBlockMs,
  treasureChancePpm,
  treasureSplitPpm,
} from "../src/index.ts";

const secret = sha256(new TextEncoder().encode("drop-test"));

describe("確定性", () => {
  it("相同 secret、digCounter、位置與數值 → 相同掉落", () => {
    const a = createBlockRng(secret);
    const b = createBlockRng(secret.slice());
    const spot = frontierSpot(1500);
    for (let i = 0; i < 500; i++) {
      expect(rollBlock(a(i), spot, 120_000, 30_000)).toEqual(rollBlock(b(i), spot, 120_000, 30_000));
    }
  });

  it("不同密鑰產生不同的掉落序列", () => {
    const spot = frontierSpot(1500);
    const run = (s: Uint8Array) => Array.from({ length: 200 }, (_, i) => rollBlock(createBlockRng(s)(i), spot, 120_000, 0));
    expect(run(secret)).not.toEqual(run(sha256(new TextEncoder().encode("other"))));
  });
});

describe("分布（不同種子 → 預期機率）", () => {
  // TECHNICAL_SPEC §14.3：每層抽樣 10^6 次，頻率與理論值相差 ±3 個標準差內。
  // 密鑰固定，所以這個測試是確定性的（不會偶發失敗）
  const within = (count: number, n: number, p: number) => {
    const sd = Math.sqrt(n * p * (1 - p));
    expect(Math.abs(count - n * p)).toBeLessThanOrEqual(3 * sd);
  };

  it("zone2 前線：四層的頻率符合 dropOdds（10^6 個方塊）", { timeout: 60_000 }, () => {
    const n = 1_000_000;
    const spot = frontierSpot(1500); // zone2、門檻段 3（CoinAvg 330）
    const luck = 36_000;
    const ms = 600_000; // 10 分鐘方塊，讓第四層有足夠樣本
    const odds = dropOdds(spot, ms, luck);
    const rng = createBlockRng(secret);
    const c = { bundle: 0, rare: 0, coin: 0, coinSum: 0, leg: 0, epic: 0, silver: 0, sapphire: 0, epicIds: new Map<string, number>() };
    let coinMin = Infinity;
    let coinMax = -Infinity;
    for (let i = 0; i < n; i++) {
      const d = rollBlock(rng(i), spot, ms, luck);
      if (d.layer2 === "bundle") c.bundle++;
      if (d.layer2 === "rare") c.rare++;
      if (d.baseOre === "silver") c.silver++;
      if (d.layer2 === "rare" && d.items.sapphire) c.sapphire++;
      if (d.coins > 0) {
        c.coin++;
        c.coinSum += d.coins;
        coinMin = Math.min(coinMin, d.coins);
        coinMax = Math.max(coinMax, d.coins);
      }
      if (d.layer4 === "legendary") c.leg++;
      if (d.layer4 === "epic") {
        c.epic++;
        c.epicIds.set(d.artifact!, (c.epicIds.get(d.artifact!) ?? 0) + 1);
      }
    }
    within(c.bundle, n, odds.bundlePpm / PPM);
    within(c.rare, n, odds.rarePpm / PPM);
    within(c.silver, n, 0.3);
    within(c.sapphire, c.rare, 0.35);
    within(c.coin, n, 0.1);
    within(c.leg, n, odds.legendaryPpm / PPM);
    within(c.epic, n, odds.epicPpm / PPM);
    // 金額：均勻整數 [165, 495]，平均 330
    expect([coinMin, coinMax]).toEqual([odds.coinMin, odds.coinMax]);
    expect([odds.coinMin, odds.coinMax]).toEqual([165, 495]);
    expect(Math.abs(c.coinSum / c.coin - 330)).toBeLessThan(2);
    // Epic 從 3 件中均勻抽取（D14）
    expect([...c.epicIds.keys()].sort()).toEqual(["a_z2_crown", "a_z2_mural", "a_z2_orb"]);
    for (const k of c.epicIds.values()) within(k, c.epic, 1 / 3);
  });
});

describe("Luck 倍率與正規化（GBS §7.1；D2）", () => {
  it("P(Rare) = RareBase × (1 + Luck)；礦石包不受 Luck 影響；「無」吸收差額", () => {
    const spot = frontierSpot(2500); // zone3：RareBase 5%
    for (const luck of [0, 120_000, 208_000]) {
      const o = dropOdds(spot, 300_000, luck);
      expect(o.rarePpm).toBe(Math.floor(50_000 * (1 + luck / PPM)));
      expect(o.bundlePpm).toBe(150_000);
      expect(o.bundlePpm + o.rarePpm + o.nonePpm).toBe(PPM);
      expect(o.legendaryPpm + o.epicPpm + o.noTreasurePpm).toBe(PPM);
    }
    expect(dropOdds(spot, 300_000, 208_000).rarePpm).toBe(60_400);
    // TECHNICAL_SPEC §14.1：Luck 0.12 時 zone1 Rare = 28,000 ppm
    expect(dropOdds(frontierSpot(0), 1000, 120_000).rarePpm).toBe(28_000);
  });

  it("寶物：P(Leg) = Chance × 0.1 × (1 + Luck)、P(Epic) = Chance × 0.9 × (1 + Luck)，比例固定 1 : 9", () => {
    expect(treasureSplitPpm(100_000, 0)).toEqual({ legendaryPpm: 10_000, epicPpm: 90_000 });
    expect(treasureSplitPpm(100_000, 200_000)).toEqual({ legendaryPpm: 12_000, epicPpm: 108_000 });
  });

  it("寶物機會上限 50%：最大 Luck 下總和仍 ≤ 100%", () => {
    const o = dropOdds(frontierSpot(2999), 100 * 3_600_000, 208_000);
    expect(o.treasureChancePpm).toBe(500_000);
    expect(o.legendaryPpm + o.epicPpm).toBe(604_000);
    expect(o.noTreasurePpm).toBe(396_000);
  });

  it("Rare 判定總和超過 100% 時拒絕（正規化前提被破壞）", () => {
    expect(() => dropOdds(frontierSpot(0), 1000, 40 * PPM)).toThrow(RangeError);
  });
});

describe("模式倍率（D12、D14、D16）", () => {
  it("回訪 / 重挖：金幣平均與寶物機會 ×0.5；礦物與 Rare 不變", () => {
    const ms = 1_200_000;
    const front = dropOdds(frontierSpot(950), ms, 0);
    const rev = dropOdds(revisitSpot(0), ms, 0);
    const rew = dropOdds(reworkSpot(9), ms, 0);
    expect(front.rarePpm).toBe(rev.rarePpm);
    expect([front.coinMin, front.coinMax]).toEqual([10, 30]);
    expect([rev.coinMin, rev.coinMax]).toEqual([5, 15]);
    expect([rew.coinMin, rew.coinMax]).toEqual([5, 15]);
    expect(rev.treasureChancePpm * 2).toBe(front.treasureChancePpm);
    expect(rew.treasureChancePpm).toBe(rev.treasureChancePpm);
  });

  it("回訪使用礦區最深門檻段的金額（GBS §7.3）", () => {
    expect([dropOdds(revisitSpot(1), 1000, 0).coinMin, dropOdds(revisitSpot(1), 1000, 0).coinMax]).toEqual([83, 248]); // 330 × 0.5 = 165
    expect([dropOdds(revisitSpot(2), 1000, 0).coinMin, dropOdds(revisitSpot(2), 1000, 0).coinMax]).toEqual([350, 1050]); // 1400 × 0.5
  });

  it("金額範圍四捨五入：Avg 75 → [38, 113]；Avg 165 → [83, 248]", () => {
    expect(coinRange(150, 500_000)).toEqual({ min: 38, max: 113 });
    expect(coinRange(330, 500_000)).toEqual({ min: 83, max: 248 });
    expect(coinRange(20, 1_000_000)).toEqual({ min: 10, max: 30 });
    expect(coinRange(1_400, 1_000_000)).toEqual({ min: 700, max: 2_100 });
  });
});

describe("Mining Speed：普通資源增加、每小時寶物機會不變（GBS §7.6）", () => {
  const perHour = (pick: Parameters<typeof computeStats>[0], lv: number, block: number) => {
    const s = computeStats(pick, lv);
    const spot = frontierSpot(block);
    const ms = spotBlockMs(spot, s);
    const e = expectedBlock(spot, ms, s.luckPpm);
    const bph = 3_600_000 / ms;
    return { bph, ores: e.ores * bph, rares: e.rares * bph, coins: e.coins * bph, treasures: e.treasures * bph };
  };

  // GBS §7.6 以深度帶的底部標示位置：「80m」= 70–80m 深度帶（blockIndex 700–799，Hardness 1,100）
  it("zone1 80m 石製 Lv1 / Lv5 與 GBS §7.6 表格一致", () => {
    const lv1 = perHour("pick_stone", 1, 799);
    const lv5 = perHour("pick_stone", 5, 799);
    expect(lv1.bph.toFixed(1)).toBe("19.6");
    expect(lv5.bph.toFixed(1)).toBe("33.0");
    expect(lv1.ores.toFixed(1)).toBe("28.5");
    expect(lv5.ores.toFixed(1)).toBe("47.8");
    // GBS 以浮點計算；引擎的 ppm 無條件捨去造成 < 0.01% 的差距
    expect(Math.abs(lv1.treasures - 0.354)).toBeLessThan(0.001);
    expect(Math.abs(lv5.treasures - 0.355)).toBeLessThan(0.001);
  });

  it("各位置 Lv1 → Lv5：礦物 / 金幣 +68%，寶物每小時差距只來自 Luck（< 3%）", () => {
    for (const [pick, block] of [["pick_stone", 799], ["pick_iron", 1199], ["pick_gold", 1699]] as const) {
      const lv1 = perHour(pick, 1, block);
      const lv5 = perHour(pick, 5, block);
      expect(lv5.ores / lv1.ores).toBeGreaterThan(1.6);
      expect(lv5.coins / lv1.coins).toBeGreaterThan(1.6);
      const luck1 = computeStats(pick, 1).luckPpm;
      const luck5 = computeStats(pick, 5).luckPpm;
      const luckRatio = (PPM + luck5) / (PPM + luck1);
      // 扣除 Luck 後，每小時寶物機會只差 floor 的捨入
      expect(Math.abs(lv5.treasures / lv1.treasures / luckRatio - 1)).toBeLessThan(0.001);
    }
  });

  it("只改 Speed（不改 Luck）時，每小時寶物機會相同（只差 ppm 捨入）", () => {
    const spot = frontierSpot(1200);
    const rate = (ms: number) => (treasureChancePpm(250, ms, PPM) * 3_600_000) / ms;
    expect(Math.abs(rate(150_000) / rate(75_000) - 1)).toBeLessThan(1e-4);
    expect(spot.zone).toBe(1);
  });
});

describe("亂數消耗順序（TECHNICAL_SPEC §6.2）", () => {
  const spot = frontierSpot(0); // zone1：OreType 權重合計 100、Rare 表合計 100
  const ms = 3_600_000; // chance 350,000 → leg 35,000、epic 315,000（Luck 0）

  const roll = (values: number[]): { d: BlockDrops; consumed: number } => {
    const src = new SequenceSource(values);
    const d = rollBlock(src, spot, ms, 0);
    return { d, consumed: src.consumed };
  };

  it("全部落空：OreType → 第二層 → 第三層 → 第四層，共 4 次", () => {
    const { d, consumed } = roll([0, 999_999, 999_999, 999_999]);
    expect(consumed).toBe(4);
    expect(d).toEqual({ items: { stone: 1 }, baseOre: "stone", layer2: "none", coins: 0, layer4: "none", artifact: null });
  });

  it("礦石包 + 金幣 + Legendary：1 + 1 + 3 + 1 + 1 + 1 = 8 次", () => {
    // OreType 累積區間：stone [0,60)、coal [60,75)、copper [75,88)、iron_ore [88,100)
    const { d, consumed } = roll([60, 0, 75, 88, 0, 0, 5, 0]);
    expect(consumed).toBe(8);
    expect(d.baseOre).toBe("coal");
    expect(d.layer2).toBe("bundle");
    expect(d.items).toEqual({ coal: 1, copper: 1, iron_ore: 1, stone: 1 });
    expect(d.coins).toBe(15); // 10 + nextInt(21) = 10 + 5
    expect(d.layer4).toBe("legendary");
    expect(d.artifact).toBe("a_z1_heart");
  });

  it("Rare + Epic：第二層 Rare 再 1 次、第四層 Epic 再 1 次", () => {
    // u2 = 150,000 → [bundle, bundle + rare)；Rare 表 silver [0,50)、amethyst [50,100)
    // u4 = 35,000 → [leg, leg + epic) → nextInt(3) = 2 → a_z1_map
    const { d, consumed } = roll([0, 150_000, 50, 999_999, 35_000, 2]);
    expect(consumed).toBe(6);
    expect(d.layer2).toBe("rare");
    expect(d.items).toEqual({ stone: 1, amethyst: 1 });
    expect(d.coins).toBe(0);
    expect(d.layer4).toBe("epic");
    expect(d.artifact).toBe("a_z1_map");
  });

  it("各層區間邊界：bundle 上界、rare 上界、coin 上界、legendary 上界", () => {
    expect(roll([0, 149_999, 0, 0, 0, 999_999, 999_999]).d.layer2).toBe("bundle");
    expect(roll([0, 174_999, 0, 999_999, 999_999]).d.layer2).toBe("rare"); // 150,000 + 25,000
    expect(roll([0, 175_000, 999_999, 999_999]).d.layer2).toBe("none");
    expect(roll([0, 999_999, 99_999, 0, 999_999]).d.coins).toBe(10);
    expect(roll([0, 999_999, 100_000, 999_999]).d.coins).toBe(0);
    expect(roll([0, 999_999, 999_999, 34_999]).d.layer4).toBe("legendary");
    expect(roll([0, 999_999, 999_999, 349_999, 0]).d.layer4).toBe("epic");
    expect(roll([0, 999_999, 999_999, 350_000]).d.layer4).toBe("none");
  });
});

describe("定點數不溢位（TECHNICAL_SPEC §5）", () => {
  it("legPpm / epicPpm 的中間值超過 2^53 時仍與 BigInt 參考值相同", () => {
    const chance = 499_999;
    const luck = 208_000;
    const mid = BigInt(chance) * 900_000n * BigInt(PPM + luck);
    expect(mid > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(BigInt(treasureSplitPpm(chance, luck).epicPpm)).toBe(mid / 1_000_000_000_000n);
  });

  it("隨機輸入與 BigInt 參考值一致", () => {
    let x = 12345;
    const next = (m: number) => ((x = (x * 1_103_515_245 + 12_345) % 2_147_483_648), x % m);
    for (let i = 0; i < 2000; i++) {
      const chance = next(500_001);
      const luck = next(300_000);
      const tph = next(1000);
      const ms = next(20_000_000) + 1;
      const s = treasureSplitPpm(chance, luck);
      expect(BigInt(s.legendaryPpm)).toBe((BigInt(chance) * 100_000n * BigInt(PPM + luck)) / 10n ** 12n);
      const c = treasureChancePpm(tph, ms, 500_000);
      const ref = (BigInt(tph) * BigInt(ms) * 500_000n) / 3_600_000_000n;
      expect(BigInt(c)).toBe(ref < 500_000n ? ref : 500_000n);
      expect(rarePpm(50_000, luck)).toBe(Number((50_000n * BigInt(PPM + luck)) / 1_000_000n));
    }
  });

  it("mulDivFloor 的 Number 快速路徑與 BigInt 完全一致（含 2^53 附近）", () => {
    const max = Number.MAX_SAFE_INTEGER;
    const cases: [number[], number][] = [
      [[max - 1], 1], [[max - 7], 3], [[2 ** 52 + 1], 7], [[94_906_265, 94_906_265], 999_983],
      [[499_999, 900_000, 1_208_000], 1_000_000_000_000], [[0, max], 5], [[3], 4], [[max], max],
    ];
    let x = 987_654_321;
    const rnd = (m: number) => ((x = (x * 48_271) % 2_147_483_647), x % m);
    for (let i = 0; i < 5000; i++) {
      const a = rnd(2 ** 26) * 2 ** 26 + rnd(2 ** 26);
      cases.push([[a % (2 ** 52)], rnd(10 ** 9) + 1], [[rnd(1e6), rnd(1e6), rnd(5e3)], rnd(1e7) + 1]);
    }
    for (const [nums, den] of cases) {
      const ref = nums.reduce((p, n) => p * BigInt(n), 1n) / BigInt(den);
      if (ref > BigInt(max)) continue;
      expect(BigInt(mulDivFloor(nums, den))).toBe(ref);
    }
  });

  it("結果超出 safe integer 或輸入不合法時丟出錯誤，而不是回傳不精確的值", () => {
    expect(() => mulDivFloor([Number.MAX_SAFE_INTEGER, 2], 1)).toThrow(RangeError);
    expect(() => mulDivFloor([1.5], 1)).toThrow(RangeError);
    expect(() => mulDivFloor([1], 0)).toThrow(RangeError);
    expect(() => dropOdds(frontierSpot(0), 0, 0)).toThrow(RangeError);
    expect(() => dropOdds(frontierSpot(0), 1000, -1)).toThrow(RangeError);
  });
});
