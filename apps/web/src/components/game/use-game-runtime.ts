"use client";

import { useEffect, useRef, useState } from "react";
import { type GameRuntime, type RuntimeFactory, acquireRuntime, browserRuntimeFactory, releaseRuntime } from "@/lib/game/runtime";

/**
 * 依登入的 userId 取得遊戲 runtime。建立 / 釋放只在 effect 中進行（render 沒有副作用）。
 * - userId 改變（換帳號 / 登出）時釋放舊的；舊 runtime 被 dispose 後不再寫入任何 store。
 * - 回傳值只在 runtime.userId 與目前 userId 相同時才有值，避免換帳號的瞬間顯示上一位玩家的畫面。
 */
export function useGameRuntime(userId: string | null, onSignedOut: () => void, factory: RuntimeFactory = browserRuntimeFactory): GameRuntime | null {
  const [runtime, setRuntime] = useState<GameRuntime | null>(null);
  const callback = useRef(onSignedOut);
  useEffect(() => {
    callback.current = onSignedOut;
  });

  useEffect(() => {
    if (!userId) {
      setRuntime(null);
      return;
    }
    const notify = () => callback.current();
    const rt = acquireRuntime(userId, notify, factory);
    setRuntime(rt);
    return () => {
      if (rt) releaseRuntime(rt, notify);
    };
  }, [userId, factory]);

  return runtime && runtime.userId === userId && !runtime.controller.isDisposed ? runtime : null;
}
