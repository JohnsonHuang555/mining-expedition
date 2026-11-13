/**
 * 《挖礦探險隊》平衡模擬 — 開發輔助工具
 *
 * 這不是遊戲實作。它用 GBS v1.1 的規則與數值模擬「參考玩家」從 0m 挖到 300m，
 * 用來驗證 GBS §18 的平衡標準。正式引擎完成後，資料與規則應改為匯入
 * `packages/game-data` 與 `packages/game-engine`，本檔只保留玩家策略與報表。
 *
 * 執行（Node 22.18+ 可直接執行 TypeScript，不需安裝套件）：
 *   node scripts/balance-sim.ts                 # 全部報表，預設 400 次 Monte Carlo
 *   node scripts/balance-sim.ts --runs 1000 --seed 7
 *   node scripts/balance-sim.ts --policy sellDupes
 *   node scripts/balance-sim.ts --json out.json
 */

// ============================================================================
// 1. 亂數（sfc32；正式引擎使用 HMAC 逐方塊種子，見 TECHNICAL_SPEC §6）
// ============================================================================

type Rng = () => number; // [0, 1)

function makeRng(seed: number): Rng {
  let a = 0x9e3779b9 ^ seed;
  let b = 0x243f6a88 ^ (seed * 31);
  let c = 0xb7e15162 ^ (seed * 131);
  let d = 0xdeadbeef ^ (seed * 1031);
  const next = (): number => {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 20; i++) next();
  return next;
}

function pickWeighted<T extends { w: number }>(rng: Rng, table: readonly T[]): T {
  const total = table.reduce((s, e) => s + e.w, 0);
  let u = rng() * total;
  for (const e of table) {
    u -= e.w;
    if (u < 0) return e;
  }
  return table[table.length - 1];
}

// ============================================================================
// 2. 遊戲資料（GBS v1.1）
// ============================================================================

const BLOCKS_PER_ZONE = 1000;
const TOTAL_BLOCKS = 3000;

/** GBS §5：每 10m（100 方塊）一個 Hardness */
const HARDNESS = [
  15, 35, 85, 210, 490, 820, 950, 1100, 1300, 1500,
  1750, 2150, 2600, 3100, 3800, 4650, 5850, 7300, 9200, 11500,
  14000, 16500, 19000, 22500, 26500, 29000, 30000, 31000, 31500, 32500,
];

/** GBS §5.1：每 50m（500 方塊）一個 RequiredPower，×10 定點 */
const REQ_POWER10 = [10, 40, 90, 160, 270, 360];

interface Pickaxe {
  id: string;
  power10: number;
  speed1000: number;
  luckPpm: number;
  coins: number;
  mats: Record<string, number>;
  upgradeBase: number;
}

/** GBS §10 */
const PICKAXES: Pickaxe[] = [
  { id: "wood", power10: 20, speed1000: 1000, luckPpm: 0, coins: 0, mats: {}, upgradeBase: 40 },
  { id: "stone", power10: 50, speed1000: 1200, luckPpm: 10_000, coins: 200, mats: { stone: 40 }, upgradeBase: 250 },
  { id: "iron", power10: 100, speed1000: 1500, luckPpm: 30_000, coins: 2_000, mats: { iron_ingot: 8 }, upgradeBase: 800 },
  { id: "gold", power10: 180, speed1000: 1800, luckPpm: 70_000, coins: 8_000, mats: { iron_ingot: 12, refined_crystal: 4 }, upgradeBase: 2_500 },
  { id: "diamond", power10: 300, speed1000: 2200, luckPpm: 120_000, coins: 15_000, mats: { refined_crystal: 10, reinforce_stone: 10 }, upgradeBase: 20_000 },
];
const UPGRADE_K = 1.8;

function upgradeCost(tier: number, toLevel: number): { coins: number; mats: Record<string, number> } {
  const coins = Math.round((PICKAXES[tier].upgradeBase * UPGRADE_K ** (toLevel - 2)) / 10) * 10;
  return { coins, mats: { reinforce_stone: toLevel - 1 } };
}

/** GBS §8.1 */
const PRICE: Record<string, number> = {
  stone: 1, coal: 3, copper: 6, iron_ore: 8, silver: 35, gold: 90,
  amethyst: 50, sapphire: 150, ruby: 500,
};

/** GBS §8.2 */
const RECIPES: Record<string, Record<string, number>> = {
  iron_ingot: { iron_ore: 5, coal: 2 },
  reinforce_stone: { stone: 20, iron_ore: 5 },
  refined_crystal: { amethyst: 3 },
};

interface Zone {
  id: string;
  unlockFee: number;
  ore: { item: string; w: number }[];
  /** 第二層：每方塊礦物判定 */
  bundleChance: number;
  bundleSize: number;
  rareChance: number;
  rare: { item: string; w: number; qty: number }[];
  /** 第三層：每方塊金幣判定；金額依 50m 門檻段（每區兩段），實際為 [0.5×, 1.5×] 的均勻整數 */
  coinChance: number;
  coinAvgBySeg: [number, number];
  /** 第四層：時間型寶物機會（每小時） */
  treasurePerHour: number;
  epics: string[];
  legendary: string;
  epicValue: number;
  legendaryValue: number;
  set: { speedPct: number; luckPpm: number };
}

