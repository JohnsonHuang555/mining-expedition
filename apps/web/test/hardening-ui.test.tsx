// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeAction } from "@/components/game/ActionToast";
import { ConfirmDialog } from "@/components/ui/confirm";
import { browserPendingStore, legacyPendingStorageKey, pendingStorageKey } from "@/lib/game/pending";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.doUnmock("@/lib/auth/supabase");
  vi.resetModules();
});

describe("舊 Runtime 的延遲 401 不得登出新帳號", () => {
  it("A 登出、B 登入後，A 的請求才收到 401：不更新 / 不登出 B 的 session，A 的 store 不變", async () => {
    vi.resetModules();
    const A = crypto.randomUUID();
    const B = crypto.randomUUID();
    let session: { user: { id: string }; access_token: string } | null = { user: { id: A }, access_token: "token-a" };
    const auth = {
      getSession: vi.fn(async () => ({ data: { session } })),
      refreshSession: vi.fn(async () => ({ data: { session }, error: null })),
      signOut: vi.fn(async () => void (session = null)),
    };
    vi.doMock("@/lib/auth/supabase", () => ({ getSupabase: () => ({ auth }), publicSupabaseEnv: () => ({ url: "http://sb.test", anonKey: "anon" }) }));
    // 第一個請求停住，直到測試讓它回 401
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetch = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify({ ok: false, requestId: null, command: null, error: { code: "UNAUTHORIZED", message: "x" } }), { status: 401 });
    });
    vi.stubGlobal("fetch", fetch);
    const { browserRuntimeFactory } = await import("@/lib/game/runtime");
    const rtA = browserRuntimeFactory(A, () => {})!;
    const pending = rtA.controller.bootstrap();
    await act(async () => {});
    const storeBefore = rtA.store.getState(); // busy = bootstrap（請求進行中）
    // A 登出、B 登入（共用同一個 Supabase client）
    session = { user: { id: B }, access_token: "token-b" };
    rtA.controller.dispose();
    release();
    await pending;
    await new Promise((r) => setTimeout(r, 0));
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(auth.refreshSession).not.toHaveBeenCalled();
    expect(session?.user.id).toBe(B);
    expect(rtA.store.getState()).toBe(storeBefore);
    // A 的 runtime 之後也不會帶著 B 的 token 送出請求
    const n = fetch.mock.calls.length;
    const r = await rtA.api.getState();
    expect(r).toMatchObject({ ok: false, code: "UNAUTHORIZED" });
    expect(fetch.mock.calls.length).toBe(n);
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it("同一位使用者的 token 真的失效（refresh 失敗）：才會登出", async () => {
    vi.resetModules();
    const A = crypto.randomUUID();
    let session: { user: { id: string }; access_token: string } | null = { user: { id: A }, access_token: "token-a" };
    const auth = {
      getSession: vi.fn(async () => ({ data: { session } })),
      refreshSession: vi.fn(async () => ({ data: { session: null }, error: { message: "invalid refresh token" } })),
      signOut: vi.fn(async () => void (session = null)),
    };
    vi.doMock("@/lib/auth/supabase", () => ({ getSupabase: () => ({ auth }), publicSupabaseEnv: () => ({ url: "http://sb.test", anonKey: "anon" }) }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    const { browserRuntimeFactory } = await import("@/lib/game/runtime");
    const signedOut = vi.fn();
    const rt = browserRuntimeFactory(A, signedOut)!;
    await rt.controller.bootstrap();
    expect(auth.refreshSession).toHaveBeenCalledTimes(1);
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(rt.store.getState().phase).toBe("signed_out");
    expect(signedOut).toHaveBeenCalled();
  });
});

describe("未確認操作的保存（v2：每筆一個 key）", () => {
  it("兩個分頁各自新增 / 刪除自己的紀錄，不會互相覆蓋；舊版（v1）紀錄自動轉換", () => {
    const u = crypto.randomUUID();
    const tabA = browserPendingStore(u);
    const tabB = browserPendingStore(u);
    const sell = { requestId: crypto.randomUUID(), command: { type: "sell_items", itemId: "stone", quantity: 1 } as const, createdAt: Date.now() + 1 };
    const buy = { requestId: crypto.randomUUID(), command: { type: "purchase_pickaxe", pickaxeId: "pick_stone" } as const, createdAt: Date.now() + 2 };
    tabA.put(sell);
    tabB.put(buy);
    expect(tabA.list()).toEqual([sell, buy]);
    tabB.remove(buy.requestId);
    expect(tabA.list()).toEqual([sell]);
    expect(localStorage.getItem(pendingStorageKey(u, sell.requestId))).not.toBeNull();

    const legacy = { requestId: crypto.randomUUID(), command: { type: "craft", materialId: "iron_ingot", times: 1 } as const, createdAt: Date.now() - 60_000 };
    localStorage.setItem(legacyPendingStorageKey(u), JSON.stringify(legacy));
    expect(tabB.list()).toEqual([legacy, sell]);
    expect(localStorage.getItem(legacyPendingStorageKey(u))).toBeNull();
    localStorage.setItem(pendingStorageKey(u, crypto.randomUUID()), "garbage");
    expect(tabB.list()).toEqual([legacy, sell]); // 壞掉的紀錄被丟棄
  });

  it("其他分頁修改 storage 時通知（storage 事件）", () => {
    const u = crypto.randomUUID();
    const fn = vi.fn();
    const off = browserPendingStore(u).subscribe!(fn);
    window.dispatchEvent(new StorageEvent("storage", { key: pendingStorageKey(u, crypto.randomUUID()) }));
    window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" }));
    expect(fn).toHaveBeenCalledTimes(1);
    off();
  });
});

function Harness({ disabled = false, onConfirm }: { disabled?: boolean; onConfirm(): void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        出售全部
      </button>
      {open && (
        <ConfirmDialog title="確認出售" confirmLabel="確定出售" disabled={disabled} disabledReason="有待領取的報告" onCancel={() => setOpen(false)} onConfirm={onConfirm}>
          <input aria-label="備註" />
        </ConfirmDialog>
      )}
    </>
  );
}

describe("ConfirmDialog", () => {
  it("開啟時聚焦取消；Tab / Shift+Tab 只在視窗內循環；Esc 關閉並把焦點還給開啟按鈕", () => {
    render(<Harness onConfirm={() => {}} />);
    const opener = screen.getByRole("button", { name: "出售全部" });
    opener.focus();
    fireEvent.click(opener);
    const cancel = screen.getByRole("button", { name: "取消" });
    const input = screen.getByLabelText("備註");
    const confirm = screen.getByRole("button", { name: "確定出售" });
    expect(document.activeElement).toBe(cancel);
    confirm.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(input); // 最後一個 → 回到第一個
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(confirm); // 第一個 → 最後一個
    opener.focus(); // 焦點跑到視窗外
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("確認只觸發一次；disabled 時無法確認並顯示原因", () => {
    const onConfirm = vi.fn();
    const { unmount } = render(<Harness onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "出售全部" }));
    const confirm = screen.getByRole("button", { name: "確定出售" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.keyDown(confirm, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    unmount();

    const blocked = vi.fn();
    render(<Harness disabled onConfirm={blocked} />);
    fireEvent.click(screen.getByRole("button", { name: "出售全部" }));
    fireEvent.click(screen.getByRole("button", { name: "確定出售" }));
    expect(blocked).not.toHaveBeenCalled();
    expect(screen.getByText("有待領取的報告")).toBeTruthy();
  });
});

describe("交易提示文字", () => {
  const base = { requestId: "r", command: "purchase_pickaxe" as const, events: [], at: 0, code: null };
  it("拒絕：交易未執行；結算已同步時另外說明；未確認：會自動確認", () => {
    expect(describeAction({ ...base, outcome: "rejected", message: "金幣不足", synced: false })).toBe("✗ 金幣不足：此操作未執行，沒有扣除金幣或素材");
    expect(describeAction({ ...base, outcome: "rejected", message: "金幣不足", synced: true })).toBe("✗ 金幣不足：此操作未執行，沒有扣除金幣或素材（挖掘結算已同步）");
    expect(describeAction({ ...base, outcome: "uncertain", message: null, synced: false })).toContain("結果尚未確認");
    expect(describeAction({ ...base, outcome: "rejected", message: "x", synced: true })).not.toContain("沒有任何變更");
  });
});
