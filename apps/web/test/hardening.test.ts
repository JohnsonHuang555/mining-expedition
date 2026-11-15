import { describe, expect, it } from "vitest";
import { MemoryBackend } from "@/lib/game/dev/memory-backend";
import { memoryActionLock, memoryPendingStore } from "@/lib/game/pending";
import { flush, rig } from "./helpers";

const HOUR = 3_600_000;
const SELL = { type: "sell_items", itemId: "stone", quantity: 10 } as const;
const BUY = { type: "purchase_pickaxe", pickaxeId: "pick_stone" } as const;
const isCmd = (type: string) => (fn: string, body: unknown) => fn === "game-action" && (body as { command?: { type?: string } })?.command?.type === type;

/** 同一位使用者的兩個分頁：共用後端、共用 storage（每筆操作一個 key）；lock 可以共用（Web Locks）或各自獨立（不支援 / 失效） */
async function twoTabs(opts: { sharedLock: boolean }) {
  const backend = new MemoryBackend();
  const userId = crypto.randomUUID();
  const storage = memoryPendingStore();
  const shared = memoryActionLock();
  const lock = () => (opts.sharedLock ? shared : memoryActionLock());
  const a = rig({ backend, userId, pendingStore: storage, actionLock: lock() });
  await a.controller.createCharacter();
  backend.mutate(userId, (s) => {
    s.coins = 1_000;
    s.inventory = { stone: 200 };
  });
  await a.controller.retryBootstrap();
  const b = rig({ backend, userId, pendingStore: storage, actionLock: lock() });
  await b.controller.bootstrap();
  const count = (type: string) => backend.requests.filter((x) => isCmd(type)(x.fn, x.body)).length;
  const committed = (type: string) => [...backend.log.values()].filter((l) => l.response.command === type && l.response.ok).length;
  return { backend, userId, storage, a, b, count, committed, server: () => backend.state(userId)! };
}

describe("跨分頁交易一致性", () => {
  it("A 出售已提交但回應遺失、B 同時購買：A 的未確認紀錄不會被覆蓋；B 先以 A 的 Request ID 確認，再購買", async () => {
    const t = await twoTabs({ sharedLock: true });
    t.backend.rules.push({ match: isCmd("sell_items"), fault: "drop_response", times: 1 }, { match: isCmd("sell_items"), fault: "network", times: 3 });
    t.backend.latencyMs = 5;
    const [oa, ob] = await Promise.all([t.a.controller.perform(SELL), t.b.controller.perform(BUY)]);
    expect(oa).toBe("uncertain");
    expect(ob).toBe("ok");
    const s = t.server();
    expect(s.inventory.stone).toBe(200 - 10 - 40); // 出售 10、購買用掉 40，各一次
    expect(s.pickaxes.pick_stone).toBe(1);
    expect(t.committed("sell_items")).toBe(1);
    expect(t.committed("purchase_pickaxe")).toBe(1);
    expect(t.storage.list()).toEqual([]); // 兩筆都已確認
    await flush();
    expect(t.a.store.getState().pendingCount).toBe(0); // A 經由 storage 通知得知已確認
  });

  it("跨分頁鎖失效（每個分頁各自的鎖）時：兩筆紀錄都保存，最後由 action_log 保證各只套用一次", async () => {
    const t = await twoTabs({ sharedLock: false });
    t.backend.rules.push({ match: isCmd("sell_items"), fault: "drop_response", times: 1 }, { match: isCmd("sell_items"), fault: "network", times: 3 });
    t.backend.rules.push({ match: isCmd("purchase_pickaxe"), fault: "drop_response", times: 1 }, { match: isCmd("purchase_pickaxe"), fault: "network", times: 3 });
    t.backend.latencyMs = 5;
    const [oa, ob] = await Promise.all([t.a.controller.perform(SELL), t.b.controller.perform(BUY)]);
    // 每筆未確認的交易都有自己的紀錄（沒有互相覆蓋）
    expect(t.storage.list().length).toBe([oa, ob].filter((o) => o === "uncertain").length);
    expect(t.storage.list().length).toBeGreaterThanOrEqual(1);
    // 兩個分頁同時同步（調和）
    await Promise.all([t.a.controller.sync(), t.b.controller.sync()]);
    await Promise.all([t.a.controller.sync(), t.b.controller.sync()]);
    expect(t.storage.list()).toEqual([]);
    expect(t.committed("sell_items")).toBeLessThanOrEqual(1);
    expect(t.committed("purchase_pickaxe")).toBeLessThanOrEqual(1);
    const s = t.server();
    const sold = t.committed("sell_items") === 1 ? 10 : 0;
    const bought = t.committed("purchase_pickaxe") === 1 ? 40 : 0;
    expect(s.inventory.stone).toBe(200 - sold - bought);
  });

  it("A、B 同時重新整理：同一筆未確認交易只確認一次，不使用新的 Request ID", async () => {
    for (const sharedLock of [true, false]) {
      const t = await twoTabs({ sharedLock });
      t.backend.rules.push({ match: isCmd("sell_items"), fault: "drop_response", times: 1 }, { match: isCmd("sell_items"), fault: "network", times: 3 });
      await t.a.controller.perform(SELL);
      const key = t.storage.list()[0]!.requestId;
      t.a.controller.dispose();
      t.b.controller.dispose();
      // 兩個分頁同時重新整理（新的 Controller、同一個 storage）
      const lock = memoryActionLock();
      const a2 = rig({ backend: t.backend, userId: t.userId, pendingStore: t.storage, actionLock: sharedLock ? lock : memoryActionLock() });
      const b2 = rig({ backend: t.backend, userId: t.userId, pendingStore: t.storage, actionLock: sharedLock ? lock : memoryActionLock() });
      t.backend.latencyMs = 5;
      await Promise.all([a2.controller.bootstrap(), b2.controller.bootstrap()]);
      const sells = t.backend.requests.filter((x) => isCmd("sell_items")(x.fn, x.body));
      expect(new Set(sells.map((x) => x.key))).toEqual(new Set([key]));
      expect(t.server().inventory.stone).toBe(190);
      expect(t.storage.list()).toEqual([]);
    }
  });

  it("分頁突然關閉（請求進行中被 dispose）：紀錄留在 storage，另一個分頁下一次同步時確認", async () => {
    const t = await twoTabs({ sharedLock: true });
    t.backend.latencyMs = 10;
    t.backend.rules.push({ match: isCmd("sell_items"), fault: "drop_response", times: 1 });
    const p = t.a.controller.perform(SELL);
    await new Promise((r) => setTimeout(r, 2));
    t.a.controller.dispose(); // 分頁關閉
    await p;
    expect(t.storage.list()).toHaveLength(1);
    await flush();
    expect(t.b.store.getState().pendingCount).toBe(1); // B 經由 storage 事件看到未確認交易，按鈕停用
    t.b.controller.start();
    await t.b.controller.sync();
    expect(t.storage.list()).toEqual([]);
    expect(t.server().inventory.stone).toBe(190);
    expect(t.committed("sell_items")).toBe(1);
  });
});

