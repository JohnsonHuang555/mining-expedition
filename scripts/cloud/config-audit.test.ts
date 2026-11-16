/**
 * 單人部署設定稽核（CI）：確認簡化之後仍然守住安全邊界。
 * - GitHub Actions 只做 CI，不部署任何雲端資源，也不需要雲端密鑰。
 * - Vercel 會建置 main（沒有會略過 main 的 Ignored Build Step），且測試站不被搜尋引擎索引。
 * - 部署腳本不會 reset；設定檔不提交；範本不含密鑰欄位。
 * - Edge CORS 在 Cloud 沒有設定時 fail closed。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");
const code = (s: string) => s.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");

test("GitHub Actions 只執行 CI：沒有部署 workflow、不使用雲端密鑰", () => {
  assert.equal(existsSync(new URL(".github/workflows/staging-deploy.yml", root)), false);
  for (const f of readdirSync(new URL(".github/workflows/", root))) {
    const wf = code(read(`.github/workflows/${f}`));
    assert.doesNotMatch(wf, /supabase (link|db push|functions deploy|secrets set)/, `${f} deploys to Supabase Cloud`);
    assert.doesNotMatch(wf, /--linked|--project-ref/, f);
    assert.doesNotMatch(wf, /vercel (deploy|--prod)/, f);
    assert.doesNotMatch(wf, /secrets\.(SUPABASE_ACCESS_TOKEN|[A-Z_]*DB_PASSWORD|[A-Z_]*DB_URL|VERCEL_TOKEN)/, f);
  }
});

test("Vercel：main 正常建置（沒有略過 main 的 ignoreCommand）；測試站加 noindex", () => {
  const cfg = JSON.parse(read("apps/web/vercel.json")) as { ignoreCommand?: string; headers?: { headers: { key: string; value: string }[] }[] };
  assert.equal(cfg.ignoreCommand, undefined);
  const headers = (cfg.headers ?? []).flatMap((h) => h.headers);
  assert.ok(headers.some((h) => h.key === "X-Robots-Tag" && /noindex/.test(h.value)));
});

test("部署腳本：所有 Supabase 呼叫經過安全檢查；沒有 reset；遠端修改需要 --ref", () => {
  const src = read("scripts/cloud/deploy.ts");
  assert.match(src, /assertSafeSupabaseArgs\(args\)/);
  assert.doesNotMatch(src, /"reset"/);
  assert.match(src, /"--dry-run"/);
  for (const cmd of ['case "secrets"', 'case "functions"']) {
    const body = src.slice(src.indexOf(cmd), src.indexOf("case ", src.indexOf(cmd) + 6));
    assert.match(body, /guardRemote\(cfg, values\.ref/, cmd);
  }
  const db = src.slice(src.indexOf('case "db"'), src.indexOf('case "secrets"'));
  assert.ok(db.indexOf("guardRemote") < db.indexOf('["db", "push", "--linked"]'), "db push only after guardRemote");
  assert.match(db, /plan !== values\.plan/);
  assert.equal(JSON.parse(read("package.json")).scripts.cloud, "node scripts/cloud/deploy.ts");
});

test("設定檔不提交；範本沒有密鑰欄位", () => {
  const ignored = (p: string) => {
    try {
      execFileSync("git", ["check-ignore", "-q", p], { cwd: root });
      return true;
    } catch {
      return false;
    }
  };
  for (const p of [".env.cloud", "supabase/functions/.env", "supabase/functions/.env.cloud", "apps/web/.env.local", "supabase/.temp/project-ref", "backups/x/data.sql"]) assert.ok(ignored(p), `${p} must be gitignored`);
  assert.equal(ignored(".env.cloud.example"), false);
  const tpl = code(read(".env.cloud.example"));
  assert.doesNotMatch(tpl, /SERVICE_ROLE|SECRET_KEY|ACCESS_TOKEN|DB_PASSWORD|CLOUD_DB_URL/);
  assert.doesNotMatch(tpl, /SMOKE_USER_PASSWORD=\S/);
});

test("Edge CORS：Cloud 上沒有允許清單時 fail closed", () => {
  const api = read("supabase/functions/_shared/api.ts");
  assert.match(api, /parseAllowedOrigins\(Deno\.env\.get\("GAME_API_ALLOWED_ORIGIN"\), requiresExplicitOrigins\(Deno\.env\.get\("SUPABASE_URL"\)\)\)/);
});
