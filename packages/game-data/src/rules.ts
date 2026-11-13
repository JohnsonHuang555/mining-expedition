/**
 * 掉落、模式與時間相關的常數（GBS §2.2、§7、§7.7、§15；決策 D7、D9、D12、D14、D16、D18）。
 */

import type { ArtifactId } from "./artifacts.ts";

export const PPM = 1_000_000;

export const MINING_MODES = ["frontier", "revisit", "rework"] as const;
export type MiningMode = (typeof MINING_MODES)[number];

/** 第三層金幣金額的模式倍率（ppm）。回訪 ×0.5 為 D12；重挖 ×0.5 為暫定 */
export const COIN_MODE_MULTIPLIER_PPM: Readonly<Record<MiningMode, number>> = {
  frontier: 1_000_000,
  revisit: 500_000,
  rework: 500_000,
};

/** 第四層寶物機會的模式倍率（ppm）。回訪 ×0.5 為 D14（MVP 暫定）；重挖 ×0.5 為暫定 */
export const TREASURE_MODE_MULTIPLIER_PPM: Readonly<Record<MiningMode, number>> = {
  frontier: 1_000_000,
  revisit: 500_000,
  rework: 500_000,
};

/** 第四層：寶物機會中 Legendary 與 Epic 的比例（9 : 1，GDD §4.1） */
export const LEGENDARY_SHARE_PPM = 100_000;
export const EPIC_SHARE_PPM = 900_000;

/** 第四層：每方塊寶物機會上限（P37，防護用） */
export const TREASURE_CHANCE_CAP_PPM = 500_000;

/** 首次寶物保護（D17、D18）：門檻與固定 Epic（P39）。發放邏輯在 Settlement 階段實作 */
export const FIRST_TREASURE_PROTECT_MS = 14_400_000;
export const FIRST_TREASURE_PROTECTED_ARTIFACT: ArtifactId = "a_z1_lantern";

/** 離線（D9、P28）。結算流程在 Settlement 階段實作 */
export const OFFLINE_CAP_MS = 12 * 60 * 60 * 1000;
export const ONLINE_GAP_MS = 300_000;
