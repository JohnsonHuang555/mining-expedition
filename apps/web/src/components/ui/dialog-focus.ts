"use client";

import { type RefObject, useEffect, useRef } from "react";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 對話框的焦點管理（ConfirmDialog、寶物詳情、寶物揭曉共用）：
 * - 開啟時把焦點移入對話框（initialFocus，沒有則第一個可聚焦元素，再沒有則對話框本身）。
 * - Escape 呼叫 onEscape。
 * - Tab / Shift+Tab 只在對話框內循環；焦點跑到外面時拉回。
 * - 卸載時把焦點還給開啟前的元素（仍在文件中時）。
 * onEscape 以 ref 保存，重新 render 不會重新執行（不會重新搶焦點）。
 */
export function useDialogFocus(container: RefObject<HTMLElement | null>, onEscape: () => void, initialFocus?: RefObject<HTMLElement | null>): void {
  const escape = useRef(onEscape);
  useEffect(() => {
    escape.current = onEscape;
  });
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = container.current;
    const first = () => root?.querySelector<HTMLElement>(FOCUSABLE) ?? null;
    (initialFocus?.current ?? first() ?? root)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        escape.current();
        return;
      }
      if (e.key !== "Tab" || !root) return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }
      const head = items[0]!;
      const tail = items[items.length - 1]!;
      const active = document.activeElement;
      if (!root.contains(active)) {
        e.preventDefault();
        head.focus();
      } else if (e.shiftKey && (active === head || active === root)) {
        e.preventDefault();
        tail.focus();
      } else if (!e.shiftKey && active === tail) {
        e.preventDefault();
        head.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (opener?.isConnected) opener.focus();
    };
    // 只在開啟 / 關閉時執行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
