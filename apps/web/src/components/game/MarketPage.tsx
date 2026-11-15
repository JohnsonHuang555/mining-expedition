"use client";

import type { ArtifactId } from "@mining/game-data";
import type { MarketQuote } from "@mining/game-engine";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ArtifactIcon } from "@/components/ui/artifact-icon";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Panel, PixelButton } from "@/components/ui/pixel";
import { coins, zoneName } from "@/lib/game/format";
import {
  MAX_ARTIFACTS_PER_SALE,
  type MarketRow,
  type PricePoint,
  type SalePlan,
  dayChange,
  formatChange,
  formatCountdown,
  formatMarketDate,
  formatMultiplier,
  formatRefreshTime,
  marketRows,
  pickInstances,
  planSale,
  priceHistory,
  quoteStatus,
} from "@/lib/game/market";
import { useController, useGame, useGameStore } from "./runtime-context";
import { useAction } from "./use-action";

const RARITY = { epic: { label: "Epic", cls: "bg-crystal/20 text-crystal" }, legendary: { label: "Legendary", cls: "bg-gold/20 text-gold" } } as const;

const STATUS_TEXT = {
  none: "正在取得市場報價…",
  unavailable: "市場價格暫時無法取得（寶物暫停出售；挖礦與其他功能不受影響）",
  refreshing: "市場已到更新時間，正在取得新報價…",
  valid: "今日報價有效",
} as const;

/** 每秒更新的本機時間（只用於倒數顯示；不決定交易是否有效） */
function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/**
 * 寶物市場（/market）。
 * - 報價（市場日、倍率、歷史）只來自伺服器；售價用引擎的公式顯示，成交價由伺服器在交易時決定。
 * - 出售只送出 heldArtifacts 的 instanceId 與報價的 marketDate（不送價格 / 倍率）；不做 optimistic update。
 * - 未發現的寶物沿用圖鑑的揭露規則：只顯示礦區與稀有度。
 */
