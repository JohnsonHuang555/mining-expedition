/**
 * 《挖礦探險隊》平衡模擬 — 開發輔助工具（不是遊戲實作）
 *
 * 用 GBS v1.2 的規則與數值模擬「參考玩家」從 0m 挖到 300m，驗證 GBS §18。
 * 正式引擎完成後，資料與規則應改為匯入 `packages/game-data` / `packages/game-engine`，
 * 本檔只保留玩家策略與報表（與正式實作的差異見 GBS §22）。
 *
 * 執行（Node 22.18+ 可直接執行 TypeScript，不需安裝套件）：
 *   node scripts/balance-sim.ts                        # 全部報表（v1.2 預設方案）
 *   node scripts/balance-sim.ts --only protection      # 首次寶物保護 A / B / C 比較
 *   node scripts/balance-sim.ts --only stress          # 防卡死：全部出售後的恢復時間
 *   node scripts/balance-sim.ts --only compare         # D12–D16 套用前後比較
 *   node scripts/balance-sim.ts --only collection      # 主線後回訪補齊收藏
 *
 * 方案參數（預設值 = GBS v1.2）：
 *   --runs 1000              Monte Carlo 次數（玩家類型）
 *   --prot-runs 4000         首次保護比較的次數（P99 需要較多樣本）
 *   --seed 1                 第 i 次模擬的種子 = seed × 100003 + i（各方案共用同一組種子）
 *   --protect 4              D17 / D18 首次保護觸發的有效挖掘小時（預設 4）；none = 方案 A
 *   --revisit-coin-mult 0.5  D12
 *   --revisit-treasure-mult 0.5  D14（MVP 暫定）
 *   --rework-coin-mult 0.5   D16 重挖的金幣倍率（暫定，與回訪相同）
 *   --rework-treasure-mult 0.5   D16 重挖的寶物倍率（暫定，與回訪相同）
 *   --flat-coins             使用 D13 之前的每區固定金幣
 *   --no-rework              停用 D16 重挖
 *   --policy keep|sellDupes  寶物全部保留 / 出售重複 Epic
 *   --hardness-scale 1       D11：預設 1，只用於探索
 *   --json out.json          另存原始結果
 */

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
// 2. 遊戲資料（GBS v1.2）
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
const ALL_ARTIFACTS = ZONES.flatMap((z) => [...z.epics, z.legendary]);
const LEGENDARY_SHARE = 0.10;      // GDD §4.1：Epic 4.5% : Legendary 0.5% = 9 : 1
const TREASURE_CHANCE_CAP = 0.5;   // 每方塊寶物機會上限
const OFFLINE_CAP_S = 12 * 3600;   // D9
const PROTECTED_EPIC = "a_z1_lantern"; // D17：首次保護發放的固定 Epic（GBS §7.5）
const FLAT_COIN_AVG = [20, 220, 1_250]; // D13 之前每區固定的金幣平均（僅供 --flat-coins）

/** 參考玩家保留的製作素材（超過的部分出售） */
const KEEP: Record<string, number> = { stone: 300, coal: 40, iron_ore: 120 };
const NEVER_SELL = new Set(["amethyst"]);

// ============================================================================
// 3. 方案參數
// ============================================================================

type Policy = "keep" | "sellDupes";
type Mode = "frontier" | "revisit" | "rework";

interface Config {
  runs: number;
  protRuns: number;
  seed: number;
  policy: Policy;
  json: string;
  only: string;
  protectHours: number | null;
  revisitCoinMult: number;
  revisitTreasureMult: number;
  reworkCoinMult: number;
  reworkTreasureMult: number;
  flatCoins: boolean;
  rework: boolean;
  hardnessScale: number;
}

function parseArgs(argv: string[]): Config {
  const get = (k: string, d: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const prot = get("--protect", "4"); // D18：預設 4 小時
  return {
    runs: Number(get("--runs", "1000")),
    protRuns: Number(get("--prot-runs", "4000")),
    seed: Number(get("--seed", "1")),
    policy: get("--policy", "keep") as Policy,
    json: get("--json", ""),
    only: get("--only", ""),
    protectHours: prot === "none" ? null : Number(prot),
    revisitCoinMult: Number(get("--revisit-coin-mult", "0.5")),
    revisitTreasureMult: Number(get("--revisit-treasure-mult", "0.5")),
    reworkCoinMult: Number(get("--rework-coin-mult", "0.5")),
    reworkTreasureMult: Number(get("--rework-treasure-mult", "0.5")),
    flatCoins: argv.includes("--flat-coins"),
    rework: !argv.includes("--no-rework"),
    hardnessScale: Number(get("--hardness-scale", "1")),
  };
}

let CFG: Config = parseArgs(process.argv.slice(2));

function withCfg<T>(patch: Partial<Config>, fn: () => T): T {
  const saved = CFG;
  CFG = { ...CFG, ...patch };
  try { return fn(); } finally { CFG = saved; }
}

// ============================================================================
// 4. 規則
// ============================================================================

interface Player {
  t: number;                 // 日曆秒數
  miningSec: number;         // 實際挖掘秒數（所有模式）
  coins: number;
  inv: Record<string, number>;
  tier: number;
  levels: number[];
  unlocked: number;
  frontier: number;          // 下一個前線方塊
  mode: Mode;
  revisitZone: number;
  reworkBand: number;
  collectTarget: number;     // 主線後補收藏的目標礦區（-1 = 無）
  work: number;
  blockSec: number;
  held: Record<string, number>;
  found: Record<string, number>;
  // D17
  first: "pending" | "obtained" | "granted";
  effSec: number;            // 首次保護用的有效挖掘秒數（已完成方塊）
  firstMining: number;       // 第一件寶物時的挖掘秒數
  firstCal: number;          // 第一件寶物時的日曆秒數
  // 紀錄
  zoneDoneAt: number[];
  zoneDoneMining: number[];
  zoneCoins: number[];
  grossCoins: number;        // 累計總收入（不扣支出）
  setDoneAtExit: boolean[];
  treasureAtZone1Exit: boolean;
  zoneEpics: number[];
  zoneLegs: number[];
  normalTreasures: number;   // 不含首次保護
  legendaries: number;
  treasureTimes: number[];   // 挖掘秒數
  buy: { tier: number; t: number; depth: number }[];
  modeSec: Record<Mode, number>;
  blockedWasteSec: number;
  events: string[];
}

function newPlayer(): Player {
  return {
    t: 0, miningSec: 0, coins: 0, inv: {}, tier: 0, levels: [1, 1, 1, 1, 1], unlocked: 0, frontier: 0,
    mode: "frontier", revisitZone: 0, reworkBand: 0, collectTarget: -1, work: 0, blockSec: 0, held: {}, found: {},
    first: "pending", effSec: 0, firstMining: Infinity, firstCal: Infinity,
    zoneDoneAt: [], zoneDoneMining: [], zoneCoins: [0, 0, 0], grossCoins: 0, setDoneAtExit: [], treasureAtZone1Exit: false,
    zoneEpics: [0, 0, 0], zoneLegs: [0, 0, 0], normalTreasures: 0, legendaries: 0, treasureTimes: [], buy: [],
    modeSec: { frontier: 0, revisit: 0, rework: 0 }, blockedWasteSec: 0, events: [],
  };
}

function add(rec: Record<string, number>, k: string, n: number) {
  rec[k] = (rec[k] ?? 0) + n;
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
    if (setActive(p, z)) { speedPct += ZONES[z].set.speedPct; luckBonus += ZONES[z].set.luckPpm; }
  }
  const power10 = (pk.power10 * (100 + 10 * step)) / 100;
  const speed1000 = Math.floor(((pk.speed1000 * (100 + 5 * step)) / 100) * (100 + speedPct) / 100);
  const luckPpm = (pk.luckPpm * (100 + 10 * step)) / 100 + luckBonus;
  return { power10, speed1000, luck: luckPpm / 1e6 };
}
type Stats = ReturnType<typeof stats>;

