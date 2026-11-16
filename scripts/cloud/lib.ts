/**
 * 單人開發的 Supabase Cloud 部署：純函式（scripts/cloud/lib.test.ts）。
 * deploy.ts 只負責呼叫 Supabase CLI / git；所有「能不能部署」的判斷都在這裡，方便測試。
 *
 * 不讀取、不輸出任何 token / 密碼。Project ref、publishable key、網址都不是密鑰。
 */
import { createHash } from "node:crypto";

/** Supabase project ref：20 個小寫英文字母 */
export const PROJECT_REF = /^[a-z]{20}$/;

/** 解析 KEY=VALUE 的 env 檔（忽略空行與 # 註解；值可用單 / 雙引號包住） */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]!] = v;
  }
  return out;
}

export interface TargetInput {
  /** .env.cloud 的 CLOUD_PROJECT_REF：唯一允許部署的專案 */
  expected: string | undefined;
  /** 指令列的 --ref：每次遠端修改都要再輸入一次（人工確認目標） */
  confirm: string | undefined;
  /** CLOUD_BLOCKED_REFS：永遠不可部署的專案（例如未來的正式環境），逗號分隔 */
  blocked: string | undefined;
  /** supabase/.temp/project-ref（supabase link 的結果）；null = 尚未 link */
  linked: string | null;
}

