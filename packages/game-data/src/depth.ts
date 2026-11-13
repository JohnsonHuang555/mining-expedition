/**
 * 深度、深度帶與門檻（GBS §1、§2.1、§5；決策 D1）。
 *
 * - blockIndex 0–2999；深度（m）= blockIndex / 10
 * - 深度帶（Band）：每 10m（100 方塊）一個 Hardness，共 30 帶
 * - 門檻段（Segment）：每 50m（500 方塊）一個 RequiredPower 與金幣金額，共 6 段
 */

export const BLOCKS_PER_METER = 10;
export const BLOCKS_PER_BAND = 100;
export const BLOCKS_PER_SEGMENT = 500;
export const BLOCKS_PER_ZONE = 1000;
export const TOTAL_BLOCKS = 3000;
export const BAND_COUNT = TOTAL_BLOCKS / BLOCKS_PER_BAND; // 30
export const SEGMENT_COUNT = TOTAL_BLOCKS / BLOCKS_PER_SEGMENT; // 6

/** GBS §5：每個深度帶的 Hardness（index = band，0 = 0–10m） */
export const BAND_HARDNESS: readonly number[] = [
  15, 35, 85, 210, 490, 820, 950, 1_100, 1_300, 1_500,
  1_750, 2_150, 2_600, 3_100, 3_800, 4_650, 5_850, 7_300, 9_200, 11_500,
  14_000, 16_500, 19_000, 22_500, 26_500, 29_000, 30_000, 31_000, 31_500, 32_500,
];

/** GBS §5.1：每個門檻段的 RequiredPower，×10 定點（1 → 10、36 → 360） */
export const SEGMENT_REQUIRED_POWER10: readonly number[] = [10, 40, 90, 160, 270, 360];
