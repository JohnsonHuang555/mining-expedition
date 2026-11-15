// @vitest-environment jsdom
/**
 * PR #15（Reliability & Security Hardening）：rate limit、Retry-After、action_log 壓縮後的重送、
 * 未確認操作的有效期限（只調和、不執行）、市場歷史的排隊讀取、大量寶物選擇、成交提示。
 * 後端是記憶體版的 Edge Functions（與正式伺服器相同的 handler / 規則，只替換資料庫）。
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { ARTIFACTS, type ArtifactId } from "@mining/game-data";
import { MAX_ARTIFACTS_PER_SALE, type PlayerGameState } from "@mining/game-engine";
import { DEFAULT_RATE_LIMITS } from "@mining/game-server";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameFrame } from "@/components/game/Dashboard";
import { MarketPage } from "@/components/game/MarketPage";
import { RuntimeContext } from "@/components/game/runtime-context";
import { PENDING_MAX_AGE_MS } from "@/lib/game/controller";
import type { GameRuntime } from "@/lib/game/runtime";
import { memoryPendingStore } from "@/lib/game/pending";
import { flush, rig } from "./helpers";

let seq = 0;
function give(s: PlayerGameState, id: ArtifactId, n = 1) {
  for (let i = 0; i < n; i++) {
    const d = 20_000 + seq++;
    s.heldArtifacts.push({ instanceId: `d${d}`, artifactId: id, obtainedAt: s.createdAt, mode: "frontier", band: 2, frontierBlockIndex: 200, digCounter: d, source: "drop" });
  }
  s.discoveredArtifacts[id] ??= { firstDiscoveredAt: s.createdAt, firstBand: 2, totalFound: n };
  if (s.firstTreasure.status === "pending") s.firstTreasure = { status: "obtained", effectiveMiningMs: 0, resolvedAt: s.createdAt, artifactInstanceId: s.heldArtifacts[0]!.instanceId, reportId: null };
  s.mining.digCounter = Math.max(s.mining.digCounter, 20_000 + seq);
}
const actions = (r: ReturnType<typeof rig>, type?: string) =>
  r.backend.requests.filter((q) => q.fn === "game-action" && (type === undefined || (q.body as { command: { type: string } }).command.type === type));
const states = (r: ReturnType<typeof rig>) => r.backend.requests.filter((q) => q.fn === "game-state");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => vi.useRealTimers());

describe("Rate limit（伺服器端；與 Edge Function 相同的規則）", () => {
  it("正常範圍內通過；超限回 429 + Retry-After；重送原 Request ID 不受限、不重複執行", async () => {
    const r = rig();
    vi.setSystemTime(r.backend.now);
    await r.controller.createCharacter();
    r.backend.rateLimits = DEFAULT_RATE_LIMITS;
    r.backend.mutate(r.userId, (s) => void (s.inventory.stone = 1_000));
    const call = (key: string) =>
      r.backend.fetch("http://edge.test/functions/v1/game-action", {
        method: "POST",
        headers: { Authorization: `Bearer ${r.token}`, "Idempotency-Key": key, "Content-Type": "application/json" },
        body: JSON.stringify({ command: { type: "sell_items", itemId: "stone", quantity: 1 } }),
      });
    const keys = Array.from({ length: DEFAULT_RATE_LIMITS["game-action"].limit }, () => crypto.randomUUID());
    for (const k of keys) expect((await call(k)).status).toBe(200);
    const over = await call(crypto.randomUUID());
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    const body = await over.json();
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.retryAfterMs).toBeGreaterThan(0);
    // 超限期間，重送已處理過的 key：回傳保存的結果（不計數、不重複出售）
    const stone = r.backend.state(r.userId)!.inventory.stone;
    const replay = await call(keys[0]!);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(r.backend.state(r.userId)!.inventory.stone).toBe(stone);
    // 視窗過後恢復
    r.backend.advance(DEFAULT_RATE_LIMITS["game-action"].windowMs);
    expect((await call(crypto.randomUUID())).status).toBe(200);
  });

  it("Client：超限的交易保留為未確認，Retry-After 之後以同一個 Request ID 自動重試，只執行一次", async () => {
    const r = rig();
    vi.setSystemTime(r.backend.now);
    await r.controller.createCharacter();
    r.backend.mutate(r.userId, (s) => void (s.inventory.stone = 100));
    r.backend.rateLimits = { ...DEFAULT_RATE_LIMITS, "game-action": { bucket: "game-action", limit: 1, windowMs: 30_000 } };
    r.controller.start();
    await act(flush);
    expect(await r.controller.perform({ type: "sell_items", itemId: "stone", quantity: 1 })).toBe("ok"); // 用掉視窗內的額度
    expect(await r.controller.perform({ type: "sell_items", itemId: "stone", quantity: 5 })).toBe("uncertain");
    expect(r.store.getState().lastAction!.code).toBe("RATE_LIMITED");
    expect(r.store.getState().pending).not.toBeNull();
    const key = r.store.getState().pending!.requestId;
    expect(r.store.getState().notice).toContain("操作太頻繁");
    // Retry-After（30 秒內）之前不再送出
    const before = actions(r).length;
    await r.clock.tick(5_000);
    expect(actions(r).length).toBe(before);
    r.backend.advance(30_000);
    await r.clock.tick(30_000);
    await act(flush);
    expect(r.store.getState().pending).toBeNull();
    const sells = actions(r, "sell_items").filter((q) => (q.body as { command: { quantity: number } }).command.quantity === 5);
    expect(new Set(sells.map((q) => q.key))).toEqual(new Set([key]));
    // 伺服器只執行一次（同一個 key 的成功紀錄只有一筆；礦物會因挖掘增加，所以不比對數量）
    const done = [...r.backend.log.entries()].filter(([k, l]) => k.endsWith(key) && l.response?.ok);
    expect(done).toHaveLength(1);
    r.controller.dispose();
  });
});

describe("Action Log 保存期限與 Request ID", () => {
  it("回應遺失 → action_log 壓縮（只保留冪等識別）→ 重新開啟以原 Request ID 重送：REQUEST_EXPIRED，不重新執行、不重複扣款", async () => {
    const pendingStore = memoryPendingStore();
    const r = rig({ pendingStore });
    vi.setSystemTime(r.backend.now);
    await r.controller.createCharacter();
    r.backend.mutate(r.userId, (s) => {
      s.coins = 1_000;
      s.inventory.stone = 200;
    });
    r.backend.faults.push("drop_response", "network", "network", "network");
    expect(await r.controller.perform({ type: "purchase_pickaxe", pickaxeId: "pick_stone" })).toBe("uncertain");
    const coins = r.backend.state(r.userId)!.coins;
    r.controller.dispose();
    r.backend.compactLog(); // 保存期限過後：settle 刪除，交易只留冪等識別

    const again = rig({ backend: r.backend, userId: r.userId, pendingStore });
    await again.controller.bootstrap();
    expect(again.store.getState().pending).toBeNull();
    expect(again.store.getState().lastAction).toMatchObject({ outcome: "ok", code: "REQUEST_EXPIRED" }); // 伺服器說當初成功
    expect(r.backend.state(r.userId)!.coins).toBeGreaterThanOrEqual(coins); // 沒有再扣款
    expect(r.backend.state(r.userId)!.coins).toBeLessThan(coins + 200);
    expect(r.backend.state(r.userId)!.pickaxes.pick_stone).toBe(1);
  });

  it("同一個 Request ID 對應不同內容：IDEMPOTENCY_MISMATCH（壓縮後也一樣）", async () => {
    const r = rig();
    await r.controller.createCharacter();
    r.backend.mutate(r.userId, (s) => void (s.inventory.stone = 10));
    const key = crypto.randomUUID();
    const a = await r.backend.fetch("http://edge.test/functions/v1/game-action", { method: "POST", headers: { Authorization: `Bearer ${r.token}`, "Idempotency-Key": key }, body: JSON.stringify({ command: { type: "sell_items", itemId: "stone", quantity: 1 } }) });
    expect(a.status).toBe(200);
    r.backend.compactLog();
    const b = await r.backend.fetch("http://edge.test/functions/v1/game-action", { method: "POST", headers: { Authorization: `Bearer ${r.token}`, "Idempotency-Key": key }, body: JSON.stringify({ command: { type: "sell_items", itemId: "stone", quantity: 2 } }) });
    expect((await b.json()).error.code).toBe("IDEMPOTENCY_MISMATCH");
    expect(r.backend.state(r.userId)!.inventory.stone).toBe(9);
  });

  it("超過有效期限的未確認操作：只調和、不執行；伺服器寫下作廢紀錄，原始請求晚到也不會執行", async () => {
    const r = rig({ pendingStore: memoryPendingStore() });
    vi.setSystemTime(r.backend.now);
    await r.controller.createCharacter();
    r.backend.mutate(r.userId, (s) => void (s.inventory.stone = 50));
    // 8 天前送出、從未到達伺服器的出售
    const old = { requestId: crypto.randomUUID(), command: { type: "sell_items", itemId: "stone", quantity: 10 } as const, createdAt: Date.now() - PENDING_MAX_AGE_MS - 86_400_000 };
    r.pendingStore.put(old);
    await r.controller.retryBootstrap();
    expect(r.store.getState().pending).toBeNull();
    expect(r.store.getState().lastAction).toMatchObject({ outcome: "rejected", code: "REQUEST_EXPIRED" });
    expect(r.backend.state(r.userId)!.inventory.stone).toBe(50); // 沒有執行
    expect(actions(r, "sell_items")[0]!.body).toMatchObject({ command: old.command });
    // 原始請求晚到（同一個 key，沒有 expire 標記）：只會得到作廢結果
    const late = await r.backend.fetch("http://edge.test/functions/v1/game-action", { method: "POST", headers: { Authorization: `Bearer ${r.token}`, "Idempotency-Key": old.requestId }, body: JSON.stringify({ command: old.command }) });
    expect(late.status).toBe(410);
    expect((await late.json()).expired).toEqual({ processed: false, ok: null, processedAt: null });
    expect(r.backend.state(r.userId)!.inventory.stone).toBe(50);
  });

  it("有效期限內的未確認操作照常以原 Request ID 調和（已提交 → 原本的結果）", async () => {
    const pendingStore = memoryPendingStore();
    const r = rig({ pendingStore });
    vi.setSystemTime(r.backend.now);
    await r.controller.createCharacter();
    r.backend.mutate(r.userId, (s) => void (s.inventory.stone = 50));
    r.backend.faults.push("drop_response", "network", "network", "network");
    expect(await r.controller.perform({ type: "sell_items", itemId: "stone", quantity: 10 })).toBe("uncertain");
    vi.setSystemTime(r.backend.now + PENDING_MAX_AGE_MS - 60_000);
    await r.controller.sync();
    expect(r.store.getState().pending).toBeNull();
    expect(r.store.getState().lastAction).toMatchObject({ outcome: "ok", code: null });
    expect(r.backend.state(r.userId)!.inventory.stone).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// 市場（PR #14 Review P2）
// ---------------------------------------------------------------------------

async function market(setup: (s: PlayerGameState) => void = () => {}, opts: { boot?: boolean } = {}) {
  const r = rig();
  vi.setSystemTime(r.backend.now);
  await r.controller.createCharacter();
  r.backend.mutate(r.userId, setup);
  if (opts.boot !== false) {
    await r.controller.retryBootstrap();
    await flush();
    r.controller.dismissAllReveals();
  }
  const runtime = { userId: r.userId, api: null as never, store: r.store, controller: r.controller } satisfies GameRuntime;
  const wrap = (ui: ReactNode) =>
    render(
      <RuntimeContext.Provider value={runtime}>
        <GameFrame email={null} onSignOut={() => {}}>
          {ui}
        </GameFrame>
      </RuntimeContext.Provider>,
    );
  return { ...r, wrap };
}

describe("市場歷史的讀取（排隊、退避、不重複）", () => {
  it("結算進行中進入市場：結算結束後補讀一次歷史", async () => {
    const r = await market();
    expect(r.store.getState().market?.history).toBeDefined(); // bootstrap 的 game-state 已帶歷史
    // 換日：只有行動回應（沒有歷史）
    r.backend.advance(30_000);
    r.store.setState({ market: { ...r.store.getState().market!, history: undefined } });
    r.backend.latencyMs = 30;
    const settling = r.controller.sync();
    expect(r.store.getState().busy).not.toBeNull();
    const n = states(r).length;
    r.wrap(<MarketPage />);
    await act(async () => {
      await settling;
      await new Promise((x) => setTimeout(x, 120));
      await flush();
    });
    expect(r.store.getState().market!.history).toBeDefined();
    expect(states(r).length).toBe(n + 1);
  });

  it("bootstrap 期間進入市場：bootstrap 結束後有歷史", async () => {
    const r = await market((s) => give(s, "a_z1_map"), { boot: false });
    r.backend.latencyMs = 20;
    const boot = r.controller.retryBootstrap();
    r.wrap(<MarketPage />);
    await act(async () => {
      await boot;
      await new Promise((x) => setTimeout(x, 100));
      await flush();
    });
    expect(r.store.getState().market!.history).toBeDefined();
    expect(screen.getByTestId("market-status").dataset.status).toBe("valid");
  });

  it("網路失敗：退避重試（2 秒、4 秒…），恢復後取得歷史；不會連續重送", async () => {
    const r = await market();
    r.store.setState({ market: { ...r.store.getState().market!, history: undefined } });
    for (let i = 0; i < 8; i++) r.backend.faults.push("network");
    const n = states(r).length;
    r.wrap(<MarketPage />);
    await act(flush);
    const afterFirst = states(r).length;
    expect(afterFirst - n).toBe(4); // 第一次嘗試（API Client 內含 3 次重試）
    await act(() => r.clock.tick(1_000));
    expect(states(r).length).toBe(afterFirst); // 還沒到退避時間
    await act(() => r.clock.tick(1_500));
    await act(flush);
    expect(states(r).length).toBe(afterFirst + 4); // 第二輪（仍失敗）
    await act(() => r.clock.tick(4_500));
    await act(flush);
    expect(r.store.getState().market!.history).toBeDefined(); // 第三輪成功
  });

  it("切換頁面：已有歷史時重新進入市場不送請求；離開後不再重試", async () => {
    const r = await market();
    const n = states(r).length;
    const first = r.wrap(<MarketPage />);
    await act(flush);
    first.unmount();
    const second = r.wrap(<MarketPage />);
    await act(flush);
    second.unmount();
    expect(states(r).length).toBe(n);
    // 離開後即使失敗也不排程重試
    r.store.setState({ market: { ...r.store.getState().market!, history: undefined } });
    r.backend.faults.push("network", "network", "network", "network");
    const third = r.wrap(<MarketPage />);
    await act(flush);
    third.unmount();
    const m = states(r).length;
    await act(() => r.clock.tick(120_000));
    expect(states(r).length).toBe(m);
  });
});

describe("大量寶物選擇（單次上限 100 件）", () => {
  it("「全部」不超過上限；顯示還可再選的件數；多種合計遵守上限；確認視窗顯示實際件數", async () => {
    const r = await market((s) => {
      give(s, "a_z1_map", 120);
      give(s, "a_z1_badge", 30);
    });
    r.wrap(<MarketPage />);
    await act(flush);
    await act(async () => fireEvent.click(screen.getByTestId("market-all-a_z1_badge")));
    expect(screen.getByTestId("market-remaining").textContent).toBe(`還可再選 ${MAX_ARTIFACTS_PER_SALE - 30} 件`);
    const all = screen.getByTestId("market-all-a_z1_map");
    expect(all.textContent).toBe(`+${MAX_ARTIFACTS_PER_SALE - 30}`);
    await act(async () => fireEvent.click(all));
    expect(screen.getByTestId("market-selected-count").textContent).toBe(String(MAX_ARTIFACTS_PER_SALE));
    expect(screen.getByTestId("market-remaining").textContent).toBe(`已達單次上限 ${MAX_ARTIFACTS_PER_SALE} 件`);
    expect(screen.getByRole("button", { name: `${ARTIFACTS.a_z1_map.name} 增加` })).toHaveProperty("disabled", true);
    await act(async () => fireEvent.click(screen.getByTestId("market-sell")));
    expect(screen.getByTestId("sale-count").textContent).toBe(String(MAX_ARTIFACTS_PER_SALE));
    expect(within(screen.getByRole("alertdialog")).getAllByRole("button").at(-1)).toHaveProperty("disabled", false);
  });

  it("UI 限制不取代後端：101 件直接送出被伺服器拒絕", async () => {
    const r = await market((s) => give(s, "a_z1_map", 101));
    const ids = r.store.getState().view!.state.heldArtifacts.map((a) => a.instanceId);
    expect(await r.controller.perform({ type: "sell_artifacts", instanceIds: ids, marketDate: r.store.getState().market!.date })).toBe("rejected");
    expect(r.store.getState().lastAction!.code).toBe("INVALID_REQUEST");
    expect(r.store.getState().view!.state.heldArtifacts).toHaveLength(101);
  });
});

describe("成交提示", () => {
  it("只對應成功的那一個 Request ID：之後有其他操作結果就不再顯示舊成交；新交易開始時清除", async () => {
    const r = await market((s) => {
      give(s, "a_z1_map", 2);
      s.inventory.stone = 10;
    });
    r.wrap(<MarketPage />);
    await act(flush);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: `${ARTIFACTS.a_z1_map.name} 增加` })));
    await act(async () => fireEvent.click(screen.getByTestId("market-sell")));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("alertdialog")).getAllByRole("button").at(-1)!);
      await flush();
    });
    const sold = r.store.getState().lastAction!;
    expect(screen.getByTestId("market-result").textContent).toContain("伺服器實際成交");
    // 其他操作（例如背包出售礦物）：舊的成交提示消失
    await act(async () => {
      await r.controller.perform({ type: "sell_items", itemId: "stone", quantity: 1 });
    });
    expect(r.store.getState().lastAction!.requestId).not.toBe(sold.requestId);
    expect(screen.queryByTestId("market-result")).toBeNull();
  });
});
