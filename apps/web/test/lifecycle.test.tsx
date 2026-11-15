// @vitest-environment jsdom
import { act, render, renderHook } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GameScreens } from "@/components/game/GameApp";
import { RuntimeContext } from "@/components/game/runtime-context";
import { useGameRuntime } from "@/components/game/use-game-runtime";
import { MemoryBackend } from "@/lib/game/dev/memory-backend";
import { browserPendingStore, pendingStorageKey } from "@/lib/game/pending";
import { type GameRuntime, type RuntimeFactory, activeRuntimeCount, disposeAllRuntimes } from "@/lib/game/runtime";
import { flush, rig } from "./helpers";

afterEach(() => {
  disposeAllRuntimes();
  localStorage.clear();
});

function factoryOn(backend: MemoryBackend) {
  const made: GameRuntime[] = [];
  const factory: RuntimeFactory = (userId) => {
    const r = rig({ backend, userId });
    const rt = { userId, api: null as never, store: r.store, controller: r.controller };
    made.push(rt);
    return rt;
  };
  return { factory, made };
}

const strict = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;

describe("Runtime 生命週期", () => {
  it("Strict Mode 重複掛載：只建立一組 runtime；卸載後才 dispose", async () => {
    const { factory, made } = factoryOn(new MemoryBackend());
    const id = crypto.randomUUID();
    const { result, unmount } = renderHook(() => useGameRuntime(id, () => {}, factory), { wrapper: strict });
    await act(async () => {});
    expect(made).toHaveLength(1);
    expect(result.current).toBe(made[0]);
    expect(activeRuntimeCount()).toBe(1);
    unmount();
    expect(made[0]!.controller.isDisposed).toBe(false); // 延後到下一個 macrotask
    await act(async () => new Promise((r) => setTimeout(r, 5)));
    expect(made[0]!.controller.isDisposed).toBe(true);
    expect(activeRuntimeCount()).toBe(0);
  });

  it("換帳號：舊 runtime 立即 dispose；舊請求晚到不會寫入任何 store；回傳值不會是上一位玩家的", async () => {
    const backend = new MemoryBackend();
    const { factory, made } = factoryOn(backend);
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    const { result, rerender } = renderHook(({ id }) => useGameRuntime(id, () => {}, factory), { initialProps: { id: a as string | null } });
    await act(async () => {});
    const rtA = result.current!;
    await rtA.controller.createCharacter();
    backend.latencyMs = 20;
    const late = rtA.controller.sync(); // A 的請求進行中
    const snapshotA = rtA.store.getState();
    rerender({ id: b });
    expect(result.current?.userId ?? b).toBe(b);
    await act(async () => {});
    expect(rtA.controller.isDisposed).toBe(true);
    await late;
    await new Promise((r) => setTimeout(r, 40));
    expect(rtA.store.getState()).toBe(snapshotA);
    const rtB = result.current!;
    expect(rtB).toBe(made[1]);
    expect(rtB.store.getState().view).toBeNull();
    rerender({ id: null });
    await act(async () => new Promise((r) => setTimeout(r, 5)));
    expect(result.current).toBeNull();
    expect(rtB.controller.isDisposed).toBe(true);
  });

  it("未確認操作依使用者分開保存：換帳號不會讀到上一位玩家的操作", () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    const p = { requestId: crypto.randomUUID(), command: { type: "craft", materialId: "iron_ingot", times: 1 } as const, createdAt: 1 };
    browserPendingStore(a).save(p);
    expect(localStorage.getItem(pendingStorageKey(a))).not.toBeNull();
    expect(browserPendingStore(b).load()).toBeNull();
    expect(browserPendingStore(a).load()).toEqual(p);
    browserPendingStore(a).save(null);
    expect(localStorage.getItem(pendingStorageKey(a))).toBeNull();
  });

  it("GameScreens 卸載時移除事件監聽並停止計時器", async () => {
    const r = rig();
    await r.controller.createCharacter();
    const rt = { userId: r.userId, api: null as never, store: r.store, controller: r.controller };
    const added: string[] = [];
    const removed: string[] = [];
    const docAdd = vi.spyOn(document, "addEventListener").mockImplementation(function (this: Document, t: string) {
      added.push(t);
    } as never);
    const docRemove = vi.spyOn(document, "removeEventListener").mockImplementation(((t: string) => void removed.push(t)) as never);
    const winAdd = vi.spyOn(window, "addEventListener").mockImplementation(((t: string) => void added.push(t)) as never);
    const winRemove = vi.spyOn(window, "removeEventListener").mockImplementation(((t: string) => void removed.push(t)) as never);
    const view = render(
      <RuntimeContext.Provider value={rt}>
        <GameScreens email={null} onSignOut={() => {}} />
      </RuntimeContext.Provider>,
    );
    await act(async () => flush());
    expect(r.clock.pending).toHaveLength(1);
    view.unmount();
    for (const t of ["visibilitychange", "online", "focus"]) {
      expect(added).toContain(t);
      expect(removed).toContain(t);
    }
    expect(r.clock.pending).toHaveLength(0);
    [docAdd, docRemove, winAdd, winRemove].forEach((s) => s.mockRestore());
  });
});
