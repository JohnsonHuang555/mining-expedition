import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { type Page, type Route, expect, test } from "@playwright/test";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres", max: 2 });
test.afterAll(async () => pool.end());

const PASSWORD = "e2e-password-123";
const SHOTS = process.env.E2E_SCREENSHOT_DIR ?? "screenshots";
mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png`, animations: "disabled" });
};

async function newPlayer(page: Page): Promise<string> {
  const email = `e2e-rel-${randomUUID()}@example.test`;
  await page.goto("/login");
  await page.getByRole("tab", { name: "註冊" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("密碼").fill(PASSWORD);
  await page.getByRole("button", { name: "建立帳號" }).click();
  await page.getByRole("button", { name: "開始探險" }).click();
  await expect(page.getByTestId("mining-status")).toHaveText("挖掘中");
  return (await pool.query<{ id: string }>(`select id from auth.users where email = $1`, [email])).rows[0]!.id;
}
const sells = async (id: string) => Number((await pool.query(`select count(*)::int as n from public.action_log where player_id = $1 and command = 'sell_items'`, [id])).rows[0].n);
const isSell = (route: Route) => route.request().method() === "POST" && (route.request().postData() ?? "").includes('"sell_items"');

test("市場首次載入與同步競爭：直接開啟 /market（bootstrap / 結算進行中）最後仍取得歷史", async ({ page }) => {
  await newPlayer(page);
  // 讓 bootstrap 的結算變慢，確保市場頁面在操作進行中掛載
  await page.route("**/functions/v1/game-action", async (route) => {
    await new Promise((r) => setTimeout(r, 800));
    await route.fallback();
  });
  await page.goto("/market");
  await expect(page.getByTestId("market-status")).toHaveAttribute("data-history", "loaded");
  await expect(page.getByTestId("market-status")).toHaveAttribute("data-status", "valid");
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("網路中斷後恢復：同步狀態顯示中斷，恢復後自動 / 手動同步成功", async ({ page }) => {
  await newPlayer(page);
  const offline = (route: Route) => route.abort("internetdisconnected");
  await page.route("**/functions/v1/**", offline);
  await page.getByRole("button", { name: "立即同步" }).click();
  await expect(page.getByTestId("sync-status")).not.toHaveText(/已同步/, { timeout: 30_000 });
  await shot(page, "21-network-down");
  await page.unroute("**/functions/v1/**", offline);
  await expect(page.getByRole("button", { name: "立即同步" })).toBeEnabled({ timeout: 30_000 });
  await page.getByRole("button", { name: "立即同步" }).click();
  await expect(page.getByTestId("sync-status")).toHaveText(/已同步/, { timeout: 30_000 });
});

test("交易結果不確定：伺服器已提交但回應遺失 → 顯示未確認 → 以同一個 Request ID 確認，只執行一次", async ({ page }) => {
  const id = await newPlayer(page);
  await pool.query(`insert into public.player_inventory values ($1, 'stone', 50) on conflict (player_id, item_id) do update set quantity = 50`, [id]);
  await page.goto("/inventory");
  await expect(page.getByTestId("inv-qty-stone")).toBeVisible();
  const keys = new Set<string>();
  const lose = async (route: Route) => {
    if (!isSell(route)) return route.fallback();
    keys.add(route.request().headers()["idempotency-key"]!);
    await route.fetch().catch(() => null); // 伺服器收到並提交
    await route.abort("connectionreset"); // 回應遺失
  };
  await page.route("**/functions/v1/game-action", lose);
  await page.getByLabel("石頭 出售數量", { exact: true }).fill("5");
  await page.getByTestId("sell-stone").click();
  await expect(page.getByTestId("pending-action")).toBeVisible({ timeout: 30_000 });
  await shot(page, "22-uncertain");
  expect(keys.size).toBe(1);
  await page.unroute("**/functions/v1/game-action", lose);
  await page.getByTestId("pending-action").getByRole("button", { name: "重新確認" }).click();
  await expect(page.getByTestId("pending-action")).toBeHidden({ timeout: 30_000 });
  expect(await sells(id)).toBe(1);
  const logged = await pool.query(`select idempotency_key::text as k from public.action_log where player_id = $1 and command = 'sell_items'`, [id]);
  expect(keys.has(logged.rows[0].k)).toBe(true);
});

test("Rate limit 後恢復：429 + Retry-After → 保留為未確認並自動以同一個 Request ID 重試，只執行一次", async ({ page }) => {
  const id = await newPlayer(page);
  await pool.query(`insert into public.player_inventory values ($1, 'stone', 50) on conflict (player_id, item_id) do update set quantity = 50`, [id]);
  await page.goto("/inventory");
  await expect(page.getByTestId("inv-qty-stone")).toBeVisible();
  let limited = 0;
  const keys = new Set<string>();
  const limit = async (route: Route) => {
    if (!isSell(route)) return route.fallback();
    const key = route.request().headers()["idempotency-key"]!;
    keys.add(key);
    if (limited < 4) {
      limited++;
      return route.fulfill({
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "2", "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "retry-after" },
        body: JSON.stringify({ ok: false, requestId: key, command: "sell_items", error: { code: "RATE_LIMITED", message: "too many requests" }, retryAfterMs: 2_000 }),
      });
    }
    return route.fallback();
  };
  await page.route("**/functions/v1/game-action", limit);
  await page.getByLabel("石頭 出售數量", { exact: true }).fill("3");
  await page.getByTestId("sell-stone").click();
  await expect(page.getByText("操作太頻繁").first()).toBeVisible({ timeout: 30_000 });
  await shot(page, "23-rate-limited");
  await expect(page.getByTestId("pending-action")).toBeHidden({ timeout: 40_000 });
  expect(keys.size).toBe(1); // 所有重試都是同一個 Request ID
  expect(await sells(id)).toBe(1);
  await page.unroute("**/functions/v1/game-action", limit);
});