/** GBS §6–§9 */
const ZONES: Zone[] = [
  {
    id: "zone1", unlockFee: 0,
    ore: [{ item: "stone", w: 60 }, { item: "coal", w: 15 }, { item: "copper", w: 13 }, { item: "iron_ore", w: 12 }],
    bundleChance: 0.15, bundleSize: 3,
    rareChance: 0.025, rare: [{ item: "silver", w: 50, qty: 1 }, { item: "amethyst", w: 50, qty: 1 }],
    coinChance: 0.10, coinAvgBySeg: [20, 20],
    treasurePerHour: 0.35, epics: ["a_z1_lantern", "a_z1_badge", "a_z1_map"], legendary: "a_z1_heart",
    epicValue: 300, legendaryValue: 3_000, set: { speedPct: 3, luckPpm: 0 },
  },
  {
    id: "zone2", unlockFee: 800,
    ore: [{ item: "stone", w: 55 }, { item: "iron_ore", w: 15 }, { item: "silver", w: 30 }],
    bundleChance: 0.15, bundleSize: 3,
    rareChance: 0.035, rare: [{ item: "amethyst", w: 65, qty: 2 }, { item: "sapphire", w: 35, qty: 1 }],
    coinChance: 0.10, coinAvgBySeg: [150, 330],
    treasurePerHour: 0.25, epics: ["a_z2_orb", "a_z2_crown", "a_z2_mural"], legendary: "a_z2_heart",
    epicValue: 2_000, legendaryValue: 20_000, set: { speedPct: 0, luckPpm: 20_000 },
  },
  {
    id: "zone3", unlockFee: 3_000,
    ore: [{ item: "stone", w: 50 }, { item: "silver", w: 15 }, { item: "gold", w: 35 }],
    bundleChance: 0.15, bundleSize: 3,
    rareChance: 0.05, rare: [{ item: "sapphire", w: 50, qty: 2 }, { item: "ruby", w: 50, qty: 1 }],
    coinChance: 0.10, coinAvgBySeg: [1_100, 1_400],
    treasurePerHour: 0.175, epics: ["a_z3_emblem", "a_z3_ring", "a_z3_tablet"], legendary: "a_z3_crown",
    epicValue: 6_000, legendaryValue: 60_000, set: { speedPct: 3, luckPpm: 20_000 },
  },
];

const LEGENDARY_IDS = new Set(ZONES.map((z) => z.legendary));
const LEGENDARY_SHARE = 0.10;      // GDD §4.1：Epic 4.5% : Legendary 0.5% = 9 : 1
const TREASURE_CHANCE_CAP = 0.5;   // 每方塊寶物機會上限
const REVISIT_TREASURE_MULT = 0.5; // D8：回訪寶物倍率（GBS §2.3，待審核）
const REVISIT_COIN_MULT = 0.5;     // 回訪金幣倍率（GBS §2.3 提案 P34，待確認）
let HARDNESS_SCALE = 1;            // --hardness-scale：只用於探索調整方案，不代表 GBS 數值
const OFFLINE_CAP_S = 12 * 3600;   // D9

/** 參考玩家保留的製作素材（超過的部分出售） */
const KEEP: Record<string, number> = { stone: 300, coal: 40, iron_ore: 120 };
const NEVER_SELL = new Set(["amethyst"]);

// ============================================================================
// 3. 規則
// ============================================================================

type Mode = "frontier" | "revisit";

interface Player {
  t: number;                 // 經過秒數
  miningSec: number;         // 實際挖掘秒數
  coins: number;
  inv: Record<string, number>;
  tier: number;
  levels: number[];
  unlocked: number;          // 已解鎖的最大 zone index
  frontier: number;          // 下一個前線方塊
  mode: Mode;
  revisitZone: number;
  work: number;              // 目前方塊工作量（power10 × speed1000 × ms）
  blockSec: number;          // 目前方塊已花秒數
  held: Record<string, number>;
  found: Record<string, number>;
  // 紀錄
  zoneDoneAt: number[];      // 完成各 zone 的時間（秒）
  zoneDoneMining: number[];
  zoneCoins: number[];       // 各 zone 前線期間的總收入（含出售）
  setDoneAtExit: boolean[];
  legendaries: number;
  epics: number;
  treasureTimes: number[];   // 以挖掘秒數記錄
  revisitSec: number;
  blockedWasteSec: number;
  events: string[];
}

function newPlayer(): Player {
  return {
    t: 0, miningSec: 0, coins: 0, inv: {}, tier: 0, levels: [1, 1, 1, 1, 1], unlocked: 0,
    frontier: 0, mode: "frontier", revisitZone: 0, work: 0, blockSec: 0, held: {}, found: {},
    zoneDoneAt: [], zoneDoneMining: [], zoneCoins: [0, 0, 0], setDoneAtExit: [], legendaries: 0, epics: 0,
    treasureTimes: [], revisitSec: 0, blockedWasteSec: 0, events: [],
  };
}

function setActive(p: Player, z: number): boolean {
  return ZONES[z].epics.every((id) => (p.held[id] ?? 0) > 0);
}

