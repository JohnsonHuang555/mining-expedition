/**
 * 市場（PGlite + 真實 migration）：SQL 產生器與引擎參考實作逐位元一致、冪等、只新增、權限、出售流程。
 * 並行與 pg_cron 由 CI 的 Supabase Local 驗證（tests/integration/market.test.ts）。
 */
import { randomUUID } from "node:crypto";
import { ARTIFACTS, ARTIFACT_IDS, type ArtifactId } from "@mining/game-data";
import { addMarketDays, artifactSalePrice, marketMultiplierFor } from "@mining/game-engine";
import { beforeAll, describe, expect, it } from "vitest";
import { type ApiResponse, createCharacter, handleGameRequest, readState } from "../src/index.ts";
import { type PgliteSupabase, startPgliteSupabase } from "./support/pglite-supabase.ts";

const denied = /permission denied/;

async function secretOf(env: PgliteSupabase): Promise<Uint8Array> {
  const r = await env.pg.query<{ s: Uint8Array }>("select secret as s from private.market_secret");
  return new Uint8Array(r.rows[0]!.s);
}
async function pricesOn(env: PgliteSupabase, date: string): Promise<Record<string, number>> {
  const r = await env.pg.query<{ a: string; m: number }>("select artifact_id as a, multiplier_ppm as m from public.market_prices where price_date = $1::date", [date]);
  return Object.fromEntries(r.rows.map((x) => [x.a, x.m]));
}
const ensure = async (env: PgliteSupabase, date: string) =>
  (await env.pg.query<{ n: number }>("select private.market_ensure($1::date) as n", [date])).rows[0]!.n;

async function giveArtifact(env: PgliteSupabase, playerId: string, artifactId: ArtifactId, dig: number) {
  await env.pg.query("update public.players set dig_counter = greatest(dig_counter, $2 + 1) where id = $1", [playerId, dig]);
  await env.pg.query(
    "insert into public.artifact_instances (player_id, instance_id, artifact_id, obtained_at_ms, mode, band, frontier_block_index, dig_counter, source) values ($1, $2, $3, 0, 'frontier', 0, 0, $4, 'drop')",
    [playerId, `d${dig}`, artifactId, dig],
  );
  await env.pg.query("insert into public.artifact_discoveries values ($1, $2, 0, 0, 1) on conflict (player_id, artifact_id) do update set total_found = public.artifact_discoveries.total_found + 1", [playerId, artifactId]);
}

describe("每日價格產生（SQL）", () => {
  let env: PgliteSupabase;
  beforeAll(async () => {
    env = await startPgliteSupabase();
  }, 60_000);

  it("與引擎參考實作逐日一致（第一天以 1.0 起算、之後遞推；補齊中間缺少的日期）", async () => {
    const secret = await secretOf(env);
    expect(await ensure(env, "2031-01-01")).toBe(12); // 第一個市場日
    expect(await ensure(env, "2031-03-01")).toBe(12 * 59); // 跳過的日期全部補齊
    for (const id of ARTIFACT_IDS) {
      let m = 1_000_000;
      for (let d = "2031-01-01"; d <= "2031-03-01"; d = addMarketDays(d, 1)) {
        m = marketMultiplierFor(secret, d, id, m);
        const row = (await env.pg.query<{ m: number }>("select multiplier_ppm as m from public.market_prices where price_date = $1::date and artifact_id = $2", [d, id])).rows[0];
        expect(row?.m, `${id} ${d}`).toBe(m);
      }
    }
  });

  it("同一市場日重複產生：不新增、不改變", async () => {
    const before = await pricesOn(env, "2031-03-01");
    expect(await ensure(env, "2031-03-01")).toBe(0);
    expect(await ensure(env, "2031-02-15")).toBe(0);
    expect(await pricesOn(env, "2031-03-01")).toEqual(before);
  });

  it("只缺部分寶物時只補缺少的；既有的不覆蓋", async () => {
    await env.pg.query("insert into public.market_prices values ('2031-03-02', 'a_z1_map', 1234567)");
    expect(await ensure(env, "2031-03-02")).toBe(11);
    expect((await pricesOn(env, "2031-03-02")).a_z1_map).toBe(1_234_567);
  });

  it("已產生的價格不可修改或刪除（連 postgres 也不行）", async () => {
    await expect(env.pg.query("update public.market_prices set multiplier_ppm = 1000000 where price_date = '2031-03-01'")).rejects.toThrow(/immutable/);
    await expect(env.pg.query("delete from public.market_prices where price_date = '2031-03-01'")).rejects.toThrow(/immutable/);
    await expect(env.pg.query("insert into public.market_prices values ('2031-03-01', 'a_z1_map', 1000000)")).rejects.toThrow(/duplicate key/);
  });

  it("任何 API 角色都不能產生價格、讀密鑰、寫價格（包含 service_role）", async () => {
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      await expect(env.asRole(role, null, "select private.market_ensure(current_date)")).rejects.toThrow(denied);
      await expect(env.asRole(role, null, "select private.market_quote(now())")).rejects.toThrow(denied);
      await expect(env.asRole(role, null, "select * from private.market_secret")).rejects.toThrow(denied);
    }
    for (const role of ["anon", "authenticated"] as const) {
      await expect(env.asRole(role, null, "insert into public.market_prices values ('2040-01-01', 'a_z1_map', 1000000)")).rejects.toThrow(denied);
    }
    await expect(env.asRole("anon", null, "select * from public.market_prices")).rejects.toThrow(denied);
  });
});

