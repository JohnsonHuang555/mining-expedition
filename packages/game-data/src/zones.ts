/**
 * 礦區與掉落表（GBS §2、§6、§7、§12；決策 D1、D7、D10、D13）。
 */

import type { ArtifactId, SetId } from "./artifacts.ts";
import type { MineralId } from "./items.ts";

export const ZONE_IDS = ["zone1", "zone2", "zone3"] as const;
export type ZoneId = (typeof ZONE_IDS)[number];

export interface WeightedEntry<T> {
  id: T;
  weight: number;
}

export interface RareEntry {
  id: MineralId;
  weight: number;
  quantity: number;
}

export interface ZoneDef {
  id: ZoneId;
  name: string;
  /** 解鎖費用：前線挖完上一區底部並付費（D10、GBS §12） */
  unlockFee: number;
  /** 第一層：基礎產出的 OreType 權重（GBS §6，P8） */
  oreTable: readonly WeightedEntry<MineralId>[];
  /** 第二層：礦石包機率（ppm）與包含的礦物數 */
  bundleChancePpm: number;
  bundleSize: number;
  /** 第二層：Rare 基礎機率（ppm，乘以 1 + Luck） */
  rareBasePpm: number;
  rareTable: readonly RareEntry[];
  /** 第三層：金幣機率（ppm）與兩個門檻段的平均金額（D13） */
  coinChancePpm: number;
  coinAvgBySegment: readonly [number, number];
  /** 第四層：每小時寶物機會 × 1000（0.35/h → 350） */
  treasurePerHourMilli: number;
  epics: readonly [ArtifactId, ArtifactId, ArtifactId];
  legendary: ArtifactId;
  set: SetId;
}

export const ZONES: readonly [ZoneDef, ZoneDef, ZoneDef] = [
  {
    id: "zone1",
    name: "新手礦坑",
    unlockFee: 0,
    oreTable: [
      { id: "stone", weight: 60 },
      { id: "coal", weight: 15 },
      { id: "copper", weight: 13 },
      { id: "iron_ore", weight: 12 },
    ],
    bundleChancePpm: 150_000,
    bundleSize: 3,
    rareBasePpm: 25_000,
    rareTable: [
      { id: "silver", weight: 50, quantity: 1 },
      { id: "amethyst", weight: 50, quantity: 1 },
    ],
    coinChancePpm: 100_000,
    coinAvgBySegment: [20, 20],
    treasurePerHourMilli: 350,
    epics: ["a_z1_lantern", "a_z1_badge", "a_z1_map"],
    legendary: "a_z1_heart",
    set: "old_miner",
  },
  {
    id: "zone2",
    name: "水晶洞窟",
    unlockFee: 800,
    oreTable: [
      { id: "stone", weight: 55 },
      { id: "iron_ore", weight: 15 },
      { id: "silver", weight: 30 },
    ],
    bundleChancePpm: 150_000,
    bundleSize: 3,
    rareBasePpm: 35_000,
    rareTable: [
      { id: "amethyst", weight: 65, quantity: 2 },
      { id: "sapphire", weight: 35, quantity: 1 },
    ],
    coinChancePpm: 100_000,
    coinAvgBySegment: [150, 330],
    treasurePerHourMilli: 250,
    epics: ["a_z2_orb", "a_z2_crown", "a_z2_mural"],
    legendary: "a_z2_heart",
    set: "crystal_resonance",
  },
  {
    id: "zone3",
    name: "古代遺跡",
    unlockFee: 3_000,
    oreTable: [
      { id: "stone", weight: 50 },
      { id: "silver", weight: 15 },
      { id: "gold", weight: 35 },
    ],
    bundleChancePpm: 150_000,
    bundleSize: 3,
    rareBasePpm: 50_000,
    rareTable: [
      { id: "sapphire", weight: 50, quantity: 2 },
      { id: "ruby", weight: 50, quantity: 1 },
    ],
    coinChancePpm: 100_000,
    coinAvgBySegment: [1_100, 1_400],
    treasurePerHourMilli: 175,
    epics: ["a_z3_emblem", "a_z3_ring", "a_z3_tablet"],
    legendary: "a_z3_crown",
    set: "ancient_civilization",
  },
];
