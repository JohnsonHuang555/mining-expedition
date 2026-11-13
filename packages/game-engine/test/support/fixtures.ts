import { type ArtifactId, PICKAXE_IDS, type PickaxeId, type PickaxeLevel } from "@mining/game-data";
import {
  type ArtifactInstance,
  type GameCommand,
  type Inventory,
  type PlayerGameState,
  type RequestResult,
  assertValidState,
  createBlockRng,
  createInitialState,
  executeRequest,
  sha256,
} from "../../src/index.ts";

export const T0 = 1_700_000_000_000;
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const rng = createBlockRng(sha256(new TextEncoder().encode("settlement-tests")));

export interface Setup {
  frontier?: number;
  unlockedZone?: 0 | 1 | 2;
  /** 擁有到第 tier 把（0 = 木製），全部為 level；裝備最後一把 */
  tier?: number;
  level?: PickaxeLevel;
  coins?: number;
  inventory?: Inventory;
  artifacts?: ArtifactId[];
  firstTreasure?: "pending" | "obtained";
}

/** 建立一個合法的測試狀態（直接設定欄位後以 assertValidState 確認） */
export function makeState(setup: Setup = {}): PlayerGameState {
  const s = createInitialState("player-1", T0);
  const tier = setup.tier ?? 0;
  s.pickaxes = {};
  for (let i = 0; i <= tier; i++) s.pickaxes[PICKAXE_IDS[i] as PickaxeId] = setup.level ?? 1;
  s.equippedPickaxe = PICKAXE_IDS[tier] as PickaxeId;
  s.unlockedZone = setup.unlockedZone ?? 0;
  s.mining.frontierBlockIndex = setup.frontier ?? 0;
  s.mining.digCounter = (setup.frontier ?? 0) + (setup.artifacts?.length ?? 0);
  s.coins = setup.coins ?? 0;
  s.inventory = { ...(setup.inventory ?? {}) };
  (setup.artifacts ?? []).forEach((id, i) => giveArtifact(s, id, `seed${i}`, i));
  if (setup.firstTreasure === "obtained" || (setup.artifacts?.length ?? 0) > 0) {
    s.firstTreasure = { status: "obtained", effectiveMiningMs: 0, resolvedAt: T0, artifactInstanceId: s.heldArtifacts[0]?.instanceId ?? "seed", reportId: null };
  }
  assertValidState(s);
  return s;
}

export function giveArtifact(s: PlayerGameState, artifactId: ArtifactId, instanceId: string, digCounter = 0): ArtifactInstance {
  const inst: ArtifactInstance = { instanceId, artifactId, obtainedAt: T0, mode: "frontier", band: 0, frontierBlockIndex: 0, digCounter, source: "drop" };
  s.heldArtifacts.push(inst);
  const rec = s.discoveredArtifacts[artifactId];
  if (rec) rec.totalFound++;
  else s.discoveredArtifacts[artifactId] = { firstDiscoveredAt: T0, firstBand: 0, totalFound: 1 };
  return inst;
}

/** 以 executeRequest 模擬「提交成功」：回傳新狀態（沒有變化時回傳原狀態） */
export function run(s: PlayerGameState, now: number, command: GameCommand, requestId = `req-${now}`): { s: PlayerGameState; r: RequestResult } {
  const r = executeRequest(s, { requestId, command }, { serverNow: now, rng, marketMultiplierPpm: BASE_MARKET });
  return { s: r.commit ? r.commit.state : s, r };
}

/** 所有寶物倍率 1.0（Base Value） */
export const BASE_MARKET: Partial<Record<ArtifactId, number>> = Object.fromEntries(
  ["a_z1_lantern", "a_z1_badge", "a_z1_map", "a_z1_heart", "a_z2_orb", "a_z2_crown", "a_z2_mural", "a_z2_heart", "a_z3_emblem", "a_z3_ring", "a_z3_tablet", "a_z3_crown"].map((id) => [id, 1_000_000]),
);

/** 遞迴凍結：確認函式不會修改傳入的狀態 */
export function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}
