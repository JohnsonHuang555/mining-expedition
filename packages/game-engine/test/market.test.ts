import { ARTIFACTS, ARTIFACT_IDS, MARKET_MULTIPLIER_RANGE_PPM, MARKET_STEP_PPM } from "@mining/game-data";
import { describe, expect, it } from "vitest";
import {
  addMarketDays,
  artifactSalePrice,
  isMarketDate,
  marketDateOf,
  marketDayStart,
  marketMultiplierFor,
  nextMarketRefreshAt,
  nextMultiplierPpm,
} from "../src/market.ts";
import { sha256 } from "../src/rng/sha256.ts";

const secret = sha256(new TextEncoder().encode("market-tests"));
const digestOf = (bytes: number[]) => Uint8Array.from([...bytes, ...new Array(32 - bytes.length).fill(0)]);

describe("市場日（Asia/Taipei，固定 UTC+8）", () => {
  it("UTC 15:59:59.999 仍是前一日；UTC 16:00 換日；下一次刷新是下一個台灣 00:00", () => {
    const t = Date.parse("2026-11-15T16:00:00Z"); // 台灣 11/16 00:00
    expect(marketDateOf(t - 1)).toBe("2026-11-15");
    expect(marketDateOf(t)).toBe("2026-11-16");
    expect(nextMarketRefreshAt(t - 1)).toBe(t);
    expect(nextMarketRefreshAt(t)).toBe(t + 86_400_000);
    expect(marketDayStart("2026-11-16")).toBe(t);
  });

  it("跨月、跨年、閏年", () => {
    expect(marketDateOf(Date.parse("2026-12-31T16:00:00Z"))).toBe("2027-01-01");
    expect(addMarketDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addMarketDays("2027-02-28", 1)).toBe("2027-03-01");
    expect(isMarketDate("2028-02-29")).toBe(true);
    for (const bad of ["2027-02-29", "2026-13-01", "2026-1-01", "", null, 20261116]) expect(isMarketDate(bad)).toBe(false);
  });
});

describe("每日倍率遞推（GBS §13）", () => {
  it("ε 的兩端與均值回歸（整數 ppm）", () => {
    // u = 0 → ε = −Step；u ≡ 2·Step（mod 2·Step+1）→ ε = +Step
    expect(nextMultiplierPpm(1_000_000, "epic", digestOf([0, 0, 0, 0, 0, 0]))).toBe(880_000);
    const twoStep = 2 * MARKET_STEP_PPM.epic; // 240,000 = 0x03A980
    expect(nextMultiplierPpm(1_000_000, "epic", digestOf([0, 0, 0, 0x03, 0xa9, 0x80]))).toBe(1_120_000);
    // 前一日 1.20：drift = floor(0.35 × −0.2) = −70,000
    expect(nextMultiplierPpm(1_200_000, "epic", digestOf([0, 0, 0, 0x01, 0xd4, 0xc0]))).toBe(1_200_000 - 70_000); // u = 120,000 → ε = 0
    expect(twoStep).toBe(0x03a980);
  });

  it("永遠在 Min–Max；確定性（同一密鑰、日期、寶物 → 同一個倍率）", () => {
    for (const id of ARTIFACT_IDS) {
      const { min, max } = MARKET_MULTIPLIER_RANGE_PPM[ARTIFACTS[id].rarity];
      let m = 1_000_000;
      let date = "2026-01-01";
      const seen = new Set<number>();
      for (let d = 0; d < 400; d++) {
        const next = marketMultiplierFor(secret, date, id, m);
        expect(marketMultiplierFor(secret, date, id, m)).toBe(next);
        expect(next).toBeGreaterThanOrEqual(min);
        expect(next).toBeLessThanOrEqual(max);
        seen.add(next);
        m = next;
        date = addMarketDays(date, 1);
      }
      expect(seen.size).toBeGreaterThan(300); // 真的有波動
    }
  });

  it("極端值會被拉回（不會長期停在邊界）", () => {
    const { max } = MARKET_MULTIPLIER_RANGE_PPM.legendary;
    let m: number = max;
    let date = "2026-01-01";
    let sum = 0;
    for (let d = 0; d < 1000; d++) {
      m = marketMultiplierFor(secret, date, "a_z1_heart", m);
      sum += m;
      date = addMarketDays(date, 1);
    }
    expect(Math.abs(sum / 1000 - 1_000_000)).toBeLessThan(30_000);
  });

  it("售價 = floor(BaseValue × 倍率)", () => {
    expect(artifactSalePrice("a_z1_badge", 1_250_000)).toBe(Math.floor(ARTIFACTS.a_z1_badge.baseValue * 1.25));
    expect(artifactSalePrice("a_z1_heart", 700_001)).toBe(Math.floor((ARTIFACTS.a_z1_heart.baseValue * 700_001) / 1_000_000));
  });
});