export function MarketPage() {
  const state = useGame((s) => s.view!.state);
  const market = useGame((s) => s.market);
  const controller = useController();
  const now = useNow();
  const status = quoteStatus(market, now);
  const rows = marketRows(state, market);
  const [counts, setCounts] = useState<Partial<Record<ArtifactId, number>>>({});
  const [confirm, setConfirm] = useState<string[] | null>(null);
  // 成交提示只對應「這一次」成功的 Request ID：之後有任何新的操作結果（或換帳號）就不再顯示舊的成交
  const [saleRequestId, setSaleRequestId] = useState<string | null>(null);
  const lastAction = useGame((s) => s.lastAction);
  const sold = lastAction && lastAction.requestId === saleRequestId && lastAction.outcome === "ok" ? lastAction.events.find((e) => e.type === "artifacts_sold") : undefined;
  const result = sold && sold.type === "artifacts_sold" ? { coins: sold.coins, count: sold.instanceIds.length } : null;

  // 開啟市場：由 Controller 取得歷史與換日後的新報價（忙碌時排隊、失敗時退避；離開頁面即停止）
  useEffect(() => controller.watchMarket(), [controller]);
  useEffect(() => {
    if (status === "refreshing") void controller.refreshMarket();
  }, [controller, status, market?.date]);

  // 選擇的數量永遠不超過目前持有（其他分頁出售後自動縮小），合計不超過單次出售上限
  const clamped = capSelection(rows, counts);
  const selected = rows.flatMap((r) => pickInstances(r, clamped[r.id] ?? 0));
  const preview = planSale(state, market, selected);
  const remaining = MAX_ARTIFACTS_PER_SALE - preview.count;
  const canSell = status === "valid" && preview.count > 0 && !preview.tooMany && preview.total !== null;

  return (
    <div className="flex flex-col gap-4 pb-24">
      <Panel title="寶物市場" right={<span className="font-mono text-sm text-gold" data-testid="market-date">{market ? formatMarketDate(market.date) : "—"}</span>}>
        <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
          <div>
            <div className="text-parchment-dim">下一次更新</div>
            <div className="font-mono" data-testid="market-next">
              {market ? formatRefreshTime(market.nextRefreshAt) : "—"}
            </div>
          </div>
          <div>
            <div className="text-parchment-dim">更新倒數</div>
            <div className="font-mono text-base text-parchment" data-testid="market-countdown">
              {market ? formatCountdown(market.nextRefreshAt - now) : "—"}
            </div>
          </div>
          <div>
            <div className="text-parchment-dim">持有金幣</div>
            <div className="font-mono text-base text-gold" data-testid="market-coins">
              {coins(state.coins)}
            </div>
          </div>
          <div className="col-span-2 sm:col-span-1">
            <div className="text-parchment-dim">報價狀態</div>
            <div className={status === "valid" ? "text-moss" : status === "unavailable" ? "text-danger" : "text-crystal"} data-testid="market-status" data-status={status} data-history={market?.history ? "loaded" : "pending"} role="status">
              {STATUS_TEXT[status]}
            </div>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-parchment-dim">
          價格 = 基礎價值 × 當日倍率，每天台灣時間 00:00 更新。畫面上的價格是今日報價，實際成交金額以伺服器在出售時的結算為準；換日後需要以新報價重新確認。
        </p>
        {status === "unavailable" && (
          <PixelButton tone="secondary" className="mt-2 px-3 py-1.5 text-xs" onClick={() => void controller.refreshMarket()} data-testid="market-retry">
            重新取得報價
          </PixelButton>
        )}
      </Panel>

      {result && (
        <p className="bg-moss/15 px-3 py-2 text-sm font-bold text-moss" role="status" data-testid="market-result">
          ✓ 已出售 {result.count} 件寶物，伺服器實際成交 {coins(result.coins)} 金幣
        </p>
      )}

      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="市場寶物">
        {rows.map((r) => (
          <MarketCard
            key={r.id}
            row={r}
            market={market}
            sellable={status === "valid"}
            count={clamped[r.id] ?? 0}
            room={remaining}
            onCount={(n) => setCounts({ ...clamped, [r.id]: n })}
          />
        ))}
      </ul>

      {preview.count > 0 && (
        <div className="fixed inset-x-0 bottom-16 z-20 border-t-4 border-cave-600 bg-cave-900/95 px-3 py-2 backdrop-blur" data-testid="market-selection">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2 text-sm">
            <span>
              已選 <b data-testid="market-selected-count">{preview.count}</b> 件（{preview.lines.length} 種）・預估{" "}
              <b className="text-gold" data-testid="market-selected-total">
                {preview.total === null ? "—" : coins(preview.total)}
              </b>{" "}
              金幣
            </span>
            <span className="text-xs text-parchment-dim" data-testid="market-remaining">
              {remaining > 0 ? `還可再選 ${remaining} 件` : `已達單次上限 ${MAX_ARTIFACTS_PER_SALE} 件`}
            </span>
            {preview.lostSets.length > 0 && <span className="text-xs text-danger">⚠ 會失去套組效果</span>}
            <div className="ml-auto flex gap-2">
              <PixelButton tone="ghost" className="px-3 py-1.5 text-xs" onClick={() => setCounts({})}>
                清除
              </PixelButton>
              <PixelButton className="px-3 py-1.5 text-xs" disabled={!canSell} onClick={() => setConfirm(preview.instanceIds)} data-testid="market-sell">
                出售…
              </PixelButton>
            </div>
          </div>
        </div>
      )}

      {confirm && (
        <SaleConfirm
          instanceIds={confirm}
          onClose={() => setConfirm(null)}
          onReselect={(ids) => setConfirm(ids)}
          onStart={() => setSaleRequestId(null)}
          onDone={(requestId) => {
            setConfirm(null);
            setCounts({});
            setSaleRequestId(requestId);
          }}
        />
      )}
    </div>
  );
}

/** 每種的件數不超過持有；合計不超過單次上限（依卡片順序保留，超出的部分縮小） */
function capSelection(rows: MarketRow[], counts: Partial<Record<ArtifactId, number>>): Partial<Record<ArtifactId, number>> {
  let left = MAX_ARTIFACTS_PER_SALE;
  const out: Partial<Record<ArtifactId, number>> = {};
  for (const r of rows) {
    const n = Math.max(0, Math.min(counts[r.id] ?? 0, r.instances.length, left));
    if (n > 0) out[r.id] = n;
    left -= n;
  }
  return out;
}

