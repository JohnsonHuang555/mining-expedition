/**
 * Cloud 部署後的最小 Smoke Test（docs/CLOUD_SMOKE_TEST.md）。執行：pnpm cloud smoke
 *
 * 只在 CLOUD_SMOKE=1 時執行（一般 CI 與本地整合測試會跳過）。分三層，缺少帳號就只跑前面的層：
 *   1. 不需要帳號：health、未登入 / 無效 JWT → 401、CORS（只允許 CLOUD_WEB_URL 的 origin）。
 *   2. 一個測試帳號（SMOKE_USER_EMAIL / PASSWORD）：建立角色、狀態與市場、冪等重送、報價過期、body 帶 playerId → 400。
 *   3. 第二個帳號（SMOKE_USER_B_*，選填）：跨玩家隔離。
 * 限流檢查需要另外設定 SMOKE_RATE_LIMIT=1（最多 30 個唯讀請求）。
 * 不建立大量資料、不輸出任何 token 或密碼。
 *
 * 環境變數（由 scripts/cloud/deploy.ts 從 .env.cloud 帶入）：
 *   CLOUD_SUPABASE_URL、CLOUD_SUPABASE_ANON_KEY（publishable / anon key）、CLOUD_WEB_URL（選填，CORS 檢查）
 */
import { randomUUID } from "node:crypto";
import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

const enabled = process.env.CLOUD_SMOKE === "1";
const hasA = Boolean(process.env.SMOKE_USER_EMAIL && process.env.SMOKE_USER_PASSWORD);
const hasB = hasA && Boolean(process.env.SMOKE_USER_B_EMAIL && process.env.SMOKE_USER_B_PASSWORD);
const webUrl = process.env.CLOUD_WEB_URL;
const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`missing ${name}`);
  return v;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;
interface Call {
  status: number;
  headers: Headers;
  body: Body;
  ms: number;
}
interface Player {
  client: SupabaseClient;
  token: string;
  id: string;
}

