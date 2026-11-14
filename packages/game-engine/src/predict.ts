/**
 * 挖掘進度預測（TECHNICAL_SPEC §12.2）。只供 Client 顯示用。
 *
 * - 只使用 Hardness、目前裝備數值與已累積的工作量，**不使用亂數**：無法、也不會預測掉落內容。
 * - 不產生任何可入帳的結果；伺服器回應永遠覆蓋預測。
 * - 預測最多到在線門檻（300 秒，GBS §15）；超過後伺服器會改為離線結算，預測停止。
 * - 不模擬數值變化（例如掉落寶物湊齊套組改變 Speed）：這些只能由伺服器結算後得知，下一次同步時校正。
 */

import { ONLINE_GAP_MS } from "@mining/game-data";
import { type MiningSpot, advanceWork, blockWork, frontierBlock, frontierSpot, revisitSpot, reworkSpot, workRate } from "./mining.ts";
import { canMine } from "./fixed.ts";
import { type MiningStatus, type PlayerGameState, currentStats } from "./state.ts";

export interface BlockPrediction {
  /** 預測時間點的挖掘狀態；有待領取報告時為 paused（D24：挖掘暫停） */
  status: MiningStatus | "paused";
  /** 預測時間點正在挖的位置（status = mining 時） */
  spot: MiningSpot | null;
  /** 目前方塊的預測進度 0–1 */
  progress: number;
  /** 從基準狀態起預測完成的方塊數（內容未知，必須等伺服器結算） */
  blocksCompleted: number;
  /** 目前方塊預測再多久完成（毫秒）；不在挖掘時為 null */
  msToNextBlock: number | null;
  /** 經過時間已超過在線門檻：之後的進度只能由伺服器的離線結算決定 */
  beyondOnlineWindow: boolean;
}

/** 防止極端數值時迴圈過長（300 秒內最快的情境也遠低於此數） */
const MAX_PREDICTED_BLOCKS = 10_000;

/**
 * `state` 必須是伺服器剛結算完的狀態（lastSettledAt = 伺服器時間）；`elapsedMs` 是從收到該狀態起經過的本機時間。
 */
export function predictBlockProgress(state: PlayerGameState, elapsedMs: number): BlockPrediction {
  const elapsed = Math.max(0, Math.floor(Number.isFinite(elapsedMs) ? elapsedMs : 0));
  const beyondOnlineWindow = elapsed > ONLINE_GAP_MS;
  const stats = currentStats(state);
  const rate = workRate(stats);
  const m = state.mining;

  const spotFor = (frontier: number): { status: MiningStatus; spot: MiningSpot | null } => {
    if (m.mode === "frontier") {
      const blocked = frontierBlock(frontier, state.unlockedZone, stats.power10);
      if (blocked === null) return { status: "mining", spot: frontierSpot(frontier) };
      return { status: blocked === "completed" ? "frontier_complete" : blocked === "locked" ? "blocked_unlock" : "blocked_power", spot: null };
    }
    const spot = m.mode === "revisit" ? revisitSpot(m.revisitZone!) : reworkSpot(m.reworkBand!);
    return canMine(stats.power10, spot.requiredPower10) ? { status: "mining", spot } : { status: "blocked_power", spot: null };
  };

  let frontier = m.frontierBlockIndex;
  let work = m.blockWork;
  let pos = spotFor(frontier);
  if (state.pendingOfflineReport !== null) {
    return { status: "paused", spot: pos.spot, progress: pos.spot ? work / blockWork(pos.spot.hardness) : 0, blocksCompleted: 0, msToNextBlock: null, beyondOnlineWindow };
  }

  let remaining = Math.min(elapsed, ONLINE_GAP_MS);
  let blocks = 0;
  while (pos.spot !== null && blocks < MAX_PREDICTED_BLOCKS) {
    const step = advanceWork(work, pos.spot.hardness, rate, remaining);
    if (!step.completed) {
      work = step.work;
      break;
    }
    blocks++;
    remaining -= step.usedMs;
    work = 0;
    if (m.mode === "frontier") {
      frontier++;
      pos = spotFor(frontier);
    }
  }

  if (pos.spot === null) return { status: pos.status, spot: null, progress: 0, blocksCompleted: blocks, msToNextBlock: null, beyondOnlineWindow };
  const total = blockWork(pos.spot.hardness);
  return {
    status: "mining",
    spot: pos.spot,
    progress: Math.min(1, work / total),
    blocksCompleted: blocks,
    msToNextBlock: Math.ceil((total - work) / rate),
    beyondOnlineWindow,
  };
}