const zoneOfBand = (b: number) => Math.floor(b / 10);
const segOfBand = (b: number) => Math.floor(b / 5);
const hardnessAt = (b: number) => Math.round(HARDNESS[b] * CFG.hardnessScale);
const reqAt = (b: number) => REQ_POWER10[segOfBand(b)];

/** 一個挖掘位置：前線 / 回訪（礦區最深帶）/ 重挖（指定深度帶） */
interface Spot { band: number; mode: Mode }

function spotOf(p: Player): Spot {
  if (p.mode === "frontier") return { band: Math.floor(p.frontier / 100), mode: "frontier" };
  if (p.mode === "revisit") return { band: p.revisitZone * 10 + 9, mode: "revisit" };
  return { band: p.reworkBand, mode: "rework" };
}
const coinMult = (m: Mode) => (m === "revisit" ? CFG.revisitCoinMult : m === "rework" ? CFG.reworkCoinMult : 1);
const treasureMultOf = (m: Mode) => (m === "revisit" ? CFG.revisitTreasureMult : m === "rework" ? CFG.reworkTreasureMult : 1);

function coinAvg(spot: Spot): number {
  const z = zoneOfBand(spot.band);
  const base = CFG.flatCoins ? FLAT_COIN_AVG[z] : ZONES[z].coinAvgBySeg[segOfBand(spot.band) % 2];
  return base * coinMult(spot.mode); // D12：只作用於第三層金幣
}
const treasureMult = (spot: Spot) => treasureMultOf(spot.mode); // D14

interface Drops { items: Record<string, number>; coins: number; artifacts: string[] }

/** GBS §7：四層判定。亂數消耗順序與 TECHNICAL_SPEC §6.2 相同 */
function rollBlock(rng: Rng, spot: Spot, sec: number, luck: number): Drops {
  const zone = ZONES[zoneOfBand(spot.band)];
  const d: Drops = { items: {}, coins: 0, artifacts: [] };
  // 第一層：基礎產出
  add(d.items, pickWeighted(rng, zone.ore).item, 1);
  // 第二層：礦物判定
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
    const avg = coinAvg(spot);
    const lo = Math.round(avg * 0.5);
    const hi = Math.round(avg * 1.5);
    d.coins += lo + Math.floor(rng() * (hi - lo + 1));
  }
  // 第四層：寶物機會
  const chance = Math.min(TREASURE_CHANCE_CAP, (zone.treasurePerHour * sec * treasureMult(spot)) / 3600);
  const pLeg = chance * LEGENDARY_SHARE * (1 + luck);
  const pEpic = chance * (1 - LEGENDARY_SHARE) * (1 + luck);
  const u4 = rng();
  if (u4 < pLeg) d.artifacts.push(zone.legendary);
  else if (u4 < pLeg + pEpic) d.artifacts.push(zone.epics[Math.floor(rng() * zone.epics.length)]);
  return d;
}

// ---------- 期望值 ----------

function blockSeconds(hardness: number, s: Stats): number {
  return Math.ceil((hardness * 1e7) / (s.power10 * s.speed1000)) / 1000;
}

interface Rates { sec: number; blocksPerHour: number; oresPerHour: number; raresPerHour: number; coinsPerHour: number; treasuresPerHour: number; legendaryPerHour: number; valuePerHour: number; itemsPerHour: Record<string, number> }

function expectedRates(spot: Spot, s: Stats): Rates {
  const z = zoneOfBand(spot.band);
  const zone = ZONES[z];
  const sec = blockSeconds(hardnessAt(spot.band), s);
  const bph = 3600 / sec;
  const items: Record<string, number> = {};
  const wOre = zone.ore.reduce((a, e) => a + e.w, 0);
  const oresPerBlock = 1 + zone.bundleChance * zone.bundleSize;
  for (const e of zone.ore) add(items, e.item, (e.w / wOre) * oresPerBlock * bph);
  const pRare = zone.rareChance * (1 + s.luck);
  const wRare = zone.rare.reduce((a, e) => a + e.w, 0);
  for (const e of zone.rare) add(items, e.item, pRare * (e.w / wRare) * e.qty * bph);
  const coins = zone.coinChance * coinAvg(spot) * bph;
  const chance = Math.min(TREASURE_CHANCE_CAP, (zone.treasurePerHour * sec * treasureMult(spot)) / 3600);
  const tph = bph * chance * (1 + s.luck);
  let value = coins;
  for (const [k, n] of Object.entries(items)) value += n * PRICE[k];
  return {
    sec, blocksPerHour: bph, oresPerHour: oresPerBlock * bph, raresPerHour: pRare * bph, coinsPerHour: coins,
    treasuresPerHour: tph, legendaryPerHour: tph * LEGENDARY_SHARE, valuePerHour: value, itemsPerHour: items,
  };
}

// ============================================================================
// 5. 參考玩家策略
// ============================================================================

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

/** 還缺多少原料（成品素材展開為配方原料） */
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

function gain(p: Player, coins: number) {
  p.coins += coins;
  p.grossCoins += coins;
  if (p.frontier < TOTAL_BLOCKS) p.zoneCoins[Math.floor(p.frontier / 1000)] += coins;
}

