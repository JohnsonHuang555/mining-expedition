/**
 * 玩家遊戲狀態（TECHNICAL_SPEC §8.1）。
 *
 * - 只有可序列化的純資料：數字、字串、null、陣列、純物件。沒有 Date / Map / Set / class。
 * - 時間一律是伺服器時間的毫秒整數（Postgres now()），所有數量都是 safe integer。
 * - 不含 rngSecret：密鑰由伺服器在結算時以 RandomSource 工廠注入（§6.2、§8.3），所以這個狀態可以原樣回傳給玩家。
 * - 與資料表結構解耦：Supabase Integration 階段負責「資料列 ⇄ PlayerGameState」的轉換。
 */

import {
  ARTIFACTS,
  ARTIFACT_IDS,
  type ArtifactId,
  DATA_VERSION,
  type ItemId,
  MATERIAL_IDS,
  MAX_PICKAXE_LEVEL,
  MINERAL_IDS,
  MINING_MODES,
  type MiningMode,
  PICKAXE_IDS,
  type PickaxeId,
  type PickaxeLevel,
  RNG_VERSION,
  TOTAL_BLOCKS,
} from "@mining/game-data";
import { canMine } from "./fixed.ts";
import {
  type FrontierBlock,
  type MiningSpot,
  type ZoneIndex,
  bandOfBlock,
  blockWork,
  frontierBlock,
  frontierSpot,
  revisitSpot,
  revisitableZones,
  reworkBand,
  reworkSpot,
} from "./mining.ts";
import type { FirstTreasureStatus } from "./protection.ts";
import { type HeldArtifacts, type Stats, computeStats } from "./stats.ts";

/** 狀態格式版本（欄位改變時加 1；與 DATA_VERSION / RNG_VERSION 無關） */
export const STATE_SCHEMA_VERSION = 1;

export type Inventory = Partial<Record<ItemId, number>>;

export type ArtifactSource = "drop" | "first_treasure_protection";

/** 一件持有中的寶物（TECHNICAL_SPEC §8.1 ArtifactInstance） */
export interface ArtifactInstance {
  /** 每位玩家唯一；由方塊序號決定（`d<digCounter>`），重算同一個方塊會得到同一個 ID */
  instanceId: string;
  artifactId: ArtifactId;
  /** 方塊完成的伺服器時間 */
  obtainedAt: number;
  mode: MiningMode;
  /** 取得位置的深度帶（0–29）；前線另記 blockIndex */
  band: number;
  frontierBlockIndex: number | null;
  digCounter: number;
  source: ArtifactSource;
}

/** 圖鑑（GBS §9：永久保留，出售不影響） */
export interface DiscoveryRecord {
  firstDiscoveredAt: number;
  firstBand: number;
  totalFound: number;
}

export interface FirstTreasureState {
  status: FirstTreasureStatus;
  /** 只累積已完成方塊的挖掘毫秒（GBS §7.7） */
  effectiveMiningMs: number;
  /** 離開 pending 的伺服器時間 */
  resolvedAt: number | null;
  /** 第一件寶物（自然或保護）的實例 ID */
  artifactInstanceId: string | null;
  /** 第一件寶物在離線報告中時的報告 ID（在線取得為 null）；用來檢查「狀態已更新但獎勵未領取」的一致性 */
  reportId: string | null;
}

export type StopReason =
  | "none" //               時間用完，仍在挖掘
  | "offline_cap" //        離線超過 12 小時，其餘時間捨棄
  | "blocked_power" //      前線 Power 不足，或回訪 / 重挖位置 Power 不足
  | "blocked_unlock" //     前線到礦區底部但未解鎖
  | "frontier_complete"; // 主線完成

export interface ReportArtifact extends ArtifactInstance {
  /** 領取前尚未在圖鑑中（也不在同一份報告更早的位置）：NEW DISCOVERY 標記 */
  isNewDiscovery: boolean;
}

/** 離線報告（GBS §15、TECHNICAL_SPEC §10.5）。內容在產生時就已確定，領取只做加法 */
export interface OfflineReport {
  /** 每位玩家唯一：`r<periodStart>`（lastSettledAt 只會遞增） */
  reportId: string;
  periodStart: number;
  periodEnd: number;
  /** 實際模擬的時間 = min(經過時間, 12 小時) */
  simulatedMs: number;
  /** 超過 12 小時而捨棄的時間（D9） */
  discardedMs: number;
  /** 有在挖掘的時間（含未完成方塊）；其餘為卡關閒置 */
  minedMs: number;
  idleMs: number;
  blocksMined: number;
  mode: MiningMode;
  frontierFrom: number;
  frontierTo: number;
  digCounterFrom: number;
  digCounterTo: number;
  stopReason: StopReason;
  rewards: {
    coins: number;
    items: Inventory;
    artifacts: ReportArtifact[];
  };
  /** 首次寶物保護在這份報告期間是否發放（只能是本報告中的實例） */
  firstTreasureGranted: boolean;
}

