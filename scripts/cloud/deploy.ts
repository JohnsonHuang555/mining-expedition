/**
 * 《挖礦探險隊》單人開發的 Supabase Cloud 部署工具（docs/DEPLOYMENT.md）。
 *
 *   pnpm cloud status                               唯讀：目標、CLI、migration、secrets 名稱、函式、網站版本
 *   pnpm cloud link                                 連結 CLOUD_PROJECT_REF（只寫入本機 supabase/.temp）
 *   pnpm cloud db                                   唯讀：dry-run，列出待套用的 migration 與計畫 ID
 *   pnpm cloud db --apply --ref <ref> --plan <id>   套用（計畫必須與 dry-run 相同；沒有 reset）
 *   pnpm cloud secrets --ref <ref>                  設定 Edge Function secrets（CORS 允許清單等）
 *   pnpm cloud functions --ref <ref>                部署 4 個 Edge Functions
 *   pnpm cloud verify                               唯讀：資料庫安全驗證（需要 CLOUD_DB_URL；或用 SQL Editor）
 *   pnpm cloud report                               唯讀：cron 結果、積壓、市場、連線
 *
 * verify / report / db --apply 的結果分開標示，最後一行輸出 VERIFY_STATUS= / REPORT_STATUS=：
 *   exit 0 = PASSED / COMPLETED；exit 1 = FAILED；exit 2 = NOT_RUN（沒有連到資料庫，「不是」成功）
 *   pnpm cloud smoke                                部署後的最小 smoke test
 *   pnpm cloud backup                               唯讀：邏輯備份（roles / schema / data）到 backups/（gitignored）
 *
 * 設定：repo 根目錄的 .env.cloud（gitignored；範本 .env.cloud.example）。
 * 安全：
 * - 會修改遠端的指令都需要 --ref，且必須等於 CLOUD_PROJECT_REF 與目前 link 的專案，不可在 CLOUD_BLOCKED_REFS。
 * - 程式碼必須是乾淨的 origin/main（--allow-unmerged 可略過「是否為 main」的檢查，但不能略過未提交的變更）。
 * - 永遠不執行 db reset / migration repair / squash / db pull。
 * - 不讀取、不輸出 access token、資料庫密碼、service role key。
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type CheckStatus,
  EXIT_CODE,
  type ReportStatus,
  applySummary,
  assertSafeSupabaseArgs,
  buildEdgeSecrets,
  checkGit,
  checkTarget,
  cliMajor,
  hasSecret,
  isLocalDbUrl,
  parseEnvFile,
  pendingMigrations,
  planId,
} from "./lib.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const FUNCTIONS = ["health", "character-create", "game-state", "game-action"];

class Stop extends Error {}
const fail = (msg: string | string[]): never => {
  for (const m of Array.isArray(msg) ? msg : [msg]) console.error(`✗ ${m}`);
  throw new Stop();
};
const ok = (msg: string) => console.log(`✓ ${msg}`);
const info = (msg: string) => console.log(`  ${msg}`);
const step = (msg: string) => console.log(`\n── ${msg}`);

function loadConfig(): Record<string, string | undefined> {
  const file = join(ROOT, ".env.cloud");
  const fromFile = existsSync(file) ? parseEnvFile(readFileSync(file, "utf8")) : {};
  const cfg: Record<string, string | undefined> = { ...fromFile };
  // 環境變數優先（例如只在這個終端機 session 提供測試帳號密碼）
  for (const k of Object.keys(process.env)) if (k.startsWith("CLOUD_") || k.startsWith("SMOKE_") || k.startsWith("GAME_")) cfg[k] = process.env[k];
  // 資料庫連線字串含密碼：只接受環境變數，不從檔案讀
  cfg.CLOUD_DB_URL = process.env.CLOUD_DB_URL;
  return cfg;
}

function linkedRef(): string | null {
  const p = join(ROOT, "supabase/.temp/project-ref");
  return existsSync(p) ? readFileSync(p, "utf8").trim() : null;
}

function supabase(args: string[], opts: { capture?: boolean; input?: string } = {}): { status: number; out: string } {
  assertSafeSupabaseArgs(args);
  const r = spawnSync("supabase", args, {
    cwd: ROOT,
    encoding: "utf8",
    input: opts.input,
    stdio: opts.capture ? ["pipe", "pipe", "pipe"] : [opts.input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
  });
  if (r.error) fail(`無法執行 supabase CLI（${(r.error as NodeJS.ErrnoException).code}）。請在開發容器內執行：docker compose run --rm dev pnpm cloud ...`);
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return { status: r.status ?? 1, out };
}

function git(args: string[]): { status: number; out: string } {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  return { status: r.status ?? 1, out: (r.stdout ?? "").trim() };
}

function requireCli(): void {
  const v = supabase(["--version"], { capture: true });
  const major = cliMajor(v.out);
  if (major !== 2) fail(`需要 Supabase CLI v2（目前：${v.out.trim() || "未知"}）。開發容器內建 v2；v3 的遠端指令語法不同（TECHNICAL_SPEC §17 T14）`);
  ok(`Supabase CLI ${v.out.trim()}`);
}

/** 會修改遠端之前的完整檢查 */
function guardRemote(cfg: Record<string, string | undefined>, confirm: string | undefined, opts: { code: boolean; allowUnmerged: boolean }): string {
  step("部署前檢查");
  requireCli();
  const errors = checkTarget({ expected: cfg.CLOUD_PROJECT_REF, confirm, blocked: cfg.CLOUD_BLOCKED_REFS, linked: linkedRef() });
  if (errors.length) fail(errors);
  const ref = cfg.CLOUD_PROJECT_REF!;
  ok(`目標專案：${ref}（與 --ref、supabase link 一致）`);
  if (!opts.code) return ref; // 只改設定（secrets），不部署程式碼
  const allowUnmerged = opts.allowUnmerged;
  const fetched = git(["fetch", "--quiet", "origin", "main"]);
  const originMain = fetched.status === 0 ? git(["rev-parse", "FETCH_HEAD"]).out : null;
  const gitErrors = checkGit({ dirty: git(["status", "--porcelain"]).out !== "", head: git(["rev-parse", "HEAD"]).out, originMain }, allowUnmerged);
  if (gitErrors.length) fail(gitErrors);
  ok(`程式碼：${git(["rev-parse", "--short", "HEAD"]).out}${allowUnmerged ? "（--allow-unmerged）" : "（= origin/main）"}`);
  return ref;
}

