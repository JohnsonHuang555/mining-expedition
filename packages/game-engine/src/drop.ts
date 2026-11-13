/**
 * 四層掉落（GBS §6、§7；TECHNICAL_SPEC §5、§6.2；決策 D2、D7、D12、D13、D14；D19：P7、P8）。
 *
 * 每層都是「無」吸收差額的分類分布：Luck 只放大稀有結果（D2）。
 * 所有機率以 ppm 整數表示，與 `nextInt(1,000,000)` 比較；乘法中間值以 BigInt 計算。
 *
 * 一個方塊的亂數消耗順序（RNG_VERSION 1，改動要升版）：
 *   1. 第一層：OreType           nextInt(Σweight)
 *   2. 第二層：u2 = nextInt(1e6)  [0, bundle) 礦石包 → 再 3 次 OreType
 *                                [bundle, bundle + rare) Rare → 1 次 nextInt(ΣrareWeight)
 *   3. 第三層：u3 = nextInt(1e6)  < coinPpm → 金額 lo + nextInt(hi − lo + 1)
 *   4. 第四層：u4 = nextInt(1e6)  [0, leg) Legendary；[leg, leg + epic) Epic → nextInt(3)
 *   （5. 首次寶物保護：不消耗亂數，見 protection.ts）
 */

import {
  type ArtifactId,
  COIN_MODE_MULTIPLIER_PPM,
  EPIC_SHARE_PPM,
  LEGENDARY_SHARE_PPM,
  type MineralId,
  type MiningMode,
  PPM,
  TREASURE_CHANCE_CAP_PPM,
  TREASURE_MODE_MULTIPLIER_PPM,
  type WeightedEntry,
} from "@mining/game-data";
import { assertNonNegativeInt, assertPositiveInt, mulDivFloor } from "./fixed.ts";
import type { MiningSpot } from "./mining.ts";
import { zoneDef } from "./mining.ts";
import type { RandomSource } from "./rng/random-source.ts";

const MS_PER_HOUR = 3_600_000;

// ---------- 機率（純函式，供結算、UI 顯示與模擬器期望值共用） ----------

/** 第二層 Rare：floor(rareBasePpm × (1e6 + luckPpm) / 1e6) */
export function rarePpm(rareBasePpm: number, luckPpm: number): number {
  return mulDivFloor([rareBasePpm, PPM + luckPpm], PPM);
}

/**
 * 第三層金額範圍（GBS §7.3）：均勻整數 [round(0.5 × Avg), round(1.5 × Avg)]，
 * Avg = coinAvg × multPpm / 1e6。round 為四捨五入（.5 進位），以整數實作：
 *   a  = coinAvg × multPpm
 *   lo = floor((a + 1e6) / 2e6)
 *   hi = floor((3a + 1e6) / 2e6)
 */
export function coinRange(coinAvg: number, multPpm: number): { min: number; max: number } {
  assertNonNegativeInt("coinAvg", coinAvg);
  assertNonNegativeInt("multPpm", multPpm);
  const a = BigInt(coinAvg) * BigInt(multPpm);
  const twoPpm = BigInt(2 * PPM);
  const min = Number((a + BigInt(PPM)) / twoPpm);
  const max = Number((3n * a + BigInt(PPM)) / twoPpm);
  return { min, max };
}

/**
 * 第四層寶物機會（GBS §7.4）：
 *   chancePpm = min(500,000, floor(treasurePerHourMilli × blockMs × multPpm / 3,600,000,000))
 *
 * 以方塊的實際挖掘毫秒數計算，所以 Mining Speed 越快、每方塊機會越低，每小時期望值不變。
 * 驗算：0.35/h（350）× 1 小時（3,600,000 ms）× 1e6 / 3.6e9 = 350,000 ppm。
 */
export function treasureChancePpm(treasurePerHourMilli: number, blockMs: number, multPpm: number): number {
  const chance = mulDivFloor([treasurePerHourMilli, blockMs, multPpm], MS_PER_HOUR * 1_000);
  return Math.min(TREASURE_CHANCE_CAP_PPM, chance);
}

