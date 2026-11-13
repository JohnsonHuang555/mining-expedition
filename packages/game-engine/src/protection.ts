/**
 * 首次寶物保護的判定（GBS §7.7；決策 D17、D18；D19：P39）。
 *
 * 這裡只有純判定函式：帳號狀態的保存、跨結算累積與冪等發放屬於 Settlement 階段（TECHNICAL_SPEC §7、§8）。
 * 判定不消耗亂數，所以有沒有保護都不會改變任何方塊的四層結果（D17）。
 */

import { type ArtifactId, FIRST_TREASURE_PROTECTED_ARTIFACT, FIRST_TREASURE_PROTECT_MS } from "@mining/game-data";
import { assertNonNegativeInt, assertPositiveInt } from "./fixed.ts";

export type FirstTreasureStatus = "pending" | "obtained" | "granted";

export interface FirstTreasureStep {
  status: FirstTreasureStatus;
  /** 累積的有效挖掘毫秒數（只加已完成方塊的挖掘時間） */
  effectiveMs: number;
  /** 本方塊由保護發放的寶物（沒有則為 null） */
  granted: ArtifactId | null;
}

/**
 * 方塊完成、四層判定之後呼叫（GBS §4.3 步驟 5）。
 *
 * @param status       方塊完成前的狀態
 * @param effectiveMs  方塊完成前累積的有效挖掘毫秒數
 * @param blockMs      本方塊的挖掘毫秒數（任何模式）
 * @param dropped      本方塊第四層掉落的寶物（null = 沒有）
 * @param thresholdMs  門檻；正式結算一律使用預設值（D18：4 小時）。只有平衡模擬比較 A / B / C 方案時才傳入其他值
 */
export function firstTreasureStep(
  status: FirstTreasureStatus,
  effectiveMs: number,
  blockMs: number,
  dropped: ArtifactId | null,
  thresholdMs: number = FIRST_TREASURE_PROTECT_MS,
): FirstTreasureStep {
  assertNonNegativeInt("effectiveMs", effectiveMs);
  assertPositiveInt("blockMs", blockMs);
  assertPositiveInt("thresholdMs", thresholdMs);
  const nextMs = effectiveMs + blockMs;
  if (status !== "pending") return { status, effectiveMs: nextMs, granted: null };
  if (dropped !== null) return { status: "obtained", effectiveMs: nextMs, granted: null };
  if (nextMs >= thresholdMs) {
    return { status: "granted", effectiveMs: nextMs, granted: FIRST_TREASURE_PROTECTED_ARTIFACT };
  }
  return { status: "pending", effectiveMs: nextMs, granted: null };
}
