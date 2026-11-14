"use client";

import { ZONES } from "@mining/game-data";
import { type BlockPrediction, type PlayerStateView, bandOfBlock, requiredPower10OfBand, reworkBand, revisitableZones, revisitSpot, type ZoneIndex } from "@mining/game-engine";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useState } from "react";
import { Panel, PixelBar, PixelButton, Stat } from "@/components/ui/pixel";
import { STATUS_LABEL, artifactName, artifactRarity, bandRange, coins, duration, formatStats, itemName, itemRarity, meters, pickaxeName, spotLabel, zoneName } from "@/lib/game/format";
import { type LootEntry, canAct } from "@/lib/game/store";
import { ActionToast } from "./ActionToast";
import { MiningScene } from "./MiningScene";
import { useController, useGame, usePrediction } from "./runtime-context";

/** 所有遊戲頁面共用的外框：標題列、玩家資訊、操作結果提示、底部導覽 */
export function GameFrame({ email, onSignOut, children }: { email: string | null; onSignOut(): void; children: ReactNode }) {
  const view = useGame((s) => s.view)!;
  const blocked = view.state.pendingOfflineReport !== null;
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-3 pb-24 sm:p-6" aria-hidden={blocked || undefined}>
      <TopBar email={email} onSignOut={onSignOut} />
      <PlayerStats view={view} />
      <ActionToast />
      {children}
      <BottomNav />
    </div>
  );
}

/** 挖礦頁（Mine） */
export function MineContent() {
  const view = useGame((s) => s.view)!;
  const prediction = usePrediction();
  return (
    <div className="grid gap-4 md:grid-cols-[1.4fr_1fr]">
      <div className="flex flex-col gap-4">
        <MiningPanel view={view} prediction={prediction} />
        <ModePanel view={view} />
      </div>
      <div className="flex flex-col gap-4">
        <LatestResult />
        <RecentLoot />
      </div>
    </div>
  );
}

/** 挖礦主畫面（外框 + 挖礦頁） */
export function Dashboard({ email, onSignOut }: { email: string | null; onSignOut(): void }) {
  return (
    <GameFrame email={email} onSignOut={onSignOut}>
      <MineContent />
    </GameFrame>
  );
}

function TopBar({ email, onSignOut }: { email: string | null; onSignOut(): void }) {
  const controller = useController();
  const busy = useGame((s) => s.busy);
  const sync = useGame((s) => s.sync);
  const notice = useGame((s) => s.notice);
  const error = useGame((s) => s.error);
  const pending = useGame((s) => s.pending);
  return (
    <header className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-black tracking-widest text-gold sm:text-2xl">⛏ 挖礦探險隊</h1>
        <div className="flex items-center gap-3">
          <span className={`flex items-center gap-1 text-xs ${sync.ok ? "text-moss" : "text-danger"}`} role="status" data-testid="sync-status">
            <span className={`inline-block h-2 w-2 ${sync.ok ? "bg-moss" : "bg-danger animate-glint"}`} />
            {busy === "settle" ? "同步中…" : sync.ok ? "已同步" : (sync.message ?? "連線中斷")}
          </span>
          <PixelButton tone="secondary" className="px-3 py-1.5 text-xs" onClick={() => void controller.sync()} disabled={busy !== null}>
            立即同步
          </PixelButton>
          <PixelButton tone="ghost" className="px-3 py-1.5 text-xs" onClick={onSignOut} title={email ?? undefined}>
            登出
          </PixelButton>
        </div>
      </div>
      {notice && (
        <p className="flex items-center justify-between gap-2 bg-ember/15 px-3 py-2 text-sm text-ember" role="status">
          {notice}
          <button type="button" className="text-xs underline" onClick={() => controller.dismissNotice()}>
            關閉
          </button>
        </p>
      )}
      {pending && (
        <div className="flex flex-wrap items-center justify-between gap-2 bg-crystal/15 px-3 py-2 text-sm text-crystal" role="status" data-testid="pending-action">
          <span>
            {busy === "reconcile" || (busy !== null && busy !== "settle") ? "正在確認上一個操作的結果…" : "上一個操作的結果尚未確認：會以同一筆請求確認，不會重複執行。"}
          </span>
          <PixelButton tone="secondary" className="px-3 py-1 text-xs" disabled={busy !== null} onClick={() => void controller.sync()}>
            重新確認
          </PixelButton>
        </div>
      )}
      {error && (
        <p className="bg-danger/15 px-3 py-2 text-sm text-danger" role="alert">
          {error}
        </p>
      )}
    </header>
  );
}

