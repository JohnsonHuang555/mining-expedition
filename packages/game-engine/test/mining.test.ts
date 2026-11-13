import { describe, expect, it } from "vitest";
import {
  advanceWork,
  blockMs,
  blockWork,
  computeStats,
  frontierBlock,
  frontierSpot,
  revisitSpot,
  revisitableZones,
  reworkBand,
  reworkSpot,
  spotBlockMs,
  workRate,
} from "../src/index.ts";

describe("Power 門檻（GBS §4.2；D5、P6）", () => {
  it("Power 不足時前線停止；等於需求時可以挖", () => {
    const wood = computeStats("pick_wood", 1).power10; // 20
    expect(frontierBlock(499, 0, wood)).toBeNull(); // 0–50m 需要 1.0
    expect(frontierBlock(500, 0, wood)).toBe("power"); // 50m 需要 4.0
    expect(frontierBlock(500, 0, 40)).toBeNull(); // 剛好 4.0
    expect(frontierBlock(500, 0, 39)).toBe("power");
  });

  it("未解鎖下一區時停止；主線完成時回報 completed", () => {
    expect(frontierBlock(1000, 0, 420)).toBe("locked");
    expect(frontierBlock(1000, 1, 420)).toBeNull();
    expect(frontierBlock(2000, 1, 420)).toBe("locked");
    expect(frontierBlock(3000, 2, 420)).toBe("completed");
  });

  it("前線位置使用該方塊所在深度帶與門檻段", () => {
    expect(frontierSpot(0)).toMatchObject({ mode: "frontier", band: 0, segment: 0, zone: 0, hardness: 15, requiredPower10: 10 });
    expect(frontierSpot(1999)).toMatchObject({ band: 19, segment: 3, zone: 1, hardness: 11_500, requiredPower10: 160 });
    expect(frontierSpot(2999)).toMatchObject({ band: 29, segment: 5, zone: 2, hardness: 32_500, requiredPower10: 360 });
    expect(() => frontierSpot(3000)).toThrow(RangeError);
  });
});

describe("回訪（GBS §2.3；D8、D15）", () => {
  it("只能回訪已解鎖、且比前線所在礦區淺的礦區；主線完成後全部可回訪", () => {
    expect(revisitableZones(500, 0)).toEqual([]);
    expect(revisitableZones(1500, 1)).toEqual([0]);
    expect(revisitableZones(2500, 2)).toEqual([0, 1]);
    expect(revisitableZones(3000, 2)).toEqual([0, 1, 2]);
  });

  it("礦區邊界（GBS §2.3.1）：前線所在礦區 = 下一個前線方塊所在的礦區，未解鎖也一樣", () => {
    const cases: [number, 0 | 1 | 2, number[]][] = [
      [999, 0, []],
      [1000, 0, [0]], // 到達 100m、zone2 未解鎖：可回訪 zone1
      [1000, 1, [0]],
      [1999, 1, [0]],
      [2000, 1, [0, 1]], // 到達 200m、zone3 未解鎖：可回訪 zone1、zone2
      [2000, 2, [0, 1]],
      [3000, 2, [0, 1, 2]],
    ];
    for (const [frontier, unlocked, zones] of cases) expect(revisitableZones(frontier, unlocked)).toEqual(zones);
    // 卡在解鎖費時，重挖也同時可用
    expect(frontierBlock(1000, 0, 50)).toBe("locked");
    expect(reworkBand(1000, 0, 50)).toBe(9);
    expect(frontierBlock(2000, 1, 180)).toBe("locked");
    expect(reworkBand(2000, 1, 180)).toBe(19);
  });

  it("位置固定在礦區最深帶", () => {
    expect(revisitSpot(0)).toMatchObject({ mode: "revisit", band: 9, hardness: 1_500, requiredPower10: 40, segment: 1 });
    expect(revisitSpot(1)).toMatchObject({ band: 19, hardness: 11_500, requiredPower10: 160, segment: 3 });
    expect(revisitSpot(2)).toMatchObject({ band: 29, hardness: 32_500, requiredPower10: 360, segment: 5 });
  });
});

describe("重挖（GBS §2.4；D16）", () => {
  it("前線未卡關時不能重挖", () => {
    expect(reworkBand(300, 0, 20)).toBeNull();
    expect(reworkBand(3000, 2, 420)).toBeNull();
  });

  it("Power 卡關：從最後挖完的深度帶往上找第一個可挖的深度帶", () => {
    // 木製 Lv5（2.8）停在 50m：最後挖完的是 49.9m（band 4，需求 1.0）
    expect(reworkBand(500, 0, 28)).toBe(4);
    // 石製（5.0）停在 100m 且 zone2 未解鎖：band 9 需求 4.0 → 可挖
    expect(reworkBand(1000, 0, 50)).toBe(9);
    // 鐵製 Lv5（14）停在 150m（需要 16）：band 14 需求 9 → 可挖
    expect(reworkBand(1500, 1, 140)).toBe(14);
  });

  it("沒有挖完任何方塊時回傳 null；重挖位置使用該深度帶的數值", () => {
    expect(reworkBand(0, 0, 5)).toBeNull();
    expect(reworkSpot(14)).toMatchObject({ mode: "rework", band: 14, zone: 1, segment: 2, hardness: 3_800, requiredPower10: 90 });
  });
});

describe("工作量（D19：P5）", () => {
  it("完成條件 work ≥ Hardness × 10^7；一次挖完的時間 = blockMs", () => {
    const s = computeStats("pick_stone", 3);
    const spot = frontierSpot(800);
    const step = advanceWork(0, spot.hardness, workRate(s), 10 ** 9);
    expect(step).toEqual({ completed: true, usedMs: spotBlockMs(spot, s), work: 0 });
    expect(blockWork(15)).toBe(150_000_000);
  });

  it("中途換裝備保留工作量，只改變之後的速率", () => {
    const h = 1_500;
    const wood = workRate(computeStats("pick_wood", 1)); // 20,000 / ms
    const stone = workRate(computeStats("pick_stone", 1)); // 60,000 / ms
    const half = advanceWork(0, h, wood, 375_000); // 7.5e9 / 1.5e10
    expect(half).toEqual({ completed: false, usedMs: 375_000, work: 7_500_000_000 });
    const done = advanceWork(half.work, h, stone, 10 ** 9);
    expect(done).toEqual({ completed: true, usedMs: 125_000, work: 0 });
    expect(half.usedMs + done.usedMs).toBeLessThan(blockMs(h, 20, 1000));
  });

  it("剩餘工作量不能整除速率時無條件進位", () => {
    expect(advanceWork(0, 1, 3, 10 ** 9).usedMs).toBe(3_333_334);
  });
});