/** GBS §3.1（定點數，對應 TECHNICAL_SPEC §5） */
function stats(p: Player, tier = p.tier, level = p.levels[tier]) {
  const pk = PICKAXES[tier];
  const step = level - 1;
  let speedPct = 0;
  let luckBonus = 0;
  for (let z = 0; z < 3; z++) {
    if (setActive(p, z)) {
      speedPct += ZONES[z].set.speedPct;
      luckBonus += ZONES[z].set.luckPpm;
    }
  }
  const power10 = (pk.power10 * (100 + 10 * step)) / 100;
  const speed1000 = Math.floor(((pk.speed1000 * (100 + 5 * step)) / 100) * (100 + speedPct) / 100);
  const luckPpm = (pk.luckPpm * (100 + 10 * step)) / 100 + luckBonus;
  return { power10, speed1000, luck: luckPpm / 1e6 };
}

function blockParams(p: Player): { zone: number; seg: number; hardness: number; req10: number } {
  if (p.mode === "frontier") {
    const i = p.frontier;
    return { zone: Math.floor(i / 1000), seg: Math.floor(i / 500) % 2, hardness: hardnessAt(Math.floor(i / 100)), req10: REQ_POWER10[Math.floor(i / 500)] };
  }
  const z = p.revisitZone;
  return { zone: z, seg: 1, hardness: hardnessAt(z * 10 + 9), req10: REQ_POWER10[z * 2 + 1] };
}

interface Drops { items: Record<string, number>; coins: number; artifacts: string[] }

function add(rec: Record<string, number>, k: string, n: number) {
  rec[k] = (rec[k] ?? 0) + n;
}

/** GBS §6–§7：一個方塊完成時的四層判定（順序與 TECHNICAL_SPEC §6.2 相同） */
function rollBlock(rng: Rng, z: number, seg: number, mode: Mode, sec: number, luck: number): Drops {
  const zone = ZONES[z];
  const d: Drops = { items: {}, coins: 0, artifacts: [] };
  // 第一層：基礎產出
  add(d.items, pickWeighted(rng, zone.ore).item, 1);
  // 第二層：礦物判定（None / 礦石包 / Rare）
  const pRare = zone.rareChance * (1 + luck);
  const u2 = rng();
  if (u2 < zone.bundleChance) {
    for (let k = 0; k < zone.bundleSize; k++) add(d.items, pickWeighted(rng, zone.ore).item, 1);
  } else if (u2 < zone.bundleChance + pRare) {
    const r = pickWeighted(rng, zone.rare);
    add(d.items, r.item, r.qty);
  }
  // 第三層：金幣判定
  if (rng() < zone.coinChance) {
    const avg = coinAvg(z, seg, mode);
    const lo = Math.round(avg * 0.5);
    const hi = Math.round(avg * 1.5);
    d.coins += lo + Math.floor(rng() * (hi - lo + 1));
  }
  // 第四層：寶物機會（時間型）
  const mult = mode === "revisit" ? REVISIT_TREASURE_MULT : 1;
  const chance = Math.min(TREASURE_CHANCE_CAP, (zone.treasurePerHour * sec * mult) / 3600);
  const pLeg = chance * LEGENDARY_SHARE * (1 + luck);
  const pEpic = chance * (1 - LEGENDARY_SHARE) * (1 + luck);
  const u4 = rng();
  if (u4 < pLeg) d.artifacts.push(zone.legendary);
  else if (u4 < pLeg + pEpic) d.artifacts.push(zone.epics[Math.floor(rng() * zone.epics.length)]);
  return d;
}

function coinAvg(z: number, segInZone: number, mode: Mode): number {
  return ZONES[z].coinAvgBySeg[segInZone] * (mode === "revisit" ? REVISIT_COIN_MULT : 1);
}
function hardnessAt(band: number): number {
  return Math.round(HARDNESS[band] * HARDNESS_SCALE);
}

// ---------- 期望值（解析解，用於回訪收益表與速度驗證） ----------

function avgOreValue(z: number): number {
  const ore = ZONES[z].ore;
  const w = ore.reduce((s, e) => s + e.w, 0);
  return ore.reduce((s, e) => s + (e.w / w) * PRICE[e.item], 0);
}
function avgRareValue(z: number): number {
  const r = ZONES[z].rare;
  const w = r.reduce((s, e) => s + e.w, 0);
  return r.reduce((s, e) => s + (e.w / w) * e.qty * PRICE[e.item], 0);
}
function blockSeconds(hardness: number, power10: number, speed1000: number): number {
  return Math.ceil((hardness * 1e7) / (power10 * speed1000)) / 1000;
}
interface Rates { blocksPerHour: number; oresPerHour: number; raresPerHour: number; coinsPerHour: number; treasuresPerHour: number; legendaryPerHour: number; valuePerHour: number; valueWithTreasure: number }
function expectedRates(band: number, s: { power10: number; speed1000: number; luck: number }, mode: Mode): Rates {
  const z = Math.floor(band / 10);
  const zone = ZONES[z];
  const hardness = hardnessAt(band);
  const sec = blockSeconds(hardness, s.power10, s.speed1000);
  const bph = 3600 / sec;
  const ores = 1 + zone.bundleChance * zone.bundleSize;
  const pRare = zone.rareChance * (1 + s.luck);
  const coins = zone.coinChance * coinAvg(z, Math.floor(band / 5) % 2, mode);
  const mult = mode === "revisit" ? REVISIT_TREASURE_MULT : 1;
  const chance = Math.min(TREASURE_CHANCE_CAP, (zone.treasurePerHour * sec * mult) / 3600);
  const tph = bph * chance * (1 + s.luck);
  const lph = tph * LEGENDARY_SHARE;
  const value = bph * (ores * avgOreValue(z) + pRare * avgRareValue(z) + coins);
  const tValue = lph * zone.legendaryValue + (tph - lph) * zone.epicValue;
  return { blocksPerHour: bph, oresPerHour: bph * ores, raresPerHour: bph * pRare, coinsPerHour: bph * coins, treasuresPerHour: tph, legendaryPerHour: lph, valuePerHour: value, valueWithTreasure: value + tValue };
}