function PlayerStats({ view }: { view: PlayerStateView }) {
  const st = formatStats(view.stats);
  const s = view.state;
  const level = s.pickaxes[s.equippedPickaxe];
  const currentZone = view.spot?.zone ?? Math.min(2, Math.floor(s.mining.frontierBlockIndex / 1000));
  return (
    <Panel>
      <div className="grid grid-cols-3 gap-x-3 gap-y-2 sm:grid-cols-4 lg:grid-cols-8">
        <Stat label="金幣" value={<span className="text-gold" data-testid="coins">{coins(s.coins)}</span>} />
        <Stat label="最大深度" value={<span data-testid="max-depth">{meters(s.mining.frontierBlockIndex)}</span>} />
        <Stat label="目前礦區" value={zoneName(currentZone)} />
        <div className="col-span-3 sm:col-span-1 lg:col-span-2">
          <Stat label="裝備中的十字鎬" value={`${pickaxeName(s.equippedPickaxe)} Lv${level}`} />
        </div>
        <Stat label="Power" value={<span data-testid="power">{st.power}</span>} />
        <Stat label="Speed" value={st.speed} />
        <Stat label="Luck" value={st.luck} />
      </div>
    </Panel>
  );
}

function MiningPanel({ view, prediction }: { view: PlayerStateView; prediction: BlockPrediction | null }) {
  const controller = useController();
  const actionable = useGame(canAct);
  const fresh = useGame((s) => s.fresh);
  const s = view.state;
  const status = prediction?.status ?? view.status;
  const spot = prediction?.spot ?? view.spot;
  const frontier = s.mining.frontierBlockIndex + (s.mining.mode === "frontier" ? (prediction?.blocksCompleted ?? 0) : 0);
  const nextZone = (s.unlockedZone + 1) as 1 | 2;
  const fee = ZONES[nextZone]?.unlockFee ?? 0;
  const badge =
    status === "mining" ? "bg-moss text-cave-950" : status === "paused" ? "bg-cave-600 text-parchment" : status === "frontier_complete" ? "bg-gold text-cave-950" : "bg-danger text-cave-950";

  return (
    <Panel
      title="挖掘"
      right={
        <span className={`px-2 py-0.5 text-xs font-bold ${badge}`} data-testid="mining-status">
          {STATUS_LABEL[status]}
        </span>
      }
    >
      <div className="overflow-hidden shadow-[0_0_0_3px_#000]">
        <MiningScene zone={spot?.zone ?? 0} prediction={prediction} />
      </div>
      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
        <span data-testid="mining-position">{spot ? spotLabel(spot, frontier) : `前線 ${meters(s.mining.frontierBlockIndex)}`}</span>
        {spot && <span className="font-mono text-xs text-parchment-dim">Hardness {spot.hardness}</span>}
      </div>
      <div className="mt-2">
        <PixelBar value={status === "mining" ? (prediction?.progress ?? 0) : 0} label="目前方塊進度" />
        <div className="mt-1 flex justify-between text-xs text-parchment-dim">
          <span>
            {status === "mining" && prediction?.msToNextBlock != null && fresh ? `約 ${duration(prediction.msToNextBlock)} 後完成（預估）` : status === "mining" ? "同步後顯示預估進度" : " "}
          </span>
          {(prediction?.blocksCompleted ?? 0) > 0 && (
            <span className="text-ember" data-testid="pending-blocks">
              +{prediction!.blocksCompleted} 個方塊待結算
            </span>
          )}
        </div>
      </div>

      {status === "blocked_power" && (
        <Hint tone="danger" testId="hint-power">
          {s.mining.mode === "frontier" ? (
            <>
              前方岩層太硬：需要 Power {(requiredPower10OfBand(bandOfBlock(s.mining.frontierBlockIndex)) / 10).toFixed(1)}，目前 {(view.stats.power10 / 10).toFixed(1)}。
              可以切換到「重挖」或「回訪」繼續收集資源，再到
              <Link href="/workshop" className="mx-1 underline">
                工坊
              </Link>
              購買或強化十字鎬。
            </>
          ) : (
            <>這個位置需要更高的 Power。請切換回前線或其他模式。</>
          )}
        </Hint>
      )}
      {status === "blocked_unlock" && (
        <Hint tone="ember" testId="hint-unlock">
          已挖到 {zoneName(s.unlockedZone)} 底部。解鎖「{zoneName(nextZone)}」需要 {coins(fee)} 金幣。
          <div className="mt-2">
            <PixelButton className="px-3 py-1.5 text-xs" disabled={!actionable || s.coins < fee} onClick={() => void controller.unlockZone(nextZone)}>
              {s.coins < fee ? `金幣不足（${coins(s.coins)} / ${coins(fee)}）` : `解鎖 ${zoneName(nextZone)}`}
            </PixelButton>
          </div>
        </Hint>
      )}
      {status === "frontier_complete" && (
        <Hint tone="gold" testId="hint-complete">
          恭喜！已挖到最深處，主線完成。可以回訪任一礦區繼續收集寶物。
        </Hint>
      )}
      {prediction?.beyondOnlineWindow && <Hint tone="ember">超過 5 分鐘沒有同步：之後的成果會由伺服器以離線報告結算。</Hint>}
    </Panel>
  );
}