function migrationContents(names: string[]): string[] {
  return names.map((n) => {
    const p = join(ROOT, "supabase/migrations", n);
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  });
}

function dryRun(): { names: string[]; plan: string } {
  step("Migration 歷史（遠端 vs 本地）");
  const list = supabase(["migration", "list", "--linked"], { capture: true });
  console.log(list.out.trim());
  if (list.status !== 0) fail("supabase migration list 失敗");
  step("Dry-run：supabase db push --linked --dry-run（不會修改資料庫）");
  const dr = supabase(["db", "push", "--linked", "--dry-run"], { capture: true });
  console.log(dr.out.trim());
  if (dr.status !== 0) fail("dry-run 失敗（遠端的 migration 歷史可能與本地不一致：不要用 repair 硬改，先檢查原因）");
  const names = pendingMigrations(dr.out);
  return { names, plan: planId(names, migrationContents(names)) };
}

type DbResult<T> = { ran: false } | { ran: true; value: T };

/** 沒有 CLOUD_DB_URL → { ran: false }（NOT_RUN）；連線或查詢錯誤會 throw（由呼叫端記為 FAILED） */
async function withDb<T>(cfg: Record<string, string | undefined>, file: string, fn: (q: (sql: string) => Promise<unknown>) => Promise<T>): Promise<DbResult<T>> {
  if (!cfg.CLOUD_DB_URL) {
    console.log(
      [
        "  沒有設定 CLOUD_DB_URL（只接受環境變數，不從檔案讀取），所以這次「沒有」連到資料庫。兩種做法：",
        `  A. Supabase Dashboard → SQL Editor → 貼上 ${file} 的內容 → Run（不需要資料庫密碼）`,
        "  B. 在這個終端機 session：read -rs CLOUD_DB_URL && export CLOUD_DB_URL  （貼上 Session pooler 連線字串，不會顯示）",
        "     然後重新執行這個指令。不要把連線字串寫進檔案或貼到對話。",
      ].join("\n"),
    );
    return { ran: false };
  }
  const { default: pg } = await import("pg");
  const local = isLocalDbUrl(cfg.CLOUD_DB_URL);
  const ca = cfg.CLOUD_DB_CA_FILE ? readFileSync(resolve(ROOT, cfg.CLOUD_DB_CA_FILE), "utf8") : undefined;
  if (!local && !ca) info("（未設定 CLOUD_DB_CA_FILE：使用 TLS 加密但不驗證伺服器憑證；可從 Dashboard → Database Settings 下載 CA 後設定）");
  const ssl = local ? false : ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false };
  const client = new pg.Client({ connectionString: cfg.CLOUD_DB_URL, ssl, connectionTimeoutMillis: 15_000 });
  client.on("notice", (n) => info(`notice: ${n.message}`));
  await client.connect();
  try {
    return { ran: true, value: await fn((sql) => client.query(sql)) };
  } finally {
    await client.end().catch(() => undefined);
  }
}

