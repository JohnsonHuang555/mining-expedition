/**
 * 《挖礦探險隊》平衡模擬 — 開發輔助工具（不是遊戲實作）
 *
 * 用 GBS v1.3 的規則與數值模擬「參考玩家」從 0m 挖到 300m，驗證 GBS §18。
 * 資料來自 `@mining/game-data`；玩家狀態是正式的 `PlayerGameState`，時間推進用引擎的 `settle`、
 * 所有玩家操作用 `applyAction`，與正式結算是同一份程式碼。
 * 本檔只保留參考玩家策略、登入排程、Monte Carlo 與報表（與正式遊戲的差異見 GBS §23.2）。
 *
 * 執行（Node 22.18+ 可直接執行 TypeScript；需要先 `pnpm install` 建立 workspace 連結）：
 *   pnpm sim                                           # = node scripts/balance-sim.ts
 *   node scripts/balance-sim.ts                        # 全部報表（v1.3 預設方案）
 *   node scripts/balance-sim.ts --only protection      # 首次寶物保護 A / B / C 比較
 *   node scripts/balance-sim.ts --only stress          # 防卡死：全部出售後的恢復時間
 *   node scripts/balance-sim.ts --only compare         # D12–D16 套用前後比較
 *   node scripts/balance-sim.ts --only collection      # 主線後回訪補齊收藏
 *
 * 方案參數（預設值 = GBS v1.3；非預設值只用於比較方案，經由引擎的 DropRules 傳入）：
 *   --runs 1000              Monte Carlo 次數（玩家類型）
 *   --prot-runs 4000         首次保護比較的次數（P99 需要較多樣本）
 *   --seed 1                 第 i 次模擬的種子 = seed × 100003 + i（各方案共用同一組種子）；
 *                            該次模擬的 rngSecret = SHA-256("balance-sim:" + 種子)
 *   --protect 4              D17 / D18 首次保護觸發的有效挖掘小時（預設 4）；none = 方案 A
 *   --revisit-coin-mult 0.5  D12
 *   --revisit-treasure-mult 0.5  D14（MVP 暫定）
 *   --rework-coin-mult 0.5   D16 重挖的金幣倍率（暫定，與回訪相同）
 *   --rework-treasure-mult 0.5   D16 重挖的寶物倍率（暫定，與回訪相同）
 *   --flat-coins             使用 D13 之前的每區固定金幣
 *   --no-rework              停用 D16 重挖
 *   --policy keep|sellDupes  寶物全部保留 / 出售重複 Epic
 *   --json out.json          另存原始結果
 */

// 1. 共用資料與引擎（packages/game-data、packages/game-engine）
// ============================================================================
//
// 遊戲規則與狀態轉換（結算、離線報告、首次保護、所有玩家操作）全部來自共用引擎；
// 本檔只保留：參考玩家策略、登入排程、Monte Carlo 與報表。

import * as GD from "@mining/game-data";
import {
  DEFAULT_DROP_RULES,
  type DropRules,
  type FirstTreasureStatus,
  type GameAction,
  type HeldArtifacts,
  type MiningSpot,
  type PlayerGameState,
  type RandomSource,
  type SettleOptions,
  type SettleSummary,
  type Stats as EngineStats,
  applyAction,
  assertValidState,
  blockWork,
  computeStats,
  createBlockRng,
  createInitialState,
  currentStats,
  expectedBlock,
  frontierBlock,
  frontierSpot,
  heldCounts,
  miningPosition,
  requiredPower10OfBand,
  revisitSpot,
  revisitableZones,
  reworkBand,
  reworkSpot,
  settle,
  sha256,
  spotBlockMs,
  workRate,
  zoneOfBand as engineZoneOfBand,
} from "@mining/game-engine";

// ============================================================================
// 2. 遊戲資料的檢視（只轉換格式，數值全部來自 @mining/game-data）
// ============================================================================

const BLOCKS_PER_ZONE = GD.BLOCKS_PER_ZONE;
const TOTAL_BLOCKS = GD.TOTAL_BLOCKS;

interface Pickaxe { id: string; key: GD.PickaxeId; coins: number; mats: Record<string, number> }

