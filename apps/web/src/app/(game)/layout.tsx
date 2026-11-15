import type { ReactNode } from "react";
import { GameApp } from "@/components/game/GameApp";

/** 遊戲頁面共用：登入檢查、runtime（同步、待領報告）在頁面切換時保持 */
export default function GameLayout({ children }: { children: ReactNode }) {
  return <GameApp>{children}</GameApp>;
}
