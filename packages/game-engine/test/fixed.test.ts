import { describe, expect, it } from "vitest";
import { blockMs, canMine, engineInfo } from "../src/index.ts";

describe("blockMs（TECHNICAL_SPEC §5）", () => {
  it("木製 Lv1 挖 0–10m（Hardness 15）需要 7.5 秒", () => {
    // power10 = 20、speed1000 = 1000 → 15 / (2.0 × 1.0) = 7.5 s
    expect(blockMs(15, 20, 1000)).toBe(7500);
  });

  it("無法整除時無條件進位", () => {
    // 鑽石 Lv5：power10 = 420、speed1000 = 2640；290–300m Hardness 32,500
    expect(blockMs(32_500, 420, 2640)).toBe(Math.ceil((32_500 * 1e7) / (420 * 2640)));
  });

  it("拒絕非正整數，避免浮點誤差進入結算", () => {
    expect(() => blockMs(1.5, 20, 1000)).toThrow(RangeError);
    expect(() => blockMs(15, 0, 1000)).toThrow(RangeError);
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
