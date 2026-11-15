import { describe, expect, it } from "vitest";
import { MemoryBackend } from "@/lib/game/dev/memory-backend";
import { type PendingAction, memoryPendingStore, parsePending } from "@/lib/game/pending";
import { rig } from "./helpers";

/** 有足夠資源購買石製十字鎬的玩家 */
async function richPlayer(backend = new MemoryBackend(), pendingStore = memoryPendingStore()) {
  const r = rig({ backend, pendingStore });
  await r.controller.createCharacter();
  backend.mutate(r.userId, (s) => {
    s.coins = 1_000;
    s.inventory = { stone: 200, iron_ore: 50 };
  });
  await r.controller.retryBootstrap();
  return r;
}
const purchases = (r: ReturnType<typeof rig>) =>
  r.backend.requests.filter((x) => x.fn === "game-action" && (x.body as { command: { type: string } }).command.type === "purchase_pickaxe");
const BUY = { type: "purchase_pickaxe", pickaxeId: "pick_stone" } as const;

describe("未確認操作（Idempotency-Key 持續保存）", () => {
  it("已提交但所有回應都遺失 → 未確認；重新點擊沿用同一個 Request ID，只扣款一次", async () => {
    const r = await richPlayer();
    const coins = r.backend.state(r.userId)!.coins;
    r.backend.faults.push("drop_response", "network", "network", "network"); // 第一次已提交、之後 3 次重試都斷線
    expect(await r.controller.perform(BUY)).toBe("uncertain");
    const pending = r.store.getState().pending!;
    expect(pending.command).toEqual(BUY);
    expect(r.pendingStore.load()).toEqual(pending);
    expect(r.backend.state(r.userId)!.pickaxes.pick_stone).toBe(1); // 伺服器其實已提交
    expect(r.store.getState().view!.state.pickaxes.pick_stone).toBeUndefined(); // 畫面不假設成功

    expect(await r.controller.perform(BUY)).toBe("ok"); // 玩家再按一次
    const keys = purchases(r).map((x) => x.key);
    expect(new Set(keys)).toEqual(new Set([pending.requestId]));
    const s = r.backend.state(r.userId)!;
    expect(s.pickaxes.pick_stone).toBe(1);
    expect(r.backend.committedActions(r.userId)).toBeGreaterThan(0);
    expect(r.store.getState().view!.state.coins).toBe(s.coins);
    expect(coins - s.coins).toBeGreaterThan(0);
    expect(r.store.getState().pending).toBeNull();
    expect(r.pendingStore.load()).toBeNull();
    expect(r.store.getState().lastAction).toMatchObject({ outcome: "ok", command: "purchase_pickaxe" });
  });

  it("未確認期間，其他操作不會送出（避免在結果未知時疊加新交易）", async () => {
    const r = await richPlayer();
    r.backend.faults.push("network", "network", "network", "network");
    expect(await r.controller.perform(BUY)).toBe("uncertain");
    const n = r.backend.requests.length;
    expect(await r.controller.perform({ type: "sell_items", itemId: "stone", quantity: 1 })).toBe("blocked");
    expect(await r.controller.selectMode("rework")).toBe(false);
    expect(r.backend.requests.length).toBe(n);
    expect(r.store.getState().notice).toContain("尚未確認");
  });

  it("自動同步先以同一個 Request ID 調和未確認操作，再結算", async () => {
    const r = await richPlayer();
    r.backend.faults.push("drop_response", "network", "network", "network");
    await r.controller.perform(BUY);
    const key = r.store.getState().pending!.requestId;
    await r.controller.sync();
    expect(r.store.getState().pending).toBeNull();
    expect(purchases(r).every((x) => x.key === key)).toBe(true);
    expect(r.store.getState().view!.state.pickaxes.pick_stone).toBe(1);
  });

  it("重新整理頁面（新的 Controller、同一個 storage）→ bootstrap 時調和：已提交的不會再執行一次", async () => {
    const backend = new MemoryBackend();
    const storage = memoryPendingStore();
    const a = await richPlayer(backend, storage);
    backend.faults.push("drop_response", "network", "network", "network");
    await a.controller.perform(BUY);
    a.controller.dispose();
    const coinsAfterCommit = backend.state(a.userId)!.coins;

    const b = rig({ backend, userId: a.userId, pendingStore: storage });
    expect(b.store.getState().pending).toEqual(storage.value);
    b.controller.start();
    await b.controller.bootstrap();
    expect(b.store.getState().pending).toBeNull();
    expect(backend.state(a.userId)!.coins).toBe(coinsAfterCommit); // 沒有第二次扣款
    expect(b.store.getState().view!.state.pickaxes.pick_stone).toBe(1);
    b.controller.dispose();
  });

  it("重新整理時，未確認操作其實沒有送達伺服器 → 調和時才第一次執行（只執行一次）", async () => {
    const backend = new MemoryBackend();
    const storage = memoryPendingStore();
    const a = await richPlayer(backend, storage);
    backend.faults.push("network", "network", "network", "network"); // 全部在送達前失敗
    await a.controller.perform(BUY);
    expect(backend.state(a.userId)!.pickaxes.pick_stone).toBeUndefined();
    const b = rig({ backend, userId: a.userId, pendingStore: storage });
    await b.controller.bootstrap();
    expect(backend.state(a.userId)!.pickaxes.pick_stone).toBe(1);
    expect(b.store.getState().pending).toBeNull();
  });

  it("伺服器確定拒絕（金幣不足）→ 清除未確認狀態，畫面不顯示已扣款", async () => {
    const r = rig();
    await r.controller.createCharacter();
    const before = r.store.getState().view!.state;
    expect(await r.controller.perform(BUY)).toBe("rejected");
    expect(r.store.getState().pending).toBeNull();
    expect(r.store.getState().lastAction).toMatchObject({ outcome: "rejected", message: "金幣不足" });
    expect(r.store.getState().view!.state.coins).toBe(before.coins);
    expect(r.store.getState().view!.state.pickaxes).toEqual(before.pickaxes);
  });

  it("同一個指令的重試沿用 Request ID；送出的 body 不含價格或玩家 ID", async () => {
    const r = await richPlayer();
    r.backend.faults.push("network", "network", "network", "network");
    await r.controller.perform({ type: "sell_items", itemId: "stone", quantity: 5 });
    await r.controller.perform({ type: "sell_items", itemId: "stone", quantity: 5 });
    const sells = r.backend.requests.filter((x) => x.fn === "game-action" && JSON.stringify(x.body).includes("sell_items"));
    expect(new Set(sells.map((x) => x.key)).size).toBe(1);
    for (const x of sells) expect(x.body).toEqual({ command: { type: "sell_items", itemId: "stone", quantity: 5 } });
    expect(r.backend.state(r.userId)!.inventory.stone).toBe(195);
  });

  it("保存的資料不可信：格式錯誤、settle、非 UUID 都丟棄", () => {
    const ok: PendingAction = { requestId: crypto.randomUUID(), command: BUY, createdAt: 1 };
    expect(parsePending(JSON.stringify(ok))).toEqual(ok);
    expect(parsePending("{")).toBeNull();
    expect(parsePending(JSON.stringify({ ...ok, requestId: "x" }))).toBeNull();
    expect(parsePending(JSON.stringify({ ...ok, command: { type: "settle" } }))).toBeNull();
    expect(parsePending(JSON.stringify({ ...ok, command: { type: "sell_items", itemId: "stone", quantity: 1, price: 9 } }))).toBeNull();
  });
});

