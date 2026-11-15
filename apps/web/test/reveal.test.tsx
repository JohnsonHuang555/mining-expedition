// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { type PlayerGameState, frontierSpot } from "@mining/game-engine";
import { type ReactNode, StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RevealOverlay } from "@/components/game/RevealOverlay";
import { RuntimeContext } from "@/components/game/runtime-context";
import { MemoryBackend } from "@/lib/game/dev/memory-backend";
import { type RevealItem, RevealQueue, SEEN_LIMIT, browserRevealStore, legacyRevealKey, memoryRevealStore, revealNamespace } from "@/lib/game/reveal";
import type { GameRuntime } from "@/lib/game/runtime";
import { flush, rig } from "./helpers";
import { findSecret, firstBlockDrops, nearlyDone, toBase64 } from "./support/rig-drops";

void frontierSpot;
const HOUR = 3_600_000;
const item = (n: number, artifactId: RevealItem["artifactId"] = "a_z1_lantern", extra: Partial<RevealItem> = {}): RevealItem => ({
  key: `d${n}`,
  digCounter: n,
  artifactId,
  rarity: artifactId.endsWith("heart") || artifactId === "a_z3_crown" ? "legendary" : "epic",
  isNewDiscovery: false,
  protection: false,
  origin: "online",
  ...extra,
});

afterEach(() => vi.unstubAllGlobals());

describe("RevealQueue（去重與保存）", () => {
  it("依 digCounter 排序；同一個實例只入列一次；同種寶物的兩個實例合法顯示兩次", () => {
    const q = new RevealQueue();
    expect(q.enqueue([item(30), item(10), item(10)])).toBe(2);
    expect(q.enqueue([item(10), item(20, "a_z1_lantern")])).toBe(1);
    expect(q.items().map((i) => i.key)).toEqual(["d10", "d20", "d30"]);
    expect(q.items().filter((i) => i.artifactId === "a_z1_lantern")).toHaveLength(3);
  });

  it("看完 / 全部略過後不會再入列（Replay）；重新開啟（同一份保存）佇列與紀錄都還在", () => {
    const store = memoryRevealStore();
    const a = new RevealQueue(store);
    a.enqueue([item(1), item(2), item(3)]);
    a.dismiss("d1");
    expect(a.enqueue([item(1)])).toBe(0);
    const reopened = new RevealQueue(store); // 重新整理
    expect(reopened.items().map((i) => i.key)).toEqual(["d2", "d3"]);
    reopened.dismissAll();
    expect(reopened.items()).toEqual([]);
    expect(new RevealQueue(store).enqueue([item(1), item(2), item(3)])).toBe(0);
  });

  it("多分頁共用：A 入列後 B 不會重複入列；任一分頁略過，兩邊都移除", () => {
    const shared = memoryRevealStore();
    const a = new RevealQueue(shared);
    const b = new RevealQueue(shared);
    a.enqueue([item(5)]);
    expect(b.enqueue([item(5)])).toBe(0);
    b.dismiss("d5");
    expect(a.items()).toEqual([]);
  });

  it("已播放紀錄有上限；被淘汰的較舊實例仍視為已播放（digCounter 只增不減）", () => {
    const q = new RevealQueue();
    const n = SEEN_LIMIT + 20;
    q.enqueue(Array.from({ length: 40 }, (_, i) => item(i)));
    for (let i = 0; i < n; i++) {
      q.enqueue([item(1000 + i)]);
      q.dismiss(`d${1000 + i}`);
    }
    q.dismissAll();
    expect(q.enqueue([item(3)])).toBe(0); // 被淘汰（≤ floor）
    expect(q.enqueue([item(5000)])).toBe(1);
  });
});

