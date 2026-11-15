// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { ARTIFACTS, ARTIFACT_IDS, type ArtifactId } from "@mining/game-data";
import { type MarketQuote, type PlayerGameState, artifactSalePrice } from "@mining/game-engine";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameFrame } from "@/components/game/Dashboard";
import { MarketPage } from "@/components/game/MarketPage";
import { RuntimeContext } from "@/components/game/runtime-context";
import { dayChange, formatChange, pickInstances, planSale, priceHistory, quoteStatus } from "@/lib/game/market";
import type { GameRuntime } from "@/lib/game/runtime";
import { MemoryBackend } from "@/lib/game/dev/memory-backend";
import { flush, rig } from "./helpers";

const HOUR = 3_600_000;
let seq = 0;
function give(s: PlayerGameState, id: ArtifactId, held = 1) {
  for (let i = 0; i < held; i++) {
    const n = 9_000 + seq++;
    s.heldArtifacts.push({ instanceId: `d${n}`, artifactId: id, obtainedAt: s.createdAt, mode: "frontier", band: 2, frontierBlockIndex: 200, digCounter: n, source: "drop" });
  }
  s.discoveredArtifacts[id] ??= { firstDiscoveredAt: s.createdAt, firstBand: 2, totalFound: held };
  if (s.firstTreasure.status === "pending") s.firstTreasure = { status: "obtained", effectiveMiningMs: 0, resolvedAt: s.createdAt, artifactInstanceId: s.heldArtifacts[0]!.instanceId, reportId: null };
  s.mining.digCounter = Math.max(s.mining.digCounter, 9_000 + seq);
}

const quote = (date: string, today: Partial<Record<ArtifactId, number>>, history: MarketQuote["history"] = []): MarketQuote => ({
  date,
  nextRefreshAt: Date.parse(`${date}T16:00:00Z`),
  multipliersPpm: today,
  history,
});

describe("市場計算（純函式）", () => {
  it("報價狀態：沒有報價 / 當日無法取得 / 超過更新時間 / 有效", () => {
    const q = quote("2026-11-15", { a_z1_map: 1_000_000 });
    expect(quoteStatus(null, 0)).toBe("none");
    expect(quoteStatus({ ...q, multipliersPpm: {} }, 0)).toBe("unavailable");
    expect(quoteStatus(q, q.nextRefreshAt)).toBe("refreshing");
    expect(quoteStatus(q, q.nextRefreshAt - 1)).toBe("valid");
  });

  it("歷史不足：只有今天 → 1 點、沒有漲跌；昨天缺少（只有前天）→ 沒有漲跌", () => {
    expect(priceHistory(quote("2026-11-15", { a_z1_map: 1_100_000 }), "a_z1_map")).toHaveLength(1);
    expect(dayChange(quote("2026-11-15", { a_z1_map: 1_100_000 }), "a_z1_map")).toBeNull();
    const gap = quote("2026-11-15", { a_z1_map: 1_100_000 }, [{ date: "2026-11-13", multipliersPpm: { a_z1_map: 900_000 } }]);
    expect(priceHistory(gap, "a_z1_map").map((p) => p.date)).toEqual(["2026-11-13", "2026-11-15"]); // 不補假資料
    expect(dayChange(gap, "a_z1_map")).toBeNull();
    expect(priceHistory(null, "a_z1_map")).toEqual([]);
  });

  it("今日 vs 昨日：上漲 / 下跌 / 持平與百分比；比基礎價高不等於上漲", () => {
    const base = ARTIFACTS.a_z1_map.baseValue;
    const up = dayChange(quote("2026-11-15", { a_z1_map: 1_100_000 }, [{ date: "2026-11-14", multipliersPpm: { a_z1_map: 1_000_000 } }]), "a_z1_map")!;
    expect(up.direction).toBe("up");
    expect(up.ratio).toBeCloseTo((artifactSalePrice("a_z1_map", 1_100_000) - base) / base);
    expect(formatChange(up)).toBe("▲ 10.0%");
    // 今天 ×1.20（高於基礎價），昨天 ×1.25 → 下跌
    const down = dayChange(quote("2026-11-15", { a_z1_map: 1_200_000 }, [{ date: "2026-11-14", multipliersPpm: { a_z1_map: 1_250_000 } }]), "a_z1_map")!;
    expect(down.direction).toBe("down");
    expect(formatChange(down)).toMatch(/^▼ /);
    const flat = dayChange(quote("2026-11-15", { a_z1_map: 900_000 }, [{ date: "2026-11-14", multipliersPpm: { a_z1_map: 900_000 } }]), "a_z1_map")!;
    expect(formatChange(flat)).toBe("持平");
  });
});

