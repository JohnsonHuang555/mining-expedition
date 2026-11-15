import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { shouldBuild } from "./vercel-ignore-build.mjs";

test("只建置 staging 分支的 Preview；main（Production）與其他分支略過", () => {
  assert.equal(shouldBuild({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "staging" }), true);
  assert.equal(shouldBuild({ VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main" }), false); // main ≠ Preview
  assert.equal(shouldBuild({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "main" }), false);
  assert.equal(shouldBuild({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feature/x" }), false);
  assert.equal(shouldBuild({}), false);
  assert.equal(shouldBuild({ VERCEL_ENV: "production", MINING_ALLOW_PRODUCTION_BUILD: "1" }), true); // 正式上線時才開
});

test("exit code 符合 Vercel 的語意（0 = 略過、1 = 建置）", () => {
  const script = fileURLToPath(new URL("./vercel-ignore-build.mjs", import.meta.url));
  const run = (env) => {
    try {
      execFileSync("node", [script], { env: { PATH: process.env.PATH, ...env }, stdio: "pipe" });
      return 0;
    } catch (e) {
      return e.status;
    }
  };
  assert.equal(run({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "staging" }), 1);
  assert.equal(run({ VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main" }), 0);
});

test("apps/web/vercel.json 使用這個腳本", async () => {
  const { readFileSync } = await import("node:fs");
  const cfg = JSON.parse(readFileSync(new URL("../apps/web/vercel.json", import.meta.url), "utf8"));
  assert.equal(cfg.ignoreCommand, "node ../../scripts/vercel-ignore-build.mjs");
});