describe("RevealQueue：多分頁交錯讀寫（PR #12 Review P1-1）", () => {
  it("兩個分頁同時入列不同實例：交錯寫入不會互相覆蓋", () => {
    const shared = memoryRevealStore();
    const a = new RevealQueue(shared);
    const b = new RevealQueue(shared);
    // A 已檢查完、正要寫入時，B 整個入列流程插進來
    shared.beforeSet = () => void b.enqueue([item(7)]);
    a.enqueue([item(5)]);
    expect(a.items().map((i) => i.key)).toEqual(["d5", "d7"]);
    expect(b.items().map((i) => i.key)).toEqual(["d5", "d7"]);
  });

  it("入列與略過競爭：B 以舊的判斷入列 X，期間 A 已入列並略過 X → X 不會回來，Replay 也不會", () => {
    const shared = memoryRevealStore();
    const a = new RevealQueue(shared);
    const b = new RevealQueue(shared);
    shared.beforeSet = () => {
      a.enqueue([item(9)]);
      a.dismiss("d9");
    };
    b.enqueue([item(9)]); // 已通過「未知」檢查後才寫入（晚到的寫入）
    expect(a.items()).toEqual([]);
    expect(b.items()).toEqual([]);
    expect(b.enqueue([item(9)])).toBe(0);
    expect(a.enqueue([item(9)])).toBe(0);
  });

  it("略過與另一個分頁入列其他實例交錯：已播放紀錄不遺失、新項目保留", () => {
    const shared = memoryRevealStore();
    const a = new RevealQueue(shared);
    const b = new RevealQueue(shared);
    a.enqueue([item(1), item(2)]);
    shared.beforeSet = () => void b.enqueue([item(3)]);
    a.dismiss("d1");
    expect(b.items().map((i) => i.key)).toEqual(["d2", "d3"]);
    expect(b.enqueue([item(1)])).toBe(0);
  });

  it("清理已播放紀錄時有另一個分頁晚到的舊入列：floor 先寫好 → 不重播", async () => {
    const shared = memoryRevealStore();
    const a = new RevealQueue(shared);
    const b = new RevealQueue(shared);
    for (let i = 0; i < SEEN_LIMIT + 10; i++) {
      a.enqueue([item(i)]);
      a.dismiss(`d${i}`);
    }
    await a.prune();
    expect([...shared.data.keys()].filter((k) => k.startsWith("s:")).length).toBeLessThanOrEqual(SEEN_LIMIT);
    shared.set("q:d3", JSON.stringify(item(3))); // 舊快照晚到
    expect(b.items()).toEqual([]);
    expect(b.enqueue([item(3)])).toBe(0);
  });

  it("不支援 Web Lock：不清理（保守），也不重播", async () => {
    const shared = memoryRevealStore({ locks: false });
    const q = new RevealQueue(shared);
    for (let i = 0; i < SEEN_LIMIT + 10; i++) {
      q.enqueue([item(i)]);
      q.dismiss(`d${i}`);
    }
    await q.prune();
    expect([...shared.data.keys()].filter((k) => k.startsWith("s:"))).toHaveLength(SEEN_LIMIT + 10);
    expect(q.enqueue([item(0)])).toBe(0);
  });

  it("清理不會吃掉仍待播放、digCounter 較小的項目", async () => {
    const shared = memoryRevealStore();
    const q = new RevealQueue(shared);
    q.enqueue([item(0)]); // 尚未播放
    for (let i = 1; i <= SEEN_LIMIT + 10; i++) {
      q.enqueue([item(i)]);
      q.dismiss(`d${i}`);
    }
    await q.prune();
    expect(q.items().map((i) => i.key)).toEqual(["d0"]);
  });

  it("瀏覽器儲存：每個實例一個 key；v1 舊資料遷移（待播放保留、已播放不重播）", () => {
    localStorage.clear();
    localStorage.setItem(legacyRevealKey("u1"), JSON.stringify({ queue: [item(8)], seen: [{ key: "d2", d: 2 }], floor: 1 }));
    const q = new RevealQueue(browserRevealStore("u1"));
    expect(localStorage.getItem(legacyRevealKey("u1"))).toBeNull();
    expect(q.items().map((i) => i.key)).toEqual(["d8"]);
    expect(q.enqueue([item(1), item(2)])).toBe(0);
    expect(localStorage.getItem(`${revealNamespace("u1")}q:d8`)).not.toBeNull();
    // 另一個分頁（同一個 localStorage）
    const other = new RevealQueue(browserRevealStore("u1"));
    other.dismiss("d8");
    expect(q.items()).toEqual([]);
    localStorage.clear();
  });
});

