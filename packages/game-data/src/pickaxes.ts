/**
 * 十字鎬與強化（GBS §10；決策 D10、D19：P21）。
 */

import type { MaterialId, MineralId } from "./items.ts";

export const PICKAXE_IDS = ["pick_wood", "pick_stone", "pick_iron", "pick_gold", "pick_diamond"] as const;
export type PickaxeId = (typeof PICKAXE_IDS)[number];

export type PickaxeLevel = 1 | 2 | 3 | 4 | 5;
export const MAX_PICKAXE_LEVEL: PickaxeLevel = 5;

export interface Cost {
  coins: number;
  items: Readonly<Partial<Record<MineralId | MaterialId, number>>>;
}

export interface PickaxeDef {
  id: PickaxeId;
  name: string;
  /** Power ×10 */
  basePower10: number;
  /** Speed ×1000 */
  baseSpeed1000: number;
  /** Luck（ppm） */
  baseLuckPpm: number;
  /** 依序購買（D10）；木製為初始裝備 */
  purchase: Cost | null;
  /** 升到 Lv2–Lv5 的成本（index 0 = →Lv2）：round10(UpgradeBase × 1.8^(L−2))、強化石 L−1 */
  upgrades: readonly [Cost, Cost, Cost, Cost];
}

/** 每升一級的增幅（百分比，相對基礎值；GBS §10） */
export const LEVEL_BONUS_PCT = { power: 10, speed: 5, luck: 10 } as const;

const upgrades = (c2: number, c3: number, c4: number, c5: number): PickaxeDef["upgrades"] => [
  { coins: c2, items: { reinforce_stone: 1 } },
  { coins: c3, items: { reinforce_stone: 2 } },
  { coins: c4, items: { reinforce_stone: 3 } },
  { coins: c5, items: { reinforce_stone: 4 } },
];

export const PICKAXES: readonly [PickaxeDef, PickaxeDef, PickaxeDef, PickaxeDef, PickaxeDef] = [
  {
    id: "pick_wood",
    name: "木製十字鎬",
    basePower10: 20,
    baseSpeed1000: 1_000,
    baseLuckPpm: 0,
    purchase: null,
    upgrades: upgrades(40, 70, 130, 230),
  },
  {
    id: "pick_stone",
    name: "石製十字鎬",
    basePower10: 50,
    baseSpeed1000: 1_200,
    baseLuckPpm: 10_000,
    purchase: { coins: 200, items: { stone: 40 } },
    upgrades: upgrades(250, 450, 810, 1_460),
  },
  {
    id: "pick_iron",
    name: "鐵製十字鎬",
    basePower10: 100,
    baseSpeed1000: 1_500,
    baseLuckPpm: 30_000,
    purchase: { coins: 2_000, items: { iron_ingot: 8 } },
    upgrades: upgrades(800, 1_440, 2_590, 4_670),
  },
  {
    id: "pick_gold",
    name: "黃金十字鎬",
    basePower10: 180,
    baseSpeed1000: 1_800,
    baseLuckPpm: 70_000,
    purchase: { coins: 8_000, items: { iron_ingot: 12, refined_crystal: 4 } },
    upgrades: upgrades(2_500, 4_500, 8_100, 14_580),
  },
  {
    id: "pick_diamond",
    name: "鑽石十字鎬",
    basePower10: 300,
    baseSpeed1000: 2_200,
    baseLuckPpm: 120_000,
    purchase: { coins: 15_000, items: { refined_crystal: 10, reinforce_stone: 10 } },
    upgrades: upgrades(20_000, 36_000, 64_800, 116_640),
  },
];

/** GBS §10 強化成本公式的參數（用於資料一致性測試） */
export const UPGRADE_BASE: Readonly<Record<PickaxeId, number>> = {
  pick_wood: 40,
  pick_stone: 250,
  pick_iron: 800,
  pick_gold: 2_500,
  pick_diamond: 20_000,
};
export const UPGRADE_GROWTH_PER_MILLE = 1_800; // 1.8