const opsSql = (name: string) => readFileSync(join(ROOT, "supabase/ops", name), "utf8");

/** 資料庫安全驗證：PASSED / FAILED / NOT_RUN（NOT_RUN 不是成功） */
async function verify(cfg: Record<string, string | undefined>): Promise<CheckStatus> {
  step("資料庫安全驗證（唯讀：RLS、Client 權限、函式權限、密鑰表、索引、cron）");
  const sql = opsSql("verify-cloud.sql");
  let status: CheckStatus;
  try {
    const r = await withDb(cfg, "supabase/ops/verify-cloud.sql", async (q) => {
      const res = (await q(sql)) as { command: string; rows: Record<string, unknown>[] }[];
      return res.find((x) => x.command === "SELECT")?.rows[0];
    });
    if (!r.ran) {
      console.log("⚠ 資料庫驗證沒有執行（NOT_RUN）：這不代表通過");
      status = "NOT_RUN";
    } else {
      ok("驗證通過（PASSED）");
      if (r.value) console.table(r.value);
      status = "PASSED";
    }
  } catch (e) {
    console.error(`✗ 驗證失敗（FAILED）：${(e as Error).message}`);
    status = "FAILED";
  }
  return status;
}

/** 營運報告：COMPLETED / FAILED / NOT_RUN */
async function report(cfg: Record<string, string | undefined>): Promise<ReportStatus> {
  step("營運報告（唯讀）");
  const sections: { label: string; sql: string }[] = [];
  let label = "";
  let buf: string[] = [];
  for (const line of opsSql("ops-report.sql").split("\n")) {
    const m = /^\\echo '(.*)'/.exec(line);
    if (m) {
      sections.push({ label, sql: buf.join("\n") });
      label = m[1]!;
      buf = [];
    } else if (!line.startsWith("\\")) buf.push(line);
  }
  sections.push({ label, sql: buf.join("\n") });
  try {
    const r = await withDb(cfg, "supabase/ops/ops-report.sql", async (q) => {
      for (const s of sections) {
        if (!s.sql.replace(/--.*$/gm, "").trim()) continue;
        const res = (await q(s.sql)) as { command: string; rows: unknown[] } | { command: string; rows: unknown[] }[];
        for (const x of Array.isArray(res) ? res : [res]) {
          if (x.command !== "SELECT") continue;
          if (s.label) console.log(`\n${s.label}`);
          if (x.rows.length) console.table(x.rows);
          else info("（沒有資料）");
        }
      }
    });
    if (!r.ran) {
      console.log("⚠ 營運報告沒有執行（NOT_RUN）：沒有讀取任何 cron / 積壓資料");
      return "NOT_RUN";
    }
    ok("營運報告完成（COMPLETED）");
    return "COMPLETED";
  } catch (e) {
    console.error(`✗ 營運報告失敗（FAILED）：${(e as Error).message}`);
    return "FAILED";
  }
}

