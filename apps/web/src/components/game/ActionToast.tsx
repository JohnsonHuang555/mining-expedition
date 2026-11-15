"use client";

import { MATERIALS, type MaterialId, SETS } from "@mining/game-data";
import { useEffect, useState } from "react";
import { coins, itemName, pickaxeName, zoneName } from "@/lib/game/format";
import type { ActionResult } from "@/lib/game/store";
import { useGame } from "./runtime-context";

const setName = (id: string) => (SETS as Record<string, { name: string }>)[id]?.name ?? id;

/** 伺服器確認的結果 → 玩家看得懂的文字（金額等數值一律取自伺服器事件） */
export function describeAction(a: ActionResult): string {
  // 拒絕：交易本身沒有執行（沒有扣除金幣 / 素材），但操作前的挖掘結算可能已經同步
  if (a.outcome === "rejected") return `✗ ${a.message ?? "操作失敗"}：此操作未執行，沒有扣除金幣或素材${a.synced ? "（挖掘結算已同步）" : ""}`;
  if (a.outcome === "uncertain" && a.code === "RATE_LIMITED") return `⋯ 操作太頻繁：伺服器尚未執行，稍後會以同一筆請求自動重試（不會重複執行）`;
  if (a.outcome === "uncertain") return `⋯ 結果尚未確認：會以同一筆請求自動確認，不會重複執行`;
  const parts: string[] = [];
  for (const e of a.events) {
    switch (e.type) {
      case "items_sold":
        parts.push(`已出售 ${itemName(e.itemId)} ×${e.quantity}，獲得 ${coins(e.coins)} 金幣`);
        break;
      case "artifacts_sold":
        parts.push(`已出售寶物 ${e.instanceIds.length} 件，成交 ${coins(e.coins)} 金幣`);
        break;
      case "set_changed":
        if (!e.active) parts.push(`${setName(e.setId)}效果已失效`);
        break;
      case "pickaxe_purchased":
        parts.push(`購買了 ${pickaxeName(e.pickaxeId)}`);
        break;
      case "pickaxe_equipped":
        if (!a.events.some((x) => x.type === "pickaxe_purchased")) parts.push(`已裝備 ${pickaxeName(e.pickaxeId)}`);
        break;
      case "pickaxe_upgraded":
        parts.push(`強化成功！${pickaxeName(e.pickaxeId)} → Lv${e.level}`);
        break;
      case "crafted":
        parts.push(`製作了 ${MATERIALS[e.materialId as MaterialId].name} ×${e.times}`);
        break;
      case "zone_unlocked":
        parts.push(`解鎖了 ${zoneName(e.zone)}`);
        break;
      case "report_claimed":
        parts.push(`領取探險成果：+${coins(e.coins)} 金幣`);
        break;
      case "mining_mode_changed":
        parts.push("已切換挖掘模式");
        break;
    }
  }
  return `✓ ${parts.join("；") || "完成"}`;
}

/** 最近一次玩家操作的結果（成功 / 失敗 / 未確認），顯示幾秒 */
export function ActionToast() {
  const last = useGame((s) => s.lastAction);
  const [visible, setVisible] = useState<string | null>(null);
  useEffect(() => {
    if (!last) return;
    setVisible(last.requestId + last.at);
    const t = setTimeout(() => setVisible(null), last.outcome === "ok" ? 4_000 : 8_000);
    return () => clearTimeout(t);
  }, [last]);
  if (!last || visible !== last.requestId + last.at) return null;
  const tone = last.outcome === "ok" ? "bg-moss/15 text-moss" : last.outcome === "rejected" ? "bg-danger/15 text-danger" : "bg-crystal/15 text-crystal";
  return (
    <p role="status" aria-live="polite" data-testid="action-result" data-outcome={last.outcome} className={`animate-pop px-3 py-2 text-sm font-bold ${tone}`}>
      {describeAction(last)}
    </p>
  );
}