/** GBS §10。報表沿用舊的短名稱（wood / stone / …） */
const PICKAXES: Pickaxe[] = GD.PICKAXES.map((p) => ({
  id: p.id.replace("pick_", ""),
  key: p.id,
  coins: p.purchase?.coins ?? 0,
  mats: { ...(p.purchase?.items ?? {}) } as Record<string, number>,
}));

function upgradeCost(tier: number, toLevel: number): { coins: number; mats: Record<string, number> } {
  const c = GD.PICKAXES[tier as 0 | 1 | 2 | 3 | 4].upgrades[toLevel - 2];
  return { coins: c.coins, mats: { ...c.items } as Record<string, number> };
}

/** GBS §8.1 */
const PRICE: Record<string, number> = Object.fromEntries(Object.values(GD.MINERALS).map((m) => [m.id, m.sellPrice]));

/** GBS §8.2 */
const RECIPES: Record<string, Record<string, number>> = Object.fromEntries(
  Object.values(GD.MATERIALS).map((m) => [m.id, { ...m.recipe } as Record<string, number>]),
);

interface Zone { id: string; unlockFee: number; epics: string[]; legendary: string; epicValue: number }

const ZONES: Zone[] = GD.ZONES.map((z) => ({
  id: z.id,
  unlockFee: z.unlockFee,
  epics: [...z.epics],
  legendary: z.legendary,
  epicValue: GD.ARTIFACTS[z.epics[0]].baseValue,
}));

const LEGENDARY_IDS = new Set(ZONES.map((z) => z.legendary));
const ALL_ARTIFACTS = ZONES.flatMap((z) => [...z.epics, z.legendary]);
/** D13 之前每區固定的金幣平均（僅供 --flat-coins 比較；依門檻段展開） */
const FLAT_COIN_AVG_BY_SEGMENT = [20, 20, 220, 220, 1_250, 1_250];

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
  };
}

let CFG: Config = parseArgs(process.argv.slice(2));

function withCfg<T>(patch: Partial<Config>, fn: () => T): T {
  const saved = CFG;
  CFG = { ...CFG, ...patch };
  try { return fn(); } finally { CFG = saved; }
}

// ============================================================================
// 4. 玩家：正式的 PlayerGameState + 模擬器自己的統計
// ============================================================================
//
// 遊戲狀態只由引擎改變：時間推進用 settle()，玩家操作用 applyAction()。
// 下面的 coins / inv / tier / … 是從 gs 同步出來的唯讀檢視，供參考玩家策略讀取。

