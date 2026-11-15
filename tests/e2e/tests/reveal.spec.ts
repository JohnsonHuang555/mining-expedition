import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { type Page, expect, test } from "@playwright/test";
import type { PlayerGameState } from "@mining/game-engine";
import pg from "pg";
import { findSecret, firstBlockDrops, nearlyDone } from "../../../apps/web/test/support/rig-drops.ts";

const pool = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres", max: 2 });
test.afterAll(async () => pool.end());

const PASSWORD = "e2e-password-123";
const SHOTS = process.env.E2E_SCREENSHOT_DIR ?? "screenshots";
mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png`, animations: "disabled" });
};

async function newPlayer(page: Page): Promise<string> {
  const email = `e2e-rev-${randomUUID()}@example.test`;
  await page.goto("/login");
  await page.getByRole("tab", { name: "註冊" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("密碼").fill(PASSWORD);
  await page.getByRole("button", { name: "建立帳號" }).click();
  await page.getByRole("button", { name: "開始探險" }).click();
  await expect(page.getByTestId("mining-status")).toHaveText("挖掘中");
  return (await pool.query<{ id: string }>(`select id from auth.users where email = $1`, [email])).rows[0]!.id;
}

async function snapshot(id: string): Promise<PlayerGameState> {
  const r = await pool.query(`select public.game_load_snapshot($1, null, null) as s`, [id]);
  return r.rows[0].s.state as PlayerGameState;
}

/**
 * 伺服器的下一個方塊（1.5 秒後完成）會掉出指定稀有度的寶物（測試只選 RNG 密鑰，規則不變）。
 * 瀏覽器會自動同步：先在本機算好，再以一個交易同時寫入 block_work 與密鑰，最後確認期間沒有方塊被結算（否則重來）。
 */
async function rigOnline(id: string, rarity: "epic" | "legendary") {
  for (let attempt = 0; attempt < 5; attempt++) {
    const s0 = await snapshot(id);
    const nd = nearlyDone(s0, 1_500);
    const planned = { ...s0, mining: { ...s0.mining, blockWork: nd.blockWork, blockMs: nd.blockMs } };
    const secret = findSecret(planned, planned.lastSettledAt + 2_000, firstBlockDrops(rarity), `e2e-${rarity}-${id}-${attempt}`);
    const client = await pool.connect();
    try {
      await client.query("begin");
      const cur = await client.query(`select dig_counter from public.players where id = $1 for update`, [id]);
      if (Number(cur.rows[0].dig_counter) !== s0.mining.digCounter) {
        await client.query("rollback");
        continue; // 期間有方塊完成：重新計算
      }
      await client.query(`update public.players set block_work = $2, block_ms = $3 where id = $1`, [id, nd.blockWork, nd.blockMs]);
      await client.query(`update private.player_secrets set rng_secret = $2 where player_id = $1`, [id, Buffer.from(secret)]);
      await client.query("commit");
      return;
    } finally {
      client.release();
    }
  }
  throw new Error("could not rig the next block");
}

/** 離線 10 分鐘（> 300 秒）期間至少取得 n 件寶物 */
async function rigOffline(id: string, n: number) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const s0 = await snapshot(id);
    const secret = findSecret(s0, s0.lastSettledAt + 10 * 60_000, (x) => (x.report?.rewards.artifacts.length ?? 0) >= n, `e2e-off-${id}-${attempt}`);
    const client = await pool.connect();
    try {
      await client.query("begin");
      const cur = await client.query(`select dig_counter, last_settled_at_ms, block_work from public.players where id = $1 for update`, [id]);
      const r = cur.rows[0];
      if (Number(r.dig_counter) !== s0.mining.digCounter || Number(r.last_settled_at_ms) !== s0.lastSettledAt || Number(r.block_work) !== s0.mining.blockWork) {
        await client.query("rollback");
        continue;
      }
      await client.query(`update private.player_secrets set rng_secret = $2 where player_id = $1`, [id, Buffer.from(secret)]);
      await client.query(`update public.players set created_at_ms = created_at_ms - $2, last_settled_at_ms = last_settled_at_ms - $2 where id = $1`, [id, 10 * 60_000]);
      await client.query("commit");
      return;
    } finally {
      client.release();
    }
  }
  throw new Error("could not rig the offline report");
}

/** 等方塊完成後立即同步（瀏覽器的自動同步也可能先送出；兩者都是正常流程） */
async function syncNow(page: Page) {
  await page.waitForTimeout(2_200);
  if (await page.getByTestId("reveal-overlay").isVisible()) return;
  await page
    .getByRole("button", { name: "立即同步" })
    .click({ timeout: 5_000 })
    .catch(() => {});
}

test("在線 Epic / Legendary 揭曉 → 離線多件依序揭曉 → 前往圖鑑 → 重新整理不重播", async ({ page }) => {
  const id = await newPlayer(page);

  // Epic（在線）：卡片揭曉
  await rigOnline(id, "epic");
  await syncNow(page);
  const overlay = page.getByTestId("reveal-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay).toHaveAttribute("data-rarity", "epic");
  await expect(page.getByTestId("reveal-rarity")).toHaveText("EPIC");
  await expect(page.getByTestId("reveal-new")).toBeVisible();
  await expect(page.getByTestId("reveal-next")).toBeFocused();
  await shot(page, "13-reveal-epic");
  await page.getByTestId("reveal-next").click();
  await expect(overlay).toBeHidden();
  await expect(page.getByTestId("loot-entry").filter({ hasText: "◆" }).first()).toBeVisible(); // 之後仍可在 Recent Loot 查看

  // Legendary（在線）：全螢幕；Escape 關閉
  await rigOnline(id, "legendary");
  await syncNow(page);
  await expect(overlay).toHaveAttribute("data-rarity", "legendary");
  await expect(page.getByTestId("reveal-rarity")).toHaveText("LEGENDARY");
  await shot(page, "14-reveal-legendary");
  await page.keyboard.press("Escape");
  await expect(overlay).toBeHidden();

  // 離線一次取得多件：先看報告（領取前不揭曉）→ 領取 → 依序揭曉
  await rigOffline(id, 2);
  await page.reload();
  const report = page.getByRole("dialog", { name: "⛏ 探險報告" });
  await expect(report).toBeVisible();
  const n = await report.getByTestId("report-artifact").count();
  expect(n).toBeGreaterThanOrEqual(2);
  await expect(overlay).toBeHidden();
  await report.getByRole("button", { name: "領取探險成果" }).click();
  await expect(report).toBeHidden();
  await expect(overlay).toBeVisible();
  await expect(page.getByTestId("reveal-next")).toHaveText(`收下（還有 ${n - 1} 件）`);
  await shot(page, "15-reveal-offline-queue");
  await page.getByTestId("reveal-next").click(); // 下一件
  await expect(overlay).toBeVisible();
  // 前往圖鑑（結束剩下的演出）
  await page.getByTestId("reveal-collection").click();
  await expect(page).toHaveURL(/\/collection$/);
  await expect(overlay).toBeHidden();
  const found = (await pool.query<{ n: number }>(`select count(*)::int as n from public.artifact_discoveries where player_id = $1`, [id])).rows[0]!.n;
  await expect(page.getByTestId("collection-overall")).toContainText(`${found} / 12`);

  // 重新整理：不重播
  await page.reload();
  await expect(page.getByTestId("collection-overall")).toBeVisible();
  await page.waitForTimeout(1_500);
  await expect(overlay).toBeHidden();
  const claims = await pool.query(`select count(*)::int as n from public.action_log where player_id = $1 and command = 'claim_report'`, [id]);
  expect(claims.rows[0].n).toBe(1);
});

test("Reduced Motion：靜態卡片，標記與操作都在", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const id = await newPlayer(page);
  await rigOnline(id, "legendary");
  await syncNow(page);
  const overlay = page.getByTestId("reveal-overlay");
  await expect(overlay).toHaveAttribute("data-reduced", "true");
  await expect(overlay.locator(".reveal-rays")).toHaveCount(0);
  await expect(page.getByTestId("reveal-rarity")).toHaveText("LEGENDARY");
  await expect(page.getByTestId("reveal-new")).toBeVisible();
  await page.getByTestId("reveal-next").click();
  await expect(overlay).toBeHidden();
});