function sellExcess(p: Player) {
  for (const item of Object.keys(p.inv)) {
    if (!(item in PRICE) || NEVER_SELL.has(item)) continue;
    const excess = (p.inv[item] ?? 0) - (KEEP[item] ?? 0);
    if (excess > 0) { p.inv[item] -= excess; gain(p, excess * PRICE[item]); }
  }
  if (CFG.policy === "sellDupes") {
    for (const z of ZONES) for (const id of z.epics) {
      const extra = (p.held[id] ?? 0) - 1;
      if (extra > 0) { p.held[id] = 1; gain(p, extra * z.epicValue); }
    }
  }
}

function frontierBlocked(p: Player): "power" | "unlock" | null {
  if (p.frontier >= TOTAL_BLOCKS) return null;
  const z = Math.floor(p.frontier / 1000);
  if (z > p.unlocked) return "unlock";
  return stats(p).power10 < REQ_POWER10[Math.floor(p.frontier / 500)] ? "power" : null;
}

/** 解除目前卡關所需要的金幣與素材 */
function goalFor(p: Player, blocked: "power" | "unlock"): { coins: number; mats: Record<string, number> } {
  if (blocked === "unlock") return { coins: ZONES[Math.floor(p.frontier / 1000)].unlockFee, mats: {} };
  const req = REQ_POWER10[Math.floor(p.frontier / 500)];
  if (stats(p, p.tier, 5).power10 >= req && p.levels[p.tier] < 5) return upgradeCost(p.tier, p.levels[p.tier] + 1);
  const nx = PICKAXES[p.tier + 1];
  return { coins: nx.coins, mats: nx.mats };
}

/** GBS §2.3（D15）：只能回訪比前線所在礦區淺、且已解鎖的礦區；主線完成後可回訪全部 */
function revisitAllowed(p: Player, z: number): boolean {
  if (p.frontier >= TOTAL_BLOCKS) return true;
  return z < Math.floor(p.frontier / 1000) && z <= p.unlocked;
}

/** GBS §2.5（D16）：重挖目標 = 目前裝備能挖的最深已探索深度帶。前線未卡關時不可用 */
function reworkBandFor(p: Player): number {
  if (!CFG.rework || p.frontier === 0 || !frontierBlocked(p)) return -1;
  const pw = stats(p).power10;
  for (let b = Math.floor((p.frontier - 1) / 100); b >= 0; b--) if (reqAt(b) <= pw) return b;
  return -1;
}

/** 卡關時選擇恢復方式：在可用的重挖與回訪中，選「湊齊目標」期望時間最短的 */
function chooseRecovery(p: Player, blocked: "power" | "unlock"): { mode: Mode; zone: number; band: number } | null {
  const s = stats(p);
  const goal = goalFor(p, blocked);
  const need = missingFor(p.inv, goal.mats);
  const coinsNeed = Math.max(0, goal.coins - p.coins);
  const options: { mode: Mode; zone: number; band: number }[] = [];
  const rb = reworkBandFor(p);
  if (rb >= 0) options.push({ mode: "rework", zone: zoneOfBand(rb), band: rb });
  for (let z = 0; z < 3; z++) if (revisitAllowed(p, z) && s.power10 >= reqAt(z * 10 + 9)) options.push({ mode: "revisit", zone: z, band: z * 10 + 9 });
  let best: (typeof options)[number] | null = null;
  let bestT = Infinity;
  for (const o of options) {
    const r = expectedRates({ band: o.band, mode: o.mode }, s);
    let t = coinsNeed > 0 ? coinsNeed / r.valuePerHour : 0;
    for (const [k, n] of Object.entries(need)) t = Math.max(t, (r.itemsPerHour[k] ?? 0) > 0 ? n / r.itemsPerHour[k] : Infinity);
    if (t < bestT) { bestT = t; best = o; }
  }
  return best ?? (options[0] ?? null);
}

function switchMode(p: Player, mode: Mode, zone: number, band: number) {
  if (p.mode === mode && p.revisitZone === zone && p.reworkBand === band) return;
  p.mode = mode; p.revisitZone = zone; p.reworkBand = band; p.work = 0; p.blockSec = 0; // GBS §2.4：進度歸零
}

