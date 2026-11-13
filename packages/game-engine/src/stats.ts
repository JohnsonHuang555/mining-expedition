/**
 * 數值聚合（GBS §3、§9；TECHNICAL_SPEC §5；決策 D3）。
 *
 *   power10   = basePower10 × (100 + 10 × step) / 100
 *   speed1000 = floor( baseSpeed1000 × (100 + 5 × step) / 100 × (100 + ΣspeedPct) / 100 )
 *   luckPpm   = baseLuckPpm × (100 + 10 × step) / 100 + ΣsetLuckPpm
 */

import {
  ARTIFACT_IDS,
  type ArtifactId,
  LEVEL_BONUS_PCT,
  MAX_PICKAXE_LEVEL,
  PICKAXES,
  type PickaxeDef,
  type PickaxeId,
  SETS,
  SET_IDS,
  type SetId,
} from "@mining/game-data";
import { mulDivFloor } from "./fixed.ts";

export interface Stats {
  power10: number;
  speed1000: number;
  luckPpm: number;
}

/** 持有數量（出售後為 0）。套組要求「實際持有」（D3） */
export type HeldArtifacts = Readonly<Partial<Record<ArtifactId, number>>>;

export function pickaxeDef(id: PickaxeId): PickaxeDef {
  const def = PICKAXES.find((p) => p.id === id);
  if (!def) throw new RangeError(`unknown pickaxe: ${id}`);
  return def;
}

/** 目前啟動的套組（每件成員至少持有 1 個） */
export function activeSets(held: HeldArtifacts): SetId[] {
  return SET_IDS.filter((id) => SETS[id].members.every((m) => (held[m] ?? 0) > 0));
}

export function isArtifactId(id: string): id is ArtifactId {
  return (ARTIFACT_IDS as readonly string[]).includes(id);
}

/**
 * 計算最終數值。強化倍率對基礎值必須整除（GBS §10 的 MVP 數值皆整除）；
 * 若新資料不整除會丟出錯誤，而不是悄悄捨入（TECHNICAL_SPEC §5）。
 */
export function computeStats(pickaxe: PickaxeId, level: number, held: HeldArtifacts = {}): Stats {
  if (!Number.isInteger(level) || level < 1 || level > MAX_PICKAXE_LEVEL) {
    throw new RangeError(`pickaxe level must be 1–${MAX_PICKAXE_LEVEL}, got ${level}`);
  }
  const def = pickaxeDef(pickaxe);
  const step = level - 1;
  let speedPct = 0;
  let setLuckPpm = 0;
  for (const id of activeSets(held)) {
    speedPct += SETS[id].speedPct;
    setLuckPpm += SETS[id].luckPpm;
  }
  const power10 = exactScale(def.basePower10, 100 + LEVEL_BONUS_PCT.power * step, "power10");
  const luckBase = exactScale(def.baseLuckPpm, 100 + LEVEL_BONUS_PCT.luck * step, "luckPpm");
  const speed1000 = mulDivFloor(
    [def.baseSpeed1000, 100 + LEVEL_BONUS_PCT.speed * step, 100 + speedPct],
    10_000,
  );
  return { power10, speed1000, luckPpm: luckBase + setLuckPpm };
}

function exactScale(base: number, pct: number, name: string): number {
  const scaled = base * pct;
  if (scaled % 100 !== 0) {
    throw new RangeError(`${name}: ${base} × ${pct}% is not an integer; data must divide evenly`);
  }
  return scaled / 100;
}