describe("RevealQueue：大量待播放不截斷（PR #12 Review P1-2）", () => {
  it("同一批 60 件：全部保留、依序；回傳實際加入數；同批重複去重", () => {
    const q = new RevealQueue();
    const batch = Array.from({ length: 60 }, (_, i) => item(100 - i));
    expect(q.enqueue([...batch, item(41)])).toBe(60);
    const keys = q.items().map((i) => i.key);
    expect(keys).toHaveLength(60);
    expect(keys[0]).toBe("d41");
    expect(keys[59]).toBe("d100");
  });

  it("51 件；佇列已有 50 件再追加 10 件；重新整理後仍完整；全部略過後不重播", () => {
    const shared = memoryRevealStore();
    const a = new RevealQueue(shared);
    expect(a.enqueue(Array.from({ length: 51 }, (_, i) => item(i)))).toBe(51);
    a.dismiss("d50");
    expect(a.items()).toHaveLength(50);
    expect(a.enqueue(Array.from({ length: 10 }, (_, i) => item(200 + i)))).toBe(10);
    const refreshed = new RevealQueue(shared);
    expect(refreshed.items()).toHaveLength(60);
    expect(refreshed.items()[0]!.key).toBe("d0");
    refreshed.dismissAll();
    expect(refreshed.items()).toEqual([]);
    expect(new RevealQueue(shared).enqueue(Array.from({ length: 51 }, (_, i) => item(i)))).toBe(0);
  });

  it("儲存空間不足：該筆保留在本分頁記憶體仍會播放；略過後不重播", () => {
    const q = new RevealQueue(memoryRevealStore({ quota: 5 }));
    expect(q.enqueue(Array.from({ length: 10 }, (_, i) => item(i)))).toBe(10);
    expect(q.items()).toHaveLength(10);
    q.dismissAll();
    expect(q.items()).toEqual([]);
    expect(q.enqueue(Array.from({ length: 10 }, (_, i) => item(i)))).toBe(0);
  });
});

/** 一位玩家，下一次在線結算的第一個方塊會掉出指定稀有度的寶物 */
async function onlineDrop(rarity: "epic" | "legendary", opts: { firstTreasure?: "pending" | "obtained" } = {}) {
  const r = rig();
  await r.controller.createCharacter();
  r.backend.mutate(r.userId, (s) => {
    Object.assign(s.mining, nearlyDone(s, 1_500));
    if (opts.firstTreasure === "obtained") s.firstTreasure = { status: "obtained", effectiveMiningMs: 0, resolvedAt: s.createdAt, artifactInstanceId: "d0", reportId: null };
  });
  await r.controller.retryBootstrap();
  const state = r.backend.state(r.userId)!;
  const secret = findSecret(state, state.lastSettledAt + 2_000, firstBlockDrops(rarity), `unit-${rarity}`);
  r.backend.players.get(r.userId)!.secret = toBase64(secret);
  r.backend.advance(2_000);
  return r;
}

