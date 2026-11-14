"use client";

import type { GameCommand } from "@mining/game-engine";
import { useState } from "react";
import type { ActionOutcome } from "@/lib/game/controller";
import { canAct } from "@/lib/game/store";
import { useController, useGame } from "./runtime-context";

/**
 * 交易按鈕共用：送出經過 Controller（未確認操作 / 冪等 / 阻擋規則都在那裡），
 * 這裡只記錄「哪一個按鈕」正在進行，用來顯示 Loading。畫面上的數值只在伺服器回應後更新。
 */
export function useAction() {
  const controller = useController();
  const actionable = useGame(canAct);
  const [running, setRunning] = useState<string | null>(null);
  async function run(key: string, command: GameCommand): Promise<ActionOutcome> {
    setRunning(key);
    try {
      return await controller.perform(command);
    } finally {
      setRunning(null);
    }
  }
  return { run, running, actionable };
}
