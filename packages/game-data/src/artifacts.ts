/**
 * 寶物與收藏套組（GBS §8.3、§9；決策 D3）。
 * zone1、zone2 的名稱為暫定（P17）。
 */

export const ARTIFACT_IDS = [
  "a_z1_lantern", "a_z1_badge", "a_z1_map", "a_z1_heart",
  "a_z2_orb", "a_z2_crown", "a_z2_mural", "a_z2_heart",
  "a_z3_emblem", "a_z3_ring", "a_z3_tablet", "a_z3_crown",
] as const;
export type ArtifactId = (typeof ARTIFACT_IDS)[number];

/** 寶物稀有度只有 Epic / Legendary（D19：P13） */
export type ArtifactRarity = "epic" | "legendary";

export const SET_IDS = ["old_miner", "crystal_resonance", "ancient_civilization"] as const;
export type SetId = (typeof SET_IDS)[number];

export interface ArtifactDef {
  id: ArtifactId;
  name: string;
  rarity: ArtifactRarity;
  zone: 0 | 1 | 2;
  baseValue: number;
  set: SetId | null;
}

export const ARTIFACTS: Readonly<Record<ArtifactId, ArtifactDef>> = {
  a_z1_lantern: { id: "a_z1_lantern", name: "老礦工的提燈", rarity: "epic", zone: 0, baseValue: 300, set: "old_miner" },
  a_z1_badge: { id: "a_z1_badge", name: "生鏽的礦工徽章", rarity: "epic", zone: 0, baseValue: 300, set: "old_miner" },
  a_z1_map: { id: "a_z1_map", name: "褪色的礦區地圖", rarity: "epic", zone: 0, baseValue: 300, set: "old_miner" },
  a_z1_heart: { id: "a_z1_heart", name: "礦脈之心", rarity: "legendary", zone: 0, baseValue: 3_000, set: null },
  a_z2_orb: { id: "a_z2_orb", name: "共鳴水晶球", rarity: "epic", zone: 1, baseValue: 2_000, set: "crystal_resonance" },
  a_z2_crown: { id: "a_z2_crown", name: "晶簇頭冠", rarity: "epic", zone: 1, baseValue: 2_000, set: "crystal_resonance" },
  a_z2_mural: { id: "a_z2_mural", name: "洞窟壁畫拓片", rarity: "epic", zone: 1, baseValue: 2_000, set: "crystal_resonance" },
  a_z2_heart: { id: "a_z2_heart", name: "永恆水晶之心", rarity: "legendary", zone: 1, baseValue: 20_000, set: null },
  a_z3_emblem: { id: "a_z3_emblem", name: "古代黃金徽章", rarity: "epic", zone: 2, baseValue: 6_000, set: "ancient_civilization" },
  a_z3_ring: { id: "a_z3_ring", name: "遠古王者之戒", rarity: "epic", zone: 2, baseValue: 6_000, set: "ancient_civilization" },
  a_z3_tablet: { id: "a_z3_tablet", name: "古代文明石板", rarity: "epic", zone: 2, baseValue: 6_000, set: "ancient_civilization" },
  a_z3_crown: { id: "a_z3_crown", name: "失落王朝的王冠", rarity: "legendary", zone: 2, baseValue: 60_000, set: null },
};

export interface SetDef {
  id: SetId;
  name: string;
  members: readonly ArtifactId[];
  /** Speed 加成（百分比整數；多套相加後乘，GBS §3） */
  speedPct: number;
  /** Luck 加值（ppm；直接加到 Luck） */
  luckPpm: number;
}

/** GBS §9：實際持有全部成員才啟動（D3） */
export const SETS: Readonly<Record<SetId, SetDef>> = {
  old_miner: { id: "old_miner", name: "老礦工套組", members: ["a_z1_lantern", "a_z1_badge", "a_z1_map"], speedPct: 3, luckPpm: 0 },
  crystal_resonance: { id: "crystal_resonance", name: "水晶共鳴套組", members: ["a_z2_orb", "a_z2_crown", "a_z2_mural"], speedPct: 0, luckPpm: 20_000 },
  ancient_civilization: { id: "ancient_civilization", name: "古代文明套組", members: ["a_z3_emblem", "a_z3_ring", "a_z3_tablet"], speedPct: 3, luckPpm: 20_000 },
};
