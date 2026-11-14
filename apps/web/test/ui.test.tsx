// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { miningPosition } from "@mining/game-engine";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { Dashboard } from "@/components/game/Dashboard";
import { OfflineReportModal } from "@/components/game/OfflineReportModal";
import { RuntimeContext } from "@/components/game/runtime-context";
import type { MemoryBackend } from "@/lib/game/dev/memory-backend";
import type { GameRuntime } from "@/lib/game/runtime";
import { flush, rig } from "./helpers";

const HOUR = 3_600_000;

async function mount(setup?: (b: MemoryBackend, id: string) => void) {
  const r = rig();
  await r.controller.createCharacter();
  if (setup) {
    setup(r.backend, r.userId);
    await r.controller.retryBootstrap();
  }
  const runtime = { userId: r.userId, api: null as never, store: r.store, controller: r.controller } satisfies GameRuntime;
  const wrap = (ui: ReactNode) => render(<RuntimeContext.Provider value={runtime}>{ui}</RuntimeContext.Provider>);
  return { ...r, wrap };
}

function blockedFrontier(b: MemoryBackend, id: string): number {
  const s = b.state(id)!;
  let f = 0;
  while (miningPosition({ ...s, mining: { ...s.mining, frontierBlockIndex: f, digCounter: f } }).status === "mining") f += 10;
  return f;
}