/** P(Legendary) / P(Epic) = floor(chancePpm × share × (1e6 + luckPpm) / 1e12)，單次取整 */
export function treasureSplitPpm(chancePpm: number, luckPpm: number): { legendaryPpm: number; epicPpm: number } {
  return {
    legendaryPpm: mulDivFloor([chancePpm, LEGENDARY_SHARE_PPM, PPM + luckPpm], PPM * PPM),
    epicPpm: mulDivFloor([chancePpm, EPIC_SHARE_PPM, PPM + luckPpm], PPM * PPM),
  };
}

/**
 * 模式倍率與金幣金額。正式結算一律使用 DEFAULT_DROP_RULES（= GBS v1.3）；
 * 只有平衡模擬比較方案（例如 D12 之前的倍率、D13 之前的固定金幣）時才傳入其他值，
 * 規則本身仍是同一份實作。
 */
export interface DropRules {
  coinModeMultiplierPpm: Readonly<Record<MiningMode, number>>;
  treasureModeMultiplierPpm: Readonly<Record<MiningMode, number>>;
  /** 依門檻段（0–5）覆寫 CoinAvg；未設定時使用礦區資料（D13） */
  coinAvgBySegment?: readonly number[];
}

export const DEFAULT_DROP_RULES: DropRules = {
  coinModeMultiplierPpm: COIN_MODE_MULTIPLIER_PPM,
  treasureModeMultiplierPpm: TREASURE_MODE_MULTIPLIER_PPM,
};

export interface DropOdds {
  bundlePpm: number;
  rarePpm: number;
  nonePpm: number;
  coinPpm: number;
  coinMin: number;
  coinMax: number;
  treasureChancePpm: number;
  legendaryPpm: number;
  epicPpm: number;
  noTreasurePpm: number;
}

/**
 * 一個方塊在某位置、某挖掘時間與 Luck 下的四層機率。
 * 任何一層的稀有結果總和超過 100% 時丟出錯誤（正規化的前提，D2）。
 */
export function dropOdds(spot: MiningSpot, blockMs: number, luckPpm: number, rules: DropRules = DEFAULT_DROP_RULES): DropOdds {
  assertPositiveInt("blockMs", blockMs);
  assertNonNegativeInt("luckPpm", luckPpm);
  const zone = zoneDef(spot.zone);
  const rare = rarePpm(zone.rareBasePpm, luckPpm);
  const nonePpm = PPM - zone.bundleChancePpm - rare;
  if (nonePpm < 0) throw new RangeError(`layer 2 probabilities exceed 100% (bundle ${zone.bundleChancePpm} + rare ${rare})`);
  const coinAvg = rules.coinAvgBySegment ? rules.coinAvgBySegment[spot.segment]! : zone.coinAvgBySegment[spot.segment % 2]!;
  const { min, max } = coinRange(coinAvg, rules.coinModeMultiplierPpm[spot.mode]);
  const chance = treasureChancePpm(zone.treasurePerHourMilli, blockMs, rules.treasureModeMultiplierPpm[spot.mode]);
  const { legendaryPpm, epicPpm } = treasureSplitPpm(chance, luckPpm);
  const noTreasurePpm = PPM - legendaryPpm - epicPpm;
  if (noTreasurePpm < 0) throw new RangeError(`layer 4 probabilities exceed 100% (legendary ${legendaryPpm} + epic ${epicPpm})`);
  return {
    bundlePpm: zone.bundleChancePpm,
    rarePpm: rare,
    nonePpm,
    coinPpm: zone.coinChancePpm,
    coinMin: min,
    coinMax: max,
    treasureChancePpm: chance,
    legendaryPpm,
    epicPpm,
    noTreasurePpm,
  };
}

// ---------- 抽取 ----------

/** 加權抽取：一次 nextInt(Σweight)，依表格順序累加 */
export function pickWeighted<T extends { weight: number }>(rng: RandomSource, table: readonly T[]): T {
  let total = 0;
  for (const e of table) {
    assertPositiveInt("weight", e.weight);
    total += e.weight;
  }
  let u = rng.nextInt(total);
  for (const e of table) {
    if (u < e.weight) return e;
    u -= e.weight;
  }
  throw new Error("unreachable: weighted pick fell through");
}

export type Layer2Outcome = "none" | "bundle" | "rare";
export type Layer4Outcome = "none" | "epic" | "legendary";

export interface BlockDrops {
  /** 第一層 + 第二層的礦物 */
  items: Partial<Record<MineralId, number>>;
  /** 第一層的 OreType */
  baseOre: MineralId;
  layer2: Layer2Outcome;
  coins: number;
  layer4: Layer4Outcome;
  artifact: ArtifactId | null;
}

