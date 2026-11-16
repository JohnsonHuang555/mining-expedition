import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertSafeSupabaseArgs,
  buildEdgeSecrets,
  checkGit,
  checkTarget,
  cliMajor,
  hasSecret,
  parseEnvFile,
  pendingMigrations,
  planId,
} from "./lib.ts";

const ref = "abcdefghijklmnopqrst";
const other = "zyxwvutsrqponmlkjihg";

test("目標檢查：ref 合法、--ref 相同、不在禁止清單、已 link 同一個專案", () => {
  assert.deepEqual(checkTarget({ expected: ref, confirm: ref, blocked: other, linked: `${ref}\n` }), []);
});

test("目標檢查：缺少 / 格式錯誤 / 沒有 --ref / --ref 不同 / 在禁止清單 / 未 link / link 到別的專案", () => {
  assert.match(checkTarget({ expected: undefined, confirm: ref, blocked: undefined, linked: ref })[0]!, /CLOUD_PROJECT_REF/);
  assert.match(checkTarget({ expected: "ABC", confirm: "ABC", blocked: undefined, linked: "ABC" })[0]!, /格式錯誤/);
  assert.match(checkTarget({ expected: ref, confirm: undefined, blocked: undefined, linked: ref })[0]!, /--ref/);
  assert.match(checkTarget({ expected: ref, confirm: other, blocked: undefined, linked: ref })[0]!, /不同/);
  assert.match(checkTarget({ expected: ref, confirm: ref, blocked: `${other}, ${ref}`, linked: ref })[0]!, /BLOCKED/);
  assert.match(checkTarget({ expected: ref, confirm: ref, blocked: undefined, linked: null })[0]!, /cloud link/);
  assert.match(checkTarget({ expected: ref, confirm: ref, blocked: undefined, linked: other })[0]!, /目前連結的專案/);
});

test("git：未提交的變更一律拒絕；不是 origin/main 時要 --allow-unmerged", () => {
  assert.deepEqual(checkGit({ dirty: false, head: "a".repeat(40), originMain: "a".repeat(40) }, false), []);
  assert.match(checkGit({ dirty: true, head: "a", originMain: "a" }, true)[0]!, /未提交/);
  assert.match(checkGit({ dirty: false, head: "a".repeat(40), originMain: "b".repeat(40) }, false)[0]!, /不是 origin\/main/);
  assert.deepEqual(checkGit({ dirty: false, head: "a".repeat(40), originMain: "b".repeat(40) }, true), []);
  assert.match(checkGit({ dirty: false, head: "a", originMain: null }, false)[0]!, /fetch/);
});

test("Supabase CLI：只允許 v2；永遠拒絕 reset / repair / squash / pull / --db-url", () => {
  assert.equal(cliMajor("2.122.1\n"), 2);
  assert.equal(cliMajor("supabase 3.0.0"), 3);
  assert.equal(cliMajor("??"), null);
  assert.throws(() => assertSafeSupabaseArgs(["db", "reset", "--linked"]), /db reset/);
  assert.throws(() => assertSafeSupabaseArgs(["migration", "repair", "--status", "reverted", "1"]), /repair/);
  assert.throws(() => assertSafeSupabaseArgs(["migration", "squash"]), /squash/);
  assert.throws(() => assertSafeSupabaseArgs(["db", "pull"]), /pull/);
  assert.throws(() => assertSafeSupabaseArgs(["db", "push", "--db-url", "postgres://x"]), /db-url/);
  assert.doesNotThrow(() => assertSafeSupabaseArgs(["db", "push", "--linked", "--dry-run"]));
  assert.doesNotThrow(() => assertSafeSupabaseArgs(["functions", "deploy", "health", "--project-ref", ref]));
});

test("dry-run：取出待套用的 migration；計畫 ID 隨檔名與內容改變", () => {
  const out = [
    "Connecting to remote database...",
    "Would push these migrations:",
    " • 20261118000000_new_feature.sql",
    " • 20261117000000_reliability.sql",
    "Finished supabase db push.",
  ].join("\n");
  const names = pendingMigrations(out);
  assert.deepEqual(names, ["20261117000000_reliability.sql", "20261118000000_new_feature.sql"]);
  assert.deepEqual(pendingMigrations("Remote database is up to date."), []);
  assert.equal(planId([]), "none");
  const p = planId(names, ["a", "b"]);
  assert.match(p, /^[0-9a-f]{10}$/);
  assert.equal(planId(names, ["a", "b"]), p);
  assert.notEqual(planId(names, ["a", "b2"]), p); // 內容被修改
  assert.notEqual(planId(names.slice(0, 1), ["a"]), p); // 少了一個
});

test("env 檔解析：註解、引號、export", () => {
  assert.deepEqual(parseEnvFile("# c\nA=1\nexport B = 'x y'\nC=\"z\" \nD=v # note\n\nbad line"), { A: "1", B: "x y", C: "z", D: "v" });
});

test("Edge secrets：CORS 只接受完整的 https origin；不接受 *；選填項目檢查格式", () => {
  const ok = buildEdgeSecrets({ CLOUD_WEB_URL: "https://mining-expedition.vercel.app/", CLOUD_EXTRA_ORIGINS: "https://play.example.com", GAME_DB_TIMEOUT_MS: "8000" });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.secrets, { GAME_API_ALLOWED_ORIGIN: "https://mining-expedition.vercel.app,https://play.example.com", GAME_DB_TIMEOUT_MS: "8000" });

  assert.ok(buildEdgeSecrets({}).errors.some((e) => /CLOUD_WEB_URL/.test(e)));
  assert.ok(buildEdgeSecrets({ CLOUD_WEB_URL: "http://insecure.example.com" }).errors.length > 0);
  assert.ok(buildEdgeSecrets({ CLOUD_WEB_URL: "*" }).errors.length > 0);
  assert.ok(buildEdgeSecrets({ CLOUD_WEB_URL: "https://a.vercel.app", CLOUD_EXTRA_ORIGINS: "https://*.vercel.app" }).errors.length > 0);
  assert.ok(buildEdgeSecrets({ CLOUD_WEB_URL: "https://a.vercel.app", CLOUD_EXTRA_ORIGINS: "https://b.example.com/path" }).errors.length > 0);
  assert.ok(buildEdgeSecrets({ CLOUD_WEB_URL: "https://a.vercel.app", GAME_RATE_LIMIT_ACTION: "lots" }).errors.length > 0);
  assert.ok(buildEdgeSecrets({ CLOUD_WEB_URL: "https://a.vercel.app", EDGE_DIAGNOSTICS: "true" }).errors.length > 0);
  // 未知的名稱（例如 SUPABASE_SERVICE_ROLE_KEY）不會被帶到 secrets
  assert.deepEqual(Object.keys(buildEdgeSecrets({ CLOUD_WEB_URL: "https://a.vercel.app", SUPABASE_SERVICE_ROLE_KEY: "x" }).secrets), ["GAME_API_ALLOWED_ORIGIN"]);
});

test("secrets list：只依名稱判斷", () => {
  const out = "   NAME                     | DIGEST\n  --------------------------|--------\n   GAME_API_ALLOWED_ORIGIN  | 1a2b\n   SUPABASE_URL             | 3c4d\n";
  assert.equal(hasSecret(out, "GAME_API_ALLOWED_ORIGIN"), true);
  assert.equal(hasSecret(out, "GAME_API_ALLOWED"), false);
  assert.equal(hasSecret("", "GAME_API_ALLOWED_ORIGIN"), false);
});