/** 玩家在線時的決策 */
function decide(p: Player) {
  sellExcess(p);
  for (let guard = 0; guard < 20; guard++) {
    const z = Math.floor(p.frontier / 1000);
    if (p.frontier < TOTAL_BLOCKS && z > p.unlocked && p.coins >= ZONES[z].unlockFee) {
      p.coins -= ZONES[z].unlockFee; p.unlocked = z;
      p.events.push(`${(p.t / 3600).toFixed(1)}h unlock ${ZONES[z].id}`);
      continue;
    }
    if (p.tier < 4) {
      const nx = PICKAXES[p.tier + 1];
      const inv = tryConsume(p.inv, nx.mats);
      if (inv && p.coins >= nx.coins) {
        p.coins -= nx.coins; p.inv = inv; p.tier += 1;
        p.buy.push({ tier: p.tier, t: p.t, depth: p.frontier / 10 });
        p.events.push(`${(p.t / 3600).toFixed(1)}h @${p.frontier / 10}m buy ${nx.id}`);
        continue;
      }
    }
    const lv = p.levels[p.tier];
    if (lv < 5) {
      const cost = upgradeCost(p.tier, lv + 1);
      const blocked = frontierBlocked(p);
      const upgradeUnblocks = blocked === "power" && stats(p, p.tier, 5).power10 >= REQ_POWER10[Math.floor(p.frontier / 500)];
      let reserve = 0;
      if (!upgradeUnblocks) {
        if (p.tier < 4) {
          const s5 = stats(p, p.tier, 5);
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
      }
      const inv = tryConsume(p.inv, cost.mats);
      if (inv && p.coins - cost.coins >= reserve) {
        p.coins -= cost.coins; p.inv = inv; p.levels[p.tier] = lv + 1;
        p.events.push(`${(p.t / 3600).toFixed(1)}h @${p.frontier / 10}m upgrade ${PICKAXES[p.tier].id} Lv${lv + 1}`);
        continue;
      }
    }
    break;
  }
  // 選擇挖掘位置
  if (p.collectTarget >= 0) { switchMode(p, "revisit", p.collectTarget, 0); return; }
  const blocked = frontierBlocked(p);
  if (!blocked) { switchMode(p, "frontier", 0, 0); return; }
  const r = chooseRecovery(p, blocked);
  if (!r) switchMode(p, "frontier", 0, 0); // 沒有任何材料來源：真正卡死
  else switchMode(p, r.mode, r.mode === "revisit" ? r.zone : 0, r.mode === "rework" ? r.band : 0);
}

// ============================================================================
// 6. 時間推進
// ============================================================================

interface Report { coins: number; items: Record<string, number>; artifacts: string[] }

function applyDrops(p: Player, d: Drops) {
  for (const [k, n] of Object.entries(d.items)) add(p.inv, k, n);
  if (d.coins) gain(p, d.coins);
  for (const a of d.artifacts) add(p.held, a, 1);
}

function claim(p: Player, r: Report) {
  applyDrops(p, r);
}

/**
 * 推進到 tEnd。online：每個方塊後由玩家決策、獎勵立即入帳。
 * offline：獎勵累積到報告；前線遇到門檻即停止（D5）；回訪 / 重挖依玩家離線前的選擇繼續。
 */
function advance(p: Player, tEnd: number, online: boolean, rng: Rng, report: Report | null): boolean {
  while (p.t < tEnd - 1e-9) {
    if (p.mode === "frontier" && p.frontier >= TOTAL_BLOCKS) return true;
    if (p.mode === "frontier" && frontierBlocked(p)) {
      if (online) {
        decide(p);
        if (p.mode !== "frontier") continue;
      }
      p.blockedWasteSec += tEnd - p.t; p.t = tEnd; return false;
    }
    if (p.mode !== "frontier" && online && p.collectTarget < 0 && !frontierBlocked(p)) { decide(p); continue; }
    const spot = spotOf(p);
    const s = stats(p);
    if (s.power10 < reqAt(spot.band)) { p.blockedWasteSec += tEnd - p.t; p.t = tEnd; return false; }
    const rate = s.power10 * s.speed1000;
    const ms = Math.ceil((hardnessAt(spot.band) * 1e7 - p.work) / rate);
    const remain = (tEnd - p.t) * 1000;
    if (ms > remain) {
      p.work += rate * remain; p.blockSec += remain / 1000; p.miningSec += remain / 1000;
      p.modeSec[p.mode] += remain / 1000; p.t = tEnd;
      return false;
    }
    const sec = ms / 1000;
    p.t += sec; p.miningSec += sec; p.blockSec += sec; p.modeSec[p.mode] += sec;
    const drops = rollBlock(rng, spot, p.blockSec, s.luck);
    // D17：有效挖掘時間只累積「已完成方塊」的挖掘秒數（所有模式；卡關、閒置、超過離線上限都不累積）
    p.effSec += p.blockSec;
    const z = zoneOfBand(spot.band);
    if (drops.artifacts.length > 0) {
      if (p.first === "pending") { p.first = "obtained"; p.firstMining = p.miningSec; p.firstCal = p.t; }
      for (const a of drops.artifacts) {
        p.normalTreasures++;
        if (LEGENDARY_IDS.has(a)) { p.legendaries++; p.zoneLegs[z]++; } else p.zoneEpics[z]++;
        p.treasureTimes.push(p.miningSec);
      }
    } else if (p.first === "pending" && CFG.protectHours !== null && p.effSec >= CFG.protectHours * 3600) {
      drops.artifacts.push(PROTECTED_EPIC); // 固定 Epic，不消耗亂數
      p.first = "granted"; p.firstMining = p.miningSec; p.firstCal = p.t;
      p.zoneEpics[0]++; p.treasureTimes.push(p.miningSec);
    }
    for (const a of drops.artifacts) if (!(a in p.found)) p.found[a] = p.t;
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
        const zz = p.frontier / 1000 - 1;
        p.zoneDoneAt[zz] = p.t; p.zoneDoneMining[zz] = p.miningSec;
        const pendingArt = report ? report.artifacts : [];
        p.setDoneAtExit[zz] = ZONES[zz].epics.every((id) => (p.held[id] ?? 0) + pendingArt.filter((a) => a === id).length > 0);
        if (zz === 0) p.treasureAtZone1Exit = p.first !== "pending";
        if (p.frontier >= TOTAL_BLOCKS) return true;
      }
    }
    if (online) decide(p);
  }
  return p.frontier >= TOTAL_BLOCKS;
}

interface Profile { id: string; label: string; logins: number[]; sessionMin: number }

/** GBS §16.3 玩家類型（登入時間為一天中的小時數） */
const PROFILES: Profile[] = [
  { id: "continuous", label: "持續在線（理論上限）", logins: [], sessionMin: 0 },
  { id: "heavy", label: "重度：每天 4 次", logins: [8, 12.5, 19, 23], sessionMin: 15 },
  { id: "normal", label: "一般：每天 2 次", logins: [8, 21], sessionMin: 20 },
  { id: "light", label: "輕度：每天 1 次", logins: [21], sessionMin: 30 },
];

const seedOf = (i: number) => CFG.seed * 100_003 + i;

function runOnce(seed: number, profile: Profile): Player {
  const rng = makeRng(seed);
  const p = newPlayer();
  decide(p);
  if (profile.logins.length === 0) { advance(p, 400 * 3600, true, rng, null); return p; }
  const loginsAbs: number[] = [];
  for (let day = 0; day < 60; day++) for (const h of profile.logins) loginsAbs.push((day * 24 + h - profile.logins[0]) * 3600);
  let report: Report | null = null;
  for (let i = 0; i < loginsAbs.length - 1; i++) {
    p.t = Math.max(p.t, loginsAbs[i]);
    if (report) { claim(p, report); report = null; }
    decide(p);
    const onlineEnd = loginsAbs[i] + profile.sessionMin * 60;
    if (advance(p, onlineEnd, true, rng, null)) return p;
    const offlineEnd = Math.min(loginsAbs[i + 1], onlineEnd + OFFLINE_CAP_S);
    report = { coins: 0, items: {}, artifacts: [] };
    if (advance(p, offlineEnd, false, rng, report)) { claim(p, report); return p; }
    p.t = loginsAbs[i + 1]; // 超過 12 小時上限的時間不產生收益（D9），也不算卡關閒置
  }
  return p;
}

