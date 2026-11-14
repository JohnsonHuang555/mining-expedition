/**
 * 遊戲畫面狀態（Zustand，TECHNICAL_SPEC §12.1）。
 *
 * 只放 UI 需要的暫時狀態。金幣、背包、裝備、挖掘進度一律來自伺服器回應的 PlayerStateView，
 * 每次回應都整個覆蓋；Client 不保存任何會入帳的計算結果。
 */

import { createStore } from "zustand/vanilla";
import type { ArtifactId, ItemId } from "@mining/game-data";
import type { GameCommand, GameEvent, PlayerStateView, SettleSummary } from "@mining/game-engine";
import type { PendingAction } from "./pending";

export type Phase = "booting" | "signed_out" | "no_character" | "ready" | "error";
export type BusyOp = "bootstrap" | "settle" | "reconcile" | "claim" | "mode" | "unlock" | "create" | "refresh" | "sell" | "buy" | "equip" | "upgrade" | "craft";

/** 一次玩家操作的結果（畫面顯示成功 / 失敗 / 未確認） */
export interface ActionResult {
  requestId: string;
  command: GameCommand["type"];
  /** ok：伺服器確認成功；rejected：伺服器確認拒絕（沒有任何變更）；uncertain：結果未確認（保留，之後以同一個 requestId 調和） */
  outcome: "ok" | "rejected" | "uncertain";
  message: string | null;
  /** 伺服器回傳的事件（成功時；例如 items_sold 的實際金幣） */
  events: GameEvent[];
  at: number;
}

export interface LootEntry {
  /** = digCounter（每個完成的方塊唯一）：同一個回應重送時不會重複顯示 */
  key: number;
  completedAt: number;
  items: Partial<Record<ItemId, number>>;
  coins: number;
  artifact: ArtifactId | null;
  /** 首次寶物保護發放（D18） */
  protection: boolean;
  isNewDiscovery: boolean;
}

export interface GameUiState {
  phase: Phase;
  view: PlayerStateView | null;
  /**
   * view 是否剛由結算產生（lastSettledAt ≈ 伺服器時間）：只有這種狀態可以做進度預測。
   * game-state（唯讀）與錯誤回應附帶的狀態不是「現在」的狀態，要等下一次結算。
   */
  fresh: boolean;
  /** 收到 view 時的本機時間（performance.now 或注入的時鐘；只用於預測） */
  receivedAt: number;
  busy: BusyOp | null;
  /** 結果尚未確認的操作（重新整理後也會從 storage 恢復）。存在時不接受其他玩家操作 */
  pending: PendingAction | null;
  /** 最近一次玩家操作的結果 */
  lastAction: ActionResult | null;
  /** 最近一次結算摘要（「最新挖掘成果」） */
  lastSettlement: { summary: SettleSummary; blocks: LootEntry[]; at: number } | null;
  recentLoot: LootEntry[];
  sync: { ok: boolean; lastOkAt: number | null; failures: number; message: string | null };
  /** 給玩家的一次性提示（例如「報告已在其他分頁領取」） */
  notice: string | null;
  /** 嚴重錯誤（伺服器狀態異常等） */
  error: string | null;
}

export const RECENT_LOOT_LIMIT = 12;

export const initialUiState = (): GameUiState => ({
  phase: "booting",
  view: null,
  fresh: false,
  receivedAt: 0,
  busy: null,
  pending: null,
  lastAction: null,
  lastSettlement: null,
  recentLoot: [],
  sync: { ok: true, lastOkAt: null, failures: 0, message: null },
  notice: null,
  error: null,
});

export type GameStore = ReturnType<typeof createGameStore>;

export function createGameStore() {
  return createStore<GameUiState>()(() => initialUiState());
}

/** block_completed 事件 → Recent Loot（依 digCounter 去除重複） */
export function lootFromEvents(events: readonly GameEvent[]): LootEntry[] {
  const out: LootEntry[] = [];
  for (const e of events) {
    if (e.type !== "block_completed") continue;
    out.push({
      key: e.digCounter,
      completedAt: e.completedAt,
      items: e.items,
      coins: e.coins,
      artifact: e.artifact ?? e.protection,
      protection: e.protection !== null,
      isNewDiscovery: e.isNewDiscovery,
    });
  }
  return out;
}

export function mergeLoot(existing: readonly LootEntry[], incoming: readonly LootEntry[]): LootEntry[] {
  const seen = new Set(existing.map((l) => l.key));
  const fresh = incoming.filter((l) => !seen.has(l.key));
  return [...fresh.reverse(), ...existing].sort((a, b) => b.key - a.key).slice(0, RECENT_LOOT_LIMIT);
}

/** 現在能不能送出新的玩家操作（按鈕的 disabled 條件；Controller 也會再檢查一次） */
export function canAct(s: Pick<GameUiState, "busy" | "pending" | "view" | "phase">): boolean {
  return s.phase === "ready" && s.busy === null && s.pending === null && !!s.view && s.view.state.pendingOfflineReport === null;
}
