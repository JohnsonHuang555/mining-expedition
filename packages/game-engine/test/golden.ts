/**
 * 跨執行環境的確定性快照（RNG_VERSION 1）。
 *
 * 只使用引擎的公開 API 與 Web 標準（TextEncoder），Node 與 Deno 都能執行：
 * - Vitest：test/golden.test.ts 比對 fixtures/golden-v1.json
 * - CI：`node test/golden-cli.ts` 與 `deno run test/golden-cli.ts` 的輸出必須與 fixture 完全相同
 *
 * fixture 只在 RNG_VERSION 或 DATA_VERSION 變更時重新產生（舊版快照保留）。
 */

import {
  type MiningSpot,
  computeStats,
  createBlockRng,
  engineInfo,
  frontierSpot,
  hmacSha256,
  revisitSpot,
  reworkSpot,
  rollBlock,
  sha256,
  spotBlockMs,
} from "../src/index.ts";

const utf8 = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function computeGolden() {
  const secret = sha256(utf8("mining-expedition golden v1"));
  const make = createBlockRng(secret);
  const uint32: Record<string, number[]> = {};
  for (const c of [0, 1, 2, 999, 123_456_789]) {
    const rng = make(c);
    uint32[c] = Array.from({ length: 6 }, () => rng.nextUint32());
  }
  const cases: [string, MiningSpot, ReturnType<typeof computeStats>][] = [
    ["zone1 frontier 5m wood", frontierSpot(50), computeStats("pick_wood", 1)],
    ["zone1 frontier 80m stone Lv3", frontierSpot(800), computeStats("pick_stone", 3)],
    ["zone2 frontier 170m gold Lv1", frontierSpot(1700), computeStats("pick_gold", 1)],
    ["zone3 frontier 290m diamond Lv5 all sets", frontierSpot(2900), computeStats("pick_diamond", 5, {
      a_z1_lantern: 1, a_z1_badge: 1, a_z1_map: 1, a_z2_orb: 1, a_z2_crown: 1, a_z2_mural: 1,
      a_z3_emblem: 1, a_z3_ring: 1, a_z3_tablet: 1,
    })],
    ["zone1 revisit iron Lv1", revisitSpot(0), computeStats("pick_iron", 1)],
    ["zone2 rework band 14 iron Lv5", reworkSpot(14), computeStats("pick_iron", 5)],
  ];
  const blocks = cases.map(([label, spot, stats]) => {
    const ms = spotBlockMs(spot, stats);
    const drops = [];
    const totals = { coins: 0, items: {} as Record<string, number>, artifacts: {} as Record<string, number> };
    for (let i = 0; i < 2_000; i++) {
      const d = rollBlock(make(i), spot, ms, stats.luckPpm);
      if (i < 12) drops.push(d);
      totals.coins += d.coins;
      for (const [k, n] of Object.entries(d.items)) totals.items[k] = (totals.items[k] ?? 0) + n;
      if (d.artifact) totals.artifacts[d.artifact] = (totals.artifacts[d.artifact] ?? 0) + 1;
    }
    totals.items = Object.fromEntries(Object.entries(totals.items).sort(([a], [b]) => a.localeCompare(b)));
    totals.artifacts = Object.fromEntries(Object.entries(totals.artifacts).sort(([a], [b]) => a.localeCompare(b)));
    return { label, stats, blockMs: ms, first12: drops, totals2000: totals };
  });
  return {
    engine: { dataVersion: engineInfo().dataVersion, rngVersion: engineInfo().rngVersion },
    secret: hex(secret),
    hmacBlock0: hex(hmacSha256(secret, utf8("block:0"))),
    uint32,
    blocks,
  };
}
