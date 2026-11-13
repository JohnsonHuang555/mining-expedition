/**
 * 結算（TECHNICAL_SPEC §7；GBS §4.3、§7.7、§15；決策 D5、D9、D16、D17、D18、D20；D19：P3、P5、P7、P28）。
 *
 * 純函式：不讀時鐘、不連資料庫、不修改傳入的狀態。相同的（狀態, serverNow, 亂數）永遠得到相同結果。
 * 在線與離線共用同一個挖掘迴圈，只差在：
 *   - 在線（經過 ≤ 300 秒）：獎勵直接入帳，套組可能在下一個方塊改變 Speed / Luck
 *   - 離線（經過 > 300 秒）：最多模擬 12 小時，獎勵放進待領取報告，期間數值不變
 * 方塊的完成、四層掉落、首次保護都使用 PR #3 的 advanceWork / rollBlock / firstTreasureStep。
 */

import {
  type ArtifactId,
  DATA_VERSION,
  OFFLINE_CAP_MS,
  ONLINE_GAP_MS,
  RNG_VERSION,
  SETS,
  type SetId,
} from "@mining/game-data";
import { type DropRules, rollBlock } from "./drop.ts";
import { type GameError, gameError } from "./errors.ts";
import type { BlockRecord, GameEvent } from "./events.ts";
import { advanceWork, workRate } from "./mining.ts";
import { firstTreasureStep } from "./protection.ts";
import type { RandomSource } from "./rng/random-source.ts";
import {
  type ArtifactInstance,
  type Inventory,
  type OfflineReport,
  type PlayerGameState,
  type ReportArtifact,
  type StopReason,
  cloneState,
  currentStats,
  miningPosition,
  validateState,
} from "./state.ts";
import { activeSets } from "./stats.ts";

export interface SettleOptions {
  /** 只供平衡模擬比較方案；正式結算不傳（= GBS v1.3） */
  dropRules?: DropRules;
  /** 只供平衡模擬比較方案：首次保護門檻；null = 停用（方案 A）。正式結算不傳（= 4 小時，D18） */
  firstTreasureProtectMs?: number | null;
  /** 離線結算也回傳每個方塊的紀錄（模擬器統計用；在線結算一定回傳） */
  recordBlocks?: boolean;
}

export interface SettleContext {
  /** 伺服器時間（Postgres now()，毫秒）；唯一的時間來源 */
  serverNow: number;
  /** 逐方塊亂數：createBlockRng(rngSecret)。密鑰只在伺服器端 */
  rng: (digCounter: number) => RandomSource;
  options?: SettleOptions;
}

export type SettleKind = "noop" | "online" | "offline";

export interface SettleSummary {
  kind: SettleKind;
  elapsedMs: number;
  simulatedMs: number;
  discardedMs: number;
  minedMs: number;
  idleMs: number;
  blocksMined: number;
  stopReason: StopReason;
}

export type SettleResult =
  | {
      ok: true;
      /** 新狀態（stateVersion 不在這裡改變；由提交流程決定，見 request.ts） */
      state: PlayerGameState;
      changed: boolean;
      summary: SettleSummary;
      events: GameEvent[];
      report: OfflineReport | null;
      blocks: BlockRecord[];
    }
  | { ok: false; error: GameError };

const isNonNegInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** 安全整數加法；溢位代表資料或程式錯誤，不能提交 */
export function addSafe(a: number, b: number): number {
  const s = a + b;
  if (!Number.isSafeInteger(s)) throw new RangeError(`integer overflow: ${a} + ${b}`);
  return s;
}

export function addItems(target: Inventory, items: Partial<Record<string, number>>): void {
  for (const [id, n] of Object.entries(items)) {
    if (!n) continue;
    const key = id as keyof Inventory;
    target[key] = addSafe(target[key] ?? 0, n);
  }
}

/** 載入狀態的共同檢查（settle 與 actions 共用） */
export function checkLoadedState(state: PlayerGameState): GameError | null {
  const issues = validateState(state);
  if (issues.length > 0) return gameError("INVALID_STATE", issues.join("; "));
  if (state.rngVersion !== RNG_VERSION) return gameError("RNG_VERSION_MISMATCH", `state rngVersion ${state.rngVersion} != engine ${RNG_VERSION}`);
  if (state.dataVersion > DATA_VERSION) return gameError("DATA_VERSION_UNSUPPORTED", `state dataVersion ${state.dataVersion} > engine ${DATA_VERSION}`);
  return null;
}

/** 方塊對應的寶物實例 ID：每位玩家唯一、重算同一個方塊得到同一個 ID（冪等） */
export const artifactInstanceId = (digCounter: number): string => `d${digCounter}`;
export const reportIdFor = (periodStart: number): string => `r${periodStart}`;

