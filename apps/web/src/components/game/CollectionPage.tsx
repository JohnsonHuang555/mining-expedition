"use client";

import type { ArtifactRarity } from "@mining/game-data";
import Link from "next/link";
import { useRef, useState } from "react";
import { ArtifactIcon } from "@/components/ui/artifact-icon";
import { useDialogFocus } from "@/components/ui/dialog-focus";
import { Panel, PixelBar, PixelButton } from "@/components/ui/pixel";
import {
  type CollectionEntry,
  type CollectionFilter,
  type SetRow,
  collectionEntries,
  collectionProgress,
  filterEntries,
  setBonusText,
  setRows,
} from "@/lib/game/collection";
import { bandRange, coins, formatStats, zoneName } from "@/lib/game/format";
import { useGame } from "./runtime-context";

const RARITY = { epic: { label: "Epic", cls: "bg-crystal/20 text-crystal" }, legendary: { label: "Legendary", cls: "bg-gold/20 text-gold" } } as const;
const pct = (r: number) => `${Math.round(r * 100)}%`;

/**
 * 寶物圖鑑（/collection）。
 * 未發現：剪影 + 「？？？」，只顯示礦區與稀有度（GBS §8.3 的公開資料；名稱、外觀、套組歸屬在發現前不揭露）。
 * 已發現與目前持有分開顯示；能力值只顯示伺服器回傳的數值。
 */