// ============================================================================
// 4. 參考玩家策略
// ============================================================================

type Policy = "keep" | "sellDupes";

/** 檢查並消耗素材；不足的成品素材以原料製作（玩家手動製作的模擬）。成功回傳新背包。 */
function tryConsume(inv: Record<string, number>, mats: Record<string, number>): Record<string, number> | null {
  const next = { ...inv };
  for (const [item, n] of Object.entries(mats)) {
    const short = Math.max(0, n - (next[item] ?? 0));
    if (short > 0) {
      const recipe = RECIPES[item];
      if (!recipe) return null;
      for (const [raw, q] of Object.entries(recipe)) next[raw] = (next[raw] ?? 0) - q * short;
      next[item] = (next[item] ?? 0) + short;
    }
    next[item] -= n;
  }
  return Object.values(next).every((v) => v >= 0) ? next : null;
}

function missingFor(inv: Record<string, number>, mats: Record<string, number>): Record<string, number> {
  const raw: Record<string, number> = {};
  for (const [item, n] of Object.entries(mats)) {
    const short = Math.max(0, n - (inv[item] ?? 0));
    const recipe = RECIPES[item];
    if (!recipe) { add(raw, item, n); continue; }
    for (const [r, q] of Object.entries(recipe)) add(raw, r, q * short);
  }
  const need: Record<string, number> = {};
  for (const [k, n] of Object.entries(raw)) if (n > (inv[k] ?? 0)) need[k] = n - (inv[k] ?? 0);
  return need;
}

function sellExcess(p: Player, policy: Policy) {
  for (const item of Object.keys(p.inv)) {
    if (!(item in PRICE) || NEVER_SELL.has(item)) continue;
    const excess = (p.inv[item] ?? 0) - (KEEP[item] ?? 0);
    if (excess > 0) {
      p.inv[item] -= excess;
      gain(p, excess * PRICE[item]);
    }
  }
  if (policy === "sellDupes") {
    for (const z of ZONES) {
      for (const id of z.epics) {
        const extra = (p.held[id] ?? 0) - 1;
        if (extra > 0) { p.held[id] = 1; gain(p, extra * z.epicValue); }
      }
    }
  }
}

function gain(p: Player, coins: number) {
  p.coins += coins;
  const z = Math.min(2, Math.floor(p.frontier / 1000));
  if (p.frontier < TOTAL_BLOCKS) p.zoneCoins[z] += coins;
}

function frontierBlocked(p: Player): "power" | "unlock" | null {
  if (p.frontier >= TOTAL_BLOCKS) return null;
  const z = Math.floor(p.frontier / 1000);
  if (z > p.unlocked) return "unlock";
  const req = REQ_POWER10[Math.floor(p.frontier / 500)];
  return stats(p).power10 < req ? "power" : null;
}

/** 玩家在線時的決策：出售、購買、解鎖、強化、選擇挖掘位置 */
function decide(p: Player, policy: Policy) {
  sellExcess(p, policy);
  for (let guard = 0; guard < 20; guard++) {
    // 1. 解鎖
    const z = Math.floor(p.frontier / 1000);
    if (p.frontier < TOTAL_BLOCKS && z > p.unlocked && p.coins >= ZONES[z].unlockFee) {
      p.coins -= ZONES[z].unlockFee; p.unlocked = z;
      p.events.push(`${(p.t / 3600).toFixed(1)}h unlock ${ZONES[z].id}`);
      continue;
    }
    // 2. 下一階十字鎬
    if (p.tier < 4) {
      const nx = PICKAXES[p.tier + 1];
      const inv = tryConsume(p.inv, nx.mats);
      if (inv && p.coins >= nx.coins) {
        p.coins -= nx.coins; p.inv = inv; p.tier += 1;
        p.events.push(`${(p.t / 3600).toFixed(1)}h @${p.frontier / 10}m buy ${nx.id}`);
        continue;
      }
    }
    // 3. 強化（接近門檻時保留購買下一階與解鎖的資金）
    const lv = p.levels[p.tier];
    if (lv < 5) {
      const cost = upgradeCost(p.tier, lv + 1);
      const s5 = stats(p, p.tier, 5);
      let reserve = 0;
      if (p.tier < 4) {
        for (let seg = Math.floor(p.frontier / 500); seg < 6; seg++) {
          if (REQ_POWER10[seg] > s5.power10) {
            const dist = seg * 500 - p.frontier;
            reserve += PICKAXES[p.tier + 1].coins * Math.max(0, Math.min(1, 1 - dist / 400));
            break;
          }
        }
      }
      for (const zb of [1000, 2000]) {
        const dist = zb - p.frontier;
        if (dist >= 0 && dist <= 400 && p.unlocked < zb / 1000) reserve += ZONES[zb / 1000].unlockFee * (1 - dist / 400);
      }
      const inv = tryConsume(p.inv, cost.mats);
      const blockedByPower = frontierBlocked(p) === "power";
      if (inv && p.coins >= cost.coins && (p.coins - cost.coins >= reserve || blockedByPower)) {
        p.coins -= cost.coins; p.inv = inv; p.levels[p.tier] = lv + 1;
        p.events.push(`${(p.t / 3600).toFixed(1)}h @${p.frontier / 10}m upgrade ${PICKAXES[p.tier].id} Lv${lv + 1}`);
        continue;
      }
    }
    break;
  }
  // 4. 選擇挖掘位置
  const blocked = frontierBlocked(p);
  const desired: Mode = blocked || p.frontier >= TOTAL_BLOCKS ? "revisit" : "frontier";
  if (desired === "frontier" && p.mode !== "frontier") switchMode(p, "frontier", 0);
  if (desired === "revisit") {
    const zr = chooseRevisitZone(p, blocked);
    if (zr < 0) { if (p.mode !== "frontier") switchMode(p, "frontier", 0); return; }
    if (p.mode !== "revisit" || p.revisitZone !== zr) switchMode(p, "revisit", zr);
  }
}

