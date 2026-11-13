import { describe, expect, it } from "vitest";
import { activeSets, computeStats } from "../src/index.ts";

describe("數值聚合（GBS §3、§10）", () => {
  it("GBS §10 的 Lv1 / Lv3 / Lv5 表格", () => {
    const table: [Parameters<typeof computeStats>[0], [number, number, number][]][] = [
      ["pick_wood", [[20, 1000, 0], [24, 1100, 0], [28, 1200, 0]]],
      ["pick_stone", [[50, 1200, 10_000], [60, 1320, 12_000], [70, 1440, 14_000]]],
      ["pick_iron", [[100, 1500, 30_000], [120, 1650, 36_000], [140, 1800, 42_000]]],
      ["pick_gold", [[180, 1800, 70_000], [216, 1980, 84_000], [252, 2160, 98_000]]],
      ["pick_diamond", [[300, 2200, 120_000], [360, 2420, 144_000], [420, 2640, 168_000]]],
    ];
    for (const [id, rows] of table) {
      [1, 3, 5].forEach((lv, i) => {
        const [power10, speed1000, luckPpm] = rows[i]!;
        expect(computeStats(id, lv)).toEqual({ power10, speed1000, luckPpm });
      });
    }
  });

  it("套組要實際持有全部成員才啟動（D3）；出售（數量 0）後失效", () => {
    expect(activeSets({ a_z1_lantern: 1, a_z1_badge: 1 })).toEqual([]);
    expect(activeSets({ a_z1_lantern: 1, a_z1_badge: 2, a_z1_map: 1 })).toEqual(["old_miner"]);
    expect(activeSets({ a_z1_lantern: 1, a_z1_badge: 1, a_z1_map: 0 })).toEqual([]);
  });

  it("Speed 套組相加後乘、Luck 套組直接加（GBS §3）", () => {
    const all = {
      a_z1_lantern: 1, a_z1_badge: 1, a_z1_map: 1,
      a_z2_orb: 1, a_z2_crown: 1, a_z2_mural: 1,
      a_z3_emblem: 1, a_z3_ring: 1, a_z3_tablet: 1,
    };
    // 鑽石 Lv5：2.64 × 1.06 = 2.7984；Luck 0.168 + 0.04 = 0.208（GBS §3 最大值）
    expect(computeStats("pick_diamond", 5, all)).toEqual({ power10: 420, speed1000: 2798, luckPpm: 208_000 });
    // 只有 zone1：石製 Lv1 1.2 × 1.03 = 1.236
    expect(computeStats("pick_stone", 1, { a_z1_lantern: 1, a_z1_badge: 1, a_z1_map: 1 }).speed1000).toBe(1236);
  });

  it("等級超出範圍時丟出錯誤", () => {
    expect(() => computeStats("pick_wood", 0)).toThrow(RangeError);
    expect(() => computeStats("pick_wood", 6)).toThrow(RangeError);
    expect(() => computeStats("pick_wood", 2.5)).toThrow(RangeError);
  });
});