/** 部署目標檢查；回傳錯誤清單（空 = 通過） */
export function checkTarget(i: TargetInput): string[] {
  const errors: string[] = [];
  const expected = (i.expected ?? "").trim();
  if (!PROJECT_REF.test(expected)) errors.push("CLOUD_PROJECT_REF（.env.cloud）沒有設定或格式錯誤（應為 20 個小寫英文字母）");
  const confirm = (i.confirm ?? "").trim();
  if (!confirm) errors.push("遠端修改必須加上 --ref <project-ref> 再確認一次目標");
  else if (confirm !== expected) errors.push(`--ref ${confirm} 與 CLOUD_PROJECT_REF 不同`);
  const blocked = (i.blocked ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (expected && blocked.includes(expected)) errors.push(`${expected} 列在 CLOUD_BLOCKED_REFS（禁止部署）`);
  if (i.linked === null) errors.push("尚未連結專案：先執行 pnpm cloud link");
  else if (i.linked.trim() !== expected) errors.push(`目前連結的專案是 ${i.linked.trim()}，不是 CLOUD_PROJECT_REF（重新執行 pnpm cloud link）`);
  return errors;
}

/** `supabase --version` → 主版本號（無法解析時 null） */
export function cliMajor(versionOutput: string): number | null {
  const m = /(\d+)\.\d+\.\d+/.exec(versionOutput);
  return m ? Number(m[1]) : null;
}

/** 這些 Supabase CLI 子指令會刪除或改寫遠端資料 / migration 歷史：部署腳本一律拒絕 */
const FORBIDDEN = [["db", "reset"], ["migration", "repair"], ["migration", "squash"], ["db", "pull"]] as const;

export function assertSafeSupabaseArgs(args: readonly string[]): void {
  for (const [a, b] of FORBIDDEN) {
    const i = args.indexOf(a);
    if (i >= 0 && args[i + 1] === b) throw new Error(`refusing to run "supabase ${a} ${b}" against a remote project`);
  }
  if (args.includes("--db-url")) throw new Error("refusing --db-url: use the linked project only");
}

/** 從 `supabase db push --dry-run` 的輸出取出待套用的 migration 檔名（排序、去重） */
export function pendingMigrations(dryRunOutput: string): string[] {
  const names = new Set<string>();
  for (const m of dryRunOutput.matchAll(/\b(\d{14}_[A-Za-z0-9_-]+\.sql)\b/g)) names.add(m[1]!);
  return [...names].sort();
}

/**
 * 計畫 ID：待套用 migration 的雜湊。dry-run 印出，--apply 時必須帶回來；
 * 若中間有人新增 / 修改了 migration（或連到別的專案），計畫不同就拒絕套用。
 */
export function planId(names: readonly string[], contents: readonly string[] = []): string {
  if (names.length === 0) return "none";
  const h = createHash("sha256");
  names.forEach((n, i) => h.update(`${n}\n${contents[i] ?? ""}\n`));
  return h.digest("hex").slice(0, 10);
}

export interface GitState {
  dirty: boolean;
  head: string;
  originMain: string | null;
}

/** 部署的程式碼必須是乾淨的 origin/main（除非明確 --allow-unmerged） */
export function checkGit(s: GitState, allowUnmerged: boolean): string[] {
  const errors: string[] = [];
  if (s.dirty) errors.push("工作目錄有未提交的變更（git status）：先 commit / stash，避免部署沒有版控的程式碼");
  if (!allowUnmerged) {
    if (s.originMain === null) errors.push("無法取得 origin/main（git fetch 失敗）");
    else if (s.head !== s.originMain) errors.push(`目前的 commit ${s.head.slice(0, 7)} 不是 origin/main ${s.originMain.slice(0, 7)}：先 git switch main && git pull（或明確加上 --allow-unmerged）`);
  }
  return errors;
}

/** Edge Function 允許的自訂 secrets（其他名稱一律拒絕；SUPABASE_* 由平台提供） */
const SECRET_FORMAT: Record<string, RegExp> = {
  GAME_RATE_LIMIT_ACTION: /^\d+\/\d+$/,
  GAME_RATE_LIMIT_STATE: /^\d+\/\d+$/,
  GAME_RATE_LIMIT_CREATE: /^\d+\/\d+$/,
  GAME_DB_TIMEOUT_MS: /^\d+$/,
};

const exactHttpsOrigin = (u: string): string | null => {
  if (u.includes("*")) return null; // 不接受萬用字元
  try {
    const url = new URL(u);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
};

/**
 * 由 .env.cloud 產生 Edge Function secrets。
 * - GAME_API_ALLOWED_ORIGIN = CLOUD_WEB_URL 的 origin（+ CLOUD_EXTRA_ORIGINS），只接受完整的 https origin，不接受 *。
 * - 選填：GAME_RATE_LIMIT_*、GAME_DB_TIMEOUT_MS（格式檢查）。
 */
export function buildEdgeSecrets(cfg: Record<string, string | undefined>): { secrets: Record<string, string>; errors: string[] } {
  const errors: string[] = [];
  const origins: string[] = [];
  const web = exactHttpsOrigin(cfg.CLOUD_WEB_URL ?? "");
  if (!web) errors.push("CLOUD_WEB_URL 必須是 https 網址（Vercel 的網址，例如 https://mining-expedition.vercel.app）");
  else origins.push(web);
  for (const raw of (cfg.CLOUD_EXTRA_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const o = exactHttpsOrigin(raw);
    if (!o || o !== raw.replace(/\/$/, "")) errors.push(`CLOUD_EXTRA_ORIGINS 的 ${raw} 不是完整的 https origin（不接受萬用字元或路徑）`);
    else if (!origins.includes(o)) origins.push(o);
  }
  const secrets: Record<string, string> = { GAME_API_ALLOWED_ORIGIN: origins.join(",") };
  for (const [k, re] of Object.entries(SECRET_FORMAT)) {
    const v = cfg[k];
    if (v === undefined || v === "") continue;
    if (!re.test(v)) errors.push(`${k}=${v} 格式錯誤`);
    else secrets[k] = v;
  }
  if (cfg.EDGE_DIAGNOSTICS) errors.push("EDGE_DIAGNOSTICS 只用於本地 / CI，不可設定到 Cloud");
  return { secrets, errors };
}

/** `supabase secrets list` 的輸出是否包含某個名稱（只看名稱，不看值） */
export function hasSecret(listOutput: string, name: string): boolean {
  return new RegExp(`(^|[\\s|])${name}([\\s|]|$)`, "m").test(listOutput);
}