describe.skipIf(!enabled)("Cloud smoke（API）", () => {
  const url = (process.env.CLOUD_SUPABASE_URL ?? "").replace(/\/$/, "");
  const anon = process.env.CLOUD_SUPABASE_ANON_KEY ?? "";
  const functions = `${url}/functions/v1`;
  const latencies: Record<string, number[]> = {};

  async function call(fn: string, opts: { method?: string; token?: string | null; key?: string; body?: unknown } = {}): Promise<Call> {
    const headers: Record<string, string> = { apikey: anon, "Content-Type": "application/json" };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.key) headers["Idempotency-Key"] = opts.key;
    const started = performance.now();
    const res = await fetch(`${functions}/${fn}`, { method: opts.method ?? "POST", headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    const text = await res.text();
    const ms = performance.now() - started;
    (latencies[fn] ??= []).push(ms);
    let body: Body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: res.status, headers: res.headers, body, ms };
  }

  async function signIn(prefix: "" | "B_"): Promise<Player> {
    const client = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await client.auth.signInWithPassword({ email: env(`SMOKE_USER_${prefix}EMAIL`), password: env(`SMOKE_USER_${prefix}PASSWORD`) });
    if (error || !data.session) throw new Error(`sign in ${prefix || "A_"}failed: ${error?.code ?? "no session"}`);
    const p = { client, token: data.session.access_token, id: data.user!.id };
    const r = await call("character-create", { token: p.token, body: {} });
    expect([201, 409]).toContain(r.status); // 第一次建立；之後已存在
    return p;
  }

  beforeAll(() => {
    env("CLOUD_SUPABASE_URL");
    env("CLOUD_SUPABASE_ANON_KEY");
  });

  // ── 1. 不需要帳號 ─────────────────────────────────────────────
  it("health：資料庫可連線", async () => {
    const r = await call("health", { method: "GET" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });

  it("未登入 / 無效 JWT / anon key 當 JWT → 401（不洩漏細節）", async () => {
    for (const token of [null, "not-a-jwt", anon]) {
      const r = await call("game-state", { method: "GET", token });
      expect(r.status).toBe(401);
      expect(r.body?.error?.code).toBe("UNAUTHORIZED");
    }
  });

  it.skipIf(!webUrl)("CORS：只有 CLOUD_WEB_URL 的 origin 取得 Access-Control-Allow-Origin（其他 origin 一律沒有）", async () => {
    const origin = new URL(webUrl!).origin;
    const preflight = (o: string) =>
      fetch(`${functions}/game-state`, { method: "OPTIONS", headers: { Origin: o, "Access-Control-Request-Method": "GET" } }).then((r) =>
        r.headers.get("access-control-allow-origin"),
      );
    expect(await preflight(origin)).toBe(origin);
    const host = new URL(origin).host;
    const denied = [
      "https://evil.example.com",
      `http://${host}`, // 非 https
      `https://${host}.evil.example.com`, // 網域偽裝
      `https://evil-${host}`,
      "https://someone-else.vercel.app", // 其他人的 Vercel 網址
      "null",
    ];
    for (const o of denied) expect.soft(await preflight(o), o).toBeNull();
  });

  // ── 2. 一個測試帳號 ───────────────────────────────────────────
  describe.skipIf(!hasA)("登入後（SMOKE_USER_EMAIL）", () => {
    let a: Player;
    beforeAll(async () => {
      a = await signIn("");
    }, 60_000);

    it("game-state：狀態與市場報價（Asia/Taipei 市場日、12 件倍率）", async () => {
      const r = await call("game-state", { method: "GET", token: a.token });
      expect(r.status).toBe(200);
      expect(r.body.state.state.playerId).toBe(a.id);
      const taipei = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
      expect([taipei, new Date(Date.now() + 8 * 3_600_000 - 60_000).toISOString().slice(0, 10)]).toContain(r.body.market.date);
      expect(Object.keys(r.body.market.multipliersPpm)).toHaveLength(12);
    });

    it("同一個 Request ID：重送回傳相同結果（Idempotent-Replayed）；不同內容 → 409", async () => {
      const key = randomUUID();
      const first = await call("game-action", { token: a.token, key, body: { command: { type: "settle" } } });
      expect(first.status).toBe(200);
      const again = await call("game-action", { token: a.token, key, body: { command: { type: "settle" } } });
      expect(again.headers.get("idempotent-replayed")).toBe("true");
      expect(again.body).toEqual(first.body);
      const other = await call("game-action", { token: a.token, key, body: { command: { type: "sell_items", itemId: "stone", quantity: 1 } } });
      expect(other.status).toBe(409);
      expect(other.body.error.code).toBe("IDEMPOTENCY_MISMATCH");
    });

    it("報價過期：舊的市場日 → 409 MARKET_QUOTE_EXPIRED，不出售（不需要持有寶物）", async () => {
      const r = await call("game-action", { token: a.token, key: randomUUID(), body: { command: { type: "sell_artifacts", instanceIds: ["d0"], marketDate: "2000-01-01" } } });
      if (r.body?.error?.code === "REPORT_PENDING") return; // 測試帳號剛好有待領報告：不影響其他檢查
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("MARKET_QUOTE_EXPIRED");
      expect(r.body.market.date).not.toBe("2000-01-01");
    });

    it("不信任 Client 傳入的 playerId：body 帶 playerId → 400", async () => {
      const r = await call("game-action", { token: a.token, key: randomUUID(), body: { command: { type: "settle" }, playerId: randomUUID() } });
      expect(r.status).toBe(400);
    });

    it.skipIf(process.env.SMOKE_RATE_LIMIT !== "1")("Rate limit：唯讀請求超過上限 → 429 + Retry-After；等待後恢復（最多 30 個請求）", async () => {
      let limited: Call | null = null;
      for (let i = 0; i < 30 && !limited; i++) {
        const r = await call("game-state", { method: "GET", token: a.token });
        if (r.status === 429) limited = r;
      }
      expect(limited).not.toBeNull();
      const wait = Number(limited!.headers.get("retry-after"));
      expect(wait).toBeGreaterThanOrEqual(1);
      await new Promise((r) => setTimeout(r, wait * 1000 + 300));
      expect((await call("game-state", { method: "GET", token: a.token })).status).toBe(200);
    }, 60_000);

    // ── 3. 第二個帳號（選填）────────────────────────────────────
    describe.skipIf(!hasB)("跨玩家（SMOKE_USER_B_EMAIL）", () => {
      it("跨玩家隔離：B 讀不到、改不了 A；B 帶 A 的 playerId → 400", async () => {
        const b = await signIn("B_");
        const before = (await call("game-state", { method: "GET", token: a.token })).body.state.state.coins;
        expect((await b.client.from("players").select("id").eq("id", a.id)).data).toEqual([]);
        await b.client.from("players").update({ coins: 999_999 }).eq("id", a.id);
        const after = (await call("game-state", { method: "GET", token: a.token })).body.state.state.coins;
        expect(after).toBeGreaterThanOrEqual(before);
        expect(after).toBeLessThan(999_999);
        const injected = await call("game-action", { token: b.token, key: randomUUID(), body: { command: { type: "settle" }, playerId: a.id } });
        expect(injected.status).toBe(400);
      }, 60_000);
    });
  });

  it("延遲摘要（只寫入測試輸出；樣本少，僅供參考）", () => {
    const summary = Object.fromEntries(
      Object.entries(latencies).map(([fn, xs]) => {
        const s = [...xs].sort((x, y) => x - y);
        const q = (p: number) => Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]!);
        return [fn, { n: s.length, p50: q(0.5), p95: q(0.95), max: Math.round(s[s.length - 1]!) }];
      }),
    );
    console.log(`SMOKE_LATENCY ${JSON.stringify(summary)}`);
    expect(Object.keys(summary).length).toBeGreaterThan(0);
  });
});