describe("在線取得寶物 → 揭曉", () => {
  it.each(["epic", "legendary"] as const)("%s：只有伺服器確認的方塊產生揭曉；NEW DISCOVERY；持有與圖鑑一致", async (rarity) => {
    const r = await onlineDrop(rarity);
    expect(r.store.getState().reveals).toEqual([]); // 預估進度不產生任何揭曉
    await r.controller.sync();
    const [rev] = r.store.getState().reveals;
    expect(rev).toMatchObject({ rarity, isNewDiscovery: true, origin: "online" });
    const s = r.backend.state(r.userId)!;
    expect(s.heldArtifacts.map((a) => a.instanceId)).toContain(rev!.key);
    expect(s.discoveredArtifacts[rev!.artifactId]).toBeDefined();
    expect(r.store.getState().recentLoot.some((l) => l.artifact === rev!.artifactId)).toBe(true);
  });

  it("同一個回應 Replay（回應遺失後以同一個 key 重送）不會重複揭曉", async () => {
    const r = await onlineDrop("epic");
    r.backend.faults.push("drop_response"); // 伺服器已結算；Client 重送得到相同回應
    await r.controller.sync();
    await r.controller.sync();
    expect(r.store.getState().reveals).toHaveLength(1);
  });

  it("沒有事件（其他分頁 / 裝置取得，以持有清單補上）：會揭曉，但不推斷 NEW DISCOVERY（PR #12 Review P2）", async () => {
    const r = rig();
    await r.controller.createCharacter(); // 基準
    r.backend.mutate(r.userId, (s) => {
      s.heldArtifacts.push({ instanceId: "d50", artifactId: "a_z1_map", obtainedAt: s.lastSettledAt, mode: "frontier", band: 0, frontierBlockIndex: 0, digCounter: 50, source: "drop" });
      s.discoveredArtifacts.a_z1_map = { firstDiscoveredAt: s.lastSettledAt, firstBand: 0, totalFound: 1 }; // 時間戳相同也不當作首次的證明
      s.mining.digCounter = Math.max(s.mining.digCounter, 51);
    });
    await r.controller.sync();
    await flush();
    expect(r.store.getState().reveals.find((i) => i.key === "d50")).toMatchObject({ artifactId: "a_z1_map", isNewDiscovery: false });
  });

  it("首次寶物保護（在線）：專屬標記", async () => {
    const r = rig();
    await r.controller.createCharacter();
    r.backend.mutate(r.userId, (s) => {
      Object.assign(s.mining, nearlyDone(s, 1_500));
      s.firstTreasure = { ...s.firstTreasure, effectiveMiningMs: 4 * HOUR - 1_000 };
    });
    await r.controller.retryBootstrap();
    const state = r.backend.state(r.userId)!;
    const secret = findSecret(state, state.lastSettledAt + 2_000, (x) => x.blocks[0]?.protection !== null && x.blocks[0]?.protection !== undefined, "unit-protect");
    r.backend.players.get(r.userId)!.secret = toBase64(secret);
    r.backend.advance(2_000);
    await r.controller.sync();
    expect(r.store.getState().reveals[0]).toMatchObject({ protection: true, isNewDiscovery: true });
  });

  it("重新整理後已看過的不重播；未看完的繼續播放", async () => {
    const backend = new MemoryBackend();
    const persistence = memoryRevealStore();
    const a = rig({ backend });
    await a.controller.createCharacter();
    backend.mutate(a.userId, (s) => {
      for (const n of [3, 4]) s.heldArtifacts.push({ instanceId: `d${n}`, artifactId: "a_z1_lantern", obtainedAt: s.createdAt, mode: "frontier", band: 0, frontierBlockIndex: 0, digCounter: n, source: "drop" });
      s.discoveredArtifacts.a_z1_lantern = { firstDiscoveredAt: s.createdAt, firstBand: 0, totalFound: 2 };
      s.firstTreasure = { status: "obtained", effectiveMiningMs: 0, resolvedAt: s.createdAt, artifactInstanceId: "d3", reportId: null };
      s.mining.digCounter = 10;
    });
    // 重新整理後第一次讀到的既有寶物：不揭曉（基準）
    const b = rig({ backend, userId: a.userId });
    const q = new RevealQueue(persistence);
    // 用同一份保存模擬：佇列中有一件尚未看完
    q.enqueue([item(4)]);
    const c = new (await import("@/lib/game/controller")).GameController({ api: (b.controller as unknown as { api: never }).api, store: b.store, reveals: new RevealQueue(persistence), channel: null });
    await c.bootstrap();
    expect(b.store.getState().reveals.map((i) => i.key)).toEqual(["d4"]); // 未看完的繼續
    c.dismissReveal("d4");
    const d = new (await import("@/lib/game/controller")).GameController({ api: (b.controller as unknown as { api: never }).api, store: b.store, reveals: new RevealQueue(persistence), channel: null });
    await d.bootstrap();
    expect(b.store.getState().reveals).toEqual([]); // 已看過、既有寶物都不重播
  });
});

