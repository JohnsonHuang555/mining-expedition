"use client";

import { ARTIFACTS, ZONES } from "@mining/game-data";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArtifactIcon } from "@/components/ui/artifact-icon";
import { useDialogFocus } from "@/components/ui/dialog-focus";
import { PixelButton } from "@/components/ui/pixel";
import { artifactName } from "@/lib/game/format";
import type { RevealItem } from "@/lib/game/reveal";
import { useController, useGame } from "./runtime-context";

/** prefers-reduced-motion：開啟時直接顯示靜態卡片（不播放長動畫） */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const h = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener?.("change", h);
    return () => mq.removeEventListener?.("change", h);
  }, []);
  return reduced;
}

/**
 * 寶物揭曉（GDD §4.2 / §7.4：Epic 特殊卡片、Legendary 全螢幕）。佇列在 Controller（共用 runtime），
 * 這裡只顯示第一筆；看完 / 略過後才換下一筆。有待領報告時先顯示報告（D20），不顯示揭曉。
 * 演出只影響畫面：不阻擋同步排程、不改變任何結算。
 */
export function RevealOverlay() {
  const reveals = useGame((s) => s.reveals);
  const reportPending = useGame((s) => s.view?.state.pendingOfflineReport != null);
  const item = reveals[0];
  if (!item || reportPending) return null;
  return <RevealCard key={item.key} item={item} remaining={reveals.length - 1} />;
}

function RevealCard({ item, remaining }: { item: RevealItem; remaining: number }) {
  const controller = useController();
  const reduced = useReducedMotion();
  const panel = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const dismiss = () => controller.dismissReveal(item.key);
  useDialogFocus(panel, dismiss, primary);
  const legendary = item.rarity === "legendary";
  const name = artifactName(item.artifactId);
  const zone = ZONES[zoneIndexOf(item.artifactId)]?.name;

  const badges = (
    <div className="mt-2 flex flex-wrap justify-center gap-1">
      <span className={`px-1.5 py-0.5 text-[11px] font-black ${legendary ? "bg-gold text-cave-950" : "bg-crystal text-cave-950"}`} data-testid="reveal-rarity">
        {legendary ? "LEGENDARY" : "EPIC"}
      </span>
      {item.isNewDiscovery && (
        <span className="bg-moss px-1.5 py-0.5 text-[11px] font-black text-cave-950" data-testid="reveal-new">
          NEW DISCOVERY
        </span>
      )}
      {item.protection && (
        <span className="bg-ember px-1.5 py-0.5 text-[11px] font-black text-cave-950" data-testid="reveal-protection">
          首次寶物保護
        </span>
      )}
    </div>
  );

  const actions = (
    <div className="mt-5 grid gap-2">
      <PixelButton ref={primary} className="w-full py-2.5" onClick={dismiss} data-testid="reveal-next">
        {remaining > 0 ? `收下（還有 ${remaining} 件）` : "收下"}
      </PixelButton>
      <div className="grid grid-cols-2 gap-2">
        <Link href="/collection" onClick={() => controller.dismissAllReveals()} className="pixel-btn bg-cave-600 px-2 py-2 text-center text-xs text-parchment" data-testid="reveal-collection">
          前往圖鑑
        </Link>
        <PixelButton tone="ghost" className="px-2 py-2 text-xs" onClick={() => controller.dismissAllReveals()} disabled={remaining === 0} data-testid="reveal-skip-all">
          全部略過
        </PixelButton>
      </div>
    </div>
  );

  return (
    <div
      className={`fixed inset-0 z-[60] flex items-center justify-center p-3 ${legendary ? "bg-cave-950" : "bg-black/75"}`}
      data-testid="reveal-overlay"
      data-rarity={item.rarity}
      data-reduced={reduced || undefined}
    >
      {legendary && (
        <>
          {!reduced && <div className="reveal-rays pointer-events-none absolute left-1/2 top-1/2 h-[180vmax] w-[180vmax] -translate-x-1/2 -translate-y-1/2" aria-hidden="true" />}
          <div className="reveal-breathe pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_45%,rgb(252_211_77/0.35),transparent_55%)]" aria-hidden="true" />
        </>
      )}
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={`${legendary ? "傳說寶物" : "寶物"}揭曉：${name}`}
        tabIndex={-1}
        className={`relative w-full outline-none ${legendary ? "max-w-md" : "max-w-xs"} ${reduced ? "" : "reveal-rise"}`}
      >
        <div
          className={`pixel-frame p-5 text-center ${legendary ? "shadow-[0_0_0_4px_var(--color-gold),0_0_0_8px_#000]" : "shadow-[0_0_0_4px_var(--color-crystal),0_0_0_8px_#000]"}`}
          data-testid="reveal-card"
        >
          <p className={`text-xs font-bold tracking-[0.3em] ${legendary ? "text-gold" : "text-crystal"}`}>{item.origin === "offline" ? "探險成果" : "挖到了寶物！"}</p>
          <div className="relative mx-auto mt-3 flex w-fit items-center justify-center">
            {!reduced &&
              [0, 1, 2, 3].map((i) => (
                <span
                  key={i}
                  className={`reveal-particle absolute h-1.5 w-1.5 ${legendary ? "bg-gold" : "bg-crystal"}`}
                  style={{ left: `${10 + i * 26}%`, bottom: "10%", animationDelay: `${i * 0.45}s` }}
                  aria-hidden="true"
                />
              ))}
            <ArtifactIcon id={item.artifactId} discovered zone={zoneIndexOf(item.artifactId)} legendary={legendary} size={legendary ? 128 : 96} />
          </div>
          <h2 className={`mt-3 text-xl font-black ${legendary ? "text-gold" : "text-crystal"}`} data-testid="reveal-name">
            {name}
          </h2>
          <p className="text-xs text-parchment-dim">{zone}</p>
          {badges}
          {actions}
        </div>
      </div>
    </div>
  );
}

function zoneIndexOf(id: RevealItem["artifactId"]): number {
  return ARTIFACTS[id].zone;
}
