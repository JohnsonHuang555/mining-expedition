import { describe, expect, it } from "vitest";
import { MAX_HARDNESS, WORK_SCALE, blockMs, canMine, engineInfo } from "../src/index.ts";

/** 參考實作：完全以 BigInt 計算 ceil(h × 10^7 / (p × s)) */
function referenceMs(h: number, p: number, s: number): bigint {
  const work = BigInt(h) * BigInt(WORK_SCALE);
  const rate = BigInt(p) * BigInt(s);
  return (work + rate - 1n) / rate;
}

describe("blockMs（TECHNICAL_SPEC §5）", () => {
  it("木製 Lv1 挖 0–10m（Hardness 15）需要 7.5 秒", () => {
    // power10 = 20、speed1000 = 1000 → 15 / (2.0 × 1.0) = 7.5 s
    expect(blockMs(15, 20, 1000)).toBe(7500);
  });

  it("無法整除時無條件進位", () => {
    // 鑽石 Lv5：power10 = 420、speed1000 = 2640；290–300m Hardness 32,500
    expect(BigInt(blockMs(32_500, 420, 2640))).toBe(referenceMs(32_500, 420, 2640));
    expect(blockMs(1, 3, 1)).toBe(3_333_334);
  });

  it("拒絕非正整數，避免浮點誤差進入結算", () => {
    expect(() => blockMs(1.5, 20, 1000)).toThrow(RangeError);
    expect(() => blockMs(15, 0, 1000)).toThrow(RangeError);
    expect(() => blockMs(15, 20, -1)).toThrow(RangeError);
    expect(() => blockMs(Number.NaN, 20, 1000)).toThrow(RangeError);
    expect(() => blockMs(Number.POSITIVE_INFINITY, 20, 1000)).toThrow(RangeError);
  });
});

describe("blockMs 的 safe integer 邊界", () => {
  it("MAX_HARDNESS × WORK_SCALE 仍是 safe integer，再加 1 就不是", () => {
    expect(Number.isSafeInteger(MAX_HARDNESS * WORK_SCALE)).toBe(true);
    expect((MAX_HARDNESS + 1) * WORK_SCALE).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
  });

  it("Hardness = MAX_HARDNESS 可以計算且結果精確", () => {
    const ms = blockMs(MAX_HARDNESS, 1, 1);
    expect(Number.isSafeInteger(ms)).toBe(true);
    expect(BigInt(ms)).toBe(referenceMs(MAX_HARDNESS, 1, 1));
  });

  it("Hardness 超過 MAX_HARDNESS 時丟出 RangeError（工作量會溢位）", () => {
    expect(() => blockMs(MAX_HARDNESS + 1, 1, 1)).toThrow(RangeError);
    expect(() => blockMs(Number.MAX_SAFE_INTEGER, 1, 1)).toThrow(RangeError);
  });

  it("power10 × speed1000 超過 MAX_SAFE_INTEGER 時丟出 RangeError", () => {
    const big = 2 ** 27; // 2^27 × 2^27 = 2^54 > 2^53 − 1
    expect(() => blockMs(15, big, big)).toThrow(RangeError);
    // 剛好在範圍內的乘積可以計算
    expect(blockMs(15, 2 ** 26, 2 ** 26)).toBe(1);
  });

  it("接近 2^53 的大數值時與 BigInt 參考實作一致", () => {
    // blockMs 以 BigInt 計算，結果的正確性不依賴浮點除法的捨入行為
    const cases: [number, number, number][] = [
      [MAX_HARDNESS, 3, 1],
      [MAX_HARDNESS, 7, 13],
      [MAX_HARDNESS - 1, 999_983, 1],
      [123_456_789, 97, 89],
      [32_500, 420, 2640],
    ];
    for (const [h, p, s] of cases) {
      expect(BigInt(blockMs(h, p, s))).toBe(referenceMs(h, p, s));
    }
  });

  it("MVP 全部 Hardness × 十字鎬組合的結果都是 safe integer", () => {
    const hardness = [15, 490, 1500, 11_500, 32_500];
    const power10 = [20, 28, 50, 70, 100, 140, 180, 252, 300, 420];
    const speed1000 = [1000, 1200, 1440, 1500, 1800, 2160, 2200, 2640, 2798];
    for (const h of hardness) for (const p of power10) for (const s of speed1000) {
      const ms = blockMs(h, p, s);
      expect(Number.isSafeInteger(ms)).toBe(true);
      expect(BigInt(ms)).toBe(referenceMs(h, p, s));
    }
  });
});

describe("canMine（D19：P6，使用 ≥）", () => {
  it("鑽石 Lv3 的 power10 = 360 剛好可以挖 250m（需求 360）", () => {
    expect(canMine(360, 360)).toBe(true);
    expect(canMine(359, 360)).toBe(false);
  });
});

describe("engineInfo", () => {
  it("讀得到 @mining/game-data 的版本號（驗證 workspace 匯入）", () => {
    expect(engineInfo()).toEqual({ engineVersion: "0.1.0", dataVersion: 1, rngVersion: 1 });
  });
});