describe("離線報告：未確認的領取", () => {
  it("領取已提交但回應遺失：待領報告不會阻止調和排程；網路恢復後以同一個 key 自動確認，只入帳一次", async () => {
    const r = rig();
    await r.controller.createCharacter();
    r.backend.rewind(r.userId, 2 * HOUR);
    await r.controller.retryBootstrap();
    r.controller.start();
    await flush();
    const report = r.store.getState().view!.state.pendingOfflineReport!;
    expect(r.clock.pending).toHaveLength(0); // 一般情況：待領報告期間不排程
    r.backend.rules.push({ match: isCmd("claim_report"), fault: "drop_response", times: 1 }, { match: isCmd("claim_report"), fault: "network", times: 3 });
    expect(await r.controller.claimReport()).toBe(false);
    expect(r.store.getState().pending?.command).toEqual({ type: "claim_report", reportId: report.reportId });
    expect(r.store.getState().view!.state.pendingOfflineReport).not.toBeNull(); // 畫面仍顯示報告（尚未確認）
    expect(await r.controller.perform(SELL)).toBe("blocked"); // 調和期間不允許一般交易
    expect(r.clock.pending.length).toBe(1); // 有排程：未確認的領取優先於「待領報告暫停」
    const delay = r.clock.pending[0]!;
    await r.clock.tick(delay);
    const s = r.store.getState();
    expect(s.pending).toBeNull();
    expect(s.view!.state.pendingOfflineReport).toBeNull();
    expect(s.view!.state.coins).toBe(report.rewards.coins);
    const claims = r.backend.requests.filter((x) => isCmd("claim_report")(x.fn, x.body));
    expect(new Set(claims.map((x) => x.key)).size).toBe(1);
    expect(r.backend.state(r.userId)!.coins).toBe(report.rewards.coins);
    expect(r.clock.pending).toHaveLength(1); // 恢復正常同步
  });
});

describe("交易回饋", () => {
  it("交易被拒絕但結算已提交：synced = true（提示「挖掘結算已同步」）；沒有結算時 synced = false", async () => {
    const r = rig();
    await r.controller.createCharacter();
    r.backend.advance(60_000);
    expect(await r.controller.perform(BUY)).toBe("rejected");
    expect(r.store.getState().lastAction).toMatchObject({ outcome: "rejected", synced: true, message: "金幣不足" });
    expect(r.store.getState().view!.state.mining.digCounter).toBeGreaterThan(0);
    expect(await r.controller.perform(BUY)).toBe("rejected");
    expect(r.store.getState().lastAction).toMatchObject({ outcome: "rejected", synced: false });
  });
});
