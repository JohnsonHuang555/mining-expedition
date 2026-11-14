"use client";

import type { ItemId } from "@mining/game-data";
import type { OfflineReport } from "@mining/game-engine";
import { PixelButton } from "@/components/ui/pixel";
import { artifactName, artifactRarity, coins, duration, itemName, itemRarity, meters, STATUS_LABEL } from "@/lib/game/format";
import { useController, useGame } from "./runtime-context";

const STOP_TEXT: Record<OfflineReport["stopReason"], string> = {
  none: "時間結束時仍在挖掘",
  offline_cap: "已達離線上限 12 小時",
  blocked_power: `途中${STATUS_LABEL.blocked_power}而停止`,
  blocked_unlock: `途中${STATUS_LABEL.blocked_unlock}而停止`,
  frontier_complete: "主線已完成",
};

/**
 * 離線探險報告（D20、GBS §15、GDD §7.3–7.4）。有待領取報告時覆蓋整個畫面，其他操作都無法進行。
 * 只有伺服器建立的報告才會出現（D23：沒有完成方塊時不會有報告）。
 */
export function OfflineReportModal({ report }: { report: OfflineReport }) {
  const controller = useController();
  const busy = useGame((s) => s.busy);
  const sync = useGame((s) => s.sync);
  const claiming = busy === "claim";
  const items = Object.entries(report.rewards.items).filter(([, q]) => (q ?? 0) > 0) as [ItemId, number][];
  const common = items.filter(([id]) => itemRarity(id) === "common");
  const rare = items.filter(([id]) => itemRarity(id) === "rare");
  const away = report.periodEnd - report.periodStart;

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="report-title" className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 p-2 sm:items-center sm:p-6">
      <div className="pixel-frame animate-pop max-h-[92dvh] w-full max-w-lg overflow-y-auto p-4 sm:p-6">
        <h2 id="report-title" className="text-center text-xl font-black tracking-widest text-gold">
          ⛏ 探險報告
        </h2>
        <p className="mt-1 text-center text-xs text-parchment-dim">你不在的時候，礦工持續挖掘了</p>

        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <dt className="text-parchment-dim">離線時間</dt>
          <dd className="text-right font-mono" data-testid="report-away">{duration(away)}</dd>
          <dt className="text-parchment-dim">有效挖掘時間</dt>
          <dd className="text-right font-mono" data-testid="report-mined">{duration(report.minedMs)}</dd>
          {report.idleMs > 0 && (
            <>
              <dt className="text-parchment-dim">卡關閒置</dt>
              <dd className="text-right font-mono">{duration(report.idleMs)}</dd>
            </>
          )}
          {report.discardedMs > 0 && (
            <>
              <dt className="text-parchment-dim">超過 12 小時（不計）</dt>
              <dd className="text-right font-mono">{duration(report.discardedMs)}</dd>
            </>
          )}
          <dt className="text-parchment-dim">完成方塊</dt>
          <dd className="text-right font-mono" data-testid="report-blocks">{report.blocksMined.toLocaleString("zh-TW")}</dd>
          {report.mode === "frontier" && report.frontierTo > report.frontierFrom && (
            <>
              <dt className="text-parchment-dim">前線深度</dt>
              <dd className="text-right font-mono">
                {meters(report.frontierFrom)} → {meters(report.frontierTo)}
              </dd>
            </>
          )}
          <dt className="text-parchment-dim">結束狀態</dt>
          <dd className="text-right">{STOP_TEXT[report.stopReason]}</dd>
        </dl>

        <div className="mt-4 bg-cave-950/60 p-3 text-center">
          <div className="text-xs text-parchment-dim">獲得金幣</div>
          <div className="font-mono text-2xl font-black text-gold" data-testid="report-coins">
            +{coins(report.rewards.coins)}
          </div>
        </div>

        {common.length > 0 && (
          <ul className="mt-3 grid grid-cols-2 gap-1 text-sm" aria-label="礦物">
            {common.map(([id, q]) => (
              <li key={id} className="flex justify-between bg-cave-900 px-2 py-1">
                <span>{itemName(id)}</span>
                <span className="font-mono">×{q}</span>
              </li>
            ))}
          </ul>
        )}
        {rare.length > 0 && (
          <ul className="mt-2 space-y-1 text-sm" aria-label="稀有礦物">
            {rare.map(([id, q]) => (
              <li key={id} className="flex justify-between bg-crystal/15 px-2 py-1 text-crystal">
                <span>✦ {itemName(id)}</span>
                <span className="font-mono">×{q}</span>
              </li>
            ))}
          </ul>
        )}

        {report.rewards.artifacts.length > 0 && (
          <div className="mt-4">
            <h3 className="mb-2 text-sm font-bold text-ember">發現的寶物</h3>
            <ul className="space-y-2" aria-label="寶物">
              {report.rewards.artifacts.map((a) => {
                const legendary = artifactRarity(a.artifactId) === "legendary";
                return (
                  <li key={a.instanceId} className={`animate-pop p-2 ${legendary ? "bg-gold/20 text-gold" : "bg-crystal/20 text-crystal"}`} data-testid="report-artifact">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-bold">{legendary ? "★" : "◆"} {artifactName(a.artifactId)}</span>
                      {a.isNewDiscovery && <span className="bg-moss px-1.5 py-0.5 text-[10px] font-black text-cave-950">NEW DISCOVERY</span>}
                      {a.source === "first_treasure_protection" && <span className="bg-ember px-1.5 py-0.5 text-[10px] font-black text-cave-950">首次寶物保護</span>}
                    </div>
                  </li>
                );
              })}
            </ul>
            {report.firstTreasureGranted && <p className="mt-2 text-xs text-parchment-dim">首次寶物保護：挖掘滿 4 小時仍未取得寶物，本次保證獲得一件。</p>}
          </div>
        )}

        <p className="mt-4 text-xs text-parchment-dim">領取後才會繼續挖掘；等待領取的時間不計入挖掘時間。</p>
        {!sync.ok && sync.message && (
          <p role="alert" className="mt-2 text-xs text-danger">
            {sync.message}
          </p>
        )}
        <PixelButton className="mt-4 w-full py-3 text-base" onClick={() => void controller.claimReport()} disabled={claiming || busy !== null} aria-busy={claiming}>
          {claiming ? "領取中…" : "領取探險成果"}
        </PixelButton>
      </div>
    </div>
  );
}
