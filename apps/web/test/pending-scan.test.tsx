// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { MemoryBackend } from "@/lib/game/dev/memory-backend";
import { type PendingAction, browserPendingStore, pendingKeyPrefix, pendingStorageKey } from "@/lib/game/pending";
import { rig } from "./helpers";

afterEach(() => localStorage.clear());

/** 依指定順序寫入 storage（jsdom 的 key(i) 依插入順序） */
function seed(userId: string, entries: ({ valid: PendingAction } | { invalidKey: string; raw: string })[]) {
  for (const e of entries) {
    if ("valid" in e) localStorage.setItem(pendingStorageKey(userId, e.valid.requestId), JSON.stringify(e.valid));
    else localStorage.setItem(e.invalidKey, e.raw);
  }
}
const sell = (q: number, at: number): PendingAction => ({ requestId: crypto.randomUUID(), command: { type: "sell_items", itemId: "stone", quantity: q }, createdAt: Date.now() + at });

describe("browserPendingStore.list()：清理無效紀錄時不漏讀", () => {
  it("無效紀錄排在有效紀錄前面：有效紀錄當次全部讀到，無效紀錄被移除", () => {
    const u = crypto.randomUUID();
    const a = sell(1, 1);
    seed(u, [{ invalidKey: `${pendingKeyPrefix(u)}${crypto.randomUUID()}`, raw: "{broken" }, { valid: a }]);
    expect(localStorage.key(0)).not.toBe(pendingStorageKey(u, a.requestId)); // 確認順序：壞的在前
    expect(browserPendingStore(u).list()).toEqual([a]);
    expect(localStorage.length).toBe(1);
  });

  it("多筆無效與有效交錯：全部有效紀錄都讀到、Request ID 不變", () => {
    const u = crypto.randomUUID();
    const valids = [sell(1, 1), sell(2, 2), sell(3, 3)];
    const p = pendingKeyPrefix(u);
    seed(u, [
      { invalidKey: `${p}x1`, raw: "garbage" },
      { valid: valids[0]! },
      { invalidKey: `${p}${crypto.randomUUID()}`, raw: JSON.stringify({ requestId: "not-uuid", command: { type: "settle" } }) },
      { invalidKey: `${p}${crypto.randomUUID()}`, raw: JSON.stringify(valids[1]) }, // key 與內容的 requestId 不一致
      { valid: valids[1]! },
      { invalidKey: `${p}x2`, raw: "" },
      { valid: valids[2]! },
      { invalidKey: "unrelated", raw: "keep" },
    ]);
    const list = browserPendingStore(u).list();
    expect(list).toEqual(valids);
    expect(list.map((x) => x.requestId)).toEqual(valids.map((x) => x.requestId));
    const left = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).sort();
    expect(left).toEqual([...valids.map((v) => pendingStorageKey(u, v.requestId)), "unrelated"].sort());
  });

  it("重新整理時：無效紀錄排在前面也會先調和全部未確認交易（原 Request ID），再結算；不重複扣款", async () => {
    const backend = new MemoryBackend();
    const u = crypto.randomUUID();
    const first = rig({ backend, userId: u, pendingStore: browserPendingStore(u) });
    await first.controller.createCharacter();
    backend.mutate(u, (s) => {
      s.coins = 1_000;
      s.inventory = { stone: 200 };
    });
    // 兩筆交易都已提交但回應遺失
    const buy: PendingAction = { requestId: crypto.randomUUID(), command: { type: "purchase_pickaxe", pickaxeId: "pick_stone" }, createdAt: Date.now() + 1 };
    const sale = sell(10, 2);
    backend.faults.push("drop_response", "network", "network", "network"); // 購買已提交，回應全部遺失
    expect(await first.controller.perform(buy.command)).toBe("uncertain");
    first.controller.dispose();
    const buyKey = browserPendingStore(u).list()[0]!.requestId;
    const coinsAfterBuy = backend.state(u)!.coins;
    expect(backend.state(u)!.pickaxes.pick_stone).toBe(1);
    // 重新整理前的 storage：壞紀錄排在前面、與有效紀錄交錯（出售尚未送達伺服器）
    localStorage.clear();
    seed(u, [
      { invalidKey: `${pendingKeyPrefix(u)}${crypto.randomUUID()}`, raw: "{" },
      { valid: { ...buy, requestId: buyKey } },
      { invalidKey: `${pendingKeyPrefix(u)}zz`, raw: "null" },
      { valid: sale },
    ]);
    backend.requests.length = 0;

    const reloaded = rig({ backend, userId: u, pendingStore: browserPendingStore(u) });
    expect(reloaded.store.getState().pendingCount).toBe(2); // 兩筆有效紀錄當次都讀到
    await reloaded.controller.bootstrap();
    // 順序：game-state → 調和全部未確認交易（原 Request ID）→ 結算
    const seq = backend.requests.map((x) => (x.fn === "game-action" ? (x.body as { command: { type: string } }).command.type : x.fn));
    expect(seq).toEqual(["game-state", "purchase_pickaxe", "sell_items", "settle"]);
    expect(backend.requests.slice(1, 3).map((x) => x.key)).toEqual([buyKey, sale.requestId]);
    expect(reloaded.store.getState().pendingCount).toBe(0);
    expect(localStorage.length).toBe(0);
    const s = backend.state(u)!;
    expect(s.pickaxes.pick_stone).toBe(1);
    expect([...backend.log.values()].filter((l) => l.response?.command === "purchase_pickaxe" && l.response?.ok)).toHaveLength(1);
    // 購買沒有再扣一次；出售在調和時第一次執行（+10）；結算可能另外加少量金幣
    expect(s.coins).toBeGreaterThanOrEqual(coinsAfterBuy + 10);
    expect(s.coins).toBeLessThan(coinsAfterBuy + 200);
  });
});
