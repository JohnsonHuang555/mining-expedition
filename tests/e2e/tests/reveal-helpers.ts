import { type Page, expect } from "@playwright/test";

/** 領取 / 取得寶物後會出現揭曉演出（PR #12）；與揭曉無關的測試逐一「收下」後繼續 */
export async function closeReveals(page: Page) {
  const overlay = page.getByTestId("reveal-overlay");
  await page.waitForTimeout(400);
  for (let i = 0; i < 60 && (await overlay.isVisible()); i++) {
    await page.getByTestId("reveal-next").click();
    await page.waitForTimeout(100);
  }
  await expect(overlay).toBeHidden();
}
