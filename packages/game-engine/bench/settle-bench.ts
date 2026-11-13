/**
 * 12 小時離線結算的最壞情境 benchmark（Node 與 Deno 共用）。
 *
 *   node packages/game-engine/bench/settle-bench.ts
 *   deno run --config packages/game-engine/deno.test.json packages/game-engine/bench/settle-bench.ts
 *
 * 最壞情境：窮舉所有合法的「位置 × 十字鎬 × 等級 × 套組」，取 12 小時內完成方塊數最多者。
 * 這只量引擎 CPU 與記憶體；Supabase Edge Function 的實際限制在 Integration PR 驗證。
 */

import { OFFLINE_CAP_MS, PICKAXE_IDS, type PickaxeId, type PickaxeLevel } from "@mining/game-data";
import {
  type PlayerGameState,
  blockMs,
  computeStats,
  createBlockRng,
  createInitialState,
  revisitSpot,
  settle,
  sha256,
} from "../src/index.ts";

const ALL_SETS = {
  a_z1_lantern: 1, a_z1_badge: 1, a_z1_map: 1, a_z2_orb: 1, a_z2_crown: 1, a_z2_mural: 1, a_z3_emblem: 1, a_z3_ring: 1, a_z3_tablet: 1,
} as const;

// 1. 窮舉找最多方塊的組合（回訪位置是可無限循環中最淺的：zone1 最深帶 Hardness 1,500；重挖最多到同一帶）
let worst = { blocks: 0, pick: "pick_wood" as PickaxeId, level: 1 as PickaxeLevel, zone: 0 as 0 | 1 | 2 };
for (const pick of PICKAXE_IDS) {
  for (let level = 1; level <= 5; level++) {
    const st = computeStats(pick, level, ALL_SETS);
    for (const zone of [0, 1, 2] as const) {
      const spot = revisitSpot(zone);
      if (st.power10 < spot.requiredPower10) continue;
      const blocks = Math.floor(OFFLINE_CAP_MS / blockMs(spot.hardness, st.power10, st.speed1000));
      if (blocks > worst.blocks) worst = { blocks, pick, level: level as PickaxeLevel, zone };
    }
  }
}

// 2. 建立該狀態：鑽石 Lv5、持有全部 9 件套組寶物、主線完成後回訪 zone1
function worstState(): PlayerGameState {
  const s = createInitialState("bench", 0);
  for (const id of PICKAXE_IDS) s.pickaxes[id] = 5;
  s.equippedPickaxe = worst.pick;
  s.unlockedZone = 2;
  s.mining.frontierBlockIndex = 3000;
  s.mining.digCounter = 3000;
  s.mining.mode = "revisit";
  s.mining.revisitZone = worst.zone;
  Object.keys(ALL_SETS).forEach((id, i) => {
    s.heldArtifacts.push({ instanceId: `b${i}`, artifactId: id as keyof typeof ALL_SETS, obtainedAt: 0, mode: "frontier", band: 0, frontierBlockIndex: 0, digCounter: i, source: "drop" });
    s.discoveredArtifacts[id as keyof typeof ALL_SETS] = { firstDiscoveredAt: 0, firstBand: 0, totalFound: 1 };
  });
  s.firstTreasure = { status: "obtained", effectiveMiningMs: 0, resolvedAt: 0, artifactInstanceId: "b0", reportId: null };
  return s;
}

const g = globalThis as unknown as { Deno?: { version: { deno: string }; memoryUsage(): { heapUsed: number } }; process?: { version: string; memoryUsage(): { heapUsed: number } } };
const runtime = g.Deno ? `Deno ${g.Deno.version.deno}` : `Node ${g.process!.version}`;
const heap = () => (g.Deno ? g.Deno.memoryUsage().heapUsed : g.process!.memoryUsage().heapUsed);
const rng = createBlockRng(sha256(new TextEncoder().encode("bench-secret")));

const state = worstState();
const now = OFFLINE_CAP_MS + 6 * 3_600_000; // 離線 18 小時，模擬 12 小時
const once = () => {
  const r = settle(state, { serverNow: now, rng });
  if (!r.ok) throw new Error(r.error.message);
  return r;
};
for (let i = 0; i < 5; i++) once(); // warm-up

const runs = 30;
const times: number[] = [];
let result = once();
const heapBefore = heap();
for (let i = 0; i < runs; i++) {
  const t = performance.now();
  result = once();
  times.push(performance.now() - t);
}
const heapAfter = heap();
times.sort((a, b) => a - b);
const reportBytes = new TextEncoder().encode(JSON.stringify(result.state)).length;

console.log(JSON.stringify({
  runtime,
  scenario: `revisit zone${worst.zone + 1}, ${worst.pick} Lv${worst.level}, all 3 sets, 12h offline (18h elapsed)`,
  blocksMined: result.summary.blocksMined,
  expectedMaxBlocks: worst.blocks,
  simulatedMs: result.summary.simulatedMs,
  discardedMs: result.summary.discardedMs,
  msMedian: +times[Math.floor(runs / 2)]!.toFixed(2),
  msP90: +times[Math.floor(runs * 0.9)]!.toFixed(2),
  msMax: +times[runs - 1]!.toFixed(2),
  usPerBlock: +((times[Math.floor(runs / 2)]! * 1000) / result.summary.blocksMined).toFixed(2),
  heapDeltaMB_30runs: +((heapAfter - heapBefore) / 1048576).toFixed(2),
  heapUsedMB: +(heapAfter / 1048576).toFixed(1),
  stateJsonKB: +(reportBytes / 1024).toFixed(1),
  reportArtifacts: result.report!.rewards.artifacts.length,
}, null, 2));
