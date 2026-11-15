// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { ARTIFACTS, ARTIFACT_IDS, type ArtifactId } from "@mining/game-data";
import { type PlayerGameState, computeStats, heldCounts } from "@mining/game-engine";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { CollectionPage } from "@/components/game/CollectionPage";
import { GameFrame } from "@/components/game/Dashboard";
import { RuntimeContext } from "@/components/game/runtime-context";
import { collectionEntries, collectionProgress, filterEntries, setRows } from "@/lib/game/collection";
import type { GameRuntime } from "@/lib/game/runtime";
import { flush, rig } from "./helpers";

let seq = 0;
function give(s: PlayerGameState, id: ArtifactId, opts: { held?: number; found?: number } = {}) {
  const held = opts.held ?? 1;
  for (let i = 0; i < held; i++) {
    const n = 9_000 + seq++;
    s.heldArtifacts.push({ instanceId: `d${n}`, artifactId: id, obtainedAt: s.createdAt, mode: "frontier", band: 2, frontierBlockIndex: 200, digCounter: n, source: "drop" });
  }
  s.discoveredArtifacts[id] = { firstDiscoveredAt: s.createdAt, firstBand: 2, totalFound: opts.found ?? Math.max(1, held) };
  if (s.firstTreasure.status === "pending") s.firstTreasure = { status: "obtained", effectiveMiningMs: 0, resolvedAt: s.createdAt, artifactInstanceId: s.heldArtifacts[0]?.instanceId ?? "d0", reportId: null };
  s.mining.digCounter = Math.max(s.mining.digCounter, 9_000 + seq);
}

async function mount(setup: (s: PlayerGameState) => void = () => {}) {
  const r = rig();
  await r.controller.createCharacter();
  r.backend.mutate(r.userId, setup);
  await r.controller.retryBootstrap();
  const runtime = { userId: r.userId, api: null as never, store: r.store, controller: r.controller } satisfies GameRuntime;
  const wrap = (ui: ReactNode) =>
    render(
      <RuntimeContext.Provider value={runtime}>
        <GameFrame email={null} onSignOut={() => {}}>
          {ui}
        </GameFrame>
      </RuntimeContext.Provider>,
    );
  return { ...r, wrap, view: () => r.store.getState().view! };
}
const sets = () => fireEvent.click(screen.getByRole("tab", { name: "套組" }));

describe("圖鑑", () => {
  it("全部未發現：0 / 12，全部是剪影、不顯示任何寶物名稱", async () => {
    const r = await mount();
    r.wrap(<CollectionPage />);
    expect(screen.getByTestId("collection-overall").textContent).toContain("0 / 12（0%）");
    for (const id of ARTIFACT_IDS) {
      expect(screen.getByTestId(`artifact-${id}`).dataset.discovered).toBe("false");
      expect(screen.queryByText(ARTIFACTS[id].name)).toBeNull();
    }
    expect(screen.getAllByText("？？？")).toHaveLength(12);
  });

  it("首次發現與重複發現：已發現顯示名稱；詳細資料顯示持有數、歷史發現次數、首次發現", async () => {
    const r = await mount((s) => {
      give(s, "a_z1_lantern", { held: 2, found: 3 });
      give(s, "a_z1_heart");
    });
    r.wrap(<CollectionPage />);
    expect(screen.getByTestId("collection-overall").textContent).toContain("2 / 12（17%）");
    expect(within(screen.getByTestId("artifact-a_z1_lantern")).getByText("老礦工的提燈")).toBeTruthy();
    fireEvent.click(screen.getByTestId("artifact-a_z1_lantern"));
    const d = screen.getByTestId("artifact-detail");
    expect(within(d).getByTestId("detail-held").textContent).toBe("×2");
    expect(within(d).getByTestId("detail-found").textContent).toBe("×3");
    expect(within(d).getByText("老礦工套組")).toBeTruthy();
    expect(within(d).getByText(/基礎估值不是當日成交價/)).toBeTruthy();
  });

  it("曾發現但目前不再持有（出售後）：仍然是已發現，持有 0", async () => {
    const r = await mount((s) => give(s, "a_z2_orb"));
    r.backend.mutate(r.userId, (s) => void (s.heldArtifacts = s.heldArtifacts.filter((a) => a.artifactId !== "a_z2_orb")));
    await r.controller.retryBootstrap();
    r.wrap(<CollectionPage />);
    const card = screen.getByTestId("artifact-a_z2_orb");
    expect(card.dataset.discovered).toBe("true");
    expect(within(card).getByText("共鳴水晶球")).toBeTruthy();
    expect(screen.getByTestId("artifact-held-a_z2_orb").textContent).toContain("已發現，未持有");
  });

  it("各礦區完成率；狀態 / 礦區 / 稀有度篩選", async () => {
    const r = await mount((s) => {
      for (const id of ["a_z1_lantern", "a_z1_badge", "a_z1_map", "a_z1_heart", "a_z2_crown", "a_z3_crown"] as ArtifactId[]) give(s, id);
    });
    const entries = collectionEntries(r.view().state);
    const p = collectionProgress(entries);
    expect(p.byZone.map((z) => `${z.found}/${z.total}`)).toEqual(["4/4", "1/4", "1/4"]);
    expect(p.overall.found).toBe(6);
    expect(filterEntries(entries, { status: "undiscovered", zone: "all", rarity: "all" })).toHaveLength(6);
    expect(filterEntries(entries, { status: "all", zone: "all", rarity: "legendary" }).map((e) => e.id)).toEqual(["a_z1_heart", "a_z2_heart", "a_z3_crown"]);
    expect(filterEntries(entries, { status: "discovered", zone: 2, rarity: "all" }).map((e) => e.id)).toEqual(["a_z3_crown"]);

    r.wrap(<CollectionPage />);
    expect(screen.getByTestId("collection-zone-0").textContent).toContain("4/4");
    fireEvent.click(within(screen.getByRole("group", { name: "稀有度" })).getByRole("button", { name: "Legendary" }));
    expect(screen.getAllByRole("listitem").filter((li) => li.closest('[aria-label="寶物"]'))).toHaveLength(3);
    expect(screen.getByTestId("artifact-a_z1_heart")).toBeTruthy();
    expect(screen.queryByTestId("artifact-a_z1_lantern")).toBeNull();
    fireEvent.click(within(screen.getByRole("group", { name: "狀態" })).getByRole("button", { name: "未發現" }));
    expect(screen.getByTestId("artifact-a_z2_heart")).toBeTruthy();
    expect(screen.queryByTestId("artifact-a_z1_heart")).toBeNull();
    fireEvent.click(within(screen.getByRole("group", { name: "礦區" })).getByRole("button", { name: "新手礦坑" }));
    expect(screen.getByTestId("collection-empty")).toBeTruthy();
  });
});