describe("出售寶物（handler + SQL）", () => {
  let env: PgliteSupabase;
  const P = randomUUID();
  beforeAll(async () => {
    env = await startPgliteSupabase();
    await env.createAuthUser(P);
    await createCharacter(env.db, P);
  }, 60_000);

  it("game-state 提供市場日、下一次刷新、當日倍率（含歷史欄位）", async () => {
    const r = await readState(env.db, P);
    if (!r.ok) throw new Error(r.error.code);
    expect(r.market!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(r.market!.multipliersPpm).sort()).toEqual([...ARTIFACT_IDS].sort());
    expect(r.market!.nextRefreshAt).toBe(Date.parse(`${addMarketDays(r.market!.date, 1)}T00:00:00+08:00`));
    expect(Array.isArray(r.market!.history)).toBe(true);
  });

  it("成交價由伺服器以當日倍率計算；Replay 只入帳一次；不可重複出售；圖鑑保留", async () => {
    await giveArtifact(env, P, "a_z1_badge", 5);
    await giveArtifact(env, P, "a_z1_badge", 6);
    const q = (await readState(env.db, P)) as Extract<ApiResponse, { ok: true }>;
    const coins0 = q.state.state.coins;
    const key = randomUUID();
    const command = { type: "sell_artifacts", instanceIds: ["d5"], marketDate: q.market!.date };
    const r1 = await handleGameRequest(env.db, { playerId: P, requestId: key, command });
    if (!r1.response.ok) throw new Error(r1.response.error.code);
    const price = artifactSalePrice("a_z1_badge", q.market!.multipliersPpm.a_z1_badge!);
    expect(r1.response.events).toContainEqual({ type: "artifacts_sold", instanceIds: ["d5"], coins: price });
    expect(r1.response.state.state.coins - coins0).toBeGreaterThanOrEqual(price);
    expect(r1.response.market!.date).toBe(q.market!.date);
    // 同一個 key：保存的回應，不再入帳
    const r2 = await handleGameRequest(env.db, { playerId: P, requestId: key, command });
    expect(r2.replayed).toBe(true);
    expect(r2.response).toEqual(r1.response);
    // 同一實例再賣一次（新 key）：拒絕
    const r3 = await handleGameRequest(env.db, { playerId: P, requestId: randomUUID(), command });
    expect(r3.response.ok ? "OK" : r3.response.error.code).toBe("INSUFFICIENT_ITEMS");
    const db = await env.pg.query<{ status: string }>("select status from public.artifact_instances where player_id = $1 and instance_id = 'd5'", [P]);
    expect(db.rows[0]!.status).toBe("sold");
    const disc = await env.pg.query("select 1 from public.artifact_discoveries where player_id = $1 and artifact_id = 'a_z1_badge'", [P]);
    expect(disc.rows).toHaveLength(1);
    expect(ARTIFACTS.a_z1_badge.baseValue).toBeGreaterThan(0);
  });

  it("報價市場日不是今天：MARKET_QUOTE_EXPIRED（不出售、回應附上新報價；保存，同一 key 重送結果相同）", async () => {
    const key = randomUUID();
    const command = { type: "sell_artifacts", instanceIds: ["d6"], marketDate: "2000-01-01" };
    const r = await handleGameRequest(env.db, { playerId: P, requestId: key, command });
    expect(r.response.ok ? "OK" : r.response.error.code).toBe("MARKET_QUOTE_EXPIRED");
    expect(r.response.market!.date).not.toBe("2000-01-01");
    expect(r.response.state!.state.heldArtifacts.map((a) => a.instanceId)).toContain("d6");
    const again = await handleGameRequest(env.db, { playerId: P, requestId: key, command });
    expect(again.replayed).toBe(true);
  });

  it("Client 不能提交價格或倍率", async () => {
    const r = await handleGameRequest(env.db, { playerId: P, requestId: randomUUID(), command: { type: "sell_artifacts", instanceIds: ["d6"], marketDate: "2031-01-01", priceCoins: 999999 } });
    expect(r.response.ok ? "OK" : r.response.error.code).toBe("INVALID_REQUEST");
  });
});

describe("當日價格無法產生（密鑰遺失）", () => {
  let env: PgliteSupabase;
  const P = randomUUID();
  beforeAll(async () => {
    env = await startPgliteSupabase();
    await env.pg.query("alter table public.market_prices disable trigger market_prices_immutable");
    await env.pg.query("delete from private.market_secret");
    await env.createAuthUser(P);
    await createCharacter(env.db, P);
    await giveArtifact(env, P, "a_z1_map", 3);
  }, 60_000);

  it("其他操作照常；出售回傳 MARKET_UNAVAILABLE（不保存、不使用備用倍率）；恢復後同一個 key 成功", async () => {
    const settle = await handleGameRequest(env.db, { playerId: P, requestId: randomUUID(), command: { type: "settle" } });
    expect(settle.response.ok).toBe(true);
    if (!settle.response.ok) return;
    expect(settle.response.market!.multipliersPpm).toEqual({});
    const key = randomUUID();
    const command = { type: "sell_artifacts", instanceIds: ["d3"], marketDate: settle.response.market!.date };
    const r = await handleGameRequest(env.db, { playerId: P, requestId: key, command });
    expect(r.response.ok ? "OK" : r.response.error.code).toBe("MARKET_UNAVAILABLE");
    expect(r.stored).toBe(false);
    expect((await env.pg.query("select 1 from public.action_log where idempotency_key = $1", [key])).rows).toHaveLength(0);
    // 恢復（排程 / 下一次請求重試）
    await env.pg.query("insert into private.market_secret (secret) values (extensions.gen_random_bytes(32))");
    const ok = await handleGameRequest(env.db, { playerId: P, requestId: key, command });
    expect(ok.response.ok).toBe(true);
  });
});