function switchMode(p: Player, mode: Mode, zone: number) {
  p.mode = mode; p.revisitZone = zone; p.work = 0; p.blockSec = 0; // GBS §2.4：切換時進度歸零
}

/** GBS §2.3：可回訪「比前線所在礦區淺」的已解鎖礦區；主線完成後可回訪全部 */
function revisitAllowed(p: Player, z: number): boolean {
  if (p.frontier >= TOTAL_BLOCKS) return true;
  return z < Math.floor(p.frontier / 1000) && z <= p.unlocked;
}

/** 卡關時選擇回訪礦區：缺素材就去產出該素材的礦區，缺金幣就去每小時收益最高的礦區 */
function chooseRevisitZone(p: Player, blocked: "power" | "unlock" | null): number {
  const s = stats(p);
  const allowed = [0, 1, 2].filter((z) => revisitAllowed(p, z) && s.power10 >= REQ_POWER10[z * 2 + 1]);
  if (allowed.length === 0) return -1; // 沒有可回訪的礦區（例如前線仍在 zone1），維持卡關
  let missing: Record<string, number> = {};
  if (blocked === "power" && p.tier < 4) missing = missingFor(p.inv, PICKAXES[p.tier + 1].mats);
  else if (blocked === "power") missing = missingFor(p.inv, upgradeCost(p.tier, p.levels[p.tier] + 1).mats);
  if ((missing.amethyst ?? 0) > 0) return allowed.includes(1) ? 1 : 0;
  if ((missing.coal ?? 0) > 0) return 0;
  if ((missing.iron_ore ?? 0) > 0 || (missing.stone ?? 0) > 0) return allowed.includes(1) ? 1 : 0;
  let best = allowed[0];
  let bestV = -1;
  for (const z of allowed) {
    const v = expectedRates(z * 10 + 9, s, "revisit").valuePerHour;
    if (v > bestV) { bestV = v; best = z; }
  }
  return best;
}

// ============================================================================
// 5. 時間推進
// ============================================================================

interface Report { coins: number; items: Record<string, number>; artifacts: string[] }

function applyDrops(p: Player, d: Drops) {
  for (const [k, n] of Object.entries(d.items)) add(p.inv, k, n);
  if (d.coins) gain(p, d.coins);
  for (const a of d.artifacts) add(p.held, a, 1);
}

/**
 * 推進到 tEnd。online = true 時每個方塊後由玩家決策；false 時獎勵累積到報告，
 * 遇到門檻即停止（D5）。回傳 true 表示主線完成。
 */
function advance(p: Player, tEnd: number, online: boolean, rng: Rng, policy: Policy, report: Report | null): boolean {
  while (p.t < tEnd - 1e-9) {
    if (p.mode === "frontier" && p.frontier >= TOTAL_BLOCKS) return true;
    if (p.mode === "frontier" && frontierBlocked(p)) {
      if (online) {
        decide(p, policy);
        if (p.mode === "frontier") { p.blockedWasteSec += tEnd - p.t; p.t = tEnd; return false; }
        continue;
      }
      p.blockedWasteSec += tEnd - p.t; p.t = tEnd; return false; // D5：離線停止
    }
    const bp = blockParams(p);
    const s = stats(p);
    if (s.power10 < bp.req10) { p.blockedWasteSec += tEnd - p.t; p.t = tEnd; return false; }
    const rate = s.power10 * s.speed1000; // 每毫秒工作量
    const need = bp.hardness * 1e7 - p.work;
    const ms = Math.ceil(need / rate);
    const remain = (tEnd - p.t) * 1000;
    if (ms > remain) {
      p.work += rate * remain; p.blockSec += remain / 1000; p.miningSec += remain / 1000;
      if (p.mode === "revisit") p.revisitSec += remain / 1000;
      p.t = tEnd;
      return false;
    }
    p.t += ms / 1000; p.miningSec += ms / 1000; p.blockSec += ms / 1000;
    if (p.mode === "revisit") p.revisitSec += ms / 1000;
    const drops = rollBlock(rng, bp.zone, bp.seg, p.mode, p.blockSec, s.luck);
    for (const a of drops.artifacts) {
      if (!(a in p.found)) p.found[a] = p.t;
      if (LEGENDARY_IDS.has(a)) p.legendaries++;
      else p.epics++;
      p.treasureTimes.push(p.miningSec);
    }
    p.work = 0; p.blockSec = 0;
    if (online) applyDrops(p, drops);
    else if (report) {
      for (const [k, n] of Object.entries(drops.items)) add(report.items, k, n);
      report.coins += drops.coins;
      report.artifacts.push(...drops.artifacts);
    }
    if (p.mode === "frontier") {
      p.frontier += 1;
      if (p.frontier % 1000 === 0) {
        const z = p.frontier / 1000 - 1;
        p.zoneDoneAt[z] = p.t; p.zoneDoneMining[z] = p.miningSec;
        p.setDoneAtExit[z] = setActive(p, z) || (report ? ZONES[z].epics.every((id) => (p.held[id] ?? 0) + report.artifacts.filter((a) => a === id).length > 0) : false);
        if (p.frontier >= TOTAL_BLOCKS) return true;
      }
    }
    if (online) decide(p, policy);
  }
  return p.frontier >= TOTAL_BLOCKS;
}