describe("套組", () => {
  it.each([
    [0, [] as ArtifactId[]],
    [1, ["a_z1_lantern"] as ArtifactId[]],
    [2, ["a_z1_lantern", "a_z1_badge"] as ArtifactId[]],
    [3, ["a_z1_lantern", "a_z1_badge", "a_z1_map"] as ArtifactId[]],
  ])("老礦工套組 %i / 3：完成度、缺少的寶物、是否生效；能力值與伺服器一致", async (n, ids) => {
    const r = await mount((s) => ids.forEach((id) => give(s, id)));
    const row = setRows(r.view().state).find((x) => x.id === "old_miner")!;
    expect(row.heldMembers).toBe(n);
    expect(row.active).toBe(n === 3);
    expect(row.missing).toHaveLength(3 - n);
    r.wrap(<CollectionPage />);
    sets();
    expect(screen.getByTestId("set-held-old_miner").textContent).toBe(`${n} / 3`);
    expect(screen.getByTestId("set-status-old_miner").textContent).toBe(n === 3 ? "加成生效中" : "未生效");
    expect(screen.getByTestId("set-bonus-old_miner").textContent).toBe("Speed ×1.03");
    // 伺服器回傳的 Speed：木製 ×1.00；完成後 ×1.03（UI 只顯示，不自行計算加成）
    expect(r.view().stats.speed1000).toBe(n === 3 ? 1_030 : 1_000);
    expect(screen.getByTestId("sets-speed").textContent).toBe(n === 3 ? "×1.03" : "×1.00");
    expect(r.view().stats).toEqual(computeStats(r.view().state.equippedPickaxe, 1, heldCounts(r.view().state)));
  });

  it("失去其中一件（例如出售）後：加成失效，但「曾經集齊」仍為是；重新取得後恢復", async () => {
    const r = await mount((s) => ["a_z3_emblem", "a_z3_ring", "a_z3_tablet"].forEach((id) => give(s, id as ArtifactId)));
    expect(r.view().stats).toMatchObject({ speed1000: 1_030, luckPpm: 20_000 });
    r.backend.mutate(r.userId, (s) => void (s.heldArtifacts = s.heldArtifacts.filter((a) => a.artifactId !== "a_z3_ring")));
    await act(async () => {
      await r.controller.retryBootstrap();
      await flush();
    });
    r.wrap(<CollectionPage />);
    sets();
    expect(r.view().stats).toMatchObject({ speed1000: 1_000, luckPpm: 0 });
    expect(screen.getByTestId("set-active-ancient_civilization").dataset.ok).toBe("false");
    expect(screen.getByTestId("set-ever-ancient_civilization").dataset.ok).toBe("true");
    expect(screen.getByTestId("set-owned-ancient_civilization").dataset.ok).toBe("false");
    expect(screen.getByTestId("set-missing-ancient_civilization").textContent).toContain("遠古王者之戒（已發現，目前未持有）");
    expect(screen.getByTestId("sets-luck").textContent).toBe("0.0%");
    // 重新取得
    r.backend.mutate(r.userId, (s) => give(s, "a_z3_ring"));
    await act(async () => {
      await r.controller.retryBootstrap();
      await flush();
    });
    expect(screen.getByTestId("set-status-ancient_civilization").textContent).toBe("加成生效中");
    expect(screen.getByTestId("sets-luck").textContent).toBe("2.0%");
  });

  it("未發現的成員以剪影顯示，不透露名稱", async () => {
    const r = await mount((s) => give(s, "a_z2_orb"));
    r.wrap(<CollectionPage />);
    sets();
    const card = screen.getByTestId("set-crystal_resonance");
    expect(within(card).getByText("共鳴水晶球")).toBeTruthy();
    expect(within(card).queryByText("晶簇頭冠")).toBeNull();
    expect(within(card).getAllByText("？？？")).toHaveLength(2);
    expect(screen.getByTestId("set-missing-crystal_resonance").textContent).toContain("未發現的寶物 ×2");
  });
});