/** 主線完成後，持續在線回訪補齊收藏（D14）。回傳補齊時間（挖掘小時，從主線完成起算） */
function runCollection(seed: number) {
  const rng = makeRng(seed);
  const p = newPlayer();
  decide(p);
  advance(p, 400 * 3600, true, rng, null);
  const start = p.miningSec;
  const coinsStart = p.grossCoins;
  const missingEpic = (z: number) => ZONES[z].epics.some((id) => !(id in p.found));
  const setsMissingAtStart = [0, 1, 2].filter(missingEpic).length;
  const codexMissingAtStart = ALL_ARTIFACTS.filter((a) => !(a in p.found)).length;
  let setsDone = setsMissingAtStart === 0 ? 0 : Infinity;
  let codexDone = codexMissingAtStart === 0 ? 0 : Infinity;
  const cap = start + 3000 * 3600;
  while (p.miningSec < cap && codexDone === Infinity) {
    const target = [0, 1, 2].find(missingEpic) ?? [0, 1, 2].find((z) => !(ZONES[z].legendary in p.found));
    if (target === undefined) break;
    p.collectTarget = target;
    decide(p);
    advance(p, p.t + 3600, true, rng, null);
    if (setsDone === Infinity && ![0, 1, 2].some(missingEpic)) setsDone = (p.miningSec - start) / 3600;
    if (ALL_ARTIFACTS.every((a) => a in p.found)) codexDone = (p.miningSec - start) / 3600;
  }
  const hours = (p.miningSec - start) / 3600;
  return { setsMissingAtStart, codexMissingAtStart, setsDone, codexDone, coinsPerHour: hours > 0 ? (p.grossCoins - coinsStart) / hours : 0 };
}

// ---------- 防卡死壓力測試（D16） ----------

interface Scenario { id: string; label: string; frontier: number; tier: number; unlocked: number }
const STRESS: Scenario[] = [
  { id: "S1", label: "50m：木 Lv1，需要石製十字鎬", frontier: 500, tier: 0, unlocked: 0 },
  { id: "S2", label: "100m：石 Lv1，需要解鎖 zone2 + 鐵製", frontier: 1000, tier: 1, unlocked: 0 },
  { id: "S3", label: "150m：鐵 Lv1，需要黃金", frontier: 1500, tier: 2, unlocked: 1 },
  { id: "S4", label: "200m：黃金 Lv1，需要解鎖 zone3 + 鑽石", frontier: 2000, tier: 3, unlocked: 1 },
  { id: "S5", label: "250m：鑽石 Lv1，需要鑽石 Lv3", frontier: 2500, tier: 4, unlocked: 2 },
];

/** 從「金幣 0、背包全空、寶物全賣」開始，到前線通過門檻所需的時間（持續在線） */
function runStress(seed: number, sc: Scenario) {
  const rng = makeRng(seed);
  const p = newPlayer();
  p.frontier = sc.frontier; p.tier = sc.tier; p.unlocked = sc.unlocked; p.first = "obtained";
  decide(p);
  const cap = 500 * 3600;
  while (p.t < cap && p.frontier <= sc.frontier) advance(p, p.t + 600, true, rng, null);
  const passed = p.frontier > sc.frontier;
  return { hours: passed ? p.t / 3600 : Infinity, rework: p.modeSec.rework / 3600, revisit: p.modeSec.revisit / 3600 };
}

// ============================================================================
// 7. 統計與報表
// ============================================================================

/** 分位數：order statistics 線性內插（與 numpy 預設、Excel PERCENTILE.INC 相同） */
function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (!Number.isFinite(s[hi])) return s[hi];
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
function summary(xs: number[]) {
  const fin = xs.filter(Number.isFinite);
  const mean = fin.length === xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Infinity;
  return { mean, p10: quantile(xs, 0.1), p50: quantile(xs, 0.5), p90: quantile(xs, 0.9), p99: quantile(xs, 0.99) };
}
type Summary = ReturnType<typeof summary>;
const fx = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "∞");
const f1 = (x: number) => fx(x, 1);
const f0 = (x: number) => (Number.isFinite(x) ? Math.round(x).toLocaleString("en-US") : "∞");
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`;
const row = (label: string, s: Summary, f: (x: number) => string = f1) => `| ${label} | ${f(s.mean)} | ${f(s.p10)} | ${f(s.p50)} | ${f(s.p90)} | ${f(s.p99)} |`;
const HEAD = ["| 指標 | 平均 | P10 | P50 | P90 | P99 |", "|---|---:|---:|---:|---:|---:|"];

function profileStats(ps: Player[]) {
  const done = ps.filter((p) => p.frontier >= TOTAL_BLOCKS);
  const zoneH = [0, 1, 2].map((z) => summary(done.map((p) => (p.zoneDoneAt[z] - (z ? p.zoneDoneAt[z - 1] : 0)) / 3600)));
  const buyDepth = [1, 2, 3, 4].map((t) => summary(done.map((p) => p.buy.find((b) => b.tier === t)?.depth ?? NaN)));
  const buyTime = [1, 2, 3, 4].map((t) => summary(done.map((p) => (p.buy.find((b) => b.tier === t)?.t ?? NaN) / 3600)));
  return {
    completion: done.length / ps.length,
    total: summary(done.map((p) => p.zoneDoneAt[2] / 3600)),
    mining: summary(done.map((p) => p.zoneDoneMining[2] / 3600)),
    zoneH,
    zoneCoins: [0, 1, 2].map((z) => summary(done.map((p) => p.zoneCoins[z]))),
    waste: summary(done.map((p) => p.blockedWasteSec / 3600)),
    revisit: summary(done.map((p) => p.modeSec.revisit / 3600)),
    rework: summary(done.map((p) => p.modeSec.rework / 3600)),
    leg: summary(done.map((p) => p.legendaries)),
    treasures: summary(done.map((p) => p.treasureTimes.length)),
    normalTreasures: summary(done.map((p) => p.normalTreasures)),
    noLeg: done.filter((p) => p.legendaries === 0).length / done.length,
    setExit: [0, 1, 2].map((z) => done.filter((p) => p.setDoneAtExit[z]).length / done.length),
    zoneEpics: [0, 1, 2].map((z) => summary(done.map((p) => p.zoneEpics[z]))),
    zoneLegs: [0, 1, 2].map((z) => summary(done.map((p) => p.zoneLegs[z]))),
    firstMining: summary(ps.map((p) => p.firstMining / 3600)),
    firstCal: summary(ps.map((p) => p.firstCal / 3600)),
    granted: ps.filter((p) => p.first === "granted").length / ps.length,
    within: [2, 4, 8].map((h) => ps.filter((p) => p.firstMining <= h * 3600).length / ps.length),
    zone1Exit: done.filter((p) => p.treasureAtZone1Exit).length / done.length,
    maxGap: summary(done.map((p) => {
      let g = p.treasureTimes[0] ?? 0;
      for (let i = 1; i < p.treasureTimes.length; i++) g = Math.max(g, p.treasureTimes[i] - p.treasureTimes[i - 1]);
      return g / 3600;
    })),
    buyDepth, buyTime,
  };
}
type ProfileStats = ReturnType<typeof profileStats>;

function simulateProfile(prof: Profile, runs: number): ProfileStats {
  const ps: Player[] = [];
  for (let i = 0; i < runs; i++) ps.push(runOnce(seedOf(i), prof));
  return profileStats(ps);
}

function cfgLabel(): string {
  return `protect=${CFG.protectHours ?? "none"}, revisitCoin×${CFG.revisitCoinMult}, revisitTreasure×${CFG.revisitTreasureMult}, reworkCoin×${CFG.reworkCoinMult}, reworkTreasure×${CFG.reworkTreasureMult}, coins=${CFG.flatCoins ? "flat" : "bySegment"}, rework=${CFG.rework ? "on" : "off"}, policy=${CFG.policy}, hardness×${CFG.hardnessScale}`;
}

// ---------- 報表 ----------

const lines: string[] = [];
const log = (...s: string[]) => { if (s.length === 0) lines.push(""); else lines.push(...s); };
const out: Record<string, unknown> = {};

function reportProfiles() {
  log(`## A. 玩家類型（runs=${CFG.runs}）`);
  log();
  log("時間類：P10 = 高運氣（快）、P90 / P99 = 低運氣（慢）。數量類：P10 = 低運氣。");
  const res: Record<string, ProfileStats> = {};
  for (const prof of PROFILES) {
    const st = simulateProfile(prof, CFG.runs);
    res[prof.id] = st;
    log();
    log(`### ${prof.label}（完成率 ${pct(st.completion)}）`);
    log();
    log(...HEAD);
    log(row("完成 300m（日曆小時）", st.total));
    log(row("完成 300m（天）", { mean: st.total.mean / 24, p10: st.total.p10 / 24, p50: st.total.p50 / 24, p90: st.total.p90 / 24, p99: st.total.p99 / 24 }));
    log(row("實際挖掘時數", st.mining));
    for (let z = 0; z < 3; z++) log(row(`${ZONES[z].id} 日曆時數`, st.zoneH[z]));
    for (let z = 0; z < 3; z++) log(row(`${ZONES[z].id} 收入`, st.zoneCoins[z], f0));
    for (let t = 0; t < 4; t++) log(row(`購買 ${PICKAXES[t + 1].id}：深度 m`, st.buyDepth[t], f0));
    for (let t = 0; t < 4; t++) log(row(`購買 ${PICKAXES[t + 1].id}：日曆小時`, st.buyTime[t]));
    log(row("卡關閒置時數", st.waste));
    log(row("回訪時數", st.revisit));
    log(row("重挖時數", st.rework));
    log(row("主線寶物總數", st.treasures));
    log(row("主線 Legendary 數", st.leg));
    log(row("第一件寶物（挖掘小時）", st.firstMining));
    log(row("第一件寶物（日曆小時）", st.firstCal));
    log(row("最長寶物空窗（挖掘小時）", st.maxGap));
    log();
    log(`0 件 Legendary：${pct(st.noLeg)}；離開礦區時已集滿套組：zone1 ${pct(st.setExit[0])} / zone2 ${pct(st.setExit[1])} / zone3 ${pct(st.setExit[2])}`);
  }
  out.profiles = res;
}