function Hint({ children, tone, testId }: { children: React.ReactNode; tone: "danger" | "ember" | "gold"; testId?: string }) {
  const cls = tone === "danger" ? "border-danger text-danger" : tone === "gold" ? "border-gold text-gold" : "border-ember text-ember";
  return (
    <div className={`mt-3 border-l-4 bg-cave-950/50 px-3 py-2 text-sm ${cls}`} data-testid={testId}>
      {children}
    </div>
  );
}

function ModePanel({ view }: { view: PlayerStateView }) {
  const controller = useController();
  const actionable = useGame(canAct);
  const [zone, setZone] = useState<ZoneIndex | null>(null);
  const s = view.state;
  const m = s.mining;
  const zones = revisitableZones(m.frontierBlockIndex, s.unlockedZone);
  const rework = reworkBand(m.frontierBlockIndex, s.unlockedZone, view.stats.power10);
  const disabled = !actionable;
  const pickZone = zone ?? zones[zones.length - 1] ?? null;

  return (
    <Panel title="挖掘模式">
      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="挖掘模式">
        <ModeButton active={m.mode === "frontier"} disabled={disabled || m.mode === "frontier"} onClick={() => void controller.selectMode("frontier")} label="前線" sub="往更深處" />
        <ModeButton
          active={m.mode === "revisit"}
          disabled={disabled || zones.length === 0 || pickZone === null || (m.mode === "revisit" && m.revisitZone === pickZone)}
          onClick={() => pickZone !== null && void controller.selectMode("revisit", pickZone)}
          label="回訪"
          sub={zones.length === 0 ? "需先挖到下一區" : `${zoneName(pickZone!)}`}
        />
        <ModeButton
          active={m.mode === "rework"}
          disabled={disabled || (rework === null && m.mode !== "rework") || m.mode === "rework"}
          onClick={() => void controller.selectMode("rework")}
          label="重挖"
          sub={m.mode === "rework" && m.reworkBand !== null ? bandRange(m.reworkBand) : rework === null ? "前線卡關時可用" : bandRange(rework)}
        />
      </div>
      {zones.length > 1 && (
        <div className="mt-3 flex flex-wrap gap-2 text-xs" aria-label="回訪礦區">
          {zones.map((z) => (
            <button
              key={z}
              type="button"
              className={`px-2 py-1 ${pickZone === z ? "bg-ember text-cave-950" : "bg-cave-700 text-parchment-dim"}`}
              onClick={() => setZone(z)}
              aria-pressed={pickZone === z}
            >
              {zoneName(z)}（{bandRange(revisitSpot(z).band)}）
            </button>
          ))}
        </div>
      )}
      <p className="mt-2 text-xs text-parchment-dim">切換模式會從新位置的方塊重新開始。重挖深度由伺服器依目前的 Power 決定。</p>
    </Panel>
  );
}

function ModeButton({ active, disabled, onClick, label, sub }: { active: boolean; disabled: boolean; onClick(): void; label: string; sub: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={disabled}
      onClick={onClick}
      className={`pixel-btn flex flex-col items-center gap-0.5 px-2 py-2 ${active ? "bg-ember text-cave-950" : "bg-cave-700 text-parchment"} ${active ? "disabled:filter-none" : ""}`}
    >
      <span className="text-sm">{label}</span>
      <span className="text-[10px] font-normal opacity-80">{sub}</span>
    </button>
  );
}