export interface MiningState {
  mode: MiningMode;
  /** 回訪的礦區；只在 mode = revisit 時非 null */
  revisitZone: ZoneIndex | null;
  /** 重挖深度帶（伺服器計算，GBS §2.4）；只在 mode = rework 時非 null */
  reworkBand: number | null;
  /** 下一個前線方塊，0–3000；最大深度 = frontierBlockIndex / 10 */
  frontierBlockIndex: number;
  /** 已完成的方塊總數（所有模式共用，TECHNICAL_SPEC §6.2） */
  digCounter: number;
  /** 目前方塊已累積的工作量（P5） */
  blockWork: number;
  /** 目前方塊已花費的挖掘毫秒 */
  blockMs: number;
}

export interface PlayerGameState {
  schemaVersion: number;
  playerId: string;
  /** 樂觀鎖：每次成功提交加 1（TECHNICAL_SPEC §10.4） */
  stateVersion: number;
  dataVersion: number;
  rngVersion: number;
  createdAt: number;
  lastSettledAt: number;

  coins: number;
  equippedPickaxe: PickaxeId;
  /** 已擁有的十字鎬與等級（只會是依序的前綴：木 → 石 → …） */
  pickaxes: Partial<Record<PickaxeId, PickaxeLevel>>;
  /** 已解鎖的最深礦區（zone1 = 0 一開始就解鎖） */
  unlockedZone: ZoneIndex;

  mining: MiningState;

  /** 可堆疊物品（只存正數） */
  inventory: Inventory;
  heldArtifacts: ArtifactInstance[];
  discoveredArtifacts: Partial<Record<ArtifactId, DiscoveryRecord>>;

  firstTreasure: FirstTreasureState;
  pendingOfflineReport: OfflineReport | null;
  /** 最後一次領取的報告 ID：重複領取時回傳 REPORT_ALREADY_CLAIMED 而不是 NOT_FOUND */
  lastClaimedReportId: string | null;
}

// ---------------------------------------------------------------------------
// 建立
// ---------------------------------------------------------------------------

/** 初始角色（TECHNICAL_SPEC §10.2 character-create；D10：木製十字鎬 Lv1） */
export function createInitialState(playerId: string, serverNow: number): PlayerGameState {
  if (typeof playerId !== "string" || playerId.length === 0) throw new RangeError("playerId must be a non-empty string");
  if (!isNonNegInt(serverNow)) throw new RangeError("serverNow must be a non-negative safe integer");
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    playerId,
    stateVersion: 0,
    dataVersion: DATA_VERSION,
    rngVersion: RNG_VERSION,
    createdAt: serverNow,
    lastSettledAt: serverNow,
    coins: 0,
    equippedPickaxe: "pick_wood",
    pickaxes: { pick_wood: 1 },
    unlockedZone: 0,
    mining: { mode: "frontier", revisitZone: null, reworkBand: null, frontierBlockIndex: 0, digCounter: 0, blockWork: 0, blockMs: 0 },
    inventory: {},
    heldArtifacts: [],
    discoveredArtifacts: {},
    firstTreasure: { status: "pending", effectiveMiningMs: 0, resolvedAt: null, artifactInstanceId: null, reportId: null },
    pendingOfflineReport: null,
    lastClaimedReportId: null,
  };
}

/** 深拷貝（狀態只含 JSON 資料） */
export function cloneState(state: PlayerGameState): PlayerGameState {
  return structuredClone(state);
}

// ---------------------------------------------------------------------------
// 衍生值（不儲存）
// ---------------------------------------------------------------------------

/** 目前實際持有的寶物數量（套組判定，D3） */
export function heldCounts(state: PlayerGameState): HeldArtifacts {
  const counts: Partial<Record<ArtifactId, number>> = {};
  for (const a of state.heldArtifacts) counts[a.artifactId] = (counts[a.artifactId] ?? 0) + 1;
  return counts;
}

export function currentStats(state: PlayerGameState): Stats {
  const level = state.pickaxes[state.equippedPickaxe];
  if (level === undefined) throw new RangeError(`equipped pickaxe ${state.equippedPickaxe} is not owned`);
  return computeStats(state.equippedPickaxe, level, heldCounts(state));
}

