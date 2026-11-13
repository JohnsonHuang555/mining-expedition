import {
  ARTIFACTS,
  ARTIFACT_IDS,
  BAND_COUNT,
  BAND_HARDNESS,
  DATA_VERSION,
  MATERIALS,
  MINERALS,
  PICKAXES,
  PPM,
  RNG_VERSION,
  SEGMENT_REQUIRED_POWER10,
  SETS,
  UPGRADE_BASE,
  ZONES,
} from "@mining/game-data";
import { describe, expect, it } from "vitest";
import { MAX_HARDNESS, computeStats } from "../src/index.ts";

describe("game-data 一致性（GBS v1.3）", () => {
  it("版本", () => {
    expect(DATA_VERSION).toBe(1);
    expect(RNG_VERSION).toBe(1);
  });

  it("30 個深度帶的 Hardness 單調遞增，且不超過定點上限", () => {
    expect(BAND_HARDNESS).toHaveLength(BAND_COUNT);
    for (let i = 1; i < BAND_HARDNESS.length; i++) expect(BAND_HARDNESS[i]!).toBeGreaterThan(BAND_HARDNESS[i - 1]!);
    expect(Math.max(...BAND_HARDNESS)).toBeLessThanOrEqual(MAX_HARDNESS);
    expect(SEGMENT_REQUIRED_POWER10).toEqual([10, 40, 90, 160, 270, 360]);
  });

  it("回訪位置（礦區最深帶）= GBS §2.3 的 1,500 / 4、11,500 / 16、32,500 / 36", () => {
    expect([BAND_HARDNESS[9], BAND_HARDNESS[19], BAND_HARDNESS[29]]).toEqual([1_500, 11_500, 32_500]);
    expect([SEGMENT_REQUIRED_POWER10[1], SEGMENT_REQUIRED_POWER10[3], SEGMENT_REQUIRED_POWER10[5]]).toEqual([40, 160, 360]);
  });

  it("強化成本 = round10(UpgradeBase × 1.8^(L−2))、強化石 L − 1（GBS §10）", () => {
    for (const p of PICKAXES) {
      p.upgrades.forEach((cost, i) => {
        const level = i + 2;
        expect(cost.coins).toBe(Math.round((UPGRADE_BASE[p.id] * 1.8 ** (level - 2)) / 10) * 10);
        expect(cost.items).toEqual({ reinforce_stone: level - 1 });
      });
    }
  });

  it("每把十字鎬 Lv1–Lv5 的數值都能整除（TECHNICAL_SPEC §5）", () => {
    for (const p of PICKAXES) for (let lv = 1; lv <= 5; lv++) expect(() => computeStats(p.id, lv)).not.toThrow();
  });

  it("掉落表引用的物品與寶物都存在；權重為正整數", () => {
    for (const z of ZONES) {
      for (const e of [...z.oreTable, ...z.rareTable]) {
        expect(MINERALS[e.id]).toBeDefined();
        expect(Number.isInteger(e.weight) && e.weight > 0).toBe(true);
      }
      for (const id of [...z.epics, z.legendary]) expect(ARTIFACTS[id]).toBeDefined();
      expect(ARTIFACTS[z.legendary].rarity).toBe("legendary");
      expect(z.epics.every((id) => ARTIFACTS[id].rarity === "epic")).toBe(true);
      expect(SETS[z.set].members).toEqual(z.epics);
      expect(z.bundleChancePpm).toBe(150_000);
      expect(z.coinChancePpm).toBe(100_000);
      expect(z.bundleChancePpm + z.rareBasePpm).toBeLessThan(PPM);
    }
    expect(new Set(ARTIFACT_IDS).size).toBe(ARTIFACT_IDS.length);
    for (const m of Object.values(MATERIALS)) for (const id of Object.keys(m.recipe)) expect(MINERALS[id as keyof typeof MINERALS]).toBeDefined();
  });

  it("GBS §6 平均售價（zone1 2.79、zone2 12.25、zone3 37.25）", () => {
    const avg = ZONES.map((z) => {
      const w = z.oreTable.reduce((s, e) => s + e.weight, 0);
      return z.oreTable.reduce((s, e) => s + (e.weight / w) * MINERALS[e.id].sellPrice, 0);
    });
    expect(avg.map((v) => v.toFixed(2))).toEqual(["2.79", "12.25", "37.25"]);
  });
});
