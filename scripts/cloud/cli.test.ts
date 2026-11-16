/**
 * CLI 層級回歸測試（PR #17 review P1）：實際執行 scripts/cloud/deploy.ts，確認
 * 「未驗證（NOT_RUN）」不會被當成成功：exit code 與最後一行的狀態都要正確。
 *
 * - verify / report：沒有 CLOUD_DB_URL → exit 2 + *_STATUS=NOT_RUN；連不上 → exit 1 + FAILED。
 * - db --apply：在暫存 git repo 中以假的 Supabase CLI 執行（不連任何雲端），
 *   migration 套用後驗證沒有執行 → exit 2 + DEPLOY_STATUS=MIGRATION_APPLIED_VERIFY_NOT_RUN。
 * PASSED / COMPLETED（exit 0）在 tests/integration/ops-sql.test.ts 以真的 Supabase Local 驗證。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { pendingMigrations, planId } from "./lib.ts";

const REPO = resolve(import.meta.dirname, "../..");
const REF = "abcdefghijklmnopqrst";
// 沒有服務在聽的位址：連線一定失敗（不會連到任何雲端）
const UNREACHABLE = "postgres://user:pw@127.0.0.1:1/postgres";

interface Run {
  code: number;
  out: string;
  last: string;
}

function run(cwdRoot: string, args: string[], env: Record<string, string> = {}): Run {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("CLOUD_") && !k.startsWith("SMOKE_")) base[k] = v;
  const r = spawnSync(process.execPath, [join(cwdRoot, "scripts/cloud/deploy.ts"), ...args], {
    cwd: cwdRoot,
    encoding: "utf8",
    env: { ...base, ...env },
    input: "", // 非 TTY（與 Claude Code / 自動化相同）
    timeout: 60_000,
  });
  const out = `${r.stdout}${r.stderr}`;
  const lines = r.stdout.trim().split("\n");
  return { code: r.status ?? -1, out, last: lines[lines.length - 1] ?? "" };
}

describe("verify / report：NOT_RUN 不是成功", () => {
  test("verify 沒有 CLOUD_DB_URL → exit 2、VERIFY_STATUS=NOT_RUN、沒有任何「通過」字樣", () => {
    const r = run(REPO, ["verify"]);
    assert.equal(r.code, 2, r.out);
    assert.equal(r.last, "VERIFY_STATUS=NOT_RUN");
    assert.doesNotMatch(r.out, /PASSED|驗證通過/);
    assert.match(r.out, /SQL Editor/); // 仍提供替代方案
  });

  test("report 沒有 CLOUD_DB_URL → exit 2、REPORT_STATUS=NOT_RUN", () => {
    const r = run(REPO, ["report"]);
    assert.equal(r.code, 2, r.out);
    assert.equal(r.last, "REPORT_STATUS=NOT_RUN");
    assert.doesNotMatch(r.out, /COMPLETED/);
  });

  test("連不上資料庫 → exit 1、FAILED（不是 NOT_RUN，也不是成功）", () => {
    const v = run(REPO, ["verify"], { CLOUD_DB_URL: UNREACHABLE });
    assert.equal(v.code, 1, v.out);
    assert.equal(v.last, "VERIFY_STATUS=FAILED");
    assert.doesNotMatch(v.out, /pw@/); // 不輸出連線字串
    const r = run(REPO, ["report"], { CLOUD_DB_URL: UNREACHABLE });
    assert.equal(r.code, 1, r.out);
    assert.equal(r.last, "REPORT_STATUS=FAILED");
  });
});

describe("db --apply：migration 已套用 ≠ 驗收通過（假的 Supabase CLI，不連雲端）", () => {
  let root: string;
  let tools: string;
  let calls: string;
  let pathEnv: string;
  const migration = "20991231000000_cli_test.sql";

  before(() => {
    root = mkdtempSync(join(tmpdir(), "cloud-cli-"));
    mkdirSync(join(root, "scripts/cloud"), { recursive: true });
    for (const f of ["deploy.ts", "lib.ts"]) cpSync(join(REPO, "scripts/cloud", f), join(root, "scripts/cloud", f));
    cpSync(join(REPO, "supabase/ops"), join(root, "supabase/ops"), { recursive: true });
    mkdirSync(join(root, "supabase/migrations"), { recursive: true });
    writeFileSync(join(root, "supabase/migrations", migration), "select 1;\n");
    symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));
    writeFileSync(join(root, ".gitignore"), ".env.cloud\nsupabase/.temp/\nnode_modules\n");
    writeFileSync(join(root, ".env.cloud"), `CLOUD_PROJECT_REF=${REF}\nCLOUD_WEB_URL=https://example.vercel.app\n# 檔案裡的連線字串必須被忽略\nCLOUD_DB_URL=${UNREACHABLE}\n`);
    mkdirSync(join(root, "supabase/.temp"), { recursive: true });
    writeFileSync(join(root, "supabase/.temp/project-ref"), REF);

    // 假的 CLI 與呼叫紀錄放在 repo 之外（否則會被當成未提交的變更）
    tools = mkdtempSync(join(tmpdir(), "cloud-cli-bin-"));
    const bin = join(tools, "bin");
    mkdirSync(bin);
    calls = join(tools, "calls.log");
    writeFileSync(
      join(bin, "supabase"),
      [
        "#!/usr/bin/env bash",
        `echo "$*" >> "${calls}"`,
        'case "$1 $2" in',
        '  "--version ") echo "2.122.1";;',
        '  "migration list") echo "local | remote";;',
        `  "db push") if [[ "$*" == *--dry-run* ]]; then echo "Would push these migrations:"; echo " • ${migration}"; else cat >/dev/null; echo "Applied"; fi;;`,
        "  *) echo \"unexpected: $*\"; exit 9;;",
        "esac",
      ].join("\n"),
    );
    chmodSync(join(bin, "supabase"), 0o755);
    pathEnv = `${bin}:${process.env.PATH}`;

    const git = (...a: string[]) => {
      const r = spawnSync("git", ["-c", "user.email=t@example.test", "-c", "user.name=t", ...a], { cwd: root, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    };
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    git("remote", "add", "origin", root);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(tools, { recursive: true, force: true });
  });

  const plan = () => planId(pendingMigrations(` • ${migration}`), ["select 1;\n"]);

  test("沒有 CLOUD_DB_URL（檔案中的值被忽略）→ exit 2、MIGRATION_APPLIED_VERIFY_NOT_RUN", () => {
    writeFileSync(calls, "");
    const r = run(root, ["db", "--apply", "--ref", REF, "--plan", plan()], { PATH: pathEnv });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /MIGRATIONS_APPLIED=1/);
    assert.match(r.out, /VERIFY_STATUS=NOT_RUN/);
    assert.equal(r.last, "DEPLOY_STATUS=MIGRATION_APPLIED_VERIFY_NOT_RUN");
    assert.match(r.out, /不是驗收通過/);
    assert.doesNotMatch(r.out, /VERIFIED\b|驗證通過/);
    // migration 確實只推送一次（不會因為 exit 2 而被誤以為沒套用）
    const pushes = spawnSync("grep", ["-c", "^db push --linked$", calls], { encoding: "utf8" }).stdout.trim();
    assert.equal(pushes, "1");
  });

  test("驗證連不上 → exit 1、MIGRATION_APPLIED_VERIFY_FAILED", () => {
    const r = run(root, ["db", "--apply", "--ref", REF, "--plan", plan()], { PATH: pathEnv, CLOUD_DB_URL: UNREACHABLE });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /VERIFY_STATUS=FAILED/);
    assert.equal(r.last, "DEPLOY_STATUS=MIGRATION_APPLIED_VERIFY_FAILED");
  });

  test("計畫 ID 不同 → 不套用、exit 1", () => {
    writeFileSync(calls, "");
    const r = run(root, ["db", "--apply", "--ref", REF, "--plan", "0000000000"], { PATH: pathEnv });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /計畫已改變/);
    const pushes = spawnSync("grep", ["-c", "^db push --linked$", calls], { encoding: "utf8" }).stdout.trim();
    assert.equal(pushes, "0");
  });
});
