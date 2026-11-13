import { FIRST_TREASURE_PROTECT_MS } from "@mining/game-data";
import { describe, expect, it } from "vitest";
import { createBlockRng, firstTreasureStep, frontierSpot, rollBlock, sha256 } from "../src/index.ts";

describe("首次寶物保護判定（GBS §7.7；D17、D18）", () => {
  it("門檻為有效挖掘 4 小時", () => {
    expect(FIRST_TREASURE_PROTECT_MS).toBe(4 * 3_600_000);
  });

  it("達到門檻且本方塊沒有寶物 → 發放 a_z1_lantern（Epic）", () => {
    expect(firstTreasureStep("pending", FIRST_TREASURE_PROTECT_MS - 1000, 1000, null)).toEqual({
      status: "granted",
      effectiveMs: FIRST_TREASURE_PROTECT_MS,
      granted: "a_z1_lantern",
    });
    expect(firstTreasureStep("pending", FIRST_TREASURE_PROTECT_MS - 1001, 1000, null).granted).toBeNull();
  });

  it("本方塊自然掉落寶物 → obtained，不發放", () => {
    expect(firstTreasureStep("pending", FIRST_TREASURE_PROTECT_MS, 1000, "a_z1_heart")).toEqual({
      status: "obtained",
      effectiveMs: FIRST_TREASURE_PROTECT_MS + 1000,
      granted: null,
    });
  });

  it("狀態不是 pending 時永不觸發", () => {
    expect(firstTreasureStep("obtained", 10 ** 9, 1000, null).granted).toBeNull();
    expect(firstTreasureStep("granted", 10 ** 9, 1000, null).granted).toBeNull();
  });

  it("不消耗亂數：保護判定前後，同一方塊與後續方塊的四層結果不變", () => {
    const make = createBlockRng(sha256(new TextEncoder().encode("protect")));
    const spot = frontierSpot(300);
    const plain = Array.from({ length: 50 }, (_, i) => rollBlock(make(i), spot, 60_000, 0));
    let status: "pending" | "obtained" | "granted" = "pending";
    let eff = FIRST_TREASURE_PROTECT_MS - 60_000;
    const withProtection = Array.from({ length: 50 }, (_, i) => {
      const d = rollBlock(make(i), spot, 60_000, 0);
      const step = firstTreasureStep(status, eff, 60_000, d.artifact);
      status = step.status;
      eff = step.effectiveMs;
      return d;
    });
    expect(withProtection).toEqual(plain);
    expect(status).not.toBe("pending");
  });
});