function claim(p: Player, r: Report) {
  for (const [k, n] of Object.entries(r.items)) add(p.inv, k, n);
  gain(p, r.coins);
  for (const a of r.artifacts) add(p.held, a, 1);
}

interface Profile { id: string; label: string; logins: number[]; sessionMin: number }

/** GBS §16.3 玩家類型（登入時間為一天中的小時數） */
const PROFILES: Profile[] = [
  { id: "continuous", label: "持續在線（理論上限）", logins: [], sessionMin: 0 },
  { id: "heavy", label: "重度：每天 4 次", logins: [8, 12.5, 19, 23], sessionMin: 15 },
  { id: "normal", label: "一般：每天 2 次", logins: [8, 21], sessionMin: 20 },
  { id: "light", label: "輕度：每天 1 次", logins: [21], sessionMin: 30 },
];

function runOnce(seed: number, profile: Profile, policy: Policy): Player {
  const rng = makeRng(seed);
  const p = newPlayer();
  decide(p, policy);
  if (profile.logins.length === 0) {
    advance(p, 400 * 3600, true, rng, policy, null);
    return p;
  }
  const loginsAbs: number[] = [];
  for (let day = 0; day < 60; day++) for (const h of profile.logins) loginsAbs.push((day * 24 + h - profile.logins[0]) * 3600);
  let report: Report | null = null;
  for (let i = 0; i < loginsAbs.length - 1; i++) {
    p.t = Math.max(p.t, loginsAbs[i]);
    if (report) { claim(p, report); report = null; }
    decide(p, policy);
    const onlineEnd = loginsAbs[i] + profile.sessionMin * 60;
    if (advance(p, onlineEnd, true, rng, policy, null)) return p;
    const offlineEnd = Math.min(loginsAbs[i + 1], onlineEnd + OFFLINE_CAP_S);
    report = { coins: 0, items: {}, artifacts: [] };
    const done = advance(p, offlineEnd, false, rng, policy, report);
    if (done) { claim(p, report); return p; }
    p.t = loginsAbs[i + 1];
  }
  return p;
}

// ============================================================================
// 6. 統計與報表
// ============================================================================

function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
function summary(xs: number[]) {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { mean, median: quantile(xs, 0.5), p10: quantile(xs, 0.1), p90: quantile(xs, 0.9) };
}
const f1 = (x: number) => x.toFixed(1);
const f0 = (x: number) => Math.round(x).toLocaleString("en-US");
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (k: string, d: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  return {
    runs: Number(get("--runs", "400")),
    seed: Number(get("--seed", "1")),
    policy: get("--policy", "keep") as Policy,
    json: get("--json", ""),
    hardnessScale: Number(get("--hardness-scale", "1")),
    only: get("--only", ""), // "profiles" 只跑玩家類型
  };
}

