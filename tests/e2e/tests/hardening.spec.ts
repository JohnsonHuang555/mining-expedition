import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { type BrowserContext, type Page, type Route, expect, test } from "@playwright/test";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres", max: 2 });
test.afterAll(async () => pool.end());

const PASSWORD = "e2e-password-123";
const HOUR = 3_600_000;
const SHOTS = process.env.E2E_SCREENSHOT_DIR ?? "screenshots";
mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png`, animations: "disabled" });
};

async function newPlayer(page: Page): Promise<{ email: string; id: string }> {
  const email = `e2e-hard-${randomUUID()}@example.test`;
  await page.goto("/login");
  await page.getByRole("tab", { name: "註冊" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("密碼").fill(PASSWORD);
  await page.getByRole("button", { name: "建立帳號" }).click();
  await page.getByRole("button", { name: "開始探險" }).click();
  await expect(page.getByTestId("mining-status")).toHaveText("挖掘中");
  const id = (await pool.query<{ id: string }>(`select id from auth.users where email = $1`, [email])).rows[0]!.id;
  return { email, id };
}

/** 伺服器收到並提交，但瀏覽器收不到回應（模擬回應在網路上遺失） */
async function loseResponses(target: Page | BrowserContext, command: string): Promise<() => Promise<void>> {
  const handler = async (route: Route) => {
    if (route.request().method() === "POST" && route.request().postData()?.includes(`"type":"${command}"`)) {
      await route.fetch(); // 送到真正的 Edge Function（已提交）
      return route.abort("connectionreset");
    }
    return route.fallback();
  };
  await target.route("**/functions/v1/game-action", handler);
  return () => target.unroute("**/functions/v1/game-action", handler);
}

const logCount = async (id: string, command: string) =>
  (await pool.query<{ n: number }>(`select count(*)::int as n from public.action_log where player_id = $1 and command = $2 and (response->>'ok')::boolean`, [id, command])).rows[0]!.n;

test("同帳號兩個分頁：A 出售的回應遺失 → B 看到未確認並被阻擋 → A、B 同時重新整理 → 只出售一次；之後 B 可以購買", async ({ context }) => {
  const a = await context.newPage();
  const { id } = await newPlayer(a);
  await pool.query(`update public.players set coins = 1000 where id = $1`, [id]);
  await pool.query(`insert into public.player_inventory values ($1, 'stone', 200) on conflict (player_id, item_id) do update set quantity = 200`, [id]);
  await a.goto("/inventory");
  const b = await context.newPage();
  await b.goto("/workshop");
  await expect(b.getByTestId("buy-pick_stone")).toBeEnabled();

  // 兩個分頁都收不到出售的回應（B 的自動調和也一樣），直到網路恢復
  const restore = await loseResponses(context, "sell_items");
  await a.getByLabel("石頭 出售數量", { exact: true }).fill("10");
  await a.getByTestId("sell-stone").click();
  await expect(a.getByTestId("pending-action")).toBeVisible({ timeout: 30_000 });
  await expect(a.getByTestId("action-result")).toContainText("結果尚未確認");
  expect(await logCount(id, "sell_items")).toBe(1); // 伺服器已提交
  // B 透過 storage 看到 A 的未確認交易：交易按鈕停用
  await expect(b.getByTestId("pending-action")).toBeVisible();
  await expect(b.getByTestId("buy-pick_stone")).toBeDisabled();
  await shot(b, "09-pending-other-tab");
  await restore();

  // A、B 同時重新整理：以原本的 Request ID 調和，不會再出售一次
  await Promise.all([a.reload(), b.reload()]);
  await expect(a.getByTestId("pending-action")).toBeHidden({ timeout: 30_000 });
  await expect(b.getByTestId("pending-action")).toBeHidden({ timeout: 30_000 });
  expect(await logCount(id, "sell_items")).toBe(1);
  const keys = await pool.query(`select count(distinct idempotency_key)::int as n from public.action_log where player_id = $1 and command = 'sell_items'`, [id]);
  expect(keys.rows[0].n).toBe(1);

  await b.getByTestId("buy-pick_stone").click();
  await expect(b.getByTestId("pickaxe-pick_stone")).toHaveAttribute("data-status", "equipped");
  expect(await logCount(id, "purchase_pickaxe")).toBe(1);
});

test("分頁在交易進行中突然關閉：另一個分頁確認那筆交易，不重複執行", async ({ context }) => {
  const a = await context.newPage();
  const { id } = await newPlayer(a);
  await pool.query(`update public.players set coins = 1000 where id = $1`, [id]);
  await pool.query(`insert into public.player_inventory values ($1, 'stone', 200) on conflict (player_id, item_id) do update set quantity = 200`, [id]);
  await a.goto("/workshop");
  const b = await context.newPage();
  await b.goto("/");
  // A 的購買送到伺服器後，回應永遠不回來；A 在等待中被關閉
  let forwarded!: () => void;
  const sent = new Promise<void>((r) => (forwarded = r));
  await a.route("**/functions/v1/game-action", async (route) => {
    if (route.request().postData()?.includes("purchase_pickaxe")) {
      await route.fetch();
      forwarded();
      return new Promise(() => {}); // 不回應
    }
    return route.fallback();
  });
  await a.getByTestId("buy-pick_stone").click();
  await sent;
  await a.close({ runBeforeUnload: false });
  // B：看到 A 留下的未確認交易，自動（或按重新確認）以同一個 Request ID 確認
  await expect(b.getByTestId("pending-action")).toBeVisible();
  // 不需要玩家操作：B 的排程在 A 釋放交易鎖（分頁關閉）後，以同一個 Request ID 確認
  await expect(b.getByTestId("pending-action")).toBeHidden({ timeout: 40_000 });
  expect(await logCount(id, "purchase_pickaxe")).toBe(1);
  await expect(b.getByText("石製十字鎬 Lv1")).toBeVisible();
});

test("離線報告的領取回應遺失：網路恢復後自動以同一個 Key 確認，只入帳一次", async ({ page }) => {
  const { id } = await newPlayer(page);
  await pool.query(`update public.players set created_at_ms = created_at_ms - $2, last_settled_at_ms = last_settled_at_ms - $2 where id = $1`, [id, 2 * HOUR]);
  await page.reload();
  const dialog = page.getByRole("dialog", { name: "⛏ 探險報告" });
  await expect(dialog).toBeVisible();
  const reward = Number((await dialog.getByTestId("report-coins").textContent())!.replace(/[^\d]/g, ""));
  const restore = await loseResponses(page, "claim_report");
  await dialog.getByRole("button", { name: "領取探險成果" }).click();
  await expect(dialog.getByTestId("claim-uncertain")).toBeVisible({ timeout: 30_000 }); // 重試用完 → 結果未確認
  await expect(dialog).toBeVisible();
  expect((await pool.query(`select count(*)::int as n from public.offline_reports where player_id = $1 and status = 'claimed'`, [id])).rows[0].n).toBe(1); // 伺服器已領取
  await shot(page, "10-claim-uncertain");
  await restore();
  // 不需要玩家操作：排程以同一個 key 調和
  await expect(dialog).toBeHidden({ timeout: 40_000 });
  const claims = await pool.query(`select count(*)::int as n, count(distinct idempotency_key)::int as k from public.action_log where player_id = $1 and command = 'claim_report'`, [id]);
  expect(claims.rows[0]).toEqual({ n: 1, k: 1 });
  expect(Number((await page.getByTestId("coins").textContent())!.replace(/[^\d]/g, ""))).toBeGreaterThanOrEqual(reward);
});

test("確認視窗：鍵盤操作、Esc 關閉後焦點回到出售按鈕", async ({ page }) => {
  const { id } = await newPlayer(page);
  await pool.query(`insert into public.player_inventory values ($1, 'coal', 30) on conflict (player_id, item_id) do update set quantity = 30`, [id]);
  await page.goto("/inventory");
  await page.getByTestId("inv-row-coal").getByRole("button", { name: "全部" }).click();
  await page.getByTestId("sell-coal").focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "取消" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "確定出售" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "取消" })).toBeFocused(); // 不會跑出視窗
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("sell-coal")).toBeFocused();
  await expect(page.getByTestId("inv-qty-coal")).toHaveText("×30");
});
