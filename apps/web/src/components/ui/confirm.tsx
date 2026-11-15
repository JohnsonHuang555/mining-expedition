"use client";

import { type ReactNode, useEffect, useRef } from "react";
import { PixelButton } from "./pixel";

/** 重要交易的確認視窗（避免誤觸大量出售） */
export function ConfirmDialog({ title, children, confirmLabel, onConfirm, onCancel }: { title: string; children: ReactNode; confirmLabel: string; onConfirm(): void; onCancel(): void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancel.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" className="fixed inset-0 z-40 flex items-end justify-center bg-black/70 p-3 sm:items-center">
      <div className="pixel-frame animate-pop w-full max-w-sm p-4">
        <h2 id="confirm-title" className="text-base font-black text-gold">
          {title}
        </h2>
        <div className="mt-2 text-sm">{children}</div>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <PixelButton tone="ghost" ref={cancel} onClick={onCancel}>
            取消
          </PixelButton>
          <PixelButton onClick={onConfirm}>{confirmLabel}</PixelButton>
        </div>
      </div>
    </div>
  );
}

/** 數量輸入：- / 數字 / + / 全部；不合法時由呼叫端停用送出 */
export function QuantityInput({ value, max, onChange, label, disabled }: { value: string; max: number; onChange(v: string): void; label: string; disabled?: boolean }) {
  const n = Number(value);
  const step = (d: number) => onChange(String(Math.max(1, Math.min(max, (Number.isFinite(n) ? Math.floor(n) : 0) + d))));
  return (
    <div className="flex items-stretch gap-1">
      <button type="button" className="bg-cave-700 px-2 text-sm disabled:opacity-40" onClick={() => step(-1)} disabled={disabled || n <= 1} aria-label={`${label} 減少`}>
        −
      </button>
      <input
        type="number"
        inputMode="numeric"
        min={1}
        max={max}
        step={1}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        className="w-16 bg-cave-950 px-2 py-1 text-right font-mono text-sm text-parchment shadow-[0_0_0_2px_#000] outline-none focus:shadow-[0_0_0_2px_var(--color-ember)] sm:w-20"
      />
      <button type="button" className="bg-cave-700 px-2 text-sm disabled:opacity-40" onClick={() => step(1)} disabled={disabled || n >= max} aria-label={`${label} 增加`}>
        +
      </button>
      <button type="button" className="bg-cave-700 px-2 text-xs disabled:opacity-40" onClick={() => onChange(String(max))} disabled={disabled || max < 1}>
        全部
      </button>
    </div>
  );
}
