"use client";

import { type BlockPrediction, predictBlockProgress } from "@mining/game-engine";
import { createContext, useContext, useEffect, useState } from "react";
import { useStore } from "zustand";
import type { GameRuntime } from "@/lib/game/runtime";
import type { GameUiState } from "@/lib/game/store";

export const RuntimeContext = createContext<GameRuntime | null>(null);

function useRuntime(): GameRuntime {
  const r = useContext(RuntimeContext);
  if (!r) throw new Error("missing RuntimeContext");
  return r;
}

export function useGame<T>(selector: (s: GameUiState) => T): T {
  return useStore(useRuntime().store, selector);
}

export function useController() {
  return useRuntime().controller;
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * 目前方塊的預估進度（只用於顯示）。每 200ms 依「收到伺服器狀態後經過的時間」重新計算；
 * 伺服器回應一到就以新狀態為基準（校正）。狀態不是剛結算的（fresh = false）時不預測。
 */
export function usePrediction(intervalMs = 200): BlockPrediction | null {
  const view = useGame((s) => s.view);
  const fresh = useGame((s) => s.fresh);
  const receivedAt = useGame((s) => s.receivedAt);
  const [t, setT] = useState(now);
  useEffect(() => {
    const id = setInterval(() => setT(now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  if (!view) return null;
  return predictBlockProgress(view.state, fresh ? Math.max(0, t - receivedAt) : 0);
}
