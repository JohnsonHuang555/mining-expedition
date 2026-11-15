/**
 * 經濟畫面用的「顯示用」計算。成本、價格、配方全部取自 @mining/game-data，不重新定義任何規則；
 * 合法性與實際扣款一律由伺服器（引擎 applyAction）決定，這裡只用來顯示與停用按鈕。
 */

import { ARTIFACTS, type ItemId, MATERIALS, MATERIAL_IDS, MAX_PICKAXE_LEVEL, MINERALS, MINERAL_IDS, type MaterialId, type MineralId, PICKAXES, PICKAXE_IDS, type PickaxeId } from "@mining/game-data";
import { MAX_ACTION_QUANTITY, type PlayerGameState, type Stats, computeStats, heldCounts } from "@mining/game-engine";

export interface CostLine {
  id: ItemId | "coins";
  need: number;
  have: number;
}

export interface CostCheck {
  lines: CostLine[];
  missing: CostLine[];
  ok: boolean;
}

export function checkCost(state: PlayerGameState, cost: { coins?: number; items?: Partial<Record<ItemId, number>> }, times = 1): CostCheck {
  const lines: CostLine[] = [];
  if (cost.coins) lines.push({ id: "coins", need: cost.coins * times, have: state.coins });
  for (const [id, n] of Object.entries(cost.items ?? {})) lines.push({ id: id as ItemId, need: (n ?? 0) * times, have: state.inventory[id as ItemId] ?? 0 });
  const missing = lines.filter((l) => l.have < l.need);
  return { lines, missing, ok: missing.length === 0 };
}

// ---------------------------------------------------------------- 背包

export interface MineralRow {
  id: MineralId;
  quantity: number;
  unitPrice: number;
  totalValue: number;
  rarity: "common" | "rare";
}

/** 礦物出售：固定價格（GBS：MINERALS[id].sellPrice）；不受市場倍率影響 */
export function mineralRows(state: PlayerGameState): MineralRow[] {
  return MINERAL_IDS.filter((id) => (state.inventory[id] ?? 0) > 0).map((id) => {
    const quantity = state.inventory[id] ?? 0;
    const unitPrice = MINERALS[id].sellPrice;
    return { id, quantity, unitPrice, totalValue: unitPrice * quantity, rarity: MINERALS[id].rarity };
  });
}

export function materialRows(state: PlayerGameState): { id: MaterialId; quantity: number }[] {
  return MATERIAL_IDS.filter((id) => (state.inventory[id] ?? 0) > 0).map((id) => ({ id, quantity: state.inventory[id] ?? 0 }));
}

export const sellEstimate = (id: MineralId, quantity: number): number => MINERALS[id].sellPrice * quantity;

/** 出售數量是否合法（整數、1 以上、不超過持有量與單次上限） */
export function validQuantity(q: number, max: number): boolean {
  return Number.isSafeInteger(q) && q >= 1 && q <= Math.min(max, MAX_ACTION_QUANTITY);
}

export function artifactRows(state: PlayerGameState) {
  return state.heldArtifacts.map((a) => ({ ...a, name: ARTIFACTS[a.artifactId].name, rarity: ARTIFACTS[a.artifactId].rarity }));
}

// ---------------------------------------------------------------- 工坊

export type PickaxeStatus = "equipped" | "owned" | "purchasable" | "locked";

export interface PickaxeRow {
  id: PickaxeId;
  tier: number;
  name: string;
  status: PickaxeStatus;
  level: number | null;
  stats: Stats;
  /** 下一級的數值（已擁有且未滿級時） */
  nextStats: Stats | null;
  maxed: boolean;
  purchase: CostCheck | null;
  upgrade: CostCheck | null;
}

export function pickaxeRows(state: PlayerGameState): PickaxeRow[] {
  const held = heldCounts(state);
  const ownedCount = PICKAXE_IDS.filter((id) => state.pickaxes[id] !== undefined).length;
  return PICKAXE_IDS.map((id, tier) => {
    const def = PICKAXES[tier]!;
    const level = state.pickaxes[id] ?? null;
    const status: PickaxeStatus = level === null ? (tier === ownedCount ? "purchasable" : "locked") : state.equippedPickaxe === id ? "equipped" : "owned";
    const maxed = level !== null && level >= MAX_PICKAXE_LEVEL;
    return {
      id,
      tier,
      name: def.name,
      status,
      level,
      stats: computeStats(id, level ?? 1, held),
      nextStats: level !== null && !maxed ? computeStats(id, level + 1, held) : null,
      maxed,
      purchase: level === null && def.purchase ? checkCost(state, def.purchase) : null,
      upgrade: level !== null && !maxed ? checkCost(state, def.upgrades[level - 1]!) : null,
    };
  });
}

// ---------------------------------------------------------------- 製作

export interface RecipeRow {
  id: MaterialId;
  name: string;
  owned: number;
  recipe: CostLine[];
  /** 目前最多可以製作幾份（受單次上限限制） */
  maxTimes: number;
}

export function recipeRows(state: PlayerGameState): RecipeRow[] {
  return MATERIAL_IDS.map((id) => {
    const recipe = MATERIALS[id].recipe;
    const lines = Object.entries(recipe).map(([item, n]) => ({ id: item as ItemId, need: n ?? 0, have: state.inventory[item as ItemId] ?? 0 }));
    const maxTimes = Math.min(MAX_ACTION_QUANTITY, ...lines.map((l) => Math.floor(l.have / Math.max(1, l.need))));
    return { id, name: MATERIALS[id].name, owned: state.inventory[id] ?? 0, recipe: lines, maxTimes };
  });
}
