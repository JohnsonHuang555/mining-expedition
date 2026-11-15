import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { type Page, expect, test } from "@playwright/test";
import pg from "pg";
import { closeReveals } from "./reveal-helpers";

const pool = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres", max: 2 });
test.afterAll(async () => pool.end());

const PASSWORD = "e2e-password-123";
const HOUR = 3_600_000;
const SHOTS = process.env.E2E_SCREENSHOT_DIR ?? "screenshots";
mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, name: string, fullPage = false) => {
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png`, fullPage, animations: "disabled" });
};
const nav = (page: Page, name: RegExp) => page.getByRole("navigation", { name: "主要功能" }).getByRole("link", { name });

test("圖鑑與套組：挖到寶物 → 圖鑑更新 → 集齊套組 → 加成顯示 → 失去一件 → 圖鑑保留、加成失效 → 重新登入一致", async ({ page }) => {
  const email = `e2e-col-${randomUUID()}@example.test`;
  await page.goto("/login");
  await page.getByRole("tab", { name: "註冊" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("密碼").fill(PASSWORD);
  await page.getByRole("button", { name: "建立帳號" }).click();
  await page.getByRole("button", { name: "開始探險" }).click();
  await expect(page.getByTestId("mining-status")).toHaveText("挖掘中");
  const id = (await pool.query<{ id: string }>(`select id from auth.users where email = $1`, [email])).rows[0]!.id;

  // 全部未發現
  await nav(page, /圖鑑/).click();
  await expect(page).toHaveURL(/\/collection$/);
  await expect(page.getByTestId("collection-overall")).toContainText("0 / 12");

  // 挖掘取得寶物：離線 5 小時（有效挖掘超過 4 小時 → 首次寶物保護保證取得，D18）
  await pool.query(`update public.players set created_at_ms = created_at_ms - $2, last_settled_at_ms = last_settled_at_ms - $2 where id = $1`, [id, 5 * HOUR]);
  await page.reload();
  const dialog = page.getByRole("dialog", { name: "⛏ 探險報告" });
  await expect(dialog).toBeVisible();
  const artifacts = await dialog.getByTestId("report-artifact").count();
  expect(artifacts).toBeGreaterThan(0);
  await expect(dialog.getByText("NEW DISCOVERY").first()).toBeVisible();
  // 領取前：圖鑑還沒有更新（待領報告中的寶物不是正式持有）
  expect((await pool.query(`select count(*)::int as n from public.artifact_discoveries where player_id = $1`, [id])).rows[0].n).toBe(0);
  await dialog.getByRole("button", { name: "領取探險成果" }).click();
  await expect(dialog).toBeHidden();
  await closeReveals(page);
  const found = (await pool.query<{ n: number }>(`select count(*)::int as n from public.artifact_discoveries where player_id = $1`, [id])).rows[0]!.n;
  await expect(page.getByTestId("collection-overall")).toContainText(`${found} / 12`);
  await shot(page, "11-collection");

  // 集齊老礦工套組（測試準備：寫入與正常掉落相同的資料列）
  const held = (await pool.query<{ artifact_id: string }>(`select artifact_id from public.artifact_instances where player_id = $1`, [id])).rows.map((r) => r.artifact_id);
  const missing = ["a_z1_lantern", "a_z1_badge", "a_z1_map"].filter((a) => !held.includes(a));
  const base = Number((await pool.query(`update public.players set dig_counter = dig_counter + 10 where id = $1 returning dig_counter - 10 as dc`, [id])).rows[0].dc);
  for (const [k, a] of missing.entries()) {
    await pool.query(
      `insert into public.artifact_instances (player_id, instance_id, artifact_id, obtained_at_ms, mode, band, frontier_block_index, dig_counter, source) values ($1, $2, $3, 0, 'frontier', 0, 0, $4, 'drop')`,
      [id, `d${base + k}`, a, base + k],
    );
    await pool.query(`insert into public.artifact_discoveries values ($1, $2, 0, 0, 1) on conflict (player_id, artifact_id) do nothing`, [id, a]);
  }
  await page.reload();
  await page.getByRole("tab", { name: "套組" }).click();
  await expect(page.getByTestId("set-status-old_miner")).toHaveText("加成生效中");
  await expect(page.getByTestId("set-held-old_miner")).toHaveText("3 / 3");
  await expect(page.getByTestId("sets-speed")).toHaveText("×1.03"); // 伺服器回傳的能力值
  await expect(page.getByText("×1.03").first()).toBeVisible();
  await shot(page, "12-sets", true);

  // 失去其中一件（模擬出售後的資料；寶物出售本階段不開放）
  await pool.query(`delete from public.artifact_instances where player_id = $1 and artifact_id = 'a_z1_badge'`, [id]);
  await page.reload();
  await page.getByRole("tab", { name: "套組" }).click();
  await expect(page.getByTestId("set-status-old_miner")).toHaveText("未生效");
  await expect(page.getByTestId("set-discovered-old_miner")).toHaveAttribute("data-ok", "true");
  await expect(page.getByTestId("sets-speed")).toHaveText("×1.00");
  await page.getByRole("tab", { name: "寶物" }).click();
  await expect(page.getByTestId("artifact-a_z1_badge")).toHaveAttribute("data-discovered", "true");
  await expect(page.getByTestId("artifact-held-a_z1_badge")).toContainText("已發現，未持有");
  await page.getByTestId("artifact-a_z1_badge").click();
  await expect(page.getByTestId("detail-held")).toHaveText("×0");
  await page.getByRole("button", { name: "關閉" }).click();

  // 篩選
  await page.getByRole("group", { name: "狀態" }).getByRole("button", { name: "未發現" }).click();
  await expect(page.getByTestId("artifact-a_z1_badge")).toHaveCount(0);

  // 重新登入：一致
  const overall = await page.getByTestId("collection-overall").textContent();
  await page.getByRole("button", { name: "登出" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("密碼").fill(PASSWORD);
  await page.getByRole("button", { name: "進入礦坑" }).click();
  await expect(page.getByTestId("mining-status")).toBeVisible();
  await page.goto("/collection");
  await expect(page.getByTestId("collection-overall")).toHaveText(overall!);
  await page.getByRole("tab", { name: "套組" }).click();
  await expect(page.getByTestId("set-status-old_miner")).toHaveText("未生效");
});