function main() {
  const args = parseArgs();
  HARDNESS_SCALE = args.hardnessScale;
  const out: Record<string, unknown> = { runs: args.runs, seed: args.seed, policy: args.policy };
  const lines: string[] = [];
  const log = (s = "") => lines.push(s);

  log(`# 平衡模擬結果（runs=${args.runs}, seed=${args.seed}, policy=${args.policy}, hardness×${args.hardnessScale}）`);
  log();
  log("時間類指標：P10 = 高運氣（較快）、P90 = 低運氣（較慢）。數量類指標（Legendary 數）：P10 = 低運氣、P90 = 高運氣。");

  // ---- A. 各玩家類型 ----
  const profileResults: Record<string, unknown> = {};
  for (const prof of PROFILES) {
    const ps: Player[] = [];
    for (let i = 0; i < args.runs; i++) ps.push(runOnce(args.seed * 100_003 + i, prof, args.policy));
    const done = ps.filter((p) => p.frontier >= TOTAL_BLOCKS);
    const total = summary(done.map((p) => p.zoneDoneAt[2] / 3600));
    const mining = summary(done.map((p) => p.zoneDoneMining[2] / 3600));
    const zoneH = [0, 1, 2].map((z) => summary(done.map((p) => (p.zoneDoneAt[z] - (z ? p.zoneDoneAt[z - 1] : 0)) / 3600)));
    const zoneCoins = [0, 1, 2].map((z) => summary(done.map((p) => p.zoneCoins[z])));
    const waste = summary(done.map((p) => p.blockedWasteSec / 3600));
    const revisit = summary(done.map((p) => p.revisitSec / 3600));
    const leg = summary(done.map((p) => p.legendaries));
    const noLeg = done.filter((p) => p.legendaries === 0).length / done.length;
    const setExit = [0, 1, 2].map((z) => done.filter((p) => p.setDoneAtExit[z]).length / done.length);
    const firstTreasure = summary(done.map((p) => (p.treasureTimes[0] ?? Infinity) / 3600));
    const maxGap = summary(done.map((p) => {
      let g = p.treasureTimes[0] ?? 0;
      for (let i = 1; i < p.treasureTimes.length; i++) g = Math.max(g, p.treasureTimes[i] - p.treasureTimes[i - 1]);
      return g / 3600;
    }));
    const days = (h: number) => (prof.logins.length ? h / 24 : h / 24);
    log();
    log(`## ${prof.label}（完成率 ${pct(done.length / ps.length)}）`);
    log();
    log("| 指標 | 平均 | 中位數 | P10 | P90 |");
    log("|---|---:|---:|---:|---:|");
    log(`| 完成 300m（小時，日曆時間） | ${f1(total.mean)} | ${f1(total.median)} | ${f1(total.p10)} | ${f1(total.p90)} |`);
    log(`| 完成 300m（天） | ${f1(days(total.mean))} | ${f1(days(total.median))} | ${f1(days(total.p10))} | ${f1(days(total.p90))} |`);
    log(`| 實際挖掘時數 | ${f1(mining.mean)} | ${f1(mining.median)} | ${f1(mining.p10)} | ${f1(mining.p90)} |`);
    for (let z = 0; z < 3; z++) log(`| ${ZONES[z].id} 時數（日曆） | ${f1(zoneH[z].mean)} | ${f1(zoneH[z].median)} | ${f1(zoneH[z].p10)} | ${f1(zoneH[z].p90)} |`);
    for (let z = 0; z < 3; z++) log(`| ${ZONES[z].id} 收入（金幣） | ${f0(zoneCoins[z].mean)} | ${f0(zoneCoins[z].median)} | ${f0(zoneCoins[z].p10)} | ${f0(zoneCoins[z].p90)} |`);
    log(`| 卡關閒置時數 | ${f1(waste.mean)} | ${f1(waste.median)} | ${f1(waste.p10)} | ${f1(waste.p90)} |`);
    log(`| 回訪時數 | ${f1(revisit.mean)} | ${f1(revisit.median)} | ${f1(revisit.p10)} | ${f1(revisit.p90)} |`);
    log(`| 主線 Legendary 數 | ${f1(leg.mean)} | ${f1(leg.median)} | ${f1(leg.p10)} | ${f1(leg.p90)} |`);
    log(`| 第一件寶物（挖掘時數） | ${f1(firstTreasure.mean)} | ${f1(firstTreasure.median)} | ${f1(firstTreasure.p10)} | ${f1(firstTreasure.p90)} |`);
    log(`| 最長寶物空窗（挖掘時數） | ${f1(maxGap.mean)} | ${f1(maxGap.median)} | ${f1(maxGap.p10)} | ${f1(maxGap.p90)} |`);
    log();
    log(`主線結束時 0 件 Legendary：${pct(noLeg)}；離開礦區時已集滿套組：zone1 ${pct(setExit[0])} / zone2 ${pct(setExit[1])} / zone3 ${pct(setExit[2])}`);
    profileResults[prof.id] = { total, mining, zoneH, zoneCoins, waste, revisit, leg, noLeg, setExit, firstTreasure, maxGap, completion: done.length / ps.length };
    if (prof.id === "continuous") {
      const sample = runOnce(args.seed * 100_003, prof, args.policy);
      out.sampleEvents = sample.events;
    }
  }
  out.profiles = profileResults;
  const finish = () => {
    console.log(lines.join("\n"));
    if (args.json) {
      const fs = process.getBuiltinModule("node:fs");
      fs.writeFileSync(args.json, JSON.stringify(out, null, 1));
    }
  };
  if (args.only === "profiles") return finish();

  // ---- B. 回訪收益 vs 前線 ----
  log();
  log("## 回訪收益 vs 前線（期望值，每小時金幣等值；不含寶物）");
  log();
  log("前線取「這把裝備能到達的最深深度帶」：這是前線最慢、最容易被回訪超越的情況。只列比前線淺的礦區（GBS §2.3）。");
  log();
  log("| 裝備 | 前線深度 | 前線 /h | 回訪 zone1 /h | 回訪 zone2 /h | 回訪 / 前線最高 |");
  log("|---|---|---:|---:|---:|---:|");
  const grid: unknown[] = [];
  const dummy = newPlayer();
  let worst = 0;
  for (let tier = 0; tier < 5; tier++) {
    for (const lv of [1, 3, 5]) {
      const s = stats(dummy, tier, lv);
      let band = -1;
      for (let b = 0; b < 30; b++) if (s.power10 >= REQ_POWER10[Math.floor(b / 5)]) band = b;
      const fz = Math.floor(band / 10);
      if (fz === 0) continue; // 前線仍在 zone1，沒有可回訪的礦區
      const front = expectedRates(band, s, "frontier").valuePerHour;
      const rv = [0, 1].map((z) => (z < fz && s.power10 >= REQ_POWER10[z * 2 + 1] ? expectedRates(z * 10 + 9, s, "revisit").valuePerHour : NaN));
      const ratio = Math.max(...rv.filter((x) => !Number.isNaN(x)).map((x) => x / front));
      worst = Math.max(worst, ratio);
      grid.push({ pickaxe: PICKAXES[tier].id, lv, band, front, revisit: rv, ratio });
      const cell = (x: number) => (Number.isNaN(x) ? "—" : f0(x));
      log(`| ${PICKAXES[tier].id} Lv${lv} | ${band * 10}–${band * 10 + 10}m | ${f0(front)} | ${cell(rv[0])} | ${cell(rv[1])} | ${pct(ratio)} |`);
    }
  }
  log();
  log(`最壞情況回訪 / 前線：${pct(worst)}`);
  out.revisitGrid = grid;
  out.revisitWorst = worst;

  // 主線參考狀態：用參考玩家在每個深度帶實際持有的裝備
  log();
  log("### 主線參考狀態（持續在線參考玩家每 10m 的裝備）");
  log();
  log("| 深度 | 裝備 | 前線 /h | 最佳回訪 /h | 比例 |");
  log("|---|---|---:|---:|---:|");
  const ref = runOnce(args.seed * 100_003, PROFILES[0], args.policy);
  const gearAt = ref.events.filter((e) => e.includes(" buy ") || e.includes(" upgrade "));
  let tierNow = 0;
  const lvNow = [1, 1, 1, 1, 1];
  let gi = 0;
  let mainWorst = 0;
  for (let band = 10; band < 30; band++) {
    while (gi < gearAt.length && Number(gearAt[gi].split("@")[1].split("m")[0]) < band * 10 + 10) {
      const e = gearAt[gi++];
      if (e.includes(" buy ")) tierNow = PICKAXES.findIndex((pk) => e.endsWith(`buy ${pk.id}`));
      else lvNow[tierNow] = Number(e.slice(-1));
    }
    const s = stats(dummy, tierNow, lvNow[tierNow]);
    const fz = Math.floor(band / 10);
    const front = expectedRates(band, s, "frontier").valuePerHour;
    let best = 0;
    for (let z = 0; z < fz; z++) if (s.power10 >= REQ_POWER10[z * 2 + 1]) best = Math.max(best, expectedRates(z * 10 + 9, s, "revisit").valuePerHour);
    mainWorst = Math.max(mainWorst, best / front);
    log(`| ${band * 10}–${band * 10 + 10}m | ${PICKAXES[tierNow].id} Lv${lvNow[tierNow]} | ${f0(front)} | ${f0(best)} | ${pct(best / front)} |`);
  }
  log();
  log(`主線最高回訪 / 前線：${pct(mainWorst)}`);
  out.revisitMainWorst = mainWorst;

  // 回訪寶物產量
  log();
  log("## 回訪寶物產量（鑽石 Lv5，每小時）");
  log();
  log("| 礦區 | 前線 Epic+Legendary /h | 回訪 /h | 回訪 Legendary /h | 回訪補齊 1 種缺少的 Epic（期望小時） |");
  log("|---|---:|---:|---:|---:|");
  const sMax = stats(dummy, 4, 5);
  for (let z = 0; z < 3; z++) {
    const fr = expectedRates(z * 10 + 9, sMax, "frontier");
    const rv = expectedRates(z * 10 + 9, sMax, "revisit");
    const epicPerType = (rv.treasuresPerHour - rv.legendaryPerHour) / 3;
    log(`| ${ZONES[z].id} | ${fr.treasuresPerHour.toFixed(3)} | ${rv.treasuresPerHour.toFixed(3)} | ${rv.legendaryPerHour.toFixed(4)} | ${f1(1 / epicPerType)} |`);
  }

  // ---- C. Mining Speed 驗證 ----
  log();
  log("## Mining Speed 提升後的產出（前線，每小時期望值）");
  log();
  log("| 位置 | 裝備 | 方塊 /h | 礦物 /h | Rare /h | 金幣 /h | 寶物 /h |");
  log("|---|---|---:|---:|---:|---:|---:|");
  const speedCases: [string, number, number, number[]][] = [
    ["zone1 80m", 7, 1, [1, 3, 5]],
    ["zone2 120m", 11, 2, [1, 3, 5]],
    ["zone2 170m", 16, 3, [1, 3, 5]],
    ["zone3 280m", 27, 4, [3, 4, 5]],
  ];
  const speedOut: unknown[] = [];
  for (const [label, band, tier, lvs] of speedCases) {
    for (const lv of lvs) {
      const r = expectedRates(band, stats(dummy, tier, lv), "frontier");
      speedOut.push({ label, tier: PICKAXES[tier].id, lv, ...r });
      log(`| ${label} | ${PICKAXES[tier].id} Lv${lv} | ${f1(r.blocksPerHour)} | ${f1(r.oresPerHour)} | ${r.raresPerHour.toFixed(2)} | ${f0(r.coinsPerHour)} | ${r.treasuresPerHour.toFixed(3)} |`);
    }
  }
  out.speed = speedOut;

  finish();
}

main();
