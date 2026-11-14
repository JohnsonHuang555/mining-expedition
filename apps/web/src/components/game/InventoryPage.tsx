"use client";

import { type MineralId } from "@mining/game-data";
import Link from "next/link";
import { useState } from "react";
import { ConfirmDialog, QuantityInput } from "@/components/ui/confirm";
import { ItemIcon } from "@/components/ui/item-icon";
import { Panel, PixelButton } from "@/components/ui/pixel";
import { type MineralRow, artifactRows, materialRows, mineralRows, sellEstimate, validQuantity } from "@/lib/game/economy";
import { coins, itemName } from "@/lib/game/format";
import { useGame } from "./runtime-context";
import { useAction } from "./use-action";

/** 大量出售需要確認：全部出售（10 個以上）或一次 100 個以上 */
const needsConfirm = (q: number, have: number) => q >= 100 || (q === have && have >= 10);

export function InventoryPage() {
  const state = useGame((s) => s.view!.state);
  const minerals = mineralRows(state);
  const materials = materialRows(state);
  const artifacts = artifactRows(state);
  const total = minerals.reduce((a, r) => a + r.totalValue, 0);

  if (minerals.length === 0 && materials.length === 0 && artifacts.length === 0) {
    return (
      <Panel title="背包">
        <p className="py-6 text-center text-sm text-parchment-dim" data-testid="inventory-empty">
          背包是空的。回到
          <Link href="/" className="mx-1 underline">
            礦坑
          </Link>
          挖掘吧！
        </p>
      </Panel>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-[1.5fr_1fr]">
      <Panel title="礦物" right={<span className="text-xs text-parchment-dim">全部出售約 {coins(total)} 金幣</span>}>
        {minerals.length === 0 ? (
          <p className="text-sm text-parchment-dim">沒有礦物。</p>
        ) : (
          <ul className="space-y-2" aria-label="礦物">
            {minerals.map((r) => (
              <MineralLine key={r.id} row={r} />
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-parchment-dim">礦物以固定價格出售；實際獲得金幣以伺服器結算為準。</p>
      </Panel>
      <div className="flex flex-col gap-4">
        <Panel title="製作素材">
          {materials.length === 0 ? (
            <p className="text-sm text-parchment-dim">還沒有素材。可以在工坊用礦物製作。</p>
          ) : (
            <ul className="space-y-2" aria-label="製作素材">
              {materials.map((m) => (
                <li key={m.id} className="flex items-center gap-2 bg-cave-900 px-2 py-2 text-sm" data-testid={`inv-row-${m.id}`}>
                  <ItemIcon id={m.id} />
                  <span className="flex-1">{itemName(m.id)}</span>
                  <span className="font-mono" data-testid={`inv-qty-${m.id}`}>
                    ×{m.quantity}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-parchment-dim">
            製作素材不可出售，用於購買與強化十字鎬（
            <Link href="/workshop" className="underline">
              前往工坊
            </Link>
            ）。
          </p>
        </Panel>
        {artifacts.length > 0 && (
          <Panel title="寶物">
            <ul className="space-y-1 text-sm" aria-label="寶物">
              {artifacts.map((a) => (
                <li key={a.instanceId} className={`px-2 py-1 ${a.rarity === "legendary" ? "bg-gold/15 text-gold" : "bg-crystal/15 text-crystal"}`}>
                  {a.rarity === "legendary" ? "★" : "◆"} {a.name}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-parchment-dim">寶物依每日市場價格出售，將在市場與圖鑑上線後開放。</p>
          </Panel>
        )}
      </div>
    </div>
  );
}

function MineralLine({ row }: { row: MineralRow }) {
  const { run, running, actionable } = useAction();
  const [qty, setQty] = useState("1");
  const [confirm, setConfirm] = useState<number | null>(null);
  const n = Number(qty);
  const valid = validQuantity(n, row.quantity);
  const key = `sell:${row.id}`;
  const busy = running === key;

  async function sell(q: number) {
    setConfirm(null);
    const o = await run(key, { type: "sell_items", itemId: row.id as MineralId, quantity: q });
    if (o === "ok") setQty("1");
  }
  const submit = (q: number) => (needsConfirm(q, row.quantity) ? setConfirm(q) : void sell(q));

  return (
    <li className="flex flex-col gap-2 bg-cave-900 px-2 py-2 sm:flex-row sm:items-center" data-testid={`inv-row-${row.id}`}>
      <div className="flex flex-1 items-center gap-2">
        <ItemIcon id={row.id} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm">
            <span className={row.rarity === "rare" ? "text-crystal" : ""}>{itemName(row.id)}</span>
            {row.rarity === "rare" && <span className="bg-crystal/20 px-1 text-[10px] text-crystal">稀有</span>}
            <span className="ml-auto font-mono" data-testid={`inv-qty-${row.id}`}>
              ×{row.quantity.toLocaleString("zh-TW")}
            </span>
          </div>
          <div className="text-xs text-parchment-dim">
            單價 {coins(row.unitPrice)}・合計 {coins(row.totalValue)}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <QuantityInput value={qty} max={row.quantity} onChange={setQty} label={`${itemName(row.id)} 出售數量`} disabled={!actionable} />
        <PixelButton className="px-3 py-1.5 text-xs" disabled={!actionable || !valid} onClick={() => submit(n)} aria-busy={busy} data-testid={`sell-${row.id}`}>
          {busy ? "出售中…" : valid ? `出售 +${coins(sellEstimate(row.id as MineralId, n))}` : "數量不正確"}
        </PixelButton>
      </div>
      {confirm !== null && (
        <ConfirmDialog title="確認出售" confirmLabel="確定出售" onCancel={() => setConfirm(null)} onConfirm={() => void sell(confirm)}>
          出售 {itemName(row.id)} ×{confirm.toLocaleString("zh-TW")}，預估獲得 <span className="font-bold text-gold">{coins(sellEstimate(row.id as MineralId, confirm))}</span> 金幣？
          <p className="mt-1 text-xs text-parchment-dim">實際金額以伺服器結算為準。</p>
        </ConfirmDialog>
      )}
    </li>
  );
}
