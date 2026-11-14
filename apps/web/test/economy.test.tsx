// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { PlayerGameState } from "@mining/game-engine";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { GameFrame } from "@/components/game/Dashboard";
import { InventoryPage } from "@/components/game/InventoryPage";
import { RuntimeContext } from "@/components/game/runtime-context";
import { WorkshopPage } from "@/components/game/WorkshopPage";
import type { GameRuntime } from "@/lib/game/runtime";
import { flush, rig } from "./helpers";

const HOUR = 3_600_000;

async function mount(setup: (s: PlayerGameState) => void) {
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
  const actions = (type: string) => r.backend.requests.filter((x) => x.fn === "game-action" && (x.body as { command: { type: string } }).command.type === type);
  return { ...r, wrap, actions, server: () => r.backend.state(r.userId)! };
}

const click = async (el: HTMLElement) =>
  act(async () => {
    fireEvent.click(el);
    await flush();
  });

describe("背包", () => {
  it("顯示礦物（名稱、數量、稀有度、單價、總價）與素材；素材沒有出售按鈕", async () => {
    const r = await mount((s) => void (s.inventory = { stone: 40, silver: 3, amethyst: 2, iron_ingot: 4 }));
    r.wrap(<InventoryPage />);
    expect(screen.getByTestId("inv-qty-stone").textContent).toBe("×40");
    expect(within(screen.getByTestId("inv-row-stone")).getByText("單價 1・合計 40")).toBeTruthy();
    expect(within(screen.getByTestId("inv-row-silver")).getByText("單價 35・合計 105")).toBeTruthy();
    expect(within(screen.getByTestId("inv-row-amethyst")).getByText("稀有")).toBeTruthy();
    expect(screen.getByTestId("inv-qty-iron_ingot").textContent).toBe("×4");
    expect(within(screen.getByTestId("inv-row-iron_ingot")).queryByRole("button")).toBeNull();
    expect(screen.getByText("全部出售約 245 金幣")).toBeTruthy();
  });

  it("空背包", async () => {
    const r = await mount((s) => void (s.inventory = {}));
    r.wrap(<InventoryPage />);
    expect(screen.getByTestId("inventory-empty")).toBeTruthy();
  });

  it("出售指定數量：成功後金幣與數量以伺服器結果更新；提示顯示伺服器回傳的金額", async () => {
    const r = await mount((s) => void (s.inventory = { copper: 30 }));
    r.wrap(<InventoryPage />);
    const coins = r.server().coins;
    fireEvent.change(screen.getByLabelText("銅礦 出售數量"), { target: { value: "5" } });
    expect(screen.getByTestId("sell-copper").textContent).toBe("出售 +30");
    await click(screen.getByTestId("sell-copper"));
    expect(r.actions("sell_items")).toHaveLength(1);
    expect((r.actions("sell_items")[0]!.body as { command: unknown }).command).toEqual({ type: "sell_items", itemId: "copper", quantity: 5 });
    expect(screen.getByTestId("inv-qty-copper").textContent).toBe("×25");
    expect(screen.getByTestId("coins").textContent).toBe(r.server().coins.toLocaleString("zh-TW"));
    expect(r.server().coins - coins).toBeGreaterThanOrEqual(30);
    expect(screen.getByTestId("action-result").textContent).toContain("已出售 銅礦 ×5，獲得 30 金幣");
  });

  it("數量不合法（0、超過持有量、小數）時不能送出", async () => {
    const r = await mount((s) => void (s.inventory = { stone: 10 }));
    r.wrap(<InventoryPage />);
    const input = screen.getByLabelText("石頭 出售數量");
    for (const v of ["0", "11", "1.5", "", "-3"]) {
      fireEvent.change(input, { target: { value: v } });
      expect((screen.getByTestId("sell-stone") as HTMLButtonElement).disabled, v).toBe(true);
    }
    expect(r.actions("sell_items")).toHaveLength(0);
  });

  it("全部出售需要確認；取消不送出；確認後只送出一次（連點也一樣）", async () => {
    const r = await mount((s) => void (s.inventory = { coal: 20 }));
    r.wrap(<InventoryPage />);
    fireEvent.click(within(screen.getByTestId("inv-row-coal")).getByText("全部"));
    await click(screen.getByTestId("sell-coal"));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    await click(screen.getByRole("button", { name: "取消" }));
    expect(r.actions("sell_items")).toHaveLength(0);
    await click(screen.getByTestId("sell-coal"));
    r.backend.latencyMs = 10;
    const confirm = screen.getByRole("button", { name: "確定出售" });
    await act(async () => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
      await new Promise((x) => setTimeout(x, 40));
      await flush();
    });
    expect(r.actions("sell_items")).toHaveLength(1);
    expect(r.server().inventory.coal).toBeUndefined();
    expect(screen.queryByTestId("inv-row-coal")).toBeNull();
  });

  it("數量不足（伺服器拒絕）：不改變任何數值，顯示失敗", async () => {
    const r = await mount((s) => void (s.inventory = { stone: 3 }));
    expect(await r.controller.perform({ type: "sell_items", itemId: "stone", quantity: 4 })).toBe("rejected");
    expect(r.store.getState().view!.state.inventory.stone).toBe(3);
    expect(r.store.getState().lastAction).toMatchObject({ outcome: "rejected", message: "素材或物品不足" });
  });

  it("製作素材不可出售（伺服器拒絕，不送出也不改變）", async () => {
    const r = await mount((s) => void (s.inventory = { iron_ingot: 2 }));
    expect(await r.controller.perform({ type: "sell_items", itemId: "iron_ingot" as never, quantity: 1 })).toBe("rejected");
    expect(r.server().inventory.iron_ingot).toBe(2);
  });

  it("待領離線報告時：背包按鈕停用、出售不會送出", async () => {
    const r = await mount((s) => void (s.inventory = { stone: 50 }));
    r.backend.rewind(r.userId, 2 * HOUR);
    await r.controller.retryBootstrap();
    expect(r.store.getState().view!.state.pendingOfflineReport).not.toBeNull();
    r.wrap(<InventoryPage />);
    expect((screen.getByTestId("sell-stone") as HTMLButtonElement).disabled).toBe(true);
    expect(await r.controller.perform({ type: "sell_items", itemId: "stone", quantity: 1 })).toBe("blocked");
    expect(r.actions("sell_items")).toHaveLength(0);
  });
});