function reportRevisit() {
  log();
  log("## B. 回訪 / 重挖收益 vs 前線（期望值，每小時金幣等值，不含寶物）");
  log();
  log("前線取「這把裝備能到達的最深深度帶」（前線最慢的時候）。回訪只列比前線淺的礦區（D15）。重挖 = 卡在門檻時、該裝備能挖的最深帶（D16）。");
  log();
  log("| 裝備 | 前線深度 | 前線 /h | 回訪 zone1 /h | 回訪 zone2 /h | 重挖 /h | 回訪最高比例 | 重挖比例 |");
  log("|---|---|---:|---:|---:|---:|---:|---:|");
  const dummy = newPlayer();
  let worstRevisit = 0;
  let worstRework = 0;
  const grid: unknown[] = [];
  for (let tier = 0; tier < 5; tier++) for (const lv of [1, 3, 5]) {
    const s = stats(dummy, tier, lv);
    let band = -1;
    for (let b = 0; b < 30; b++) if (s.power10 >= reqAt(b)) band = b;
    const fz = zoneOfBand(band);
    const front = expectedRates({ band, mode: "frontier" }, s).valuePerHour;
    const rv = [0, 1].map((z) => (z < fz && s.power10 >= reqAt(z * 10 + 9) ? expectedRates({ band: z * 10 + 9, mode: "revisit" }, s).valuePerHour : NaN));
    const rw = band < 29 ? expectedRates({ band, mode: "rework" }, s).valuePerHour : NaN; // 卡在下一門檻時重挖同一帶
    const rr = rv.filter((x) => !Number.isNaN(x)).map((x) => x / front);
    const ratio = rr.length ? Math.max(...rr) : NaN;
    if (!Number.isNaN(ratio)) worstRevisit = Math.max(worstRevisit, ratio);
    if (!Number.isNaN(rw)) worstRework = Math.max(worstRework, rw / front);
    grid.push({ pickaxe: PICKAXES[tier].id, lv, band, front, revisit: rv, rework: rw });
    const c = (x: number) => (Number.isNaN(x) ? "—" : f0(x));
    log(`| ${PICKAXES[tier].id} Lv${lv} | ${band * 10}–${band * 10 + 10}m | ${f0(front)} | ${c(rv[0])} | ${c(rv[1])} | ${c(rw)} | ${Number.isNaN(ratio) ? "—" : pct(ratio)} | ${Number.isNaN(rw) ? "—" : pct(rw / front)} |`);
  }
  log();
  log(`最壞情況：回訪 / 前線 ${pct(worstRevisit)}；重挖 / 前線 ${pct(worstRework)}`);

  // 主線參考狀態
  log();
  log("### 主線參考狀態（持續在線參考玩家每 10m 的裝備）");
  log();
  log("| 深度 | 裝備 | 前線 /h | 最佳回訪 /h | 比例 |");
  log("|---|---|---:|---:|---:|");
  const ref = runOnce(seedOf(0), PROFILES[0]);
  let tierNow = 0;
  const lvNow = [1, 1, 1, 1, 1];
  const gear = ref.events.filter((e) => e.includes("@"));
  let gi = 0;
  let mainWorst = 0;
  for (let band = 10; band < 30; band++) {
    while (gi < gear.length && Number(gear[gi].split("@")[1].split("m")[0]) < band * 10 + 10) {
      const e = gear[gi++];
      if (e.includes(" buy ")) tierNow = PICKAXES.findIndex((pk) => e.endsWith(`buy ${pk.id}`));
      else lvNow[tierNow] = Number(e.slice(-1));
    }
    const s = stats(dummy, tierNow, lvNow[tierNow]);
    const front = expectedRates({ band, mode: "frontier" }, s).valuePerHour;
    let best = 0;
    for (let z = 0; z < zoneOfBand(band); z++) if (s.power10 >= reqAt(z * 10 + 9)) best = Math.max(best, expectedRates({ band: z * 10 + 9, mode: "revisit" }, s).valuePerHour);
    mainWorst = Math.max(mainWorst, best / front);
    log(`| ${band * 10}–${band * 10 + 10}m | ${PICKAXES[tierNow].id} Lv${lvNow[tierNow]} | ${f0(front)} | ${f0(best)} | ${pct(best / front)} |`);
  }
  log();
  log(`主線最高回訪 / 前線：${pct(mainWorst)}`);
  out.revisit = { grid, worstRevisit, worstRework, mainWorst, refEvents: ref.events };

  log();
  log("### 回訪寶物產量（鑽石 Lv5，每小時）");
  log();
  log("| 礦區 | 前線寶物 /h | 回訪寶物 /h | 回訪 Legendary /h | 補齊 1 種缺少的 Epic（期望小時） |");
  log("|---|---:|---:|---:|---:|");
  const sMax = stats(dummy, 4, 5);
  for (let z = 0; z < 3; z++) {
    const fr = expectedRates({ band: z * 10 + 9, mode: "frontier" }, sMax);
    const rv = expectedRates({ band: z * 10 + 9, mode: "revisit" }, sMax);
    log(`| ${ZONES[z].id} | ${fr.treasuresPerHour.toFixed(3)} | ${rv.treasuresPerHour.toFixed(3)} | ${rv.legendaryPerHour.toFixed(4)} | ${f1(3 / (rv.treasuresPerHour - rv.legendaryPerHour))} |`);
  }
}

