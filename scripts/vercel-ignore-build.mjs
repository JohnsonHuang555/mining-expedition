// Vercel「Ignored Build Step」（apps/web/vercel.json 的 ignoreCommand）。
// Vercel 的規則：exit 0 = 略過這次部署；exit 1 = 繼續建置。
//
// 目前只部署 Staging（docs/DEPLOYMENT_STAGING.md §4.2）：
// - Vercel 的 Production Branch 是 main（Vercel 預設）：main 的部署是 **Production** 環境，Production 尚未上線 → 略過。
// - Staging = `staging` 分支的 **Preview** 部署（固定的分支網址 + Preview 專用環境變數）→ 建置。
// - 其他分支 / PR 的 Preview → 略過（避免未審核的程式碼以 Staging 的環境變數部署、也節省建置額度）。
// 正式上線時：在 Vercel 的 Production 環境設定 MINING_ALLOW_PRODUCTION_BUILD=1（另開 PR / 由擁有者決定）。

/** 是否要建置（純函式；scripts/vercel-ignore-build.test.mjs） */
export function shouldBuild(env) {
  if (env.VERCEL_ENV === "production") return env.MINING_ALLOW_PRODUCTION_BUILD === "1";
  if (env.VERCEL_ENV === "preview") return env.VERCEL_GIT_COMMIT_REF === "staging";
  return false;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const build = shouldBuild(process.env);
  console.log(`${build ? "build" : "skip"}: VERCEL_ENV=${process.env.VERCEL_ENV ?? "?"} ref=${process.env.VERCEL_GIT_COMMIT_REF ?? "?"}`);
  process.exit(build ? 1 : 0);
}