async function httpJson(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    const text = await r.text();
    try {
      return { status: r.status, body: JSON.parse(text) };
    } catch {
      return { status: r.status, body: text.slice(0, 120) };
    }
  } catch (e) {
    return { status: 0, body: (e as Error).message };
  }
}

async function status(cfg: Record<string, string | undefined>): Promise<void> {
  step("設定");
  requireCli();
  const ref = cfg.CLOUD_PROJECT_REF;
  info(`CLOUD_PROJECT_REF = ${ref ?? "（未設定）"}`);
  info(`supabase link      = ${linkedRef() ?? "（尚未 link）"}`);
  info(`CLOUD_WEB_URL      = ${cfg.CLOUD_WEB_URL ?? "（未設定）"}`);
  const t = checkTarget({ expected: ref, confirm: ref, blocked: cfg.CLOUD_BLOCKED_REFS, linked: linkedRef() });
  if (t.length) for (const e of t) console.log(`! ${e}`);
  if (!ref || !linkedRef()) return;
  step("Migration（遠端 vs 本地）");
  console.log(supabase(["migration", "list", "--linked"], { capture: true }).out.trim());
  step("Edge Function secrets（只顯示名稱與摘要，不顯示值）");
  console.log(supabase(["secrets", "list", "--project-ref", ref], { capture: true }).out.trim());
  step("Edge Functions");
  console.log(supabase(["functions", "list", "--project-ref", ref], { capture: true }).out.trim());
  step("線上狀態");
  const anon = cfg.CLOUD_SUPABASE_ANON_KEY;
  const edge = await httpJson(`https://${ref}.supabase.co/functions/v1/health`, anon ? { apikey: anon } : {});
  info(`Edge health：${edge.status} ${JSON.stringify(edge.body)}`);
  if (cfg.CLOUD_WEB_URL) {
    const web = cfg.CLOUD_WEB_URL.replace(/\/$/, "");
    const v = await httpJson(`${web}/api/version`);
    const h = await httpJson(`${web}/api/health`);
    info(`Web /api/version：${v.status} ${JSON.stringify(v.body)}`);
    info(`Web /api/health ：${h.status} ${JSON.stringify(h.body)}`);
    const commit = (v.body as { commit?: string } | null)?.commit;
    if (commit) info(`本機 HEAD ${git(["rev-parse", "--short", "HEAD"]).out}；Vercel 部署 ${commit.slice(0, 7)}`);
  }
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      ref: { type: "string" },
      plan: { type: "string" },
      apply: { type: "boolean", default: false },
      "allow-unmerged": { type: "boolean", default: false },
      only: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const cmd = positionals[0] ?? "help";
  const cfg = loadConfig();
  const allowUnmerged = values["allow-unmerged"];

  switch (cmd) {
    case "status":
      await status(cfg);
      return;

    case "link": {
      requireCli();
      const ref = cfg.CLOUD_PROJECT_REF;
      if (!ref || !/^[a-z]{20}$/.test(ref)) fail("先在 .env.cloud 設定 CLOUD_PROJECT_REF");
      if ((cfg.CLOUD_BLOCKED_REFS ?? "").split(",").map((s) => s.trim()).includes(ref!)) fail(`${ref} 列在 CLOUD_BLOCKED_REFS`);
      step(`supabase link --project-ref ${ref}（只寫入本機 supabase/.temp；若詢問資料庫密碼可直接按 Enter 略過）`);
      if (supabase(["link", "--project-ref", ref!]).status !== 0) fail("supabase link 失敗（是否已執行 supabase login？）");
      if (linkedRef() !== ref) fail("link 之後 supabase/.temp/project-ref 與 CLOUD_PROJECT_REF 不同");
      ok(`已連結 ${ref}`);
      return;
    }

    case "db": {
      if (!values.apply) {
        // 唯讀：任何時候都可以執行
        step("部署前檢查（唯讀）");
        requireCli();
        const errors = checkTarget({ expected: cfg.CLOUD_PROJECT_REF, confirm: cfg.CLOUD_PROJECT_REF, blocked: cfg.CLOUD_BLOCKED_REFS, linked: linkedRef() });
        if (errors.length) fail(errors);
        const { names, plan } = dryRun();
        step("計畫");
        if (names.length === 0) {
          ok("遠端資料庫已是最新，沒有要套用的 migration");
          return;
        }
        for (const n of names) info(`• ${n}`);
        console.log(`\n計畫 ID：${plan}`);
        console.log(`確認上面的 migration 正確後再執行（會修改遠端資料庫；不會 reset、不會刪除玩家資料）：`);
        console.log(`  pnpm cloud db --apply --ref ${cfg.CLOUD_PROJECT_REF} --plan ${plan}`);
        return;
      }
      const ref = guardRemote(cfg, values.ref, { code: true, allowUnmerged });
      if (!values.plan) fail("--apply 需要 --plan <計畫 ID>（先執行 pnpm cloud db 取得）");
      const { names, plan } = dryRun();
      if (names.length === 0) {
        ok("遠端資料庫已是最新，沒有要套用的 migration");
        return;
      }
      if (plan !== values.plan) fail(`計畫已改變（dry-run 的計畫 ID 現在是 ${plan}，你確認的是 ${values.plan}）：重新執行 pnpm cloud db 檢查`);
      step(`套用 ${names.length} 個 migration 到 ${ref}（supabase db push --linked）`);
      // 在終端機執行時由你回答 CLI 的確認；非互動（例如由 Claude Code 代為執行）時，--ref + --plan 就是你的確認
      const push = supabase(["db", "push", "--linked"], process.stdin.isTTY ? {} : { input: "y\n" });
      if (push.status !== 0) fail("db push 失敗。已套用的 migration 不會回滾；執行 pnpm cloud status 查看目前狀態，修正後用新的 migration 往前修");
      ok("Migration 已套用");
      const after = supabase(["migration", "list", "--linked"], { capture: true });
      console.log(after.out.trim());
      const summary = applySummary(names, await verify(cfg));
      step("摘要");
      for (const l of summary.lines) console.log(l);
      process.exitCode = summary.exitCode;
      return;
    }

    case "secrets": {
      const ref = guardRemote(cfg, values.ref, { code: false, allowUnmerged });
      const { secrets, errors } = buildEdgeSecrets(cfg);
      if (errors.length) fail(errors);
      step(`設定 Edge Function secrets 到 ${ref}`);
      for (const [k, v] of Object.entries(secrets)) info(`${k} = ${k === "GAME_API_ALLOWED_ORIGIN" ? v : "(set)"}`);
      // 寫到權限 600 的暫存檔再交給 CLI（不放在指令列），結束後刪除
      const dir = mkdtempSync(join(tmpdir(), "mining-secrets-"));
      const file = join(dir, "edge.env");
      try {
        writeFileSync(file, Object.entries(secrets).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
        chmodSync(file, 0o600);
        if (supabase(["secrets", "set", "--env-file", file, "--project-ref", ref]).status !== 0) fail("supabase secrets set 失敗");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      ok("Secrets 已設定（新的值在下一次呼叫函式時生效）");
      return;
    }

    case "functions": {
      const ref = guardRemote(cfg, values.ref, { code: true, allowUnmerged });
      const list = supabase(["secrets", "list", "--project-ref", ref], { capture: true });
      if (list.status !== 0) fail("無法讀取 secrets 清單");
      if (!hasSecret(list.out, "GAME_API_ALLOWED_ORIGIN")) fail("Cloud 尚未設定 GAME_API_ALLOWED_ORIGIN（未設定時瀏覽器會被 CORS 拒絕）：先執行 pnpm cloud secrets --ref " + ref);
      const targets = values.only ? values.only.split(",").map((s) => s.trim()) : FUNCTIONS;
      const unknown = targets.filter((t) => !FUNCTIONS.includes(t));
      if (unknown.length) fail(`未知的函式：${unknown.join(", ")}`);
      step(`部署 Edge Functions 到 ${ref}：${targets.join(", ")}`);
      if (supabase(["functions", "deploy", ...targets, "--project-ref", ref, "--use-api"]).status !== 0) fail("functions deploy 失敗（已部署的函式維持新版本；修正後重新執行，或依 runbook 回滾）");
      ok("Edge Functions 已部署");
      const edge = await httpJson(`https://${ref}.supabase.co/functions/v1/health`, cfg.CLOUD_SUPABASE_ANON_KEY ? { apikey: cfg.CLOUD_SUPABASE_ANON_KEY } : {});
      if (edge.status === 200) ok("health 200");
      else fail(`health 回應 ${edge.status} ${JSON.stringify(edge.body)}`);
      return;
    }

    case "verify": {
      const status = await verify(cfg);
      console.log(`VERIFY_STATUS=${status}`);
      process.exitCode = EXIT_CODE[status];
      return;
    }

    case "report": {
      const status = await report(cfg);
      console.log(`REPORT_STATUS=${status}`);
      process.exitCode = EXIT_CODE[status];
      return;
    }

    case "backup": {
      step("邏輯備份（唯讀：supabase db dump）");
      requireCli();
      const errors = checkTarget({ expected: cfg.CLOUD_PROJECT_REF, confirm: cfg.CLOUD_PROJECT_REF, blocked: undefined, linked: linkedRef() });
      if (errors.length) fail(errors);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const dir = join(ROOT, "backups", `${cfg.CLOUD_PROJECT_REF}-${stamp}`);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const dumps: [string, string[]][] = [
        ["roles.sql", ["--role-only"]],
        ["schema.sql", []],
        ["data.sql", ["--use-copy", "--data-only", "--schema", "public,private,supabase_migrations"]],
      ];
      for (const [file, extra] of dumps) {
        info(`→ ${file}`);
        if (supabase(["db", "dump", "--linked", "-f", join(dir, file), ...extra]).status !== 0) fail(`db dump ${file} 失敗`);
        if (existsSync(join(dir, file))) chmodSync(join(dir, file), 0o600);
      }
      ok(`遊戲資料邏輯備份完成（非完整環境還原點）：${dir}`);
      info("內含玩家資料與 private 密鑰表：只存放在加密的位置（例如加密磁碟 / 密碼管理器的附件），不要提交 Git、不要上傳到公開位置");
      info("不含 auth.users（帳號）；需要時另外匯出並評估個資處理（docs/OPERATIONS_RUNBOOK.md §5）");
      return;
    }

    case "smoke": {
      const ref = cfg.CLOUD_PROJECT_REF;
      if (!ref) fail("先在 .env.cloud 設定 CLOUD_PROJECT_REF");
      if (!cfg.CLOUD_SUPABASE_ANON_KEY) fail("先在 .env.cloud 設定 CLOUD_SUPABASE_ANON_KEY（publishable / anon key，公開的）");
      step("Smoke test（tests/integration/cloud-smoke.test.ts）");
      if (!cfg.SMOKE_USER_EMAIL) info("沒有 SMOKE_USER_EMAIL：只執行不需要帳號的檢查（health、401、CORS）");
      const env: Record<string, string> = { ...(process.env as Record<string, string>), CLOUD_SMOKE: "1", CLOUD_SUPABASE_URL: `https://${ref}.supabase.co` };
      for (const k of ["CLOUD_SUPABASE_ANON_KEY", "CLOUD_WEB_URL", "SMOKE_USER_EMAIL", "SMOKE_USER_PASSWORD", "SMOKE_USER_B_EMAIL", "SMOKE_USER_B_PASSWORD", "SMOKE_RATE_LIMIT"]) {
        if (cfg[k]) env[k] = cfg[k]!;
      }
      const r = spawnSync("pnpm", ["--filter", "@mining/integration-tests", "exec", "vitest", "run", "cloud-smoke.test.ts"], { cwd: ROOT, stdio: "inherit", env });
      if (r.status !== 0) fail("smoke test 失敗");
      ok("smoke test 通過");
      return;
    }

    default:
      {
        const lines = readFileSync(import.meta.filename, "utf8").split("\n");
        console.log(lines.slice(1, lines.indexOf(" */")).join("\n").replace(/^ \* ?/gm, ""));
      }
  }
}

main().catch((e) => {
  if (!(e instanceof Stop)) console.error(`✗ ${(e as Error).message}`);
  process.exitCode = 1;
});