function LootLine({ l }: { l: LootEntry }) {
  const items = Object.entries(l.items).filter(([, q]) => (q ?? 0) > 0);
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-0.5 bg-cave-900 px-2 py-1 text-sm" data-testid="loot-entry">
      {items.map(([id, q]) => (
        <span key={id} className={itemRarity(id as never) === "rare" ? "text-crystal" : ""}>
          {itemRarity(id as never) === "rare" ? "✦ " : ""}
          {itemName(id as never)} ×{q}
        </span>
      ))}
      {l.coins > 0 && <span className="text-gold">+{coins(l.coins)} 金幣</span>}
      {l.artifact && (
        <span className={artifactRarity(l.artifact) === "legendary" ? "font-bold text-gold" : "font-bold text-crystal"}>
          {artifactRarity(l.artifact) === "legendary" ? "★" : "◆"} {artifactName(l.artifact)}
          {l.isNewDiscovery && <span className="ml-1 bg-moss px-1 text-[10px] text-cave-950">NEW</span>}
          {l.protection && <span className="ml-1 bg-ember px-1 text-[10px] text-cave-950">保護</span>}
        </span>
      )}
    </li>
  );
}

function RecentLoot() {
  const loot = useGame((s) => s.recentLoot);
  return (
    <Panel title="Recent Loot">
      {loot.length === 0 ? (
        <p className="text-sm text-parchment-dim">還沒有收穫。方塊完成並同步後會出現在這裡。</p>
      ) : (
        <ul className="space-y-1" aria-label="最近獲得">
          {loot.map((l) => (
            <LootLine key={l.key} l={l} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function LatestResult() {
  const last = useGame((s) => s.lastSettlement);
  const [open, setOpen] = useState(false);
  const totals = new Map<string, number>();
  let coinSum = 0;
  for (const b of last?.blocks ?? []) {
    coinSum += b.coins;
    for (const [id, q] of Object.entries(b.items)) totals.set(id, (totals.get(id) ?? 0) + (q ?? 0));
  }
  return (
    <Panel
      title="最新挖掘成果"
      right={
        last && last.blocks.length > 0 ? (
          <button type="button" className="text-xs text-parchment-dim underline" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? "收合" : "查看明細"}
          </button>
        ) : null
      }
    >
      {!last ? (
        <p className="text-sm text-parchment-dim">目前還沒有新完成的方塊。</p>
      ) : (
        <div className="text-sm" data-testid="latest-result">
          <p>
            上次同步完成 <span className="font-mono font-bold text-ember">{last.summary.blocksMined}</span> 個方塊（挖掘 {duration(last.summary.minedMs)}）
          </p>
          {totals.size > 0 && (
            <p className="mt-1 text-parchment-dim">
              {[...totals].map(([id, q]) => `${itemName(id as never)} ×${q}`).join("、")}
              {coinSum > 0 ? `、金幣 +${coins(coinSum)}` : ""}
            </p>
          )}
          {open && (
            <ul className="mt-2 space-y-1">
              {last.blocks.map((l) => (
                <LootLine key={l.key} l={l} />
              ))}
            </ul>
          )}
        </div>
      )}
    </Panel>
  );
}

const NAV = [
  { href: "/", label: "Mine", sub: "挖礦" },
  { href: "/inventory", label: "Inventory", sub: "背包" },
  { href: "/workshop", label: "Workshop", sub: "工坊" },
  { href: null, label: "Collection", sub: "圖鑑" },
] as const;

function BottomNav() {
  const pathname = usePathname() ?? "/";
  return (
    <nav className="fixed inset-x-0 bottom-0 z-10 border-t-4 border-cave-600 bg-cave-900/95 backdrop-blur" aria-label="主要功能">
      <ul className="mx-auto grid max-w-5xl grid-cols-4">
        {NAV.map((t) => {
          const current = t.href !== null && (t.href === "/" ? pathname === "/" : pathname.startsWith(t.href));
          const cls = `flex w-full flex-col items-center py-2 text-xs ${current ? "text-gold" : t.href ? "text-parchment hover:text-gold" : "text-parchment-dim/50"}`;
          return (
            <li key={t.label}>
              {t.href ? (
                <Link href={t.href} aria-current={current ? "page" : undefined} className={cls}>
                  <span className="font-bold">{t.sub}</span>
                  <span className="text-[10px]">{t.label}</span>
                </Link>
              ) : (
                <span className={cls} title="下一版開放" aria-disabled="true">
                  <span className="font-bold">{t.sub}</span>
                  <span className="text-[10px]">即將推出</span>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