describe("離線報告 → 領取後揭曉", () => {
  async function offlineWithArtifacts() {
    const r = rig();
    await r.controller.createCharacter();
    r.backend.mutate(r.userId, (s) => void (s.firstTreasure = { ...s.firstTreasure, effectiveMiningMs: 4 * HOUR - 30_000 }));
    const state = r.backend.state(r.userId)!;
    // 離線期間：首次保護 + 自然掉落的 Legendary（皆在前段方塊）
    const secret = findSecret(
      state,
      state.lastSettledAt + 10 * 60_000,
      (x) => !!x.report && x.report.rewards.artifacts.some((a) => a.source === "first_treasure_protection") && x.report.rewards.artifacts.some((a) => a.artifactId === "a_z1_heart"),
      "unit-offline",
    );
    r.backend.players.get(r.userId)!.secret = toBase64(secret);
    r.backend.rewind(r.userId, 10 * 60_000);
    await r.controller.retryBootstrap();
    return r;
  }

  it("領取前不入列；領取成功後依順序入列（首次保護、Legendary、NEW DISCOVERY）", async () => {
    const r = await offlineWithArtifacts();
    const report = r.store.getState().view!.state.pendingOfflineReport!;
    expect(report.rewards.artifacts.length).toBeGreaterThanOrEqual(2);
    expect(r.store.getState().reveals).toEqual([]);
    expect(await r.controller.claimReport()).toBe(true);
    const reveals = r.store.getState().reveals;
    expect(reveals.map((i) => i.key)).toEqual(report.rewards.artifacts.map((a) => a.instanceId)); // 報告中的順序（digCounter）
    expect(reveals.every((i) => i.origin === "offline")).toBe(true);
    expect(reveals.find((i) => i.protection)).toBeDefined();
    expect(reveals.find((i) => i.rarity === "legendary")).toBeDefined();
    expect(reveals[0]!.isNewDiscovery).toBe(true);
  });

  it("領取回應遺失 → 以同一個 Request ID 調和 → 只揭曉一次", async () => {
    const r = await offlineWithArtifacts();
    const n = r.store.getState().view!.state.pendingOfflineReport!.rewards.artifacts.length;
    r.backend.faults.push("drop_response", "network", "network", "network");
    expect(await r.controller.claimReport()).toBe(false);
    expect(r.store.getState().reveals).toEqual([]); // 未確認：不揭曉
    await r.controller.sync(); // 調和
    expect(r.store.getState().reveals).toHaveLength(n);
    await r.controller.sync();
    expect(r.store.getState().reveals).toHaveLength(n);
  });

  it("D23：沒有完成方塊的離線不產生揭曉", async () => {
    const r = rig();
    await r.controller.createCharacter();
    r.backend.mutate(r.userId, (s) => void ((s.mining.frontierBlockIndex = 500), (s.mining.digCounter = 500)));
    r.backend.rewind(r.userId, 6 * HOUR);
    await r.controller.retryBootstrap();
    expect(r.store.getState().view!.state.pendingOfflineReport).toBeNull();
    expect(r.store.getState().reveals).toEqual([]);
  });
});

