import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/version/route";

describe("/api/version", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("回報 Vercel 的部署 commit / 分支 / 環境（不含密鑰）", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "a".repeat(40));
    vi.stubEnv("VERCEL_GIT_COMMIT_REF", "staging");
    vi.stubEnv("VERCEL_ENV", "preview");
    const r = GET();
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual({ commit: "a".repeat(40), ref: "staging", env: "preview" });
  });

  it("本地沒有 Vercel 變數", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", undefined as unknown as string);
    vi.stubEnv("VERCEL_GIT_COMMIT_REF", undefined as unknown as string);
    vi.stubEnv("VERCEL_ENV", undefined as unknown as string);
    expect(await GET().json()).toEqual({ commit: null, ref: null, env: "local" });
  });
});