describe("API 回應驗證", () => {
  it("200 但缺少 state / events → BAD_RESPONSE；畫面狀態不變，之後恢復", async () => {
    const r = rig();
    await r.controller.createCharacter();
    const view = r.store.getState().view;
    r.backend.faults.push("malformed");
    await r.controller.sync();
    expect(r.store.getState().view).toBe(view);
    expect(r.store.getState().sync).toMatchObject({ ok: false, message: "伺服器回應異常，正在重試…" });
    await r.controller.sync();
    expect(r.store.getState().sync.ok).toBe(true);
  });

  it("操作已提交但回應損壞 → 視為未確認，以同一個 Request ID 調和", async () => {
    const r = await richPlayer();
    r.backend.faults.push("malformed_after_commit");
    expect(await r.controller.perform(BUY)).toBe("uncertain");
    expect(r.store.getState().pending).not.toBeNull();
    await r.controller.sync();
    expect(r.store.getState().pending).toBeNull();
    expect(r.backend.state(r.userId)!.pickaxes.pick_stone).toBe(1);
    expect(purchases(r).length).toBe(2);
    expect(new Set(purchases(r).map((x) => x.key)).size).toBe(1);
  });
});

describe("Controller dispose", () => {
  it("dispose 後，進行中的請求回來也不會更新 store；不再排程；關閉 channel", async () => {
    let closed = 0;
    const channel = { post() {}, subscribe: () => () => {}, close: () => void closed++ };
    const r = rig({ channel });
    await r.controller.createCharacter();
    r.controller.start();
    r.backend.latencyMs = 10;
    r.backend.advance(60_000);
    const p = r.controller.sync();
    const snapshot = r.store.getState(); // busy = settle（請求進行中）
    r.controller.dispose();
    await p;
    await new Promise((x) => setTimeout(x, 30));
    expect(r.store.getState()).toBe(snapshot);
    expect(r.clock.pending).toHaveLength(0);
    expect(closed).toBe(1);
    expect(await r.controller.perform(BUY)).toBe("blocked");
    r.controller.start();
    expect(r.clock.pending).toHaveLength(0);
  });
});