describe("挖礦主畫面", () => {
  it("初始狀態：金幣 0、0 m、木製十字鎬 Lv1、Power / Speed / Luck、挖掘中", async () => {
    const r = await mount();
    r.wrap(<Dashboard email="a@b.c" onSignOut={() => {}} />);
    expect(screen.getByTestId("coins").textContent).toBe("0");
    expect(screen.getByTestId("max-depth").textContent).toBe("0 m");
    expect(screen.getByText("木製十字鎬 Lv1")).toBeTruthy();
    expect(screen.getByTestId("power").textContent).toBe("2.0");
    expect(screen.getByText("×1.00")).toBeTruthy();
    expect(screen.getByTestId("mining-status").textContent).toBe("挖掘中");
    expect(screen.getByTestId("mining-position").textContent).toContain("新手礦坑・前線 0 m");
    expect(screen.getByRole("progressbar", { name: "目前方塊進度" })).toBeTruthy();
  });

  it("同步成功後畫面更新（金幣、最大深度、Recent Loot）", async () => {
    const r = await mount();
    r.wrap(<Dashboard email={null} onSignOut={() => {}} />);
    r.backend.advance(200_000);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "立即同步" }));
      await flush();
    });
    const s = r.backend.state(r.userId)!;
    expect(screen.getByTestId("max-depth").textContent).toBe(`${s.mining.frontierBlockIndex / 10} m`);
    expect(screen.getByTestId("coins").textContent).toBe(s.coins.toLocaleString("zh-TW"));
    expect(screen.getAllByTestId("loot-entry").length).toBeGreaterThan(0);
    expect(screen.getByTestId("latest-result").textContent).toContain("個方塊");
  });

  it("Power 不足：顯示卡關原因與需要的 Power；可以切換重挖", async () => {
    const r = await mount((b, id) => {
      const f = blockedFrontier(b, id);
      b.mutate(id, (x) => void ((x.mining.frontierBlockIndex = f), (x.mining.digCounter = f)));
    });
    r.wrap(<Dashboard email={null} onSignOut={() => {}} />);
    expect(screen.getByTestId("mining-status").textContent).toBe("Power 不足");
    expect(screen.getByTestId("hint-power").textContent).toMatch(/需要 Power [\d.]+，目前 2\.0/);
    const rework = screen.getByRole("radio", { name: /重挖/ });
    expect((rework as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(rework);
      await flush();
    });
    expect(r.backend.state(r.userId)!.mining.mode).toBe("rework");
    expect(screen.getByTestId("mining-status").textContent).toBe("挖掘中");
  });

  it("礦區未解鎖：顯示解鎖提示與費用；金幣不足時按鈕停用", async () => {
    const r = await mount((b, id) =>
      b.mutate(id, (x) => {
        x.pickaxes = { pick_wood: 1, pick_stone: 1, pick_iron: 1, pick_gold: 1, pick_diamond: 5 };
        x.equippedPickaxe = "pick_diamond";
        x.mining.frontierBlockIndex = 1000;
        x.mining.digCounter = 1000;
      }),
    );
    r.wrap(<Dashboard email={null} onSignOut={() => {}} />);
    expect(screen.getByTestId("mining-status").textContent).toBe("礦區未解鎖");
    expect(screen.getByTestId("hint-unlock").textContent).toContain("水晶洞窟");
    const btn = screen.getByRole("button", { name: /金幣不足/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});

describe("離線報告", () => {
  it("列出離線時間、有效挖掘時間、方塊數、金幣、礦物；領取期間按鈕停用；領取後更新", async () => {
    const r = await mount((b, id) => b.rewind(id, 3 * HOUR));
    const report = r.store.getState().view!.state.pendingOfflineReport!;
    r.wrap(<OfflineReportModal report={report} />);
    expect(screen.getByRole("dialog", { name: "⛏ 探險報告" })).toBeTruthy();
    expect(screen.getByTestId("report-away").textContent).toBe("3 小時 0 分");
    expect(screen.getByTestId("report-mined").textContent).toMatch(/小時|分/);
    expect(screen.getByTestId("report-blocks").textContent).toBe(report.blocksMined.toLocaleString("zh-TW"));
    expect(screen.getByTestId("report-coins").textContent).toBe(`+${report.rewards.coins.toLocaleString("zh-TW")}`);
    expect(screen.getByRole("list", { name: "礦物" })).toBeTruthy();
    r.backend.latencyMs = 20;
    const btn = screen.getByRole("button", { name: "領取探險成果" }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(btn);
      fireEvent.click(btn); // 連點
    });
    expect((screen.getByRole("button", { name: "領取中…" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      await new Promise((x) => setTimeout(x, 60));
      await flush();
    });
    expect(r.backend.requests.filter((x) => x.fn === "game-action" && (x.body as { command: { type: string } }).command.type === "claim_report")).toHaveLength(1);
    expect(r.store.getState().view!.state.pendingOfflineReport).toBeNull();
  });

  it("標示 NEW DISCOVERY 與首次寶物保護", async () => {
    const r = await mount((b, id) => b.rewind(id, 5 * HOUR)); // 4 小時有效挖掘仍無寶物 → 首次保護（D18）
    const report = r.store.getState().view!.state.pendingOfflineReport!;
    expect(report.rewards.artifacts.length).toBeGreaterThan(0);
    r.wrap(<OfflineReportModal report={report} />);
    const entries = screen.getAllByTestId("report-artifact");
    expect(entries.length).toBe(report.rewards.artifacts.length);
    expect(screen.getAllByText("NEW DISCOVERY").length).toBe(report.rewards.artifacts.filter((a) => a.isNewDiscovery).length);
    if (report.firstTreasureGranted) expect(screen.getByText("首次寶物保護")).toBeTruthy();
  });
});

describe("進入點（Auth gating）", () => {
  it("未登入 → 導向 /login；登入過期 → /login?expired=1", async () => {
    const replace = vi.fn();
    vi.resetModules();
    vi.doMock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
    let status = "signed_out";
    vi.doMock("@/lib/auth/auth-provider", () => ({
      useAuth: () => ({ status, userId: null, email: null, signIn: vi.fn(), signUp: vi.fn(), signOut: vi.fn() }),
    }));
    const { GameApp } = await import("@/components/game/GameApp");
    const view = render(<GameApp />);
    expect(replace).toHaveBeenCalledWith("/login");
    expect(screen.queryByTestId("coins")).toBeNull();
    status = "loading";
    view.rerender(<GameApp />);
    expect(screen.getByRole("status").textContent).toBe("載入中…");
    vi.doUnmock("next/navigation");
    vi.doUnmock("@/lib/auth/auth-provider");
  });
});
