/**
 * Staging 部署前的目標檢查（在任何遠端修改之前執行；失敗就停止整個部署）。
 *
 * 防止誤部署到 Production / 其他專案：
 * - STAGING_PROJECT_REF（GitHub Environment 變數）必須是合法的 project ref（20 個小寫英文字母）。
 * - 手動觸發時輸入的 CONFIRM_PROJECT_REF 必須與它完全相同（人工再確認一次目標）。
 * - 不可等於 PRODUCTION_PROJECT_REF（若已設定，可逗號分隔多個）。
 * - 若已 `supabase link`，supabase/.temp/project-ref 也必須相同。
 *
 * 用法：node scripts/staging/guard.ts            （讀環境變數）
 * 只輸出 project ref（不是密鑰），不讀取或輸出任何密碼 / token。
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const PROJECT_REF = /^[a-z]{20}$/;

export interface GuardInput {
  stagingRef: string | undefined;
  confirmRef: string | undefined;
  productionRefs: string | undefined;
  linkedRef: string | null;
}

/** 回傳錯誤清單（空 = 通過） */
export function checkTarget(i: GuardInput): string[] {
  const errors: string[] = [];
  const staging = (i.stagingRef ?? "").trim();
  if (!PROJECT_REF.test(staging)) errors.push("STAGING_PROJECT_REF is missing or not a valid project ref");
  if ((i.confirmRef ?? "").trim() !== staging) errors.push("CONFIRM_PROJECT_REF does not match STAGING_PROJECT_REF");
  const prod = (i.productionRefs ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (staging && prod.includes(staging)) errors.push("STAGING_PROJECT_REF equals a production project ref");
  if (i.linkedRef !== null && i.linkedRef.trim() !== staging) errors.push("the linked Supabase project (supabase/.temp/project-ref) is not the staging project");
  return errors;
}

function main(): void {
  const linkedPath = resolve(import.meta.dirname, "../../supabase/.temp/project-ref");
  const errors = checkTarget({
    stagingRef: process.env.STAGING_PROJECT_REF,
    confirmRef: process.env.CONFIRM_PROJECT_REF,
    productionRefs: process.env.PRODUCTION_PROJECT_REF,
    linkedRef: existsSync(linkedPath) ? readFileSync(linkedPath, "utf8") : null,
  });
  if (errors.length > 0) {
    for (const e of errors) console.error(`✗ ${e}`);
    process.exit(1);
  }
  console.log(`✓ target is the staging project ${process.env.STAGING_PROJECT_REF}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