describe("出售選擇與套組影響（planSale）", () => {
  const state = (counts: Partial<Record<ArtifactId, number>>) => {
    const r = rig();
    const s = { heldArtifacts: [], discoveredArtifacts: {}, firstTreasure: { status: "pending" }, mining: { digCounter: 0 }, createdAt: 0 } as unknown as PlayerGameState;
    for (const [id, n] of Object.entries(counts)) give(s, id as ArtifactId, n);
    void r;
    return s;
  };
  const q = quote("2026-11-15", Object.fromEntries(ARTIFACT_IDS.map((id) => [id, 1_100_000])));
  const pick = (s: PlayerGameState, id: ArtifactId, n: number) => pickInstances({ instances: s.heldArtifacts.filter((a) => a.artifactId === id) }, n);

  it("多實例選擇：使用 instanceId（不是 artifactId）；預估收入 = 件數 × 今日報價", () => {
    const s = state({ a_z1_lantern: 3, a_z1_map: 1 });
    const ids = [...pick(s, "a_z1_lantern", 2), ...pick(s, "a_z1_map", 1)];
    expect(ids.every((i) => /^d\d+$/.test(i))).toBe(true);
    const p = planSale(s, q, ids);
    expect(p.count).toBe(3);
    expect(p.total).toBe(2 * artifactSalePrice("a_z1_lantern", 1_100_000) + artifactSalePrice("a_z1_map", 1_100_000));
    expect(p.lines.find((l) => l.id === "a_z1_lantern")).toMatchObject({ heldBefore: 3, remaining: 1 });
  });

  it("情境 A：出售重複的提燈 → 仍持有完整老礦工套組，不警告", () => {
    const s = state({ a_z1_lantern: 2, a_z1_badge: 1, a_z1_map: 1 });
    expect(planSale(s, q, pick(s, "a_z1_lantern", 1)).lostSets).toEqual([]);
  });

  it("情境 B：出售最後一件 → 失去老礦工套組：Speed ×1.03", () => {
    const s = state({ a_z1_lantern: 1, a_z1_badge: 1, a_z1_map: 1 });
    expect(planSale(s, q, pick(s, "a_z1_lantern", 1)).lostSets).toEqual([{ id: "old_miner", name: "老礦工套組", bonus: "Speed ×1.03" }]);
  });

  it("一次出售造成多個套組失效：全部列出", () => {
    const zone1 = ["a_z1_lantern", "a_z1_badge", "a_z1_map"] as const;
    const zone2 = ARTIFACT_IDS.filter((id) => ARTIFACTS[id].set !== null && ARTIFACTS[id].set === ARTIFACTS.a_z2_orb.set);
    const s = state(Object.fromEntries([...zone1, ...zone2].map((id) => [id, 1])));
    const lost = planSale(s, q, [...pick(s, "a_z1_map", 1), ...pick(s, zone2[0]!, 1)]).lostSets;
    expect(lost.map((l) => l.id).sort()).toEqual(["old_miner", ARTIFACTS.a_z2_orb.set].sort());
  });

  it("已不在持有中的實例 / 沒有報價 / 超過上限", () => {
    const s = state({ a_z1_map: 1 });
    expect(planSale(s, q, ["d1", ...pick(s, "a_z1_map", 1)]).missing).toEqual(["d1"]);
    expect(planSale(s, quote("2026-11-15", {}), pick(s, "a_z1_map", 1)).total).toBeNull();
    const many = state({ a_z1_map: 101 });
    expect(planSale(many, q, pick(many, "a_z1_map", 101)).tooMany).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 畫面（記憶體後端 = 與正式伺服器相同的 handler；只替換資料庫）
// ---------------------------------------------------------------------------

async function mount(setup: (s: PlayerGameState) => void = () => {}, startAt?: number) {
  const r = rig(startAt === undefined ? {} : { backend: new MemoryBackend(startAt) });
  vi.setSystemTime(r.backend.now); // 倒數 / 報價狀態用的本機時間與伺服器一致
  await r.controller.createCharacter();
  r.backend.mutate(r.userId, setup);
  await r.controller.retryBootstrap();
  await flush();
  r.controller.dismissAllReveals();
  const runtime = { userId: r.userId, api: null as never, store: r.store, controller: r.controller } satisfies GameRuntime;
  const wrap = (ui: ReactNode) =>
    render(
      <RuntimeContext.Provider value={runtime}>
        <GameFrame email={null} onSignOut={() => {}}>
          {ui}
        </GameFrame>
      </RuntimeContext.Provider>,
    );
  const sells = () => r.backend.requests.filter((q) => (q.body as { command?: { type?: string } } | undefined)?.command?.type === "sell_artifacts");
  return { ...r, wrap, sells, view: () => r.store.getState().view! };
}
const click = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
    await flush();
  });
};
const plus = (name: string) => screen.getByRole("button", { name: `${name} 增加` });
/** 確認視窗的確認按鈕（永遠是最後一個按鈕） */
const confirmButton = () => within(screen.getByRole("alertdialog")).getAllByRole("button").at(-1)!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("市場畫面", () => {
  it("今日報價：市場日、更新時間、倒數、售價 / 倍率 / 基礎價 / 持有；未發現的寶物不揭露", async () => {
    const r = await mount((s) => give(s, "a_z1_badge", 2));
    r.wrap(<MarketPage />);
    await act(flush);
    const m = r.store.getState().market!;
    expect(screen.getByTestId("market-date").textContent).toBe(m.date.replaceAll("-", "/"));
    expect(screen.getByTestId("market-status").dataset.status).toBe("valid");
    expect(screen.getByTestId("market-next").textContent).toContain("00:00（台灣時間）");
    expect(screen.getByTestId("market-countdown").textContent).toMatch(/^\d\d:\d\d:\d\d$/);
    expect(screen.getByTestId("market-price-a_z1_badge").textContent).toBe(artifactSalePrice("a_z1_badge", m.multipliersPpm.a_z1_badge!).toLocaleString("zh-TW"));
    expect(screen.getByTestId("market-held-a_z1_badge").textContent).toBe("持有 ×2");
    expect(screen.getByTestId("market-trend-a_z1_badge").textContent).toContain("尚無歷史行情"); // 第一天：沒有歷史
    expect(screen.queryByTestId("market-change-a_z1_badge")).toBeNull();
    expect(screen.getByTestId("market-card-a_z1_heart").dataset.discovered).toBe("false");
    expect(screen.queryByText(ARTIFACTS.a_z1_heart.name)).toBeNull();
    expect(screen.queryByTestId("market-price-a_z1_heart")).toBeNull();
  });

  it("有昨天的歷史：顯示走勢與漲跌（伺服器資料）", async () => {
    const r = await mount((s) => give(s, "a_z1_map"));
    // 隔天：伺服器的歷史有昨天
    r.backend.advance(24 * HOUR);
    vi.setSystemTime(r.backend.now);
    await act(() => r.controller.refreshMarket());
    r.wrap(<MarketPage />);
    await act(flush);
    const m = r.store.getState().market!;
    expect(m.history!.length).toBe(1);
    const trend = screen.getByTestId("market-trend-a_z1_map");
    expect(trend.dataset.points).toBe("2");
    const change = dayChange(m, "a_z1_map")!;
    expect(screen.getByTestId("market-change-a_z1_map").dataset.direction).toBe(change.direction);
  });

  it("出售重複寶物：不顯示套組警告；送出的只有 instanceIds + marketDate；金幣以伺服器成交金額更新", async () => {
    const r = await mount((s) => {
      give(s, "a_z1_lantern", 2);
      give(s, "a_z1_badge");
      give(s, "a_z1_map");
    });
    r.wrap(<MarketPage />);
    await act(flush);
    await click(plus(ARTIFACTS.a_z1_lantern.name));
    expect(screen.getByTestId("market-selected-count").textContent).toBe("1");
    await click(screen.getByTestId("market-sell"));
    expect(screen.getByTestId("sale-confirm").dataset.losingSet).toBe("false");
    expect(screen.getByTestId("sale-no-set-impact")).toBeTruthy();
    expect(screen.getByTestId("sale-remaining-a_z1_lantern").textContent).toBe("持有 2 → 1");
    const coins0 = r.view().state.coins;
    await click(confirmButton());
    const [req] = r.sells();
    expect(Object.keys((req!.body as { command: object }).command).sort()).toEqual(["instanceIds", "marketDate", "type"]);
    const sold = r.store.getState().lastAction!.events.find((e) => e.type === "artifacts_sold")!;
    expect(sold.type === "artifacts_sold" && r.view().state.coins - coins0).toBeGreaterThanOrEqual(sold.type === "artifacts_sold" ? sold.coins : 0);
    expect(screen.getByTestId("market-result").textContent).toContain(`伺服器實際成交 ${(sold as { coins: number }).coins.toLocaleString("zh-TW")} 金幣`);
    expect(r.view().state.heldArtifacts.filter((a) => a.artifactId === "a_z1_lantern")).toHaveLength(1);
    expect(r.view().stats.speed1000).toBe(1_030); // 套組仍生效（伺服器回傳）
  });

  it("出售最後一件：明確警告失去套組效果；成交後伺服器能力值不再有加成；圖鑑保留", async () => {
    const r = await mount((s) => {
      for (const id of ["a_z1_lantern", "a_z1_badge", "a_z1_map"] as const) give(s, id);
    });
    r.wrap(<MarketPage />);
    await act(flush);
    expect(screen.getByTestId("market-set-a_z1_lantern")).toBeTruthy();
    await click(plus(ARTIFACTS.a_z1_lantern.name));
    await click(screen.getByTestId("market-sell"));
    expect(screen.getByTestId("sale-confirm").dataset.losingSet).toBe("true");
    expect(screen.getByTestId("sale-set-warning").textContent).toContain("出售後將失去老礦工套組效果：Speed ×1.03");
    expect(screen.getByRole("alertdialog").textContent).toContain("⚠ 出售將失去套組效果");
    await click(screen.getByRole("button", { name: "仍要出售" }));
    expect(r.view().stats.speed1000).toBe(1_000);
    expect(r.view().state.discoveredArtifacts.a_z1_lantern).toBeDefined();
    expect(screen.getByTestId("market-card-a_z1_lantern").dataset.discovered).toBe("true");
  });

  it("報價過期（確認視窗開著時換日）：沒有出售、以新報價重新計算、不自動重送；再次確認用新的 Request ID 與市場日", async () => {
    // 台灣時間 23:59:00 開始；確認前伺服器跨過午夜（線上，沒有離線報告）
    const r = await mount((s) => give(s, "a_z1_map", 2), Date.UTC(2026, 10, 14, 15, 59, 0));
    r.wrap(<MarketPage />);
    await act(flush);
    const before = r.store.getState().market!.date;
    await click(plus(ARTIFACTS.a_z1_map.name));
    await click(screen.getByTestId("market-sell"));
    r.backend.advance(70_000); // 伺服器已換日；Client 還拿著舊報價
    await click(confirmButton());
    expect(r.sells()).toHaveLength(1);
    expect(r.store.getState().lastAction!.code).toBe("MARKET_QUOTE_EXPIRED");
    expect(r.store.getState().pending).toBeNull(); // 確定的拒絕：清除未確認紀錄
    expect(r.view().state.heldArtifacts).toHaveLength(2);
    const after = r.store.getState().market!;
    expect(after.date > before).toBe(true);
    expect(screen.getByTestId("sale-problem").textContent).toBe("市場價格已更新，請重新確認");
    expect(screen.getByTestId("sale-market-date").textContent).toBe(after.date.replaceAll("-", "/"));
    expect(screen.getByTestId("sale-total").textContent).toContain(artifactSalePrice("a_z1_map", after.multipliersPpm.a_z1_map!).toLocaleString("zh-TW"));
    await act(flush);
    expect(r.sells()).toHaveLength(1); // 沒有自動重新出售
    vi.setSystemTime(r.backend.now);
    await click(screen.getByRole("button", { name: "以新報價出售" }));
    const [first, second] = r.sells();
    expect(second!.key).not.toBe(first!.key);
    expect((second!.body as { command: { marketDate: string } }).command.marketDate).toBe(after.date);
    expect(r.view().state.heldArtifacts).toHaveLength(1);
  });

  it("MARKET_UNAVAILABLE：不顯示假價格、不能出售；挖礦同步照常；未確認紀錄被清除", async () => {
    const r = await mount((s) => give(s, "a_z1_map"));
    r.wrap(<MarketPage />);
    await act(flush);
    await click(plus(ARTIFACTS.a_z1_map.name));
    await click(screen.getByTestId("market-sell"));
    r.backend.marketUnavailable = true;
    await click(confirmButton());
    expect(r.store.getState().lastAction!.code).toBe("MARKET_UNAVAILABLE");
    expect(r.store.getState().pending).toBeNull();
    expect(screen.getByTestId("sale-problem").textContent).toBe("市場價格暫時無法取得，請稍後再試");
    expect(confirmButton()).toHaveProperty("disabled", true);
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "取消" }));
    await act(flush);
    expect(screen.getByTestId("market-status").dataset.status).toBe("unavailable");
    expect(screen.getByTestId("market-price-a_z1_map").textContent).toBe("—");
    expect(screen.getByTestId("market-mult-a_z1_map").textContent).toBe("無報價");
    expect(r.view().state.heldArtifacts).toHaveLength(1);
    // 挖礦照常
    r.backend.advance(10_000);
    await act(() => r.controller.sync());
    expect(r.store.getState().sync.ok).toBe(true);
  });

  it("有待領取的離線報告：出售被阻擋", async () => {
    const r = await mount((s) => give(s, "a_z1_map"));
    r.backend.rewind(r.userId, 3 * HOUR);
    await act(() => r.controller.sync());
    expect(r.view().state.pendingOfflineReport).not.toBeNull();
    expect(await r.controller.perform({ type: "sell_artifacts", instanceIds: [r.view().state.heldArtifacts[0]!.instanceId], marketDate: r.store.getState().market!.date })).toBe("blocked");
    expect(r.sells()).toHaveLength(0);
  });

  it("確認視窗開著時另一分頁已出售：持有狀態更新、停用確認、提供重新選擇；伺服器拒絕不存在的實例", async () => {
    const r = await mount((s) => give(s, "a_z1_map", 2));
    r.wrap(<MarketPage />);
    await act(flush);
    await click(screen.getByRole("button", { name: "全部" }));
    await click(screen.getByTestId("market-sell"));
    expect(screen.getByTestId("sale-count").textContent).toBe("2");
    const gone = r.view().state.heldArtifacts[0]!.instanceId;
    r.backend.mutate(r.userId, (s) => {
      s.heldArtifacts = s.heldArtifacts.filter((a) => a.instanceId !== gone);
      s.stateVersion++;
    });
    await act(() => r.controller.sync());
    expect(confirmButton()).toHaveProperty("disabled", true);
    expect(screen.getByRole("alertdialog").textContent).toContain("持有狀態已變更");
    await click(screen.getByTestId("sale-reselect"));
    expect(screen.getByTestId("sale-count").textContent).toBe("1");
    expect(confirmButton()).toHaveProperty("disabled", false);
    // 伺服器也拒絕不存在的實例
    expect(await r.controller.perform({ type: "sell_artifacts", instanceIds: [gone], marketDate: r.store.getState().market!.date })).toBe("rejected");
    expect(r.store.getState().lastAction!.code).toBe("INSUFFICIENT_ITEMS");
  });
});