export type MiningStatus = "mining" | Exclude<StopReason, "none" | "offline_cap">;

export interface MiningPosition {
  status: MiningStatus;
  /** status = mining 時的挖掘位置 */
  spot: MiningSpot | null;
}

/**
 * 目前模式下能不能挖、挖哪裡（GBS §2.2–§2.4、§4.2）。
 * 前線：frontierBlock；回訪 / 重挖：該位置的 RequiredPower。
 */
export function miningPosition(state: PlayerGameState, power10 = currentStats(state).power10): MiningPosition {
  const m = state.mining;
  if (m.mode === "frontier") {
    const blocked: FrontierBlock | null = frontierBlock(m.frontierBlockIndex, state.unlockedZone, power10);
    if (blocked === null) return { status: "mining", spot: frontierSpot(m.frontierBlockIndex) };
    return { status: blocked === "completed" ? "frontier_complete" : blocked === "locked" ? "blocked_unlock" : "blocked_power", spot: null };
  }
  const spot = m.mode === "revisit" ? revisitSpot(m.revisitZone!) : reworkSpot(m.reworkBand!);
  return canMine(power10, spot.requiredPower10) ? { status: "mining", spot } : { status: "blocked_power", spot: null };
}

// ---------------------------------------------------------------------------
// 驗證（從資料庫載入後、提交前都要執行）
// ---------------------------------------------------------------------------

function isNonNegInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/** 回傳所有違反的不變式；空陣列代表合法 */
export function validateState(state: PlayerGameState): string[] {
  const issues: string[] = [];
  const check = (ok: boolean, msg: string) => {
    if (!ok) issues.push(msg);
  };
  const int = (v: unknown, name: string) => check(isNonNegInt(v), `${name} must be a non-negative safe integer`);

  if (typeof state !== "object" || state === null) return ["state must be an object"];
  check(state.schemaVersion === STATE_SCHEMA_VERSION, `schemaVersion must be ${STATE_SCHEMA_VERSION}`);
  check(typeof state.playerId === "string" && state.playerId.length > 0, "playerId must be a non-empty string");
  int(state.stateVersion, "stateVersion");
  int(state.dataVersion, "dataVersion");
  int(state.rngVersion, "rngVersion");
  int(state.createdAt, "createdAt");
  int(state.lastSettledAt, "lastSettledAt");
  check(state.lastSettledAt >= state.createdAt, "lastSettledAt must be >= createdAt");
  int(state.coins, "coins");

  // 十字鎬：擁有的是依序前綴，等級 1–5，裝備中的已擁有
  const owned = PICKAXE_IDS.filter((id) => state.pickaxes?.[id] !== undefined);
  check(owned.length >= 1 && owned.every((id, i) => PICKAXE_IDS[i] === id), "owned pickaxes must be a prefix of the tier order");
  for (const [id, lv] of Object.entries(state.pickaxes ?? {})) {
    check((PICKAXE_IDS as readonly string[]).includes(id), `unknown pickaxe ${id}`);
    check(Number.isInteger(lv) && (lv as number) >= 1 && (lv as number) <= MAX_PICKAXE_LEVEL, `pickaxe ${id} level out of range`);
  }
  check(state.pickaxes?.[state.equippedPickaxe] !== undefined, "equipped pickaxe must be owned");

  // 深度與解鎖
  const m = state.mining;
  int(m?.frontierBlockIndex, "frontierBlockIndex");
  check(m.frontierBlockIndex <= TOTAL_BLOCKS, `frontierBlockIndex must be <= ${TOTAL_BLOCKS}`);
  check([0, 1, 2].includes(state.unlockedZone), "unlockedZone must be 0, 1 or 2");
  check(state.unlockedZone * 1000 <= m.frontierBlockIndex, "a zone can only be unlocked after reaching it");
  check(m.frontierBlockIndex <= (state.unlockedZone + 1) * 1000, "frontier cannot pass a locked zone");
  int(m.digCounter, "digCounter");
  check(m.digCounter >= m.frontierBlockIndex, "digCounter must be >= frontierBlockIndex");
  int(m.blockWork, "blockWork");
  int(m.blockMs, "blockMs");
  check((m.blockWork === 0) === (m.blockMs === 0), "blockWork and blockMs must both be zero or both be positive");

  // 模式
  check((MINING_MODES as readonly string[]).includes(m.mode), "invalid mining mode");
  check((m.revisitZone !== null) === (m.mode === "revisit"), "revisitZone must be set exactly when mode = revisit");
  check((m.reworkBand !== null) === (m.mode === "rework"), "reworkBand must be set exactly when mode = rework");
  if (issues.length > 0) return issues; // 以下需要前面的欄位合法

  const power10 = currentStats(state).power10;
  if (m.mode === "revisit") {
    check(revisitableZones(m.frontierBlockIndex, state.unlockedZone).includes(m.revisitZone!), "revisitZone is not revisitable (GBS §2.3)");
  }
  if (m.mode === "rework") {
    check(reworkBand(m.frontierBlockIndex, state.unlockedZone, power10) === m.reworkBand, "reworkBand must equal the server-computed band (GBS §2.4)");
  }
  // 換成較弱的十字鎬時（P5、P21）未完成方塊可能停在 Power 不足的狀態，所以只檢查可挖時的上限
  const pos = miningPosition(state, power10);
  if (pos.spot) check(m.blockWork < blockWork(pos.spot.hardness), "blockWork must be below the current block's work");

  // 物品
  for (const [id, n] of Object.entries(state.inventory)) {
    check(([...MINERAL_IDS, ...MATERIAL_IDS] as readonly string[]).includes(id), `unknown item ${id}`);
    check(isNonNegInt(n) && n > 0, `inventory ${id} must be a positive safe integer`);
  }

  // 寶物與圖鑑
  const ids = new Set<string>();
  for (const a of state.heldArtifacts) {
    check(!ids.has(a.instanceId), `duplicate artifact instance ${a.instanceId}`);
    ids.add(a.instanceId);
    check((ARTIFACT_IDS as readonly string[]).includes(a.artifactId), `unknown artifact ${a.artifactId}`);
    check(state.discoveredArtifacts[a.artifactId] !== undefined, `held artifact ${a.artifactId} must be discovered`);
    check(a.digCounter < m.digCounter, `artifact ${a.instanceId} comes from a future block`);
  }
  for (const [id, rec] of Object.entries(state.discoveredArtifacts)) {
    check(ARTIFACTS[id as ArtifactId] !== undefined, `unknown discovered artifact ${id}`);
    check(isNonNegInt(rec!.totalFound) && rec!.totalFound >= 1, `discovery ${id} totalFound must be >= 1`);
  }

  // 首次寶物保護
  const ft = state.firstTreasure;
  check(["pending", "obtained", "granted"].includes(ft.status), "invalid firstTreasure.status");
  int(ft.effectiveMiningMs, "firstTreasure.effectiveMiningMs");
  if (ft.status === "pending") {
    check(ft.resolvedAt === null && ft.artifactInstanceId === null && ft.reportId === null, "pending firstTreasure must have no resolution");
  } else {
    check(isNonNegInt(ft.resolvedAt) && typeof ft.artifactInstanceId === "string", "resolved firstTreasure must record time and instance");
  }

  // 待領取報告
  const r = state.pendingOfflineReport;
  if (r) {
    check(r.periodEnd === state.lastSettledAt, "pending report must end at lastSettledAt");
    check(r.reportId === `r${r.periodStart}`, "reportId must be derived from periodStart");
    check(r.digCounterTo === m.digCounter, "pending report must end at the current digCounter");
    for (const a of r.rewards.artifacts) check(!ids.has(a.instanceId), `report artifact ${a.instanceId} is already held`);
  }
  // 「保護狀態已更新但獎勵還在報告裡」的一致性：reportId 非 null ⇔ 第一件寶物還在待領取報告中
  if (ft.reportId !== null) {
    check(r !== null && r.reportId === ft.reportId, "firstTreasure.reportId must point to the pending report");
    check(r?.rewards.artifacts.some((a) => a.instanceId === ft.artifactInstanceId) ?? false, "firstTreasure artifact must be inside its pending report");
    if (ft.status === "granted") check(r?.firstTreasureGranted === true, "report must flag the granted first treasure");
  }
  return issues;
}

export function assertValidState(state: PlayerGameState): void {
  const issues = validateState(state);
  if (issues.length > 0) throw new RangeError(`invalid PlayerGameState: ${issues.join("; ")}`);
}

/** 給玩家的狀態（不含任何伺服器密鑰；附上衍生值方便 UI） */
export interface PlayerStateView {
  state: PlayerGameState;
  stats: Stats;
  status: MiningStatus;
  spot: MiningSpot | null;
  maxDepthBand: number;
}

export function toPlayerView(state: PlayerGameState): PlayerStateView {
  const stats = currentStats(state);
  const pos = miningPosition(state, stats.power10);
  const f = state.mining.frontierBlockIndex;
  return { state: cloneState(state), stats, status: pos.status, spot: pos.spot, maxDepthBand: f === 0 ? 0 : bandOfBlock(f - 1) };
}