describe("揭曉畫面", () => {
  async function mounted(items: RevealItem[], wrapper: (n: ReactNode) => ReactNode = (n) => n) {
    const r = rig();
    await r.controller.createCharacter();
    (r.controller as unknown as { reveals: RevealQueue }).reveals.enqueue(items);
    r.store.setState({ reveals: (r.controller as unknown as { reveals: RevealQueue }).reveals.items() });
    const runtime = { userId: r.userId, api: null as never, store: r.store, controller: r.controller } satisfies GameRuntime;
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const view = render(wrapper(<RuntimeContext.Provider value={runtime}><RevealOverlay /></RuntimeContext.Provider>) as never);
    return { ...r, view, opener };
  }

  it("Epic 卡片與 Legendary 全螢幕；依序顯示；跳過單筆 / 全部；Escape；焦點在對話框內並在結束後還原", async () => {
    const m = await mounted([item(1, "a_z1_heart", { isNewDiscovery: true }), item(2, "a_z1_map", { protection: true })]);
    expect(screen.getByTestId("reveal-overlay").dataset.rarity).toBe("legendary");
    expect(screen.getByTestId("reveal-name").textContent).toBe("礦脈之心");
    expect(screen.getByTestId("reveal-new")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByTestId("reveal-next"));
    // Tab 不會跑到背景
    const last = screen.getByTestId("reveal-collection");
    act(() => last.focus());
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    fireEvent.keyDown(document, { key: "Tab" });
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    await act(async () => fireEvent.click(screen.getByTestId("reveal-next")));
    expect(screen.getByTestId("reveal-overlay").dataset.rarity).toBe("epic");
    expect(screen.getByTestId("reveal-protection").textContent).toBe("首次寶物保護");
    expect(screen.queryByTestId("reveal-new")).toBeNull();
    await act(async () => fireEvent.keyDown(document, { key: "Escape" }));
    expect(screen.queryByTestId("reveal-overlay")).toBeNull();
    expect(document.activeElement).toBe(m.opener);
    expect(m.store.getState().reveals).toEqual([]);
  });

  it("全部略過", async () => {
    const m = await mounted([item(1), item(2), item(3)]);
    expect(screen.getByTestId("reveal-next").textContent).toBe("收下（還有 2 件）");
    await act(async () => fireEvent.click(screen.getByTestId("reveal-skip-all")));
    expect(screen.queryByTestId("reveal-overlay")).toBeNull();
    expect(m.store.getState().reveals).toEqual([]);
  });

  it("React Strict Mode：同一筆只顯示一個、不會重複入列", async () => {
    const m = await mounted([item(7, "a_z2_heart")], (n) => <StrictMode>{n}</StrictMode>);
    expect(screen.getAllByTestId("reveal-overlay")).toHaveLength(1);
    expect(m.store.getState().reveals).toHaveLength(1);
  });

  it("Reduced Motion：靜態卡片（沒有光芒與粒子），名稱、稀有度、標記與按鈕仍在", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), addEventListener() {}, removeEventListener() {} }));
    await mounted([item(1, "a_z3_crown", { isNewDiscovery: true, protection: true })]);
    await act(async () => flush());
    const overlay = screen.getByTestId("reveal-overlay");
    expect(overlay.dataset.reduced).toBe("true");
    expect(overlay.querySelector(".reveal-rays")).toBeNull();
    expect(overlay.querySelector(".reveal-particle")).toBeNull();
    expect(screen.getByTestId("reveal-rarity").textContent).toBe("LEGENDARY");
    expect(screen.getByTestId("reveal-new")).toBeTruthy();
    expect(screen.getByTestId("reveal-protection")).toBeTruthy();
    expect(screen.getByTestId("reveal-next")).toBeTruthy();
  });

  it("待領報告時不顯示揭曉（先處理報告，D20）", async () => {
    const r = rig();
    await r.controller.createCharacter();
    r.backend.rewind(r.userId, 2 * HOUR);
    await r.controller.retryBootstrap();
    (r.controller as unknown as { reveals: RevealQueue }).reveals.enqueue([item(1)]);
    r.store.setState({ reveals: (r.controller as unknown as { reveals: RevealQueue }).reveals.items() });
    render(<RuntimeContext.Provider value={{ userId: r.userId, api: null as never, store: r.store, controller: r.controller }}><RevealOverlay /></RuntimeContext.Provider>);
    expect(screen.queryByTestId("reveal-overlay")).toBeNull();
  });
});

void ({} as PlayerGameState);