function reportSpeed() {
  log();
  log("## C. Mining Speed 驗證（前線，每小時期望值）");
  log();
  log("| 位置 | 裝備 | 方塊 /h | 礦物 /h | Rare /h | 金幣 /h | 寶物 /h |");
  log("|---|---|---:|---:|---:|---:|---:|");
  const dummy = newPlayer();
  const cases: [string, number, number, number[]][] = [["zone1 80m", 7, 1, [1, 3, 5]], ["zone2 120m", 11, 2, [1, 3, 5]], ["zone2 170m", 16, 3, [1, 3, 5]], ["zone3 280m", 27, 4, [3, 4, 5]]];
  for (const [label, band, tier, lvs] of cases) for (const lv of lvs) {
    const r = expectedRates({ band, mode: "frontier" }, stats(dummy, tier, lv));
    log(`| ${label} | ${PICKAXES[tier].id} Lv${lv} | ${f1(r.blocksPerHour)} | ${f1(r.oresPerHour)} | ${r.raresPerHour.toFixed(2)} | ${f0(r.coinsPerHour)} | ${r.treasuresPerHour.toFixed(3)} |`);
  }
}

function reportProtection() {
  log();
  log(`## D. 首次寶物保護 A / B / C（持續在線 runs=${CFG.protRuns}；各方案共用同一組種子）`);
  const schemes: [string, number | null][] = [["A 無保護", null], ["B 2 小時", 2], ["C 4 小時", 4]];
  const res: Record<string, unknown> = {};
  const cont: Record<string, ProfileStats> = {};
  for (const [name, h] of schemes) cont[name] = withCfg({ protectHours: h }, () => simulateProfile(PROFILES[0], CFG.protRuns));
  log();
  log("| 指標 | A 無保護 | B 2 小時 | C 4 小時 |");
  log("|---|---:|---:|---:|");
  const line = (label: string, f: (s: ProfileStats) => string) => log(`| ${label} | ${schemes.map(([n]) => f(cont[n])).join(" | ")} |`);
  line("第一件寶物（挖掘小時）平均", (s) => f1(s.firstMining.mean));
  line("　P10", (s) => f1(s.firstMining.p10));
  line("　P50", (s) => f1(s.firstMining.p50));
  line("　P90", (s) => f1(s.firstMining.p90));
  line("　P99", (s) => f1(s.firstMining.p99));
  line("首次保護實際觸發比例", (s) => pct1(s.granted));
  line("前 2 小時至少 1 件", (s) => pct1(s.within[0]));
  line("前 4 小時至少 1 件", (s) => pct1(s.within[1]));
  line("前 8 小時至少 1 件", (s) => pct1(s.within[2]));
  line("離開 zone1 時至少 1 件", (s) => pct1(s.zone1Exit));
  line("zone1 Epic 數（含保護）", (s) => s.zoneEpics[0].mean.toFixed(2));
  line("zone1 Legendary 數", (s) => s.zoneLegs[0].mean.toFixed(3));
  line("離開 zone1 時集滿套組", (s) => pct1(s.setExit[0]));
  line("主線正常掉落寶物數（不含保護）", (s) => s.normalTreasures.mean.toFixed(2));
  line("主線 Legendary 數", (s) => s.leg.mean.toFixed(3));
  line("主線完成（挖掘小時）平均", (s) => f1(s.total.mean));
  res.continuous = cont;

  // 出售重複時的經濟影響
  const sell: Record<string, ProfileStats> = {};
  for (const [name, h] of schemes) sell[name] = withCfg({ protectHours: h, policy: "sellDupes" }, () => simulateProfile(PROFILES[0], CFG.runs));
  log();
  log(`出售重複 Epic（runs=${CFG.runs}）：主線完成小時 A ${f1(sell["A 無保護"].total.mean)} / B ${f1(sell["B 2 小時"].total.mean)} / C ${f1(sell["C 4 小時"].total.mean)}；zone1 收入 A ${f0(sell["A 無保護"].zoneCoins[0].mean)} / B ${f0(sell["B 2 小時"].zoneCoins[0].mean)} / C ${f0(sell["C 4 小時"].zoneCoins[0].mean)}`);
  res.sellDupes = sell;

  // 登入頻率公平性
  log();
  log(`### 不同登入頻率的第一件寶物（日曆小時，runs=${CFG.runs}）`);
  log();
  log("| 類型 | A 平均 / P90 / P99 | B 平均 / P90 / P99 | C 平均 / P90 / P99 | B 觸發 | C 觸發 |");
  log("|---|---|---|---|---:|---:|");
  const fair: Record<string, unknown> = {};
  for (const prof of PROFILES) {
    const r = schemes.map(([, h]) => withCfg({ protectHours: h }, () => simulateProfile(prof, CFG.runs)));
    fair[prof.id] = r.map((x) => ({ firstCal: x.firstCal, granted: x.granted }));
    const c = (x: ProfileStats) => `${f1(x.firstCal.mean)} / ${f1(x.firstCal.p90)} / ${f1(x.firstCal.p99)}`;
    log(`| ${prof.label} | ${c(r[0])} | ${c(r[1])} | ${c(r[2])} | ${pct1(r[1].granted)} | ${pct1(r[2].granted)} |`);
  }
  res.fairness = fair;
  out.protection = res;
}

