/**
 * 挖掘位置、門檻與工作量（GBS §2、§4、§5；決策 D1、D5、D8、D10、D15、D16；D19：P2、P3、P5、P6）。
 *
 * 只做純計算：不保存玩家狀態，也不決定玩家要選哪個模式（那是 UI / 結算 / 模擬器策略的事）。
 */

import {
  BAND_COUNT,
  BAND_HARDNESS,
  BLOCKS_PER_BAND,
  BLOCKS_PER_SEGMENT,
  BLOCKS_PER_ZONE,
  type MiningMode,
  SEGMENT_REQUIRED_POWER10,
  TOTAL_BLOCKS,
  ZONES,
  type ZoneDef,
} from "@mining/game-data";
import { MAX_HARDNESS, WORK_SCALE, assertNonNegativeInt, assertPositiveInt, blockMs, canMine } from "./fixed.ts";
import type { Stats } from "./stats.ts";

export type ZoneIndex = 0 | 1 | 2;

/** 一個挖掘位置：決定 Hardness、RequiredPower、掉落表與模式倍率 */
export interface MiningSpot {
  mode: MiningMode;
  /** 深度帶 0–29（10m） */
  band: number;
  /** 門檻段 0–5（50m） */
  segment: number;
  zone: ZoneIndex;
  hardness: number;
  requiredPower10: number;
}

// ---------- 深度換算 ----------

export function assertBlockIndex(blockIndex: number): void {
  assertNonNegativeInt("blockIndex", blockIndex);
  if (blockIndex >= TOTAL_BLOCKS) throw new RangeError(`blockIndex must be < ${TOTAL_BLOCKS}, got ${blockIndex}`);
}

export function assertBand(band: number): void {
  assertNonNegativeInt("band", band);
  if (band >= BAND_COUNT) throw new RangeError(`band must be < ${BAND_COUNT}, got ${band}`);
}

export const bandOfBlock = (blockIndex: number): number => (assertBlockIndex(blockIndex), Math.floor(blockIndex / BLOCKS_PER_BAND));
export const segmentOfBand = (band: number): number => (assertBand(band), Math.floor((band * BLOCKS_PER_BAND) / BLOCKS_PER_SEGMENT));
export const zoneOfBand = (band: number): ZoneIndex => (assertBand(band), Math.floor((band * BLOCKS_PER_BAND) / BLOCKS_PER_ZONE) as ZoneIndex);
export const hardnessOfBand = (band: number): number => (assertBand(band), BAND_HARDNESS[band]!);
export const requiredPower10OfBand = (band: number): number => SEGMENT_REQUIRED_POWER10[segmentOfBand(band)]!;
export const zoneDef = (zone: ZoneIndex): ZoneDef => ZONES[zone];
/** 礦區最深的深度帶（回訪位置，D8） */
export const bottomBandOfZone = (zone: ZoneIndex): number => ((zone + 1) * BLOCKS_PER_ZONE) / BLOCKS_PER_BAND - 1;

function spotAt(mode: MiningMode, band: number): MiningSpot {
  return {
    mode,
    band,
    segment: segmentOfBand(band),
    zone: zoneOfBand(band),
    hardness: hardnessOfBand(band),
    requiredPower10: requiredPower10OfBand(band),
  };
}

// ---------- 前線 ----------

/** 前線不能挖的原因（null = 可以挖） */
export type FrontierBlock = "completed" | "locked" | "power";

/**
 * GBS §4.2、§12：前線方塊 `frontier`（下一個要挖的 blockIndex）是否可挖。
 * - completed：主線完成（P1）
 * - locked：到達礦區底部但下一區未付費解鎖（D10）
 * - power：Power < RequiredPower（D5、P6）
 *
 * `unlockedZone` 為已解鎖的最深礦區 index（zone1 = 0 一開始就解鎖）。
 */
export function frontierBlock(frontier: number, unlockedZone: ZoneIndex, power10: number): FrontierBlock | null {
  assertNonNegativeInt("frontier", frontier);
  if (frontier >= TOTAL_BLOCKS) return "completed";
  const band = bandOfBlock(frontier);
  if (zoneOfBand(band) > unlockedZone) return "locked";
  return canMine(power10, requiredPower10OfBand(band)) ? null : "power";
}

