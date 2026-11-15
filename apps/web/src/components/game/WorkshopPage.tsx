"use client";

import type { MaterialId } from "@mining/game-data";
import type { Stats } from "@mining/game-engine";
import { useState } from "react";
import { QuantityInput } from "@/components/ui/confirm";
import { ItemIcon } from "@/components/ui/item-icon";
import { Panel, PixelButton } from "@/components/ui/pixel";
import { type CostCheck, type CostLine, type PickaxeRow, pickaxeRows, recipeRows } from "@/lib/game/economy";
import { coins, formatStats, itemName, pickaxeName } from "@/lib/game/format";
import { useGame } from "./runtime-context";
import { useAction } from "./use-action";

const lineName = (l: CostLine) => (l.id === "coins" ? "金幣" : itemName(l.id));
const missingText = (c: CostCheck, times = 1) => c.missing.map((l) => `${lineName(l)} ×${(l.need - l.have).toLocaleString("zh-TW")}`).join("、") + (times > 1 ? "" : "");

function CostList({ check, testId }: { check: CostCheck; testId?: string }) {
  return (
    <ul className="space-y-1 text-xs" data-testid={testId}>
      {check.lines.map((l) => (
        <li key={l.id} className={`flex items-center gap-2 ${l.have >= l.need ? "" : "text-danger"}`}>
          {l.id === "coins" ? <span className="inline-block h-3 w-3 bg-gold" aria-hidden="true" /> : <ItemIcon id={l.id} size={14} />}
          <span className="flex-1">{lineName(l)}</span>
          <span className="font-mono">
            {l.have.toLocaleString("zh-TW")} / {l.need.toLocaleString("zh-TW")}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function WorkshopPage() {
  const state = useGame((s) => s.view!.state);
  const rows = pickaxeRows(state);
  return (
    <div className="flex flex-col gap-4">
      <Panel title="十字鎬" right={<span className="text-xs text-parchment-dim">依序購買；購買後自動裝備</span>}>
        <ul className="grid gap-3 md:grid-cols-2" aria-label="十字鎬">
          {rows.map((r) => (
            <PickaxeCard key={r.id} row={r} previous={r.tier > 0 ? rows[r.tier - 1]!.name : null} />
          ))}
        </ul>
      </Panel>
      <CraftingPanel />
    </div>
  );
}

function StatLine({ label, now, next, testId }: { label: string; now: string; next?: string; testId?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-xs">
      <span className="text-parchment-dim">{label}</span>
      <span className="font-mono" data-testid={testId}>
        {now}
        {next && next !== now && <span className="ml-1 text-moss">→ {next}</span>}
      </span>
    </div>
  );
}

function PickaxeCard({ row, previous }: { row: PickaxeRow; previous: string | null }) {
  const { run, running, actionable } = useAction();
  const last = useGame((s) => s.lastAction);
  const leveledUp = last?.outcome === "ok" && last.events.some((e) => e.type === "pickaxe_upgraded" && e.pickaxeId === row.id) && Date.now() - last.at < 4_000;
  const now = formatStats(row.stats);
  const next: ReturnType<typeof formatStats> | null = row.nextStats ? formatStats(row.nextStats as Stats) : null;
  const badge = { equipped: ["裝備中", "bg-moss text-cave-950"], owned: ["已擁有", "bg-cave-600 text-parchment"], purchasable: ["可購買", "bg-ember text-cave-950"], locked: ["未開放", "bg-cave-700 text-parchment-dim"] }[row.status];

  return (
    <li className={`bg-cave-900 p-3 ${row.status === "equipped" ? "shadow-[0_0_0_3px_var(--color-moss)]" : ""} ${leveledUp ? "animate-pop shadow-[0_0_0_3px_var(--color-gold)]" : ""}`} data-testid={`pickaxe-${row.id}`} data-status={row.status}>
      <div className="flex items-center gap-2">
        <span className="text-sm font-bold">{row.name}</span>
        <span className={`px-1.5 py-0.5 text-[10px] font-bold ${badge[1]}`}>{badge[0]}</span>
        {leveledUp && <span className="animate-glint bg-gold px-1.5 py-0.5 text-[10px] font-black text-cave-950">LEVEL UP!</span>}
        <span className="ml-auto font-mono text-xs" data-testid={`pickaxe-level-${row.id}`}>
          {row.level === null ? "—" : `Lv${row.level} / 5`}
        </span>
      </div>
      {row.level !== null && (
        <div className="mt-1 flex gap-1" aria-hidden="true">
          {[1, 2, 3, 4, 5].map((i) => (
            <span key={i} className={`h-1.5 flex-1 ${i <= row.level! ? "bg-ember" : "bg-cave-700"}`} />
          ))}
        </div>
      )}
      <div className="mt-2 space-y-0.5">
        <StatLine label="Power" now={now.power} next={next?.power} testId={`pickaxe-power-${row.id}`} />
        <StatLine label="Speed" now={now.speed} next={next?.speed} />
        <StatLine label="Luck" now={now.luck} next={next?.luck} />
      </div>

      {row.status === "locked" && <p className="mt-2 text-xs text-parchment-dim">需先擁有 {previous}（必須依序購買）。</p>}

      {row.status === "purchasable" && row.purchase && (
        <div className="mt-3 border-t-2 border-cave-700 pt-2">
          <div className="mb-1 text-xs font-bold text-ember">購買成本</div>
          <CostList check={row.purchase} testId={`purchase-cost-${row.id}`} />
          {!row.purchase.ok && <p className="mt-1 text-xs text-danger">缺少：{missingText(row.purchase)}</p>}
          <PixelButton
            className="mt-2 w-full py-1.5 text-xs"
            disabled={!actionable || !row.purchase.ok}
            aria-busy={running === `buy:${row.id}`}
            onClick={() => void run(`buy:${row.id}`, { type: "purchase_pickaxe", pickaxeId: row.id })}
            data-testid={`buy-${row.id}`}
          >
            {running === `buy:${row.id}` ? "購買中…" : `購買 ${row.name}`}
          </PixelButton>
        </div>
      )}

      {(row.status === "owned" || row.status === "equipped") && (
        <div className="mt-3 space-y-2 border-t-2 border-cave-700 pt-2">
          {row.status === "owned" && (
            <PixelButton
              tone="secondary"
              className="w-full py-1.5 text-xs"
              disabled={!actionable}
              aria-busy={running === `equip:${row.id}`}
              onClick={() => void run(`equip:${row.id}`, { type: "equip_pickaxe", pickaxeId: row.id })}
              data-testid={`equip-${row.id}`}
            >
              {running === `equip:${row.id}` ? "裝備中…" : `裝備 ${row.name}`}
            </PixelButton>
          )}
          {row.maxed ? (
            <p className="text-center text-xs font-bold text-gold" data-testid={`maxed-${row.id}`}>
              已達最高等級
            </p>
          ) : (
            row.upgrade && (
              <>
                <div className="text-xs font-bold text-ember">強化到 Lv{row.level! + 1}</div>
                <CostList check={row.upgrade} testId={`upgrade-cost-${row.id}`} />
                {!row.upgrade.ok && <p className="text-xs text-danger">缺少：{missingText(row.upgrade)}</p>}
                <PixelButton
                  className="w-full py-1.5 text-xs"
                  disabled={!actionable || !row.upgrade.ok}
                  aria-busy={running === `upgrade:${row.id}`}
                  onClick={() => void run(`upgrade:${row.id}`, { type: "upgrade_pickaxe", pickaxeId: row.id })}
                  data-testid={`upgrade-${row.id}`}
                >
                  {running === `upgrade:${row.id}` ? "強化中…" : `強化 ${pickaxeName(row.id)}`}
                </PixelButton>
              </>
            )
          )}
        </div>
      )}
    </li>
  );
}

function CraftingPanel() {
  const state = useGame((s) => s.view!.state);
  const rows = recipeRows(state);
  return (
    <Panel title="製作素材" right={<span className="text-xs text-parchment-dim">素材不足時整批失敗，不會部分製作</span>}>
      <ul className="grid gap-3 md:grid-cols-3" aria-label="製作">
        {rows.map((r) => (
          <RecipeCard key={r.id} id={r.id} />
        ))}
      </ul>
    </Panel>
  );
}

function RecipeCard({ id }: { id: MaterialId }) {
  const state = useGame((s) => s.view!.state);
  const row = recipeRows(state).find((r) => r.id === id)!;
  const { run, running, actionable } = useAction();
  const [times, setTimes] = useState("1");
  const n = Number(times);
  const valid = Number.isSafeInteger(n) && n >= 1 && n <= Math.max(1, row.maxTimes);
  const can = (k: number) => row.maxTimes >= k;
  const key = `craft:${id}`;
  const lines = row.recipe.map((l) => ({ ...l, need: l.need * (valid ? n : 1) }));
  const missing = lines.filter((l) => l.have < l.need);

  return (
    <li className="bg-cave-900 p-3" data-testid={`recipe-${id}`}>
      <div className="flex items-center gap-2">
        <ItemIcon id={id} />
        <span className="text-sm font-bold">{row.name}</span>
        <span className="ml-auto font-mono text-xs" data-testid={`recipe-owned-${id}`}>
          持有 ×{row.owned}
        </span>
      </div>
      <div className="mt-2 text-xs text-parchment-dim">所需原料（×{valid ? n : 1}）</div>
      <CostList check={{ lines, missing, ok: missing.length === 0 }} />
      <p className="mt-1 text-xs text-parchment-dim">目前最多可製作 {row.maxTimes.toLocaleString("zh-TW")} 個</p>
      {missing.length > 0 && <p className="mt-1 text-xs text-danger">缺少：{missing.map((l) => `${itemName(l.id as never)} ×${l.need - l.have}`).join("、")}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <QuantityInput value={times} max={Math.max(1, row.maxTimes)} onChange={setTimes} label={`${row.name} 製作數量`} disabled={!actionable || row.maxTimes < 1} />
        <PixelButton
          className="px-3 py-1.5 text-xs"
          disabled={!actionable || !valid || !can(n)}
          aria-busy={running === key}
          onClick={async () => {
            const o = await run(key, { type: "craft", materialId: id, times: n });
            if (o === "ok") setTimes("1");
          }}
          data-testid={`craft-${id}`}
        >
          {running === key ? "製作中…" : `製作 ${valid ? n : 1} 個`}
        </PixelButton>
      </div>
    </li>
  );
}