describe("工坊", () => {
  it("十字鎬列表：擁有 / 裝備中 / 可購買 / 未開放、等級、數值與下一級變化、成本", async () => {
    const r = await mount((s) => {
      s.coins = 100;
      s.inventory = { stone: 10 };
    });
    r.wrap(<WorkshopPage />);
    expect(screen.getByTestId("pickaxe-pick_wood").dataset.status).toBe("equipped");
    expect(screen.getByTestId("pickaxe-pick_stone").dataset.status).toBe("purchasable");
    expect(screen.getByTestId("pickaxe-pick_iron").dataset.status).toBe("locked");
    expect(screen.getByTestId("pickaxe-level-pick_wood").textContent).toBe("Lv1 / 5");
    expect(screen.getByTestId("pickaxe-power-pick_wood").textContent).toBe("2.0→ 2.2");
    expect(within(screen.getByTestId("pickaxe-pick_iron")).getByText("需先擁有 石製十字鎬（必須依序購買）。")).toBeTruthy();
    // 購買成本取自 game-data：金幣 200、石頭 40；不足時列出缺少的項目並停用
    expect(screen.getByTestId("purchase-cost-pick_stone").textContent).toContain("100 / 200");
    expect(screen.getByTestId("purchase-cost-pick_stone").textContent).toContain("10 / 40");
    expect(within(screen.getByTestId("pickaxe-pick_stone")).getByText("缺少：金幣 ×100、石頭 ×30")).toBeTruthy();
    expect((screen.getByTestId("buy-pick_stone") as HTMLButtonElement).disabled).toBe(true);
  });

  it("購買成功：扣款、擁有並自動裝備，能力值立即更新", async () => {
    const r = await mount((s) => {
      s.coins = 500;
      s.inventory = { stone: 60 };
    });
    r.wrap(<WorkshopPage />);
    await click(screen.getByTestId("buy-pick_stone"));
    const s = r.server();
    expect(s.pickaxes.pick_stone).toBe(1);
    expect(s.coins).toBeLessThanOrEqual(500 - 200 + 50); // 操作前的在線結算可能加了少量金幣
    expect(screen.getByTestId("pickaxe-pick_stone").dataset.status).toBe("equipped");
    expect(screen.getByTestId("power").textContent).toBe("5.0");
    expect(screen.getByTestId("action-result").textContent).toContain("購買了 石製十字鎬");
  });

  it("購買失敗（伺服器拒絕：資源不足 / 跳過前置）：畫面不顯示扣款或擁有", async () => {
    const r = await mount((s) => void (s.coins = 50));
    expect(await r.controller.perform({ type: "purchase_pickaxe", pickaxeId: "pick_stone" })).toBe("rejected");
    expect(await r.controller.perform({ type: "purchase_pickaxe", pickaxeId: "pick_gold" })).toBe("rejected");
    expect(r.store.getState().lastAction).toMatchObject({ outcome: "rejected", message: "尚未達成條件" });
    const view = r.store.getState().view!.state;
    expect(view.pickaxes).toEqual({ pick_wood: 1 });
    expect(view.coins).toBe(r.server().coins);
  });

  it("強化成功：等級與數值提升、LEVEL UP 回饋；素材不足時列出缺少並停用", async () => {
    const r = await mount((s) => {
      s.coins = 300;
      s.inventory = { reinforce_stone: 1 };
    });
    r.wrap(<WorkshopPage />);
    await click(screen.getByTestId("upgrade-pick_wood"));
    expect(r.server().pickaxes.pick_wood).toBe(2);
    expect(screen.getByTestId("pickaxe-level-pick_wood").textContent).toBe("Lv2 / 5");
    expect(screen.getByText("LEVEL UP!")).toBeTruthy();
    expect(screen.getByTestId("power").textContent).toBe("2.2");
    // 下一級需要強化石 ×2，已經用完
    expect(within(screen.getByTestId("pickaxe-pick_wood")).getByText(/缺少：強化石 ×2/)).toBeTruthy();
    expect((screen.getByTestId("upgrade-pick_wood") as HTMLButtonElement).disabled).toBe(true);
  });

  it("最高等級：不顯示強化按鈕；伺服器也拒絕", async () => {
    const r = await mount((s) => {
      s.pickaxes = { pick_wood: 5 };
      s.coins = 99_999;
      s.inventory = { reinforce_stone: 10 };
    });
    r.wrap(<WorkshopPage />);
    expect(screen.getByTestId("maxed-pick_wood")).toBeTruthy();
    expect(screen.queryByTestId("upgrade-pick_wood")).toBeNull();
    expect(await r.controller.perform({ type: "upgrade_pickaxe", pickaxeId: "pick_wood" })).toBe("rejected");
    expect(r.store.getState().lastAction?.message).toBe("已達最高等級");
  });

  it("切換裝備：能力值立即更新；目前方塊的進度依引擎規則保留（UI 不重置）", async () => {
    const r = await mount((s) => {
      s.pickaxes = { pick_wood: 1, pick_stone: 3 };
      s.equippedPickaxe = "pick_stone";
    });
    r.backend.advance(3_000);
    await r.controller.sync();
    const before = r.server().mining;
    r.wrap(<WorkshopPage />);
    expect(screen.getByTestId("power").textContent).toBe("6.0");
    await click(screen.getByTestId("equip-pick_wood"));
    expect(screen.getByTestId("power").textContent).toBe("2.0");
    expect(screen.getByTestId("pickaxe-pick_wood").dataset.status).toBe("equipped");
    const after = r.server().mining;
    expect(after.blockWork).toBe(before.blockWork); // P5：保留累積工作量
    expect(after.mode).toBe(before.mode);
    expect(r.store.getState().view!.state.mining).toEqual(after);
  });

  it("製作：顯示配方與可製作數量；製作 N 個後背包更新；不足時停用並列出缺少", async () => {
    const r = await mount((s) => void (s.inventory = { iron_ore: 12, coal: 5 }));
    r.wrap(<WorkshopPage />);
    const card = screen.getByTestId("recipe-iron_ingot");
    expect(within(card).getByText("目前最多可製作 2 個")).toBeTruthy();
    fireEvent.change(within(card).getByLabelText("鐵錠 製作數量"), { target: { value: "2" } });
    await click(screen.getByTestId("craft-iron_ingot"));
    expect((r.actions("craft")[0]!.body as { command: unknown }).command).toEqual({ type: "craft", materialId: "iron_ingot", times: 2 });
    expect(r.server().inventory).toMatchObject({ iron_ingot: 2, iron_ore: 2, coal: 1 });
    expect(screen.getByTestId("recipe-owned-iron_ingot").textContent).toBe("持有 ×2");
    expect((screen.getByTestId("craft-iron_ingot") as HTMLButtonElement).disabled).toBe(true);
    expect(within(screen.getByTestId("recipe-iron_ingot")).getByText(/缺少：鐵礦 ×3、煤炭 ×1/)).toBeTruthy();
  });

  it("製作失敗（伺服器拒絕）：素材不變", async () => {
    const r = await mount((s) => void (s.inventory = { stone: 5 }));
    expect(await r.controller.perform({ type: "craft", materialId: "reinforce_stone", times: 1 })).toBe("rejected");
    expect(r.store.getState().view!.state.inventory).toEqual({ stone: 5 });
  });

  it("待領離線報告時：工坊操作被阻擋", async () => {
    const r = await mount((s) => {
      s.coins = 1_000;
      s.inventory = { stone: 100 };
    });
    r.backend.rewind(r.userId, 2 * HOUR);
    await r.controller.retryBootstrap();
    r.wrap(<WorkshopPage />);
    expect((screen.getByTestId("buy-pick_stone") as HTMLButtonElement).disabled).toBe(true);
    expect(await r.controller.perform({ type: "purchase_pickaxe", pickaxeId: "pick_stone" })).toBe("blocked");
    expect(r.actions("purchase_pickaxe")).toHaveLength(0);
  });
});
