// 部署設定稽核（PR #16 review）：防止「main = Vercel Preview」的錯誤設計回來，
// 並確認 Staging deploy workflow 會把同一個 main commit 推到 staging 分支、核對 Web 版本，以及 CORS fail closed。
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("Vercel：只建置 staging 分支的 Preview（main 是 Production Branch，目前略過）", async () => {
  const { shouldBuild } = await import("../vercel-ignore-build.mjs");
  assert.equal(shouldBuild({ VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main" }), false);
  assert.equal(shouldBuild({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "staging" }), true);
  assert.equal(JSON.parse(read("apps/web/vercel.json")).ignoreCommand, "node ../../scripts/vercel-ignore-build.mjs");
});

test("Staging deploy workflow：fast-forward staging、等待同一個 commit、smoke 在之後", () => {
  const wf = read(".github/workflows/staging-deploy.yml");
  const code = wf.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
  assert.match(wf, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(wf, /merge-base --is-ancestor origin\/staging "\$GITHUB_SHA"/);
  assert.match(wf, /git push origin "\$GITHUB_SHA:refs\/heads\/staging"/);
  assert.doesNotMatch(code, /push[^\n]*(--force|\s-f\s|\+\$GITHUB_SHA)/);
  assert.match(wf, /\/api\/version/);
  assert.match(wf, /\$GITHUB_SHA\|preview\|staging/);
  assert.doesNotMatch(code, /db reset/);
  const order = ["functions deploy", "refs/heads/staging", "/api/version", "API smoke test", "Browser smoke test"].map((k) => code.indexOf(k));
  assert.ok(order.every((i) => i >= 0), `missing step: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "順序必須是 Edge → promote → 版本核對 → smoke");
  assert.match(wf, /STAGING_ALLOWED_ORIGINS is required/);
});

test("文件與範本：Staging 網址是 staging 分支，不是 main 的 Preview", () => {
  const files = [
    ...readdirSync(new URL("../../docs/", import.meta.url)).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`),
    "apps/web/.env.example",
    "supabase/functions/.env.example",
  ];
  for (const f of files) {
    const s = read(f);
    assert.doesNotMatch(s, /-git-main-/, `${f} 使用 main 的 Preview 網址`);
    assert.doesNotMatch(s, /`main` 分支的 Preview/, f);
  }
  const doc = read("docs/DEPLOYMENT_STAGING.md");
  assert.match(doc, /git-staging-<team>\.vercel\.app/);
  assert.match(doc, /Production Branch 維持 `main`/);
});

test("Edge CORS：Cloud 上沒有允許清單時 fail closed", () => {
  const api = read("supabase/functions/_shared/api.ts");
  assert.match(api, /parseAllowedOrigins\(Deno\.env\.get\("GAME_API_ALLOWED_ORIGIN"\), requiresExplicitOrigins\(Deno\.env\.get\("SUPABASE_URL"\)\)\)/);
});