export function settle(input: PlayerGameState, ctx: SettleContext): SettleResult {
  const loadErr = checkLoadedState(input);
  if (loadErr) return { ok: false, error: loadErr };
  if (!isNonNegInt(ctx.serverNow)) return { ok: false, error: gameError("INVALID_TIME", "serverNow must be a non-negative safe integer") };
  if (ctx.serverNow < input.lastSettledAt) {
    return { ok: false, error: gameError("INVALID_TIME", `serverNow ${ctx.serverNow} is before lastSettledAt ${input.lastSettledAt}`) };
  }
  // D20：有待領取的報告時不結算（等待領取的時間在領取後才結算，GBS §7.7）
  if (input.pendingOfflineReport) return { ok: false, error: gameError("REPORT_PENDING", "claim the pending offline report first") };

  const elapsedMs = ctx.serverNow - input.lastSettledAt;
  const options = ctx.options ?? {};
  if (elapsedMs === 0) {
    return {
      ok: true,
      state: cloneState(input),
      changed: false,
      summary: { kind: "noop", elapsedMs: 0, simulatedMs: 0, discardedMs: 0, minedMs: 0, idleMs: 0, blocksMined: 0, stopReason: "none" },
      events: [],
      report: null,
      blocks: [],
    };
  }

  const offline = elapsedMs > ONLINE_GAP_MS; // P28：剛好 300,000 ms 仍算在線
  const simulatedMs = offline ? Math.min(elapsedMs, OFFLINE_CAP_MS) : elapsedMs; // D9
  const discardedMs = elapsedMs - simulatedMs;
  const periodStart = input.lastSettledAt;
  const reportId = offline ? reportIdFor(periodStart) : null;

  const state = cloneState(input);
  state.dataVersion = DATA_VERSION; // GBS §24：新數值從下一次結算開始生效
  const m = state.mining;
  const from = { frontier: m.frontierBlockIndex, digCounter: m.digCounter };

  const events: GameEvent[] = [];
  const blocks: BlockRecord[] = [];
  const recordBlocks = !offline || options.recordBlocks === true;
  const rewards = { coins: 0, items: {} as Inventory, artifacts: [] as ReportArtifact[] };
  const seenInReport = new Set<ArtifactId>();
  let firstTreasureGranted = false;

  let t = 0;
  let minedMs = 0;
  let blocksMined = 0;
  let stopReason: StopReason = "none";
  let stats = currentStats(state);

  while (t < simulatedMs) {
    const pos = miningPosition(state, stats.power10);
    if (!pos.spot) {
      // D5：前線卡關或位置 Power 不足時停止，保留成果；剩餘時間沒有產出，也不累積有效挖掘時間
      stopReason = pos.status === "mining" ? "none" : pos.status;
      break;
    }
    const spot = pos.spot;
    const step = advanceWork(m.blockWork, spot.hardness, workRate(stats), simulatedMs - t);
    t += step.usedMs;
    minedMs += step.usedMs;
    m.blockMs = addSafe(m.blockMs, step.usedMs);
    if (!step.completed) {
      m.blockWork = step.work; // 未完成方塊的工作量與時間保留到下一次結算（P5）
      break;
    }

    // ---- 方塊完成（GBS §4.3）----
    const completedAt = periodStart + t;
    const dig = m.digCounter;
    const drop = rollBlock(ctx.rng(dig), spot, m.blockMs, stats.luckPpm, options.dropRules);
    const prevFt = state.firstTreasure.status;
    let protection: ArtifactId | null = null;
    if (options.firstTreasureProtectMs === null) {
      // 方案 A（只供模擬）：沒有保護，只記錄第一件自然寶物
      state.firstTreasure.effectiveMiningMs = addSafe(state.firstTreasure.effectiveMiningMs, m.blockMs);
      if (prevFt === "pending" && drop.artifact) state.firstTreasure.status = "obtained";
    } else {
      const ft = firstTreasureStep(prevFt, state.firstTreasure.effectiveMiningMs, m.blockMs, drop.artifact, options.firstTreasureProtectMs);
      state.firstTreasure.status = ft.status;
      state.firstTreasure.effectiveMiningMs = ft.effectiveMs;
      protection = ft.granted;
    }
    const artifactId = drop.artifact ?? protection;
    const instanceId = artifactId ? artifactInstanceId(dig) : null;
    const isNewDiscovery = artifactId !== null && state.discoveredArtifacts[artifactId] === undefined && !seenInReport.has(artifactId);
    const instance: ArtifactInstance | null =
      artifactId && instanceId
        ? {
            instanceId,
            artifactId,
            obtainedAt: completedAt,
            mode: spot.mode,
            band: spot.band,
            frontierBlockIndex: spot.mode === "frontier" ? m.frontierBlockIndex : null,
            digCounter: dig,
            source: protection ? "first_treasure_protection" : "drop",
          }
        : null;
    if (prevFt === "pending" && state.firstTreasure.status !== "pending" && instance) {
      state.firstTreasure.resolvedAt = completedAt;
      state.firstTreasure.artifactInstanceId = instance.instanceId;
      state.firstTreasure.reportId = reportId; // 離線：寶物在報告中，領取時清除
      if (protection) firstTreasureGranted = true;
      events.push({
        type: "first_treasure_resolved",
        status: state.firstTreasure.status as "obtained" | "granted",
        instanceId: instance.instanceId,
        artifactId: instance.artifactId,
        source: instance.source,
      });
    }

    const record: BlockRecord = {
      digCounter: dig,
      completedAt,
      blockMs: m.blockMs,
      mode: spot.mode,
      band: spot.band,
      zone: spot.zone,
      frontierBlockIndex: spot.mode === "frontier" ? m.frontierBlockIndex : null,
      minedMsInSettle: minedMs,
      items: drop.items,
      coins: drop.coins,
      layer2: drop.layer2,
      layer4: drop.layer4,
      artifact: drop.artifact,
      protection,
      instanceId,
      isNewDiscovery,
    };
    if (recordBlocks) blocks.push(record);

    if (offline) {
      // 離線：獎勵只進報告，不進可使用的背包（D20）；數值在整段離線期間不變
      rewards.coins = addSafe(rewards.coins, drop.coins);
      addItems(rewards.items, drop.items);
      if (instance) {
        rewards.artifacts.push({ ...instance, isNewDiscovery });
        seenInReport.add(instance.artifactId);
      }
    } else {
      // 在線：直接入帳；套組可能改變，下一個方塊重新計算數值（GBS §9 P20）
      events.push({ type: "block_completed", ...record });
      state.coins = addSafe(state.coins, drop.coins);
      addItems(state.inventory, drop.items);
      if (instance) {
        const before = activeSets(heldCountsOf(state.heldArtifacts));
        state.heldArtifacts.push(instance);
        recordDiscovery(state, instance);
        pushSetChanges(events, before, activeSets(heldCountsOf(state.heldArtifacts)));
        stats = currentStats(state);
      }
    }

    m.digCounter = dig + 1;
    m.blockWork = 0;
    m.blockMs = 0;
    blocksMined++;
    if (spot.mode === "frontier") m.frontierBlockIndex += 1; // 只有前線推進最大深度（GBS §2.2）
  }

  const idleMs = simulatedMs - t;
  if (stopReason === "none" && discardedMs > 0) stopReason = "offline_cap";
  if (!offline && idleMs > 0 && stopReason !== "none") events.push({ type: "mining_stopped", status: stopReason as Exclude<StopReason, "none" | "offline_cap"> });

  state.lastSettledAt = ctx.serverNow; // 超過 12 小時的部分捨棄，不會再被結算（D9）

  let report: OfflineReport | null = null;
  if (offline && reportId) {
    report = {
      reportId,
      periodStart,
      periodEnd: ctx.serverNow,
      simulatedMs,
      discardedMs,
      minedMs,
      idleMs,
      blocksMined,
      mode: m.mode,
      frontierFrom: from.frontier,
      frontierTo: m.frontierBlockIndex,
      digCounterFrom: from.digCounter,
      digCounterTo: m.digCounter,
      stopReason,
      rewards,
      firstTreasureGranted,
    };
    state.pendingOfflineReport = report;
    events.push({ type: "report_created", reportId });
  }

  return {
    ok: true,
    state,
    changed: true,
    summary: { kind: offline ? "offline" : "online", elapsedMs, simulatedMs, discardedMs, minedMs, idleMs, blocksMined, stopReason },
    events,
    report,
    blocks,
  };
}

function heldCountsOf(held: readonly ArtifactInstance[]): Partial<Record<ArtifactId, number>> {
  const c: Partial<Record<ArtifactId, number>> = {};
  for (const a of held) c[a.artifactId] = (c[a.artifactId] ?? 0) + 1;
  return c;
}

export function recordDiscovery(state: PlayerGameState, a: ArtifactInstance): void {
  const rec = state.discoveredArtifacts[a.artifactId];
  if (rec) rec.totalFound = addSafe(rec.totalFound, 1);
  else state.discoveredArtifacts[a.artifactId] = { firstDiscoveredAt: a.obtainedAt, firstBand: a.band, totalFound: 1 };
}

export function pushSetChanges(events: GameEvent[], before: readonly SetId[], after: readonly SetId[]): void {
  for (const id of Object.keys(SETS) as SetId[]) {
    const was = before.includes(id);
    const is = after.includes(id);
    if (was !== is) events.push({ type: "set_changed", setId: id, active: is });
  }
}

export { heldCountsOf };
