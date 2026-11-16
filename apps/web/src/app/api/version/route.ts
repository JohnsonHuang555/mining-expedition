export const dynamic = "force-dynamic";

/**
 * 部署版本（`pnpm cloud status` 用來比對 Vercel 部署的 commit 與本機 / Edge Functions 的版本）。
 * VERCEL_GIT_COMMIT_SHA / VERCEL_ENV / VERCEL_GIT_COMMIT_REF 是 Vercel 的系統環境變數（伺服器端），不是密鑰。
 */
export function GET() {
  return Response.json(
    {
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      ref: process.env.VERCEL_GIT_COMMIT_REF ?? null,
      env: process.env.VERCEL_ENV ?? "local",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
