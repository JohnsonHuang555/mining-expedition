/**
 * supabase/ops/*.sql（Staging 驗證與營運報告）在真實的 Supabase Local 上可以執行：
 * 驗證 SQL 對正確的資料庫通過；權限被破壞時失敗；兩者都是唯讀（rollback），不改變任何資料。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "./src/backend.ts";

afterAll(async () => pool.end());

/** psql 專用的 \echo 等指令在 node-postgres 中移除 */
const sqlOf = (name: string) =>
  readFileSync(resolve(import.meta.dirname, "../../supabase/ops", name), "utf8")
    .split("\n")
    .filter((l) => !l.startsWith("\\"))
    .join("\n");

describe("supabase/ops", () => {
  it("verify-staging.sql：正確的資料庫通過；回傳摘要；唯讀", async () => {
    const c = await pool.connect();
    try {
      const notices: string[] = [];
      c.on("notice", (n) => notices.push(n.message ?? ""));
      const res = await c.query(sqlOf("verify-staging.sql"));
      const results = Array.isArray(res) ? res : [res];
      const summary = results.find((r) => r.command === "SELECT")!.rows[0];
      expect(Number(summary.migrations_applied)).toBeGreaterThanOrEqual(6);
      expect(notices).toContain("staging verification passed");
    } finally {
      c.release();
    }
  });

  it("verify-staging.sql：權限被破壞時失敗（在交易內暫時授權後 rollback）", async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("grant insert on public.market_prices to authenticated");
      const body = sqlOf("verify-staging.sql").replace(/^begin read only;$/m, "").replace(/^rollback;$/m, "");
      await expect(c.query(body)).rejects.toThrow(/client role can write public\.market_prices/);
    } finally {
      await c.query("rollback").catch(() => undefined);
      c.release();
    }
  });

  it("ops-report.sql：可以執行（排程、積壓、市場、限流、連線）", async () => {
    const res = await pool.query(sqlOf("ops-report.sql"));
    const results = Array.isArray(res) ? res : [res];
    const selects = results.filter((r) => r.command === "SELECT");
    expect(selects.length).toBeGreaterThanOrEqual(8);
    expect(selects[0]!.rows.map((r: { jobname: string }) => r.jobname)).toEqual(expect.arrayContaining(["action-log-compact", "market-daily-prices"]));
  });
});
