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
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png`, fullPage: false, animations: "disabled" });
}
const userId = async (email: string) => (await pool.query<{ id: string }>(`select id from auth.users where email = $1`, [email])).rows[0]!.id;
const coinsOf = async (page: Page) => Number((await page.getByTestId("coins").textContent())!.replace(/[^\d]/g, ""));

test("經濟循環：挖礦 → 出售 → 購買 → 製作 → 強化 → 裝備 → 成長有效 → 重新整理 / 重新登入後一致", async ({ page }) => {
  const email = `e2e-eco-${randomUUID()}@example.test`;
  await page.goto("/login");
  await page.getByRole("tab", { name: "註冊" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("密碼").fill(PASSWORD);
  await page.getByRole("button", { name: "建立帳號" }).click();
  await page.getByRole("button", { name: "開始探險" }).click();
  await expect(page.getByTestId("mining-status")).toHaveText("挖掘中");

  // 1–2. 挖礦獲得礦物（離線 3 小時的探險成果）
  const id = await userId(email);
  await pool.query(`update public.players set created_at_ms = created_at_ms - $2, last_settled_at_ms = last_settled_at_ms - $2 where id = $1`, [id, 3 * HOUR]);
  await page.reload();
  await page.getByRole("button", { name: "領取探險成果" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  // 3. 背包：出售礦物取得金幣（切換頁面不重新登入、不重建狀態）
  await page.getByRole("navigation", { name: "主要功能" }).getByRole("link", { name: /背包/ }).click();
  await expect(page).toHaveURL(/\/inventory$/);
  const stoneBefore = Number((await page.getByTestId("inv-qty-stone").textContent())!.replace(/[^\d]/g, ""));
  expect(stoneBefore).toBeGreaterThan(100);
  await shot(page, "06-inventory");
  const coins0 = await coinsOf(page);
  await page.getByLabel("石頭 出售數量", { exact: true }).fill("50");
  await page.getByTestId("sell-stone").click();
  await expect(page.getByTestId("action-result")).toContainText("已出售 石頭 ×50，獲得 50 金幣");
  await expect(page.getByTestId("inv-qty-stone")).toHaveText(`×${(stoneBefore - 50).toLocaleString("zh-TW")}`);
  expect(await coinsOf(page)).toBeGreaterThanOrEqual(coins0 + 50);

  // 4. 工坊：購買石製十字鎬（自動裝備，Power 2.0 → 5.0）
  await page.getByRole("navigation", { name: "主要功能" }).getByRole("link", { name: /工坊/ }).click();
  await expect(page).toHaveURL(/\/workshop$/);
  await page.getByTestId("buy-pick_stone").click();
  await expect(page.getByTestId("action-result")).toContainText("購買了 石製十字鎬");
  await expect(page.getByTestId("power")).toHaveText("5.0");
  await expect(page.getByTestId("pickaxe-pick_stone")).toHaveAttribute("data-status", "equipped");

  // 5. 製作強化石
  await page.getByTestId("craft-reinforce_stone").click();
  await expect(page.getByTestId("recipe-owned-reinforce_stone")).toHaveText("持有 ×1");

  // 6. 強化石製十字鎬 → Lv2（Power 5.5）
  await page.getByTestId("upgrade-pick_stone").click();
  await expect(page.getByTestId("pickaxe-level-pick_stone")).toHaveText("Lv2 / 5");
  await expect(page.getByText("LEVEL UP!")).toBeVisible();
  await expect(page.getByTestId("power")).toHaveText("5.5");
  await shot(page, "07-workshop-upgraded");

  // 7. 裝備切換：能力值立即改變
  await page.getByTestId("equip-pick_wood").click();
  await expect(page.getByTestId("power")).toHaveText("2.0");
  await page.getByTestId("equip-pick_stone").click();
  await expect(page.getByTestId("power")).toHaveText("5.5");

  // 8. 成長有效：50 m（木製會卡關）現在可以繼續挖
  await pool.query(`update public.players set frontier_block_index = 500, dig_counter = dig_counter + 500 - frontier_block_index, block_work = 0, block_ms = 0 where id = $1`, [id]);
  await page.getByRole("navigation", { name: "主要功能" }).getByRole("link", { name: /挖礦/ }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.reload();
  await expect(page.getByTestId("mining-status")).toHaveText("挖掘中");
  await expect(page.getByTestId("mining-position")).toContainText("前線 50 m");

  // 9. 重新整理 / 重新登入後一致
  await page.goto("/workshop");
  await expect(page.getByTestId("pickaxe-level-pick_stone")).toHaveText("Lv2 / 5");
  await page.getByRole("button", { name: "登出" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("密碼").fill(PASSWORD);
  await page.getByRole("button", { name: "進入礦坑" }).click();
  await expect(page.getByTestId("power")).toHaveText("5.5");
  const db = await pool.query(`select coins, equipped_pickaxe from public.players where id = $1`, [id]);
  expect(db.rows[0].equipped_pickaxe).toBe("pick_stone");
  await page.goto("/inventory");
  await expect(page.getByTestId("coins")).toHaveText(Number(db.rows[0].coins).toLocaleString("zh-TW"));
  const sells = await pool.query(`select count(*)::int as n from public.action_log where player_id = $1 and command = 'sell_items'`, [id]);
  expect(sells.rows[0].n).toBe(1); // 沒有重複出售
});

test("背包：全部出售需要確認；待領報告時無法出售", async ({ page }) => {
  const email = `e2e-inv-${randomUUID()}@example.test`;
  await page.goto("/login");
  await page.getByRole("tab", { name: "註冊" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("密碼").fill(PASSWORD);
  await page.getByRole("button", { name: "建立帳號" }).click();
  await page.getByRole("button", { name: "開始探險" }).click();
  await expect(page.getByTestId("mining-status")).toHaveText("挖掘中");
  const id = await userId(email);
  await pool.query(`insert into public.player_inventory values ($1, 'coal', 30) on conflict (player_id, item_id) do update set quantity = 30`, [id]);
  await page.goto("/inventory");
  const row = page.getByTestId("inv-row-coal");
  await row.getByRole("button", { name: "全部" }).click();
  await page.getByTestId("sell-coal").click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await shot(page, "08-confirm-sell-all");
  await page.getByRole("button", { name: "取消" }).click();
  await expect(page.getByTestId("inv-qty-coal")).toHaveText("×30");

  // 待領報告：任何頁面都先顯示報告並阻擋操作
  await pool.query(`update public.players set created_at_ms = created_at_ms - $2, last_settled_at_ms = last_settled_at_ms - $2 where id = $1`, [id, 2 * HOUR]);
  await page.reload();
  await expect(page.getByRole("dialog", { name: "⛏ 探險報告" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^出售/ })).toHaveCount(0); // 背包在報告後面（aria-hidden），無法操作
});