interface Player {
  gs: PlayerGameState;
  rng: (digCounter: number) => RandomSource;
  // ---- gs 的檢視（sync() 更新）----
  t: number;                 // 日曆秒數 = gs.lastSettledAt / 1000
  coins: number;
  inv: Record<string, number>;
  tier: number;              // 擁有的最高階十字鎬（購買後自動裝備，策略不會換回舊的）
  levels: number[];
  unlocked: number;
  frontier: number;          // 下一個前線方塊
  mode: Mode;
  revisitZone: number;
  reworkBand: number;
  held: Record<string, number>;
  first: FirstTreasureStatus;
  // ---- 策略 ----
  collectTarget: number;     // 主線後補收藏的目標礦區（-1 = 無）
  // ---- 統計 ----
  miningSec: number;         // 實際挖掘秒數（所有模式，含未完成方塊）
  found: Record<string, number>;
  firstMining: number;       // 第一件寶物時的挖掘秒數
  firstCal: number;          // 第一件寶物時的日曆秒數
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

const utf8 = new TextEncoder();

/** 每次模擬的 rngSecret = SHA-256("balance-sim:" + seed)；同 seed → 同結果 */
function newPlayer(seed: number): Player {
  const p = {
    gs: createInitialState(`sim-${seed}`, 0),
    rng: createBlockRng(sha256(utf8.encode(`balance-sim:${seed}`))),
    collectTarget: -1,
    miningSec: 0, found: {}, firstMining: Infinity, firstCal: Infinity,
    zoneDoneAt: [], zoneDoneMining: [], zoneCoins: [0, 0, 0], grossCoins: 0, setDoneAtExit: [], treasureAtZone1Exit: false,
    zoneEpics: [0, 0, 0], zoneLegs: [0, 0, 0], normalTreasures: 0, legendaries: 0, treasureTimes: [], buy: [],
    modeSec: { frontier: 0, revisit: 0, rework: 0 }, blockedWasteSec: 0, events: [],
  } as unknown as Player;
  sync(p);
  return p;
}

function sync(p: Player): void {
  const gs = p.gs;
  const m = gs.mining;
  p.t = gs.lastSettledAt / 1000;
  p.coins = gs.coins;
  p.inv = gs.inventory as Record<string, number>;
  p.tier = GD.PICKAXE_IDS.filter((id) => gs.pickaxes[id] !== undefined).length - 1;
  p.levels = GD.PICKAXE_IDS.map((id) => gs.pickaxes[id] ?? 1);
  p.unlocked = gs.unlockedZone;
  p.frontier = m.frontierBlockIndex;
  p.mode = m.mode;
  p.revisitZone = m.revisitZone ?? 0;
  p.reworkBand = m.reworkBand ?? 0;
  p.held = heldCounts(gs) as Record<string, number>;
  p.first = gs.firstTreasure.status;
}

function add(rec: Record<string, number>, k: string, n: number) {
  rec[k] = (rec[k] ?? 0) + n;
}

type ZoneIndex = 0 | 1 | 2;
type Stats = EngineStats;

/** GBS §3（引擎 computeStats：定點數、套組需實際持有） */
function stats(p: Player, tier = p.tier, level = p.levels[tier]): Stats {
  return computeStats(PICKAXES[tier].key, level, p.held as HeldArtifacts);
}

const zoneOfBand = (b: number): ZoneIndex => engineZoneOfBand(b);
const reqAt = (b: number) => requiredPower10OfBand(b);

/** 一個挖掘位置：前線 / 回訪（礦區最深帶）/ 重挖（指定深度帶） */
interface Spot { band: number; mode: Mode }

function engineSpot(spot: Spot): MiningSpot {
  const base =
    spot.mode === "frontier" ? frontierSpot(spot.band * 100)
    : spot.mode === "revisit" ? revisitSpot(zoneOfBand(spot.band))
    : reworkSpot(spot.band);
  if (base.band !== spot.band) throw new Error(`spot mismatch: ${JSON.stringify(spot)}`);
  return base;
}

const toPpm = (x: number) => Math.round(x * 1_000_000);

/** 方案參數 → 引擎的 DropRules（預設值 = GBS v1.3 = DEFAULT_DROP_RULES）。依 CFG 快取 */
let rulesCache: { cfg: Config; rules: DropRules; id: number } | null = null;
let rulesId = 0;
function dropRules(): DropRules {
  if (rulesCache?.cfg === CFG) return rulesCache.rules;
  const rules: DropRules = {
    coinModeMultiplierPpm: { frontier: 1_000_000, revisit: toPpm(CFG.revisitCoinMult), rework: toPpm(CFG.reworkCoinMult) },
    treasureModeMultiplierPpm: { frontier: 1_000_000, revisit: toPpm(CFG.revisitTreasureMult), rework: toPpm(CFG.reworkTreasureMult) },
    ...(CFG.flatCoins ? { coinAvgBySegment: FLAT_COIN_AVG_BY_SEGMENT } : {}),
  };
  const resolved = JSON.stringify(rules) === JSON.stringify(DEFAULT_DROP_RULES) ? DEFAULT_DROP_RULES : rules;
  rulesCache = { cfg: CFG, rules: resolved, id: ++rulesId };
  return resolved;
}

/** 方案參數 → settle 的選項（正式結算一律不傳；這裡只為了比較方案） */
function settleOptions(): SettleOptions {
  const rules = dropRules();
  return {
    ...(rules === DEFAULT_DROP_RULES ? {} : { dropRules: rules }),
    ...(CFG.protectHours === 4 ? {} : { firstTreasureProtectMs: CFG.protectHours === null ? null : Math.round(CFG.protectHours * 3_600_000) }),
    recordBlocks: true,
  };
}

// ---------- 期望值（引擎 expectedBlock；只供參考玩家做決策與報表） ----------

interface Rates { sec: number; blocksPerHour: number; oresPerHour: number; raresPerHour: number; coinsPerHour: number; treasuresPerHour: number; legendaryPerHour: number; valuePerHour: number; itemsPerHour: Record<string, number> }

/** 決策時常查詢；結果只取決於位置、數值與方案，依此快取 */
const ratesCache = new Map<string, Rates>();
function expectedRates(spot: Spot, s: Stats): Rates {
  const key = `${spot.band}|${spot.mode}|${s.power10}|${s.speed1000}|${s.luckPpm}|${(dropRules(), rulesCache!.id)}`;
  let r = ratesCache.get(key);
  if (!r) { r = computeRates(spot, s); ratesCache.set(key, r); }
  return r;
}

function computeRates(spot: Spot, s: Stats): Rates {
  const es = engineSpot(spot);
  const ms = spotBlockMs(es, s);
  const e = expectedBlock(es, ms, s.luckPpm, dropRules());
  const bph = 3_600_000 / ms;
  const items: Record<string, number> = {};
  for (const [k, n] of Object.entries(e.items)) add(items, k, n * bph);
  let value = e.coins * bph;
  for (const [k, n] of Object.entries(items)) value += n * PRICE[k];
  return {
    sec: ms / 1000, blocksPerHour: bph, oresPerHour: e.ores * bph, raresPerHour: e.rares * bph, coinsPerHour: e.coins * bph,
    treasuresPerHour: e.treasures * bph, legendaryPerHour: e.legendaries * bph, valuePerHour: value, itemsPerHour: items,
  };
}

// ---------- 引擎呼叫 ----------

/** 以 Base Value 出售寶物（模擬器不模擬每日市場，GBS §23.2） */
const BASE_MARKET = Object.fromEntries(GD.ARTIFACT_IDS.map((id) => [id, 1_000_000])) as Partial<Record<GD.ArtifactId, number>>;

/** 套用一個玩家操作；策略只送出合法的操作，失敗代表模擬器或引擎有錯 */
function act(p: Player, action: GameAction): void {
  const r = applyAction(p.gs, action, { marketMultiplierPpm: BASE_MARKET });
  if (!r.ok) throw new Error(`sim action ${JSON.stringify(action)} failed: ${r.error.code} ${r.error.message}`);
  for (const e of r.events) {
    if (e.type === "items_sold" || e.type === "artifacts_sold") gain(p, e.coins);
    if (e.type === "report_claimed") gain(p, e.coins);
  }
  p.gs = r.state;
  sync(p);
}

function gain(p: Player, coins: number, frontier = p.gs.mining.frontierBlockIndex) {
  p.grossCoins += coins;
  if (frontier < TOTAL_BLOCKS) p.zoneCoins[Math.floor(frontier / 1000)] += coins;
}

/** 結算到 targetMs（引擎依經過時間決定在線 / 離線），並由方塊紀錄更新統計 */
function settleTo(p: Player, targetMs: number): SettleSummary {
  const before = p.gs;
  const r = settle(before, { serverNow: targetMs, rng: p.rng, options: settleOptions() });
  if (!r.ok) throw new Error(`sim settle failed: ${r.error.code} ${r.error.message}`);
  const online = r.summary.kind !== "offline";
  const miningBase = p.miningSec;
  const pendingArtifacts: string[] = [];
  for (const b of r.blocks) {
    const miningAt = miningBase + b.minedMsInSettle / 1000;
    const at = b.completedAt / 1000;
    const got = b.artifact ?? b.protection;
    if (got && p.firstMining === Infinity) { p.firstMining = miningAt; p.firstCal = at; }
    if (b.artifact) {
      p.normalTreasures++;
      if (LEGENDARY_IDS.has(b.artifact)) { p.legendaries++; p.zoneLegs[b.zone]++; } else p.zoneEpics[b.zone]++;
      p.treasureTimes.push(miningAt);
    }
    if (b.protection) { p.zoneEpics[0]++; p.treasureTimes.push(miningAt); }
    if (got) {
      if (!(got in p.found)) p.found[got] = at;
      if (!online) pendingArtifacts.push(got);
    }
    // 在線：方塊完成即入帳；收入計入挖這個方塊時的前線礦區
    if (online && b.coins) gain(p, b.coins, b.frontierBlockIndex ?? before.mining.frontierBlockIndex);
    if (b.frontierBlockIndex !== null && (b.frontierBlockIndex + 1) % 1000 === 0) {
      const zz = (b.frontierBlockIndex + 1) / 1000 - 1;
      p.zoneDoneAt[zz] = at; p.zoneDoneMining[zz] = miningAt;
      const held = online ? heldCounts(r.state) : heldCounts(before);
      p.setDoneAtExit[zz] = ZONES[zz].epics.every((id) => (held[id as GD.ArtifactId] ?? 0) + pendingArtifacts.filter((a) => a === id).length > 0);
      if (zz === 0) p.treasureAtZone1Exit = p.firstMining <= miningAt;
    }
  }
  p.miningSec = miningBase + r.summary.minedMs / 1000;
  p.modeSec[before.mining.mode] += r.summary.minedMs / 1000;
  // 卡關閒置只計 Power 不足 / 未解鎖；主線完成後的時間不算
  if (r.summary.stopReason === "blocked_power" || r.summary.stopReason === "blocked_unlock") p.blockedWasteSec += r.summary.idleMs / 1000;
  p.gs = r.state;
  sync(p);
  return r.summary;
}

function claimPending(p: Player): void {
  const r = p.gs.pendingOfflineReport;
  if (r) act(p, { type: "claim_report", reportId: r.reportId });
}

// ============================================================================
// 5. 參考玩家策略
// ============================================================================

/** 檢查能否湊齊成本（不足的製作素材以配方原料補足）；回傳扣除後的背包或 null */
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

/** 參考玩家在購買 / 強化前手動製作不足的素材（引擎不會自動製作，P22） */
function craftShortfall(p: Player, mats: Record<string, number>): void {
  for (const [item, n] of Object.entries(mats)) {
    const short = Math.max(0, n - (p.inv[item] ?? 0));
    if (short > 0) act(p, { type: "craft", materialId: item as GD.MaterialId, times: short });
  }
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

function sellExcess(p: Player) {
  for (const item of Object.keys(p.inv)) {
    if (!(item in PRICE) || NEVER_SELL.has(item)) continue;
    const excess = (p.inv[item] ?? 0) - (KEEP[item] ?? 0);
    if (excess > 0) act(p, { type: "sell_items", itemId: item as GD.MineralId, quantity: excess });
  }
  if (CFG.policy === "sellDupes") {
    const extra: string[] = [];
    for (const z of ZONES) for (const id of z.epics) {
      extra.push(...p.gs.heldArtifacts.filter((a) => a.artifactId === id).slice(1).map((a) => a.instanceId));
    }
    if (extra.length > 0) act(p, { type: "sell_artifacts", instanceIds: extra });
  }
}

/** GBS §4.2、§12（引擎 frontierBlock）。主線完成不算卡關 */
function frontierBlocked(p: Player): "power" | "unlock" | null {
  const b = frontierBlock(p.frontier, p.unlocked as ZoneIndex, stats(p).power10);
  return b === "power" ? "power" : b === "locked" ? "unlock" : null;
}

/** 解除目前卡關所需要的金幣與素材 */
function goalFor(p: Player, blocked: "power" | "unlock"): { coins: number; mats: Record<string, number> } {
  if (blocked === "unlock") return { coins: ZONES[Math.floor(p.frontier / 1000)].unlockFee, mats: {} };
  const req = reqAt(Math.floor(p.frontier / 100));
  if (stats(p, p.tier, 5).power10 >= req && p.levels[p.tier] < 5) return upgradeCost(p.tier, p.levels[p.tier] + 1);
  const nx = PICKAXES[p.tier + 1];
  return { coins: nx.coins, mats: nx.mats };
}

/** GBS §2.3（D15、§2.3.1）：引擎 revisitableZones */
function revisitAllowed(p: Player, z: number): boolean {
  return revisitableZones(p.frontier, p.unlocked as ZoneIndex).includes(z as ZoneIndex);
}

/** GBS §2.4（D16，引擎 reworkBand）：重挖目標 = 目前裝備能挖的最深已探索深度帶。前線未卡關時不可用 */
function reworkBandFor(p: Player): number {
  if (!CFG.rework) return -1;
  return reworkBand(p.frontier, p.unlocked as ZoneIndex, stats(p).power10) ?? -1;
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

/** 切換模式（引擎 select_mining_mode；重挖深度帶由引擎計算；切換時進度歸零 P3） */
function switchMode(p: Player, mode: Mode, zone: number) {
  if (p.mode === mode && (mode !== "revisit" || p.revisitZone === zone)) return;
  if (mode === "revisit") act(p, { type: "select_mining_mode", mode, zone: zone as ZoneIndex });
  else act(p, { type: "select_mining_mode", mode });
}

/** 玩家在線時的決策（所有變更都經由引擎的 Actions） */
function decide(p: Player) {
  sellExcess(p);
  for (let guard = 0; guard < 20; guard++) {
    const z = Math.floor(p.frontier / 1000);
    if (p.frontier < TOTAL_BLOCKS && z > p.unlocked && p.coins >= ZONES[z].unlockFee) {
      act(p, { type: "unlock_zone", zone: z as ZoneIndex });
      p.events.push(`${(p.t / 3600).toFixed(1)}h unlock ${ZONES[z].id}`);
      continue;
    }
    if (p.tier < 4) {
      const nx = PICKAXES[p.tier + 1];
      if (tryConsume(p.inv, nx.mats) && p.coins >= nx.coins) {
        craftShortfall(p, nx.mats);
        act(p, { type: "purchase_pickaxe", pickaxeId: nx.key });
        p.buy.push({ tier: p.tier, t: p.t, depth: p.frontier / 10 });
        p.events.push(`${(p.t / 3600).toFixed(1)}h @${p.frontier / 10}m buy ${nx.id}`);
        continue;
      }
    }
    const lv = p.levels[p.tier];
    if (lv < 5) {
      const cost = upgradeCost(p.tier, lv + 1);
      const blocked = frontierBlocked(p);
      const upgradeUnblocks = blocked === "power" && stats(p, p.tier, 5).power10 >= reqAt(Math.floor(p.frontier / 100));
      let reserve = 0;
      if (!upgradeUnblocks) {
        if (p.tier < 4) {
          const s5 = stats(p, p.tier, 5);
          for (let seg = Math.floor(p.frontier / 500); seg < 6; seg++) {
            if (GD.SEGMENT_REQUIRED_POWER10[seg] > s5.power10) {
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
      if (tryConsume(p.inv, cost.mats) && p.coins - cost.coins >= reserve) {
        craftShortfall(p, cost.mats);
        act(p, { type: "upgrade_pickaxe", pickaxeId: PICKAXES[p.tier].key });
        p.events.push(`${(p.t / 3600).toFixed(1)}h @${p.frontier / 10}m upgrade ${PICKAXES[p.tier].id} Lv${lv + 1}`);
        continue;
      }
    }
    break;
  }
  // 選擇挖掘位置
  if (p.collectTarget >= 0) { switchMode(p, "revisit", p.collectTarget); return; }
  const blocked = frontierBlocked(p);
  if (!blocked) { switchMode(p, "frontier", 0); return; }
  const r = chooseRecovery(p, blocked);
  if (!r) switchMode(p, "frontier", 0); // 沒有任何材料來源：真正卡死
  else switchMode(p, r.mode, r.zone);
}

// ============================================================================
// 6. 時間推進（引擎 settle）
// ============================================================================
//
// 在線：每次結算到「下一個方塊完成」或 300 秒（取較早者），之後由參考玩家決策，
//       與正式 Client 定期呼叫結算（≤ 300 秒，P28）相同。
// 離線：下次登入時一次結算（> 300 秒 → 離線報告，最多 12 小時），接著領取報告。

const ONLINE_STEP_MS = GD.ONLINE_GAP_MS;

/** 在線閒置（卡關）：以 ≤ 300 秒的在線結算推進到 endMs，不產生任何產出 */
function idleOnline(p: Player, endMs: number) {
  while (p.gs.lastSettledAt < endMs) settleTo(p, Math.min(endMs, p.gs.lastSettledAt + ONLINE_STEP_MS));
}

/** 在線到 tEnd（秒）；主線完成時回傳 true */
function playOnline(p: Player, tEnd: number): boolean {
  const endMs = Math.round(tEnd * 1000);
  while (p.gs.lastSettledAt < endMs) {
    if (p.mode === "frontier" && p.frontier >= TOTAL_BLOCKS) return true;
    if (p.mode === "frontier" && frontierBlocked(p)) {
      decide(p);
      if (p.mode === "frontier") { idleOnline(p, endMs); return false; }
      continue;
    }
    if (p.mode !== "frontier" && p.collectTarget < 0 && !frontierBlocked(p)) { decide(p); continue; }
    const pos = miningPosition(p.gs);
    if (!pos.spot) { idleOnline(p, endMs); return false; } // 回訪 / 重挖位置 Power 不足
    const st = currentStats(p.gs);
    const needMs = Math.ceil((blockWork(pos.spot.hardness) - p.gs.mining.blockWork) / workRate(st));
    const now = p.gs.lastSettledAt;
    const summary = settleTo(p, Math.min(endMs, now + Math.min(needMs, ONLINE_STEP_MS)));
    if (summary.blocksMined > 0) decide(p);
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
  const p = newPlayer(seed);
  decide(p);
  if (profile.logins.length === 0) { playOnline(p, 400 * 3600); return p; }
  const loginsAbs: number[] = [];
  for (let day = 0; day < 60; day++) for (const h of profile.logins) loginsAbs.push((day * 24 + h - profile.logins[0]) * 3600);
  for (let i = 0; i < loginsAbs.length - 1; i++) {
    // 登入：結算離線期間（引擎套用 12 小時上限，其餘捨棄），領取報告後決策
    if (p.gs.lastSettledAt < loginsAbs[i] * 1000) settleTo(p, loginsAbs[i] * 1000);
    claimPending(p);
    if (p.frontier >= TOTAL_BLOCKS) return p;
    decide(p);
    if (playOnline(p, loginsAbs[i] + profile.sessionMin * 60)) return p;
  }
  return p;
}

/** 主線完成後，持續在線回訪補齊收藏（D14）。回傳補齊時間（挖掘小時，從主線完成起算） */
function runCollection(seed: number) {
  const p = newPlayer(seed);
  decide(p);
  playOnline(p, 400 * 3600);
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
    playOnline(p, p.t + 3600);
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
  const p = newPlayer(seed);
  const gs = p.gs;
  for (let t = 0; t <= sc.tier; t++) gs.pickaxes[PICKAXES[t].key] = 1;
  gs.equippedPickaxe = PICKAXES[sc.tier].key;
  gs.unlockedZone = sc.unlocked as ZoneIndex;
  gs.mining.frontierBlockIndex = sc.frontier;
  gs.mining.digCounter = sc.frontier;
  gs.firstTreasure = { status: "obtained", effectiveMiningMs: 0, resolvedAt: 0, artifactInstanceId: "stress", reportId: null };
  assertValidState(gs);
  sync(p);
  decide(p);
  const cap = 500 * 3600;
  while (p.t < cap && p.frontier <= sc.frontier) playOnline(p, p.t + 600);
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
  return `protect=${CFG.protectHours ?? "none"}, revisitCoin×${CFG.revisitCoinMult}, revisitTreasure×${CFG.revisitTreasureMult}, reworkCoin×${CFG.reworkCoinMult}, reworkTreasure×${CFG.reworkTreasureMult}, coins=${CFG.flatCoins ? "flat" : "bySegment"}, rework=${CFG.rework ? "on" : "off"}, policy=${CFG.policy}`;
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
  const dummy = newPlayer(0);
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
  const dummy = newPlayer(0);
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