function reportCollection() {
  log();
  log(`## E. 主線後回訪補齊收藏（持續在線，runs=${CFG.runs}；寶物倍率 ×${CFG.revisitTreasureMult}）`);
  const rs = Array.from({ length: CFG.runs }, (_, i) => runCollection(seedOf(i)));
  const needSets = rs.filter((r) => r.setsMissingAtStart > 0);
  const needCodex = rs.filter((r) => r.codexMissingAtStart > 0);
  log();
  log(`主線結束時：${pct(needSets.length / rs.length)} 的玩家還缺至少 1 套套組；${pct(needCodex.length / rs.length)} 的玩家圖鑑未滿 12 件。`);
  log();
  log(...HEAD);
  log(row("補齊三套套組（挖掘小時，僅需補的玩家）", summary(needSets.map((r) => r.setsDone))));
  log(row("補齊 12 件圖鑑（挖掘小時，僅需補的玩家）", summary(needCodex.map((r) => r.codexDone))));
  log(row("回訪期間總收入 /h（不扣支出）", summary(rs.filter((r) => r.codexMissingAtStart > 0).map((r) => r.coinsPerHour)), f0));
  out.collection = { needSets: needSets.length / rs.length, needCodex: needCodex.length / rs.length, sets: summary(needSets.map((r) => r.setsDone)), codex: summary(needCodex.map((r) => r.codexDone)), coinsPerHour: summary(rs.filter((r) => r.codexMissingAtStart > 0).map((r) => r.coinsPerHour)) };
}

function reportStress() {
  log();
  log(`## F. 防卡死：金幣 0、背包全空、寶物全賣（持續在線，runs=${Math.min(CFG.runs, 500)}）`);
  log();
  log("| 情境 | 重挖 | 恢復時間 平均 | P50 | P90 | P99 | 平均重挖小時 | 平均回訪小時 | 卡死比例 |");
  log("|---|---|---:|---:|---:|---:|---:|---:|---:|");
  const res: Record<string, unknown> = {};
  const variants: [string, Partial<Config>][] = [["重挖 ×0.5", { rework: true }], ["重挖 ×1.0", { rework: true, reworkCoinMult: 1 }], ["無重挖", { rework: false }]];
  for (const sc of STRESS) for (const [vname, patch] of variants) {
    const rs = withCfg(patch, () => Array.from({ length: Math.min(CFG.runs, 500) }, (_, i) => runStress(seedOf(i), sc)));
    const s = summary(rs.map((r) => r.hours));
    const stuck = rs.filter((r) => !Number.isFinite(r.hours)).length / rs.length;
    res[`${sc.id}_${vname}`] = { s, stuck };
    const avg = (k: "rework" | "revisit") => rs.reduce((a, r) => a + r[k], 0) / rs.length;
    log(`| ${sc.id} ${sc.label} | ${vname} | ${f1(s.mean)} | ${f1(s.p50)} | ${f1(s.p90)} | ${f1(s.p99)} | ${f1(avg("rework"))} | ${f1(avg("revisit"))} | ${pct(stuck)} |`);
  }
  out.stress = res;
}

function reportCompare() {
  log();
  log(`## G. D12 / D13 / D14 / D16 套用前後（runs=${CFG.runs}）`);
  log();
  log("前 = 每區固定金幣、回訪金幣 ×1、回訪寶物 ×1、無重挖。後 = GBS v1.2 預設。兩者都沒有首次保護。");
  const variants: [string, Partial<Config>][] = [
    ["前", { flatCoins: true, revisitCoinMult: 1, revisitTreasureMult: 1, rework: false, protectHours: null }],
    ["後", { protectHours: null }],
  ];
  const res: Record<string, Record<string, ProfileStats>> = {};
  for (const [name, patch] of variants) {
    res[name] = {};
    for (const prof of PROFILES) res[name][prof.id] = withCfg(patch, () => simulateProfile(prof, CFG.runs));
  }
  log();
  log("| 指標 | 前 | 後 |");
  log("|---|---:|---:|");
  const cmp = (label: string, f: (r: Record<string, ProfileStats>) => string) => log(`| ${label} | ${f(res["前"])} | ${f(res["後"])} |`);
  for (let z = 0; z < 3; z++) cmp(`持續在線 ${ZONES[z].id} 小時`, (r) => f1(r.continuous.zoneH[z].mean));
  cmp("持續在線 主線小時", (r) => f1(r.continuous.total.mean));
  for (const prof of PROFILES.slice(1)) cmp(`${prof.label} 天數`, (r) => f1(r[prof.id].total.mean / 24));
  for (let t = 0; t < 4; t++) cmp(`購買 ${PICKAXES[t + 1].id} 深度（m）`, (r) => f0(r.continuous.buyDepth[t].mean));
  for (let z = 0; z < 3; z++) cmp(`${ZONES[z].id} 收入`, (r) => f0(r.continuous.zoneCoins[z].mean));
  cmp("主線寶物數", (r) => f1(r.continuous.treasures.mean));
  cmp("離開 zone1 集滿套組", (r) => pct(r.continuous.setExit[0]));
  cmp("一般玩家 卡關閒置小時", (r) => f1(r.normal.waste.mean));
  cmp("重度玩家 回訪 + 重挖小時", (r) => f1(r.heavy.revisit.mean + r.heavy.rework.mean));
  out.compare = res;
}

function main() {
  log(`# 平衡模擬結果（seed=${CFG.seed}；${cfgLabel()}）`);
  log();
  const only = CFG.only;
  const run = (k: string, fn: () => void) => { if (!only || only === k) fn(); };
  run("profiles", reportProfiles);
  run("revisit", reportRevisit);
  run("speed", reportSpeed);
  run("protection", reportProtection);
  run("collection", reportCollection);
  run("stress", reportStress);
  run("compare", reportCompare);
  console.log(lines.join("\n"));
  if (CFG.json) process.getBuiltinModule("node:fs").writeFileSync(CFG.json, JSON.stringify({ config: CFG, ...out }, (_, v) => (v === Infinity ? "Infinity" : v), 1));
}

main();
