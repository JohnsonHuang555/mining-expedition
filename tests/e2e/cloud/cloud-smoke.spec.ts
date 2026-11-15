import { type Page, expect, test } from "@playwright/test";

/**
 * Cloud Staging 瀏覽器 Smoke（只在設定 STAGING_WEB_URL 時執行）。
 * 不輸入或輸出任何密鑰以外的資料；測試帳號密碼來自環境變數，不寫入截圖、trace 或 log。
 */
const url = process.env.STAGING_WEB_URL;
test.skip(!url, "STAGING_WEB_URL is not set");

const account = (p: "A" | "B") => ({ email: process.env[`SMOKE_USER_${p}_EMAIL`] ?? "", password: process.env[`SMOKE_USER_${p}_PASSWORD`] ?? "" });

async function signIn(page: Page, p: "A" | "B") {
  const a = account(p);
  await page.goto("/login");
  await page.getByLabel("Email").fill(a.email);
  await page.getByLabel("密碼").fill(a.password);
  await page.getByRole("button", { name: "進入礦坑" }).click();
  const start = page.getByRole("button", { name: "開始探險" });
  const status = page.getByTestId("mining-status");
  await expect(start.or(status)).toBeVisible();
  if (await start.isVisible()) await start.click(); // 第一次登入：建立角色
  await expect(status).toBeVisible();
}

test("部署版本：Staging 網址是 staging 分支的 Preview，且是預期的 commit", async ({ request }) => {
  const r = await request.get("/api/version");
  expect(r.ok()).toBe(true);
  const v = (await r.json()) as { commit: string | null; ref: string | null; env: string };
  expect(v).toMatchObject({ env: "preview", ref: "staging" });
  if (process.env.EXPECTED_COMMIT) expect(v.commit).toBe(process.env.EXPECTED_COMMIT);
});

test("登入 → 挖礦同步 → 重新整理保留 → 市場 / 背包 / 圖鑑 → 登出 → 換帳號不殘留", async ({ page }) => {
  await page.goto("/login");
  // 封閉測試：不顯示公開註冊
  await expect(page.getByTestId("signup-closed")).toBeVisible();
  await expect(page.getByRole("tab", { name: "註冊" })).toHaveCount(0);

  await signIn(page, "A");
  await page.getByRole("button", { name: "立即同步" }).click();
  await expect(page.getByTestId("sync-status")).toHaveText(/已同步/);
  const coins = await page.getByTestId("coins").textContent();
  await page.reload();
  await expect(page.getByTestId("mining-status")).toBeVisible();
  expect(Number((await page.getByTestId("coins").textContent())!.replace(/[^\d]/g, ""))).toBeGreaterThanOrEqual(Number(coins!.replace(/[^\d]/g, "")));

  const nav = page.getByRole("navigation", { name: "主要功能" });
  await nav.getByRole("link", { name: /市場/ }).click();
  await expect(page.getByTestId("market-status")).toHaveAttribute("data-history", "loaded");
  await expect(page.getByTestId("market-status")).toHaveAttribute("data-status", /valid|refreshing/);
  await nav.getByRole("link", { name: /背包/ }).click();
  await expect(page).toHaveURL(/\/inventory$/);
  await nav.getByRole("link", { name: /圖鑑/ }).click();
  await expect(page.getByTestId("collection-overall")).toBeVisible();

  await page.getByRole("button", { name: "登出" }).click();
  await expect(page).toHaveURL(/\/login/);
  await signIn(page, "B");
  await expect(page.getByRole("button", { name: "登出" })).toHaveAttribute("title", account("B").email);
});