export function CollectionPage() {
  const state = useGame((s) => s.view!.state);
  const entries = collectionEntries(state);
  const progress = collectionProgress(entries);
  const [tab, setTab] = useState<"artifacts" | "sets">("artifacts");

  return (
    <div className="flex flex-col gap-4">
      <Panel title="收藏進度" right={<span className="font-mono text-sm text-gold" data-testid="collection-overall">{progress.overall.found} / {progress.overall.total}（{pct(progress.overall.ratio)}）</span>}>
        <PixelBar value={progress.overall.ratio} label="圖鑑完成率" tone="crystal" />
        <div className="mt-3 grid grid-cols-3 gap-2">
          {progress.byZone.map((p, z) => (
            <div key={z} className="text-xs" data-testid={`collection-zone-${z}`}>
              <div className="flex justify-between gap-1">
                <span className="truncate text-parchment-dim">{zoneName(z)}</span>
                <span className="font-mono">
                  {p.found}/{p.total}
                </span>
              </div>
              <div className="mt-1 h-1.5 bg-cave-950">
                <div className="h-full bg-crystal" style={{ width: pct(p.ratio) }} />
              </div>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-parchment-dim">圖鑑紀錄永久保留：出售寶物後仍算已發現。</p>
      </Panel>

      <div className="grid grid-cols-2 gap-2" role="tablist" aria-label="圖鑑分類">
        {(
          [
            ["artifacts", "寶物"],
            ["sets", "套組"],
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`py-2 text-sm font-bold ${tab === k ? "bg-ember text-cave-950" : "bg-cave-700 text-parchment-dim"}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === "artifacts" ? <ArtifactGrid entries={entries} /> : <SetList />}
    </div>
  );
}

function Chips<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange(v: T): void }) {
  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label={label}>
      <span className="w-10 shrink-0 text-[11px] text-parchment-dim">{label}</span>
      {options.map(([v, text]) => (
        <button
          key={String(v)}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={`px-2 py-1 text-xs ${value === v ? "bg-ember text-cave-950" : "bg-cave-700 text-parchment-dim"}`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function ArtifactGrid({ entries }: { entries: CollectionEntry[] }) {
  const [filter, setFilter] = useState<CollectionFilter>({ status: "all", zone: "all", rarity: "all" });
  const [selected, setSelected] = useState<CollectionEntry["id"] | null>(null);
  const list = filterEntries(entries, filter);
  const detail = entries.find((e) => e.id === selected) ?? null;

  return (
    <Panel>
      <div className="flex flex-col gap-2">
        <Chips label="狀態" value={filter.status} options={[["all", "全部"], ["discovered", "已發現"], ["undiscovered", "未發現"]]} onChange={(status) => setFilter({ ...filter, status })} />
        <Chips<0 | 1 | 2 | "all"> label="礦區" value={filter.zone} options={[["all", "全部"], [0, zoneName(0)], [1, zoneName(1)], [2, zoneName(2)]]} onChange={(zone) => setFilter({ ...filter, zone })} />
        <Chips<ArtifactRarity | "all"> label="稀有度" value={filter.rarity} options={[["all", "全部"], ["epic", "Epic"], ["legendary", "Legendary"]]} onChange={(rarity) => setFilter({ ...filter, rarity })} />
      </div>
      {list.length === 0 ? (
        <p className="py-6 text-center text-sm text-parchment-dim" data-testid="collection-empty">
          沒有符合條件的寶物。
        </p>
      ) : (
        <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4" aria-label="寶物">
          {list.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                onClick={() => setSelected(e.id)}
                className={`flex w-full flex-col items-center gap-1 p-2 text-center ${e.discovery ? (e.held === 0 ? "bg-cave-900 opacity-75 shadow-[0_0_0_2px_var(--color-cave-600)]" : e.rarity === "legendary" ? "bg-gold/10 shadow-[0_0_0_2px_var(--color-gold)]" : "bg-cave-900 shadow-[0_0_0_2px_var(--color-crystal)]") : "bg-cave-950/70"}`}
                data-testid={`artifact-${e.id}`}
                data-discovered={e.discovery ? "true" : "false"}
                aria-label={e.discovery ? `${e.name}，持有 ${e.held}` : `未發現的寶物（${zoneName(e.zone)}）`}
              >
                <ArtifactIcon id={e.id} discovered={!!e.discovery} zone={e.zone} legendary={e.rarity === "legendary"} />
                <span className={`text-xs font-bold ${e.discovery ? "" : "text-parchment-dim"}`}>{e.discovery ? e.name : "？？？"}</span>
                <span className={`px-1 text-[10px] ${RARITY[e.rarity].cls}`}>{RARITY[e.rarity].label}</span>
                <span className="text-[10px] text-parchment-dim">
                  {zoneName(e.zone)}
                  {e.discovery && <span data-testid={`artifact-held-${e.id}`}>{e.held > 0 ? `・持有 ×${e.held}` : "・已發現，未持有"}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {detail && <ArtifactDetail entry={detail} onClose={() => setSelected(null)} />}
    </Panel>
  );
}

function ArtifactDetail({ entry: e, onClose }: { entry: CollectionEntry; onClose(): void }) {
  const set = setRows(useGame((s) => s.view!.state)).find((s) => s.id === e.set);
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useDialogFocus(panel, onClose, close);
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/70 p-3 sm:items-center" onClick={onClose} data-testid="artifact-detail-backdrop">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={e.discovery ? e.name : "未發現的寶物"}
        tabIndex={-1}
        className="pixel-frame animate-pop w-full max-w-sm p-4 outline-none"
        onClick={(ev) => ev.stopPropagation()}
        data-testid="artifact-detail"
      >
        <div className="flex items-center gap-3">
          <ArtifactIcon id={e.id} discovered={!!e.discovery} zone={e.zone} legendary={e.rarity === "legendary"} size={64} />
          <div>
            <h2 className="text-base font-black text-gold">{e.discovery ? e.name : "？？？"}</h2>
            <div className="mt-1 flex flex-wrap gap-1 text-[11px]">
              <span className={`px-1 ${RARITY[e.rarity].cls}`}>{RARITY[e.rarity].label}</span>
              <span className="bg-cave-700 px-1">{zoneName(e.zone)}</span>
            </div>
          </div>
        </div>
        {e.discovery ? (
          <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
            <dt className="text-parchment-dim">目前持有</dt>
            <dd className="text-right font-mono" data-testid="detail-held">×{e.held}</dd>
            <dt className="text-parchment-dim">歷史發現次數</dt>
            <dd className="text-right font-mono" data-testid="detail-found">×{e.discovery.totalFound}</dd>
            <dt className="text-parchment-dim">首次發現</dt>
            <dd className="text-right font-mono text-xs" data-testid="detail-first">{new Date(e.discovery.firstDiscoveredAt).toLocaleString("zh-TW", { hour12: false })}</dd>
            <dt className="text-parchment-dim">首次發現深度</dt>
            <dd className="text-right font-mono">{bandRange(e.discovery.firstBand)}</dd>
            <dt className="text-parchment-dim">所屬套組</dt>
            <dd className="text-right">{set ? set.name : "—"}</dd>
            <dt className="text-parchment-dim">基礎估值</dt>
            <dd className="text-right font-mono">{coins(e.baseValue)}</dd>
          </dl>
        ) : (
          <p className="mt-3 text-sm text-parchment-dim">尚未發現。在{zoneName(e.zone)}挖掘時有機會取得。</p>
        )}
        {e.discovery && (
          <p className="mt-2 text-[11px] text-parchment-dim">
            基礎估值不是當日成交價。
            <Link href={`/market#market-${e.id}`} className="ml-1 text-gold underline" data-testid="detail-market-link">
              查看市場行情
            </Link>
            （出售後圖鑑紀錄仍會保留）
          </p>
        )}
        <PixelButton tone="secondary" className="mt-4 w-full" onClick={onClose} ref={close}>
          關閉
        </PixelButton>
      </div>
    </div>
  );
}

function SetList() {
  const state = useGame((s) => s.view!.state);
  const stats = useGame((s) => s.view!.stats);
  const rows = setRows(state);
  const st = formatStats(stats);
  return (
    <div className="flex flex-col gap-3">
      <p className="bg-cave-900 px-3 py-2 text-xs text-parchment-dim">
        套組必須<span className="text-parchment">實際持有全部成員</span>才生效；出售其中一件即失效，重新取得後恢復（D3）。目前能力值（伺服器）：Power{" "}
        <span className="font-mono text-parchment">{st.power}</span>・Speed <span className="font-mono text-parchment" data-testid="sets-speed">{st.speed}</span>・Luck{" "}
        <span className="font-mono text-parchment" data-testid="sets-luck">{st.luck}</span>
      </p>
      <ul className="grid gap-3 md:grid-cols-3" aria-label="套組">
        {rows.map((r) => (
          <SetCard key={r.id} row={r} />
        ))}
      </ul>
    </div>
  );
}

function Flag({ ok, label, testId }: { ok: boolean; label: string; testId: string }) {
  return (
    <li className={`flex items-center gap-1 ${ok ? "text-moss" : "text-parchment-dim"}`} data-testid={testId} data-ok={ok}>
      <span aria-hidden="true">{ok ? "■" : "□"}</span>
      {label}
    </li>
  );
}

function SetCard({ row: r }: { row: SetRow }) {
  const names = Object.fromEntries(collectionEntries(useGame((s) => s.view!.state)).map((e) => [e.id, e]));
  return (
    <li className={`bg-cave-900 p-3 ${r.active ? "shadow-[0_0_0_3px_var(--color-moss)]" : ""}`} data-testid={`set-${r.id}`} data-active={r.active}>
      <div className="flex items-center gap-2">
        <span className="text-sm font-bold">{r.name}</span>
        <span className={`ml-auto px-1.5 py-0.5 text-[10px] font-bold ${r.active ? "bg-moss text-cave-950" : "bg-cave-700 text-parchment-dim"}`} data-testid={`set-status-${r.id}`}>
          {r.active ? "加成生效中" : "未生效"}
        </span>
      </div>
      <div className="mt-2 flex gap-2">
        {r.members.map((m) => (
          <div key={m.id} className={`flex flex-1 flex-col items-center gap-0.5 p-1 ${m.held > 0 ? "bg-crystal/15" : "bg-cave-950/60"}`} title={m.discovered ? names[m.id]!.name : "未發現"}>
            <ArtifactIcon id={m.id} discovered={m.discovered} zone={names[m.id]!.zone} legendary={names[m.id]!.rarity === "legendary"} size={32} />
            <span className="text-center text-[10px] leading-tight">{m.discovered ? names[m.id]!.name : "？？？"}</span>
            <span className="text-[10px] text-parchment-dim">{m.held > 0 ? `持有 ×${m.held}` : m.discovered ? "未持有" : "未發現"}</span>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between text-xs">
        <span className="text-parchment-dim">目前持有</span>
        <span className="font-mono" data-testid={`set-held-${r.id}`}>
          {r.heldMembers} / {r.total}
        </span>
      </div>
      <div className="mt-1 h-1.5 bg-cave-950">
        <div className={`h-full ${r.active ? "bg-moss" : "bg-ember"}`} style={{ width: pct(r.heldMembers / r.total) }} />
      </div>
      <ul className="mt-2 space-y-0.5 text-[11px]">
        <Flag ok={r.allDiscovered} label="圖鑑已發現全部成員" testId={`set-discovered-${r.id}`} />
        <Flag ok={r.ownedNow} label="目前持有全部成員" testId={`set-owned-${r.id}`} />
        <Flag ok={r.active} label="套組加成生效中" testId={`set-active-${r.id}`} />
      </ul>
      <div className="mt-2 text-xs">
        完成加成：<span className="font-bold text-gold" data-testid={`set-bonus-${r.id}`}>{setBonusText(r)}</span>
      </div>
      {r.missing.length > 0 && (
        <p className="mt-1 text-[11px] text-danger" data-testid={`set-missing-${r.id}`}>
          缺少：
          {[
            ...r.missing.filter((m) => m.discovered).map((m) => `${names[m.id]!.name}（已發現，目前未持有）`),
            ...(r.missing.some((m) => !m.discovered) ? [`未發現的寶物 ×${r.missing.filter((m) => !m.discovered).length}`] : []),
          ].join("、")}
        </p>
      )}
    </li>
  );
}