function addItem(items: Partial<Record<MineralId, number>>, id: MineralId, n: number): void {
  items[id] = (items[id] ?? 0) + n;
}

/**
 * 結算一個完成的方塊（GBS §4.3 步驟 1–4）。
 *
 * @param rng      該方塊專用的亂數（createBlockRng(secret)(digCounter)）
 * @param spot     挖掘位置（決定掉落表、門檻段與模式倍率）
 * @param blockMs  該方塊實際的挖掘毫秒數（第四層用）
 * @param luckPpm  方塊完成時的 Luck
 */
export function rollBlock(
  rng: RandomSource,
  spot: MiningSpot,
  blockMs: number,
  luckPpm: number,
  rules: DropRules = DEFAULT_DROP_RULES,
): BlockDrops {
  const zone = zoneDef(spot.zone);
  const odds = dropOdds(spot, blockMs, luckPpm, rules);
  const items: Partial<Record<MineralId, number>> = {};
  const oreTable: readonly WeightedEntry<MineralId>[] = zone.oreTable;

  // 第一層：基礎產出
  const baseOre = pickWeighted(rng, oreTable).id;
  addItem(items, baseOre, 1);

  // 第二層：礦物判定
  let layer2: Layer2Outcome = "none";
  const u2 = rng.nextInt(PPM);
  if (u2 < odds.bundlePpm) {
    layer2 = "bundle";
    for (let k = 0; k < zone.bundleSize; k++) addItem(items, pickWeighted(rng, oreTable).id, 1);
  } else if (u2 < odds.bundlePpm + odds.rarePpm) {
    layer2 = "rare";
    const r = pickWeighted(rng, zone.rareTable);
    addItem(items, r.id, r.quantity);
  }

  // 第三層：金幣判定
  let coins = 0;
  const u3 = rng.nextInt(PPM);
  if (u3 < odds.coinPpm) coins = odds.coinMin + rng.nextInt(odds.coinMax - odds.coinMin + 1);

  // 第四層：寶物機會
  let layer4: Layer4Outcome = "none";
  let artifact: ArtifactId | null = null;
  const u4 = rng.nextInt(PPM);
  if (u4 < odds.legendaryPpm) {
    layer4 = "legendary";
    artifact = zone.legendary;
  } else if (u4 < odds.legendaryPpm + odds.epicPpm) {
    layer4 = "epic";
    artifact = zone.epics[rng.nextInt(zone.epics.length)]!;
  }

  return { items, baseOre, layer2, coins, layer4, artifact };
}

// ---------- 期望值（模擬器、UI 預估用；不參與結算） ----------

export interface ExpectedBlock {
  /** 每方塊各礦物的期望數量 */
  items: Partial<Record<MineralId, number>>;
  ores: number;
  rares: number;
  coins: number;
  treasures: number;
  legendaries: number;
}

/** 由 dropOdds 推導的每方塊期望值（浮點，只供規劃使用） */
export function expectedBlock(
  spot: MiningSpot,
  blockMs: number,
  luckPpm: number,
  rules: DropRules = DEFAULT_DROP_RULES,
): ExpectedBlock {
  const zone = zoneDef(spot.zone);
  const odds = dropOdds(spot, blockMs, luckPpm, rules);
  const items: Partial<Record<MineralId, number>> = {};
  const wOre = zone.oreTable.reduce((s, e) => s + e.weight, 0);
  const oresPerBlock = 1 + (odds.bundlePpm / PPM) * zone.bundleSize;
  for (const e of zone.oreTable) addItem(items, e.id, (e.weight / wOre) * oresPerBlock);
  const pRare = odds.rarePpm / PPM;
  const wRare = zone.rareTable.reduce((s, e) => s + e.weight, 0);
  for (const e of zone.rareTable) addItem(items, e.id, pRare * (e.weight / wRare) * e.quantity);
  return {
    items,
    ores: oresPerBlock,
    rares: pRare,
    coins: (odds.coinPpm / PPM) * ((odds.coinMin + odds.coinMax) / 2),
    treasures: (odds.legendaryPpm + odds.epicPpm) / PPM,
    legendaries: odds.legendaryPpm / PPM,
  };
}
