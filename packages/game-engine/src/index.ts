/**
 * 《挖礦探險隊》遊戲引擎核心：純 TypeScript，不依賴 React / Next.js / Supabase。
 * Node（Next.js、模擬器、Vitest）與 Deno（Edge Functions）共用同一份原始碼，
 * 所以相對匯入一律寫 `.ts` 副檔名。
 */

import { DATA_VERSION, RNG_VERSION } from "@mining/game-data";

export { MAX_HARDNESS, WORK_SCALE, blockMs, canMine, mulDivFloor } from "./fixed.ts";
export { type RandomSource, SequenceSource, uniformInt } from "./rng/random-source.ts";
export { SFC32_WARMUP, Sfc32 } from "./rng/sfc32.ts";
export { createHmacSha256, hmacSha256, sha256 } from "./rng/sha256.ts";
export { blockMessage, createBlockRng, seedWords } from "./rng/block-rng.ts";
export { type HeldArtifacts, type Stats, activeSets, computeStats, isArtifactId, pickaxeDef } from "./stats.ts";
export {
  type FrontierBlock,
  type MiningSpot,
  type WorkStep,
  type ZoneIndex,
  advanceWork,
  bandOfBlock,
  blockWork,
  bottomBandOfZone,
  frontierBlock,
  frontierSpot,
  hardnessOfBand,
  requiredPower10OfBand,
  revisitSpot,
  revisitableZones,
  reworkBand,
  reworkSpot,
  segmentOfBand,
  spotBlockMs,
  workRate,
  zoneDef,
  zoneOfBand,
} from "./mining.ts";
export {
  type BlockDrops,
  type DropOdds,
  type DropRules,
  DEFAULT_DROP_RULES,
  type ExpectedBlock,
  type Layer2Outcome,
  type Layer4Outcome,
  coinRange,
  dropOdds,
  expectedBlock,
  pickWeighted,
  rarePpm,
  rollBlock,
  treasureChancePpm,
  treasureSplitPpm,
} from "./drop.ts";
export { type FirstTreasureStatus, type FirstTreasureStep, firstTreasureStep } from "./protection.ts";
export { DEV_MARKER } from "./dev-marker.ts";

export const ENGINE_VERSION = "0.2.0";

export interface EngineInfo {
  engineVersion: string;
  dataVersion: number;
  rngVersion: number;
}

export function engineInfo(): EngineInfo {
  return { engineVersion: ENGINE_VERSION, dataVersion: DATA_VERSION, rngVersion: RNG_VERSION };
}