function MarketCard({ row: r, market, sellable, count, room, onCount }: { row: MarketRow; market: MarketQuote | null; sellable: boolean; count: number; room: number; onCount(n: number): void }) {
  if (!r.discovered) {
    return (
      <li id={`market-${r.id}`} className="flex items-center gap-3 bg-cave-950/70 p-3" data-testid={`market-card-${r.id}`} data-discovered="false" aria-label={`未發現的寶物（${zoneName(r.zone)}）`}>
        <ArtifactIcon id={r.id} discovered={false} zone={r.zone} legendary={r.rarity === "legendary"} />
        <div className="text-xs">
          <div className="font-bold text-parchment-dim">？？？</div>
          <div className="mt-1 flex items-center gap-1">
            <span className={`px-1 text-[10px] ${RARITY[r.rarity].cls}`}>{RARITY[r.rarity].label}</span>
            <span className="text-parchment-dim">{zoneName(r.zone)}</span>
          </div>
          <div className="mt-1 text-[11px] text-parchment-dim">發現後才會顯示行情</div>
        </div>
      </li>
    );
  }
  const change = dayChange(market, r.id);
  const history = priceHistory(market, r.id);
  const held = r.instances.length;
  return (
    <li
      id={`market-${r.id}`}
      className={`flex flex-col gap-2 p-3 target:shadow-[0_0_0_3px_var(--color-ember)] ${r.rarity === "legendary" ? "bg-gold/10" : "bg-cave-900"} ${count > 0 ? "shadow-[0_0_0_2px_var(--color-ember)]" : ""}`}
      data-testid={`market-card-${r.id}`}
      data-discovered="true"
    >
      <div className="flex items-start gap-3">
        <ArtifactIcon id={r.id} discovered zone={r.zone} legendary={r.rarity === "legendary"} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-sm font-bold">{r.name}</span>
            <span className={`px-1 text-[10px] ${RARITY[r.rarity].cls}`}>{RARITY[r.rarity].label}</span>
          </div>
          <div className="text-[11px] text-parchment-dim">{zoneName(r.zone)}</div>
          {r.inActiveSet && (
            <div className="mt-1 inline-block bg-moss/20 px-1 text-[10px] text-moss" data-testid={`market-set-${r.id}`}>
              套組生效中
            </div>
          )}
        </div>
        <div className="text-right">
          <div className="font-mono text-lg font-bold text-gold" data-testid={`market-price-${r.id}`}>
            {r.price === null ? "—" : coins(r.price)}
          </div>
          <div className="font-mono text-[11px] text-parchment-dim" data-testid={`market-mult-${r.id}`}>
            {r.multiplierPpm === null ? "無報價" : formatMultiplier(r.multiplierPpm)}
          </div>
          {change && (
            <div
              className={`font-mono text-[11px] ${change.direction === "up" ? "text-moss" : change.direction === "down" ? "text-danger" : "text-parchment-dim"}`}
              data-testid={`market-change-${r.id}`}
              data-direction={change.direction}
              title={`昨日 ${coins(change.yesterday.price)}`}
            >
              {formatChange(change)}
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between text-[11px] text-parchment-dim">
        <span>基礎價值 {coins(r.baseValue)}</span>
        <span data-testid={`market-held-${r.id}`}>持有 ×{held}</span>
      </div>
      <Trend id={r.id} points={history} />
      {held > 0 && (
        <div className="flex items-center gap-1" role="group" aria-label={`${r.name} 出售數量`}>
          <span className="mr-auto text-[11px] text-parchment-dim">出售</span>
          <button type="button" className="bg-cave-700 px-2 text-sm disabled:opacity-40" disabled={!sellable || count <= 0} onClick={() => onCount(count - 1)} aria-label={`${r.name} 減少`}>
            −
          </button>
          <span className="w-12 text-center font-mono text-sm" data-testid={`market-count-${r.id}`}>
            {count}/{held}
          </span>
          <button type="button" className="bg-cave-700 px-2 text-sm disabled:opacity-40" disabled={!sellable || count >= held || room <= 0} onClick={() => onCount(count + 1)} aria-label={`${r.name} 增加`}>
            ＋
          </button>
          <button
            type="button"
            className="bg-cave-700 px-2 text-xs disabled:opacity-40"
            disabled={!sellable || count >= held || room <= 0}
            onClick={() => onCount(Math.min(held, count + room))}
            title={held - count > room ? `單次最多出售 ${MAX_ARTIFACTS_PER_SALE} 件：只會再選 ${room} 件` : undefined}
            data-testid={`market-all-${r.id}`}
          >
            {held - count > room && room > 0 ? `+${room}` : "全部"}
          </button>
        </div>
      )}
    </li>
  );
}

/** 伺服器提供的真實歷史（最多 7 天）：SVG 折線 + 可展開的日期 / 價格表。沒有歷史時不畫線 */
function Trend({ id, points }: { id: ArtifactId; points: PricePoint[] }) {
  if (points.length < 2) {
    return (
      <p className="text-[11px] text-parchment-dim" data-testid={`market-trend-${id}`} data-points={points.length}>
        尚無歷史行情
      </p>
    );
  }
  const W = 140;
  const H = 32;
  const prices = points.map((p) => p.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const xy = points.map((p, i) => [(i / (points.length - 1)) * (W - 4) + 2, max === min ? H / 2 : H - 3 - ((p.price - min) / (max - min)) * (H - 6)] as const);
  return (
    <details className="text-[11px]" data-testid={`market-trend-${id}`} data-points={points.length}>
      <summary className="flex cursor-pointer items-center gap-2 text-parchment-dim">
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`近 ${points.length} 天價格走勢`} className="bg-cave-950">
          <polyline points={xy.map(([x, y]) => `${x},${y}`).join(" ")} fill="none" stroke="var(--color-gold)" strokeWidth="2" shapeRendering="crispEdges" />
          {xy.map(([x, y], i) => (
            <rect key={i} x={x - 1.5} y={y - 1.5} width="3" height="3" fill={i === xy.length - 1 ? "var(--color-ember)" : "var(--color-gold)"} />
          ))}
        </svg>
        <span>{points.length} 天行情</span>
      </summary>
      <table className="mt-1 w-full font-mono">
        <tbody>
          {[...points].reverse().map((p) => (
            <tr key={p.date}>
              <td className="text-parchment-dim">{formatMarketDate(p.date)}</td>
              <td className="text-right">{formatMultiplier(p.multiplierPpm)}</td>
              <td className="text-right">{coins(p.price)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

/**
 * 出售確認：顯示實際會送出的實例、數量、預估收入、市場日 / 報價、剩餘數量與套組影響。
 * 報價或持有在開啟後改變時，畫面以最新資料重新計算，玩家再次按下確認才會送出（不會自動重新出售）。
 */
function SaleConfirm({ instanceIds, onClose, onReselect, onStart, onDone }: { instanceIds: string[]; onClose(): void; onReselect(ids: string[]): void; onStart(): void; onDone(requestId: string): void }) {
  const state = useGame((s) => s.view!.state);
  const market = useGame((s) => s.market);
  const { run, actionable } = useAction();
  const store = useGameStore();
  const status = quoteStatus(market, Date.now());
  const plan: SalePlan = planSale(state, market, instanceIds);
  const [openedDate] = useState(market?.date ?? null);
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const quoteChanged = market !== null && openedDate !== null && market.date !== openedDate;
  const losing = plan.lostSets.length > 0;

  async function sell() {
    if (!market) return;
    setProblem(null);
    onStart(); // 新交易開始：不再顯示上一筆的成交提示
    const o = await run("sell-artifacts", { type: "sell_artifacts", instanceIds: plan.instanceIds, marketDate: market.date });
    const last = store.getState().lastAction;
    if (o === "ok" && last) {
      onDone(last.requestId); // 成交金額只取自這個 Request ID 的伺服器事件
      return;
    }
    setAttempt((n) => n + 1); // 重新啟用確認按鈕（下一次是新的 Request ID）
    if (o === "rejected") {
      if (last?.code === "MARKET_QUOTE_EXPIRED") setProblem("市場價格已更新，請重新確認");
      else if (last?.code === "INSUFFICIENT_ITEMS") setProblem("部分寶物已不在持有中（可能已在其他分頁出售），請重新選擇");
      else if (last?.code === "MARKET_UNAVAILABLE") setProblem("市場價格暫時無法取得，請稍後再試");
      else setProblem(last?.message ?? "出售失敗");
    } else if (o === "uncertain") {
      onClose(); // 結果未確認：交給既有的未確認操作機制以同一個 Request ID 調和
    } else {
      setProblem("目前有其他操作進行中或有待領取的報告，請稍後再試");
    }
  }

  const disabledReason =
    status === "unavailable"
      ? "市場價格暫時無法取得，無法出售"
      : status !== "valid"
        ? "正在取得最新報價，請稍候"
        : plan.missing.length > 0
          ? "持有狀態已變更（部分寶物已不在持有中），請重新選擇"
          : plan.count === 0
            ? "沒有可出售的寶物"
            : plan.tooMany
              ? `一次最多出售 ${MAX_ARTIFACTS_PER_SALE} 件`
              : "目前有待領取的報告或尚未確認的操作，暫時無法出售";
  const disabled = !actionable || status !== "valid" || plan.missing.length > 0 || plan.count === 0 || plan.tooMany || plan.total === null;

  return (
    <ConfirmDialog
      key={attempt}
      title={losing ? "⚠ 出售將失去套組效果" : "確認出售寶物"}
      confirmLabel={losing ? "仍要出售" : quoteChanged || problem === "市場價格已更新，請重新確認" ? "以新報價出售" : "確定出售"}
      onCancel={onClose}
      onConfirm={() => void sell()}
      disabled={disabled}
      disabledReason={disabledReason}
    >
      <div data-testid="sale-confirm" data-losing-set={losing ? "true" : "false"}>
        {(problem || quoteChanged) && (
          <p className="mb-2 bg-crystal/15 px-2 py-1 text-xs font-bold text-crystal" role="alert" data-testid="sale-problem">
            {problem ?? "市場價格已更新，請重新確認"}
          </p>
        )}
        <p className="text-xs text-parchment-dim">
          市場日 <span className="font-mono text-parchment" data-testid="sale-market-date">{market ? formatMarketDate(market.date) : "—"}</span>
        </p>
        <ul className="mt-2 space-y-1" aria-label="出售明細">
          {plan.lines.map((l) => (
            <li key={l.id} className="bg-cave-900 px-2 py-1 text-xs" data-testid={`sale-line-${l.id}`}>
              <div className="flex justify-between gap-2">
                <span className="font-bold">
                  {l.name} ×{l.instanceIds.length}
                </span>
                <span className="font-mono text-gold">{l.subtotal === null ? "—" : coins(l.subtotal)}</span>
              </div>
              <div className="flex justify-between gap-2 text-[11px] text-parchment-dim">
                <span>
                  報價 {l.unitPrice === null ? "—" : coins(l.unitPrice)}・
                  {market?.multipliersPpm[l.id] !== undefined ? formatMultiplier(market.multipliersPpm[l.id]!) : "無報價"}
                </span>
                <span data-testid={`sale-remaining-${l.id}`}>
                  持有 {l.heldBefore} → {l.remaining}
                </span>
              </div>
              <div className="truncate font-mono text-[10px] text-parchment-dim" title={l.instanceIds.join(", ")}>
                實例 {l.instanceIds.map((i) => `#${i}`).join(" ")}
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-2 flex justify-between text-sm">
          <span>
            共 <b data-testid="sale-count">{plan.count}</b> 件，預估收入
          </span>
          <b className="font-mono text-gold" data-testid="sale-total">
            {plan.total === null ? "—" : coins(plan.total)} 金幣
          </b>
        </p>
        {losing ? (
          <div className="mt-2 bg-danger/15 px-2 py-1 text-xs text-danger" role="alert" data-testid="sale-set-warning">
            {plan.lostSets.map((s) => (
              <p key={s.id}>
                出售後將失去{s.name}效果：{s.bonus}
              </p>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-[11px] text-parchment-dim" data-testid="sale-no-set-impact">
            不影響目前生效的套組。
          </p>
        )}
        {plan.missing.length > 0 && (
          <button type="button" className="mt-2 text-xs underline" onClick={() => onReselect(plan.instanceIds)} data-testid="sale-reselect">
            移除已不在持有中的寶物，重新選擇
          </button>
        )}
        <p className="mt-2 text-[11px] text-parchment-dim">預估以今日報價計算；實際成交金額以伺服器在出售時的結算為準。</p>
      </div>
    </ConfirmDialog>
  );
}
