import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { type Page, expect, test } from "@playwright/test";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres", max: 2 });
test.afterAll(async () => pool.end());

const PASSWORD = "e2e-password-123";
const HOUR = 3_600_000;
const SHOTS = process.env.E2E_SCREENSHOT_DIR ?? "screenshots";
mkdirSync(SHOTS, { recursive: true });

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png`, fullPage: false });
}

async function userId(email: string): Promise<string> {
  const r = await pool.query<{ id: string }>(`select id from auth.users where email = $1`, [email]);
  return r.rows[0]!.id;
}

/** 測試用時光倒流（等同玩家離開了 ms 毫秒）；正式程式碼沒有任何改時間的方式 */
async function rewind(id: string, ms: number) {
  await pool.query(`update public.players set created_at_ms = created_at_ms - $2, last_settled_at_ms = last_settled_at_ms - $2 where id = $1`, [id, ms]);
}

async function signUp(page: Page): Promise<string> {
  const email = `e2e-${randomUUID()}@example.test`;
  await page.goto("/login");
  await page.getByRole("tab", { name: "註冊" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("密碼").fill(PASSWORD);
  await page.getByRole("button", { name: "建立帳號" }).click();
  return email;
}

test.describe.configure({ mode: "serial" });

test("未登入不能進入遊戲：導向登入頁", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("button", { name: "進入礦坑" })).toBeVisible();
  await shot(page, "01-login");
});

test("註冊 → 建立角色 → 挖礦主畫面 → 同步 → Session 恢復 → 離線報告 → 卡關 → 登出 / 登入", async ({ page }) => {
  const email = await signUp(page);

  // 建立角色
  await expect(page.getByRole("heading", { name: "建立礦工" })).toBeVisible();
  await shot(page, "02-create-character");
  await page.getByRole("button", { name: "開始探險" }).click();

  // 初始狀態
  await expect(page.getByTestId("mining-status")).toHaveText("挖掘中");
  await expect(page.getByTestId("coins")).toHaveText("0");
  await expect(page.getByText("木製十字鎬 Lv1")).toBeVisible();
  await expect(page.getByTestId("power")).toHaveText("2.0");

  // 在線挖掘：等第一個方塊完成並同步（木製十字鎬約 6.5 秒一個方塊）
  await page.waitForTimeout(8_000);
  await page.getByRole("button", { name: "立即同步" }).click();
  await expect(page.getByTestId("loot-entry").first()).toBeVisible();
  await expect(page.getByTestId("sync-status")).toHaveText(/已同步/);
  await shot(page, "03-dashboard");

  // Session 恢復：重新整理不需要再登入
  await page.reload();
  await expect(page.getByTestId("mining-status")).toBeVisible();
  await expect(page).toHaveURL(/\/$/);

  // 離線 3 小時 → 重新開啟 → 先顯示探險報告
  const id = await userId(email);
  await rewind(id, 3 * HOUR);
  await page.reload();
  const dialog = page.getByRole("dialog", { name: "⛏ 探險報告" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("report-away")).toHaveText(/3 小時/);
  const reward = Number((await dialog.getByTestId("report-coins").textContent())!.replace(/[^\d]/g, ""));
  await shot(page, "04-offline-report");
  // 有待領報告時其他操作被阻擋（畫面被報告覆蓋）
  await expect(page.getByRole("button", { name: "立即同步" })).toHaveCount(0); // 主畫面被報告覆蓋（aria-hidden）
  await dialog.getByRole("button", { name: "領取探險成果" }).click();
  await expect(dialog).toBeHidden();
  const coins = Number((await page.getByTestId("coins").textContent())!.replace(/[^\d]/g, ""));
  expect(coins).toBeGreaterThanOrEqual(reward);
  const db = await pool.query<{ n: number }>(`select count(*)::int as n from public.offline_reports where player_id = $1 and status = 'claimed'`, [id]);
  expect(db.rows[0]!.n).toBe(1);

  // Power 不足：前線 50 m（木製十字鎬 Power 2.0 < 4.0）
  await pool.query(`update public.players set frontier_block_index = 500, dig_counter = dig_counter + 500 - frontier_block_index where id = $1`, [id]);
  await page.reload();
  await expect(page.getByTestId("mining-status")).toHaveText("Power 不足");
  await expect(page.getByTestId("hint-power")).toContainText("需要 Power 4.0");
  await shot(page, "05-blocked-power");
  await page.getByRole("radio", { name: /重挖/ }).click();
  await expect(page.getByTestId("mining-status")).toHaveText("挖掘中");
  await expect(page.getByTestId("mining-position")).toContainText("重挖");

  // 登出 → 登入頁；再登入回到同一個角色
  await page.getByRole("button", { name: "登出" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("密碼").fill(PASSWORD);
  await page.getByRole("button", { name: "進入礦坑" }).click();
  await expect(page.getByTestId("mining-position")).toContainText("重挖");
});

test("Session 失效（token 被撤銷）→ 回到登入頁並提示重新登入", async ({ page }) => {
  const email = await signUp(page);
  await page.getByRole("button", { name: "開始探險" }).click();
  await expect(page.getByTestId("mining-status")).toHaveText("挖掘中");
  // 撤銷這個使用者的所有 session（等同在其他地方登出全部裝置 / refresh token 過期）
  await pool.query(`delete from auth.sessions where user_id = $1`, [await userId(email)]);
  await pool.query(`delete from auth.refresh_tokens where user_id = $1::text`, [await userId(email)]);
  await page.getByRole("button", { name: "立即同步" }).click();
  await expect(page).toHaveURL(/\/login/);
});

test("多分頁：一個分頁領取報告後，另一個分頁也更新", async ({ context }) => {
  const a = await context.newPage();
  const email = await signUp(a);
  await a.getByRole("button", { name: "開始探險" }).click();
  await expect(a.getByTestId("mining-status")).toHaveText("挖掘中");
  await rewind(await userId(email), 2 * HOUR);
  await a.reload();
  const b = await context.newPage();
  await b.goto("/");
  await expect(a.getByRole("dialog")).toBeVisible();
  await expect(b.getByRole("dialog")).toBeVisible();
  await a.getByRole("button", { name: "領取探險成果" }).click();
  await expect(a.getByRole("dialog")).toBeHidden();
  // 另一個分頁：收到通知後重新讀取，或按領取時得到「已領取」並恢復
  await expect(b.getByRole("dialog")).toBeHidden({ timeout: 10_000 }).catch(async () => {
    await b.getByRole("button", { name: "領取探險成果" }).click();
    await expect(b.getByRole("dialog")).toBeHidden();
  });
  await expect(b.getByTestId("coins")).toHaveText((await a.getByTestId("coins").textContent())!);
});