export function frontierSpot(frontier: number): MiningSpot {
  return spotAt("frontier", bandOfBlock(frontier));
}

// ---------- 回訪（D8、D15、P2） ----------

/**
 * GBS §2.3：可回訪 = 已解鎖、且比前線所在礦區淺的礦區；主線完成後全部可回訪（P1）。
 * 回訪位置的 Power 門檻另外檢查（revisitSpot().requiredPower10）。
 */
export function revisitableZones(frontier: number, unlockedZone: ZoneIndex): ZoneIndex[] {
  assertNonNegativeInt("frontier", frontier);
  if (frontier >= TOTAL_BLOCKS) return [0, 1, 2];
  const frontierZone = Math.floor(frontier / BLOCKS_PER_ZONE);
  return ([0, 1, 2] as const).filter((z) => z < frontierZone && z <= unlockedZone);
}

/** 回訪固定在該礦區最深帶：zone1 1,500 / 4、zone2 11,500 / 16、zone3 32,500 / 36 */
export function revisitSpot(zone: ZoneIndex): MiningSpot {
  return spotAt("revisit", bottomBandOfZone(zone));
}

// ---------- 重挖（D16） ----------

/**
 * GBS §2.4：重挖深度帶由伺服器決定。
 * - 只在前線卡關（power / locked）時可用；未卡關或主線完成時回傳 null
 * - 從最後挖完的方塊（frontier − 1）所在深度帶往上找第一個 RequiredPower ≤ 目前 Power 的深度帶
 * - 還沒挖完任何方塊、或沒有可挖的深度帶時回傳 null
 */
export function reworkBand(frontier: number, unlockedZone: ZoneIndex, power10: number): number | null {
  const blocked = frontierBlock(frontier, unlockedZone, power10);
  if (blocked !== "power" && blocked !== "locked") return null;
  if (frontier === 0) return null;
  for (let b = bandOfBlock(frontier - 1); b >= 0; b--) {
    if (canMine(power10, requiredPower10OfBand(b))) return b;
  }
  return null;
}

export function reworkSpot(band: number): MiningSpot {
  return spotAt("rework", band);
}

// ---------- 工作量（D19：P5） ----------

/** 完成一個方塊需要的工作量 = Hardness × 10^7 */
export function blockWork(hardness: number): number {
  assertPositiveInt("hardness", hardness);
  if (hardness > MAX_HARDNESS) throw new RangeError(`hardness must be <= ${MAX_HARDNESS}, got ${hardness}`);
  return hardness * WORK_SCALE;
}

/** 每毫秒工作量 = power10 × speed1000 */
export function workRate(stats: Pick<Stats, "power10" | "speed1000">): number {
  return stats.power10 * stats.speed1000;
}

/** 以目前數值挖完一整個方塊的毫秒數 */
export function spotBlockMs(spot: MiningSpot, stats: Pick<Stats, "power10" | "speed1000">): number {
  return blockMs(spot.hardness, stats.power10, stats.speed1000);
}

export interface WorkStep {
  /** 是否在 availableMs 內完成方塊 */
  completed: boolean;
  /** 實際使用的毫秒數（完成時 = 剩餘工作量所需時間） */
  usedMs: number;
  /** 之後的累積工作量（完成時為 0；切換模式時由呼叫端歸零，P3） */
  work: number;
}

/**
 * 推進目前方塊的工作量（P5：換裝備時保留累積工作量，只改變之後的速率）。
 * 呼叫端必須先確認 canMine；Power 不足時不能呼叫（D5）。
 */
export function advanceWork(work: number, hardness: number, rate: number, availableMs: number): WorkStep {
  assertNonNegativeInt("work", work);
  assertNonNegativeInt("availableMs", availableMs);
  if (!Number.isSafeInteger(rate) || rate <= 0) throw new RangeError(`rate must be a positive safe integer, got ${rate}`);
  const total = blockWork(hardness);
  if (work >= total) return { completed: true, usedMs: 0, work: 0 };
  const remaining = BigInt(total - work);
  const r = BigInt(rate);
  const needMs = Number((remaining + r - 1n) / r);
  if (needMs <= availableMs) return { completed: true, usedMs: needMs, work: 0 };
  // 未完成：work + rate × availableMs < total ≤ MAX_SAFE_INTEGER
  return { completed: false, usedMs: availableMs, work: work + rate * availableMs };
}
