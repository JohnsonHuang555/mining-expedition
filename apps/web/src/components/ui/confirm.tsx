"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { useDialogFocus } from "./dialog-focus";
import { PixelButton } from "./pixel";

/**
 * 重要交易的確認視窗（避免誤觸大量出售）。
 * - 開啟時聚焦「取消」；Tab / Shift+Tab 只在視窗內循環（focus trap）；Esc 取消。
 * - 關閉後把焦點還給開啟視窗前的元素。
 * - 確認只會觸發一次；`disabled`（例如出現待領報告或未確認操作）時無法確認。
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  onConfirm,
  onCancel,
  disabled = false,
  disabledReason,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm(): void;
  onCancel(): void;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef(onCancel);
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => {
    cancelRef.current = onCancel;
  });
  useDialogFocus(dialog, () => cancelRef.current(), cancel);

  const blocked = disabled || submitted;
  return (
    <div role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" className="fixed inset-0 z-40 flex items-end justify-center bg-black/70 p-3 sm:items-center">
      <div ref={dialog} className="pixel-frame animate-pop w-full max-w-sm p-4">
        <h2 id="confirm-title" className="text-base font-black text-gold">
          {title}
        </h2>
        <div className="mt-2 text-sm">{children}</div>
        {disabled && disabledReason && (
          <p className="mt-2 text-xs text-danger" role="status">
            {disabledReason}
          </p>
        )}
        <div className="mt-4 grid grid-cols-2 gap-3">
          <PixelButton tone="ghost" ref={cancel} onClick={() => cancelRef.current()}>
            取消
          </PixelButton>
          <PixelButton
            disabled={blocked}
            onClick={() => {
              if (blocked) return;
              setSubmitted(true);
              onConfirm();
            }}
          >
            {confirmLabel}
          </PixelButton>
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
