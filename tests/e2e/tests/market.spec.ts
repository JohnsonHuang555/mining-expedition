import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { type Page, type Route, expect, test } from "@playwright/test";
import pg from "pg";
import { closeReveals } from "./reveal-helpers";

const pool = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres", max: 2 });
test.afterAll(async () => pool.end());

const PASSWORD = "e2e-password-123";
const SHOTS = process.env.E2E_SCREENSHOT_DIR ?? "screenshots";
mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, name: string, fullPage = false) => {
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png`, fullPage, animations: "disabled" });
};

const BASE: Record<string, number> = { a_z1_lantern: 300, a_z1_badge: 300, a_z1_map: 300, a_z1_heart: 3_000 };
const price = (id: string, ppm: number) => Math.floor((BASE[id]! * ppm) / 1_000_000);
const fmt = (n: number) => n.toLocaleString("zh-TW");

async function newPlayer(page: Page): Promise<string> {
  const email = `e2e-mkt-${randomUUID()}@example.test`;
  await page.goto("/login");
  await page.getByRole("tab", { name: "註冊" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("密碼").fill(PASSWORD);
  await page.getByRole("button", { name: "建立帳號" }).click();
  await page.getByRole("button", { name: "開始探險" }).click();
  await expect(page.getByTestId("mining-status")).toHaveText("挖掘中");
  return (await pool.query<{ id: string }>(`select id from auth.users where email = $1`, [email])).rows[0]!.id;
}

/** 測試準備：寫入與正常掉落相同的寶物資料列 */
async function give(id: string, artifacts: string[]) {
  const base = Number((await pool.query(`update public.players set dig_counter = dig_counter + $2 where id = $1 returning dig_counter - $2 as dc`, [id, artifacts.length + 1])).rows[0].dc);
  for (const [k, a] of artifacts.entries()) {
    await pool.query(
      `insert into public.artifact_instances (player_id, instance_id, artifact_id, obtained_at_ms, mode, band, frontier_block_index, dig_counter, source) values ($1, $2, $3, 0, 'frontier', 0, 0, $4, 'drop')`,
      [id, `d${base + k}`, a, base + k],
    );
    await pool.query(`insert into public.artifact_discoveries values ($1, $2, 0, 0, 1) on conflict (player_id, artifact_id) do update set total_found = public.artifact_discoveries.total_found + 1`, [id, a]);
  }
}
const today = async () => (await pool.query(`select to_char(private.market_date(now()), 'YYYY-MM-DD') as d`)).rows[0].d as string;
const ppm = async (date: string, id: string) => Number((await pool.query(`select multiplier_ppm from public.market_prices where price_date = $1::date and artifact_id = $2`, [date, id])).rows[0].multiplier_ppm);
const coinsOf = async (id: string) => Number((await pool.query(`select coins from public.players where id = $1`, [id])).rows[0].coins);
const held = async (id: string, artifact: string) => Number((await pool.query(`select count(*)::int as n from public.artifact_instances where player_id = $1 and artifact_id = $2 and status = 'held'`, [id, artifact])).rows[0].n);
const plus = (page: Page, name: string) => page.getByRole("button", { name: `${name} 增加` });
const dialog = (page: Page) => page.getByRole("alertdialog");

test("市場：報價 → 出售重複寶物 → 套組失效警告 → 成交 → 報價過期重新確認 → 重新整理一致", async ({ page }) => {
  const id = await newPlayer(page);
  await give(id, ["a_z1_lantern", "a_z1_lantern", "a_z1_badge", "a_z1_map", "a_z1_heart"]);
  await page.reload();
  await closeReveals(page);

  // 市場首頁（導覽入口）
  await page.getByRole("navigation", { name: "主要功能" }).getByRole("link", { name: /市場/ }).click();
  await expect(page).toHaveURL(/\/market$/);
  const date = await today();
  await expect(page.getByTestId("market-date")).toHaveText(date.replaceAll("-", "/"));
  await expect(page.getByTestId("market-status")).toHaveAttribute("data-status", "valid");
  await expect(page.getByTestId("market-price-a_z1_lantern")).toHaveText(fmt(price("a_z1_lantern", await ppm(date, "a_z1_lantern"))));
  await expect(page.getByTestId("market-held-a_z1_lantern")).toHaveText("持有 ×2");
  await expect(page.getByTestId("market-set-a_z1_lantern")).toBeVisible();
  await expect(page.getByTestId("market-card-a_z2_heart")).toHaveAttribute("data-discovered", "false");
  await shot(page, "16-market", true);

  // 出售重複的提燈：沒有套組警告
  await plus(page, "老礦工的提燈").click();
  await expect(page.getByTestId("market-selected-count")).toHaveText("1");
  await page.getByTestId("market-sell").click();
  await expect(page.getByTestId("sale-confirm")).toHaveAttribute("data-losing-set", "false");
  await expect(page.getByTestId("sale-remaining-a_z1_lantern")).toHaveText("持有 2 → 1");
  await expect(page.getByTestId("sale-market-date")).toHaveText(date.replaceAll("-", "/"));
  await shot(page, "17-sale-confirm");
  const c0 = await coinsOf(id);
  await dialog(page).getByRole("button", { name: "確定出售" }).click();
  await expect(page.getByTestId("market-result")).toContainText(`伺服器實際成交 ${fmt(price("a_z1_lantern", await ppm(date, "a_z1_lantern")))} 金幣`);
  expect(await held(id, "a_z1_lantern")).toBe(1);
  expect(await coinsOf(id)).toBeGreaterThanOrEqual(c0 + price("a_z1_lantern", await ppm(date, "a_z1_lantern")));

  // 最後一件提燈：套組失效警告
  await plus(page, "老礦工的提燈").click();
  await page.getByTestId("market-sell").click();
  await expect(page.getByTestId("sale-confirm")).toHaveAttribute("data-losing-set", "true");
  await expect(page.getByTestId("sale-set-warning")).toContainText("出售後將失去老礦工套組效果：Speed ×1.03");
  await shot(page, "18-set-warning");
  await dialog(page).getByRole("button", { name: "仍要出售" }).click();
  await expect(page.getByTestId("market-result")).toBeVisible();
  await expect(page.getByTestId("market-held-a_z1_lantern")).toHaveText("持有 ×0");
  await expect(page.getByTestId("market-set-a_z1_badge")).toHaveCount(0);

  // 報價過期：把送出的市場日改成昨天（模擬開著舊頁面跨日）→ 伺服器 409、附新報價；不自動重送
  let rewritten = 0;
  const expire = async (route: Route) => {
    const body = route.request().postDataJSON() as { command?: { type?: string; marketDate?: string } };
    if (body.command?.type === "sell_artifacts" && rewritten === 0) {
      rewritten++;
      const [y, m, d] = body.command.marketDate!.split("-").map(Number);
      body.command.marketDate = new Date(Date.UTC(y!, m! - 1, d! - 1)).toISOString().slice(0, 10);
      return route.continue({ postData: JSON.stringify(body) });
    }
    return route.fallback();
  };
  await page.route("**/functions/v1/game-action", expire);
  await plus(page, "礦脈之心").click();
  await page.getByTestId("market-sell").click();
  await dialog(page).getByRole("button", { name: "確定出售" }).click();
  await expect(page.getByTestId("sale-problem")).toHaveText("市場價格已更新，請重新確認");
  expect(await held(id, "a_z1_heart")).toBe(1);
  await shot(page, "19-quote-expired");
  await page.unroute("**/functions/v1/game-action", expire);
  await dialog(page).getByRole("button", { name: "以新報價出售" }).click();
  await expect(page.getByTestId("market-result")).toBeVisible();
  expect(await held(id, "a_z1_heart")).toBe(0);
  const sells = await pool.query(`select count(*)::int as n, count(distinct idempotency_key)::int as k from public.action_log where player_id = $1 and command = 'sell_artifacts'`, [id]);
  expect(sells.rows[0]).toEqual({ n: 4, k: 4 }); // 提燈、提燈、過期（拒絕）、礦脈之心（新的 Request ID）

  // 圖鑑保留
  await page.getByRole("navigation", { name: "主要功能" }).getByRole("link", { name: /圖鑑/ }).click();
  await expect(page.getByTestId("artifact-a_z1_lantern")).toHaveAttribute("data-discovered", "true");
  await expect(page.getByTestId("artifact-held-a_z1_lantern")).toContainText("已發現，未持有");

  // 重新整理：與伺服器一致
  await page.goto("/market");
  await expect(page.getByTestId("market-held-a_z1_lantern")).toHaveText("持有 ×0");
  await expect(page.getByTestId("market-held-a_z1_badge")).toHaveText("持有 ×1");
  await expect(page.getByTestId("market-date")).toHaveText(date.replaceAll("-", "/"));
  // 顯示的是伺服器最後一次回應的金幣（挖掘持續進行，資料庫只會相同或更多）
  const shown = Number((await page.getByTestId("market-coins").textContent())!.replace(/[^\d]/g, ""));
  expect(shown).toBeGreaterThanOrEqual(c0);
  expect(shown).toBeLessThanOrEqual(await coinsOf(id));
});

test("市場：當日價格無法取得 → 不顯示價格、不能出售；挖礦照常", async ({ page }) => {
  const id = await newPlayer(page);
  await give(id, ["a_z1_map"]);
  // 模擬伺服器回報當日價格無法產生（回應中的倍率為空；伺服器行為由整合測試驗證）
  const empty = async (route: Route) => {
    const res = await route.fetch();
    const json = await res.json().catch(() => null);
    if (json && typeof json === "object" && json.market) json.market.multipliersPpm = {};
    await route.fulfill({ response: res, json });
  };
  await page.route(/functions\/v1\/game-(state|action)/, empty);
  await page.goto("/market");
  await closeReveals(page);
  await expect(page.getByTestId("market-status")).toHaveAttribute("data-status", "unavailable");
  await expect(page.getByTestId("market-price-a_z1_map")).toHaveText("—");
  await expect(page.getByTestId("market-mult-a_z1_map")).toHaveText("無報價");
  await expect(plus(page, "褪色的礦區地圖")).toBeDisabled();
  await shot(page, "20-market-unavailable");
  await page.getByRole("navigation", { name: "主要功能" }).getByRole("link", { name: /挖礦/ }).click();
  await expect(page.getByTestId("mining-status")).toHaveText("挖掘中");
  await page.getByRole("button", { name: "立即同步" }).click();
  await expect(page.getByTestId("sync-status")).toHaveText(/已同步/);
  await page.unroute(/functions\/v1\/game-(state|action)/, empty);
});
