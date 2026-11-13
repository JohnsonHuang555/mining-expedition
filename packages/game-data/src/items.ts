/**
 * 礦物、寶石與製作素材（GBS §8.1、§8.2）。
 */

export const MINERAL_IDS = ["stone", "coal", "copper", "iron_ore", "silver", "gold", "amethyst", "sapphire", "ruby"] as const;
export type MineralId = (typeof MINERAL_IDS)[number];

export const MATERIAL_IDS = ["iron_ingot", "reinforce_stone", "refined_crystal"] as const;
export type MaterialId = (typeof MATERIAL_IDS)[number];

export type ItemId = MineralId | MaterialId;

/** 方塊礦物為 Common，只能從 Rare 判定取得的寶石為 Rare（D19：P13） */
export type MineralRarity = "common" | "rare";

export interface MineralDef {
  id: MineralId;
  name: string;
  rarity: MineralRarity;
  /** 固定售價（GBS §8.1，P14） */
  sellPrice: number;
}

export const MINERALS: Readonly<Record<MineralId, MineralDef>> = {
  stone: { id: "stone", name: "石頭", rarity: "common", sellPrice: 1 },
  coal: { id: "coal", name: "煤炭", rarity: "common", sellPrice: 3 },
  copper: { id: "copper", name: "銅礦", rarity: "common", sellPrice: 6 },
  iron_ore: { id: "iron_ore", name: "鐵礦", rarity: "common", sellPrice: 8 },
  silver: { id: "silver", name: "銀礦", rarity: "common", sellPrice: 35 },
  gold: { id: "gold", name: "黃金", rarity: "common", sellPrice: 90 },
  amethyst: { id: "amethyst", name: "紫水晶", rarity: "rare", sellPrice: 50 },
  sapphire: { id: "sapphire", name: "藍寶石", rarity: "rare", sellPrice: 150 },
  ruby: { id: "ruby", name: "紅寶石", rarity: "rare", sellPrice: 500 },
};

export interface MaterialDef {
  id: MaterialId;
  name: string;
  /** 配方（GBS §8.2）；製作素材不可出售（P16） */
  recipe: Readonly<Partial<Record<MineralId, number>>>;
}

export const MATERIALS: Readonly<Record<MaterialId, MaterialDef>> = {
  iron_ingot: { id: "iron_ingot", name: "鐵錠", recipe: { iron_ore: 5, coal: 2 } },
  reinforce_stone: { id: "reinforce_stone", name: "強化石", recipe: { stone: 20, iron_ore: 5 } },
  // GDD 原文為「水晶 ×3」；GBS 提案 P15 定為紫水晶（待確認）
  refined_crystal: { id: "refined_crystal", name: "精煉水晶", recipe: { amethyst: 3 } },
};
