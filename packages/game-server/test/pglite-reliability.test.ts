/**
 * PR #15：rate limit、action_log 分層保存（compaction）、過期 Request ID、作廢探詢、權限稽核（PGlite + 真實 migration）。
 * 並行、Edge Functions 與 HTTP 標頭由 CI 的 Supabase Local 驗證（tests/integration/reliability.test.ts）。
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_RATE_LIMITS, createCharacter, handleGameRequest, readState } from "../src/index.ts";
import { type PgliteSupabase, startPgliteSupabase } from "./support/pglite-supabase.ts";

let env: PgliteSupabase;
beforeAll(async () => {
  env = await startPgliteSupabase();
}, 60_000);

async function player(stone = 0): Promise<string> {
  const id = randomUUID();
  await env.createAuthUser(id);
  await createCharacter(env.db, id);
  if (stone > 0) await env.pg.query("insert into public.player_inventory values ($1, 'stone', $2)", [id, stone]);
  return id;
}
const sell = (n = 1) => ({ type: "sell_items", itemId: "stone", quantity: n });
const stoneOf = async (id: string) => Number((await env.pg.query<{ q: number }>("select quantity as q from public.player_inventory where player_id = $1 and item_id = 'stone'", [id])).rows[0]?.q ?? 0);
const compact = (id: string) => env.pg.query("select private.action_log_compact(interval '0 seconds', $1::uuid)", [id]);

describe("Rate limit（資料庫計數）", () => {
  const rate = { bucket: "game-action" as const, limit: 3, windowMs: 60_000 };

  it("視窗內超過上限 → RATE_LIMITED（未執行、未保存）；重送已處理的 key 不受限", async () => {
    const id = await player(100);
    const keys = [randomUUID(), randomUUID(), randomUUID()];
    for (const k of keys) expect((await handleGameRequest(env.db, { playerId: id, requestId: k, command: sell() }, { rateLimit: rate })).response.ok).toBe(true);
    const over = await handleGameRequest(env.db, { playerId: id, requestId: randomUUID(), command: sell() }, { rateLimit: rate });
    expect(over.response.ok ? "OK" : over.response.error.code).toBe("RATE_LIMITED");
    expect(!over.response.ok && over.response.retryAfterMs).toBeGreaterThan(0);
    expect(over.stored).toBe(false);
    expect(await stoneOf(id)).toBe(97);
    const replay = await handleGameRequest(env.db, { playerId: id, requestId: keys[0]!, command: sell() }, { rateLimit: rate });
    expect(replay.replayed).toBe(true);
    expect(await stoneOf(id)).toBe(97);
    // 每位使用者各自計數
    const other = await player(10);
    expect((await handleGameRequest(env.db, { playerId: other, requestId: randomUUID(), command: sell() }, { rateLimit: rate })).response.ok).toBe(true);
  });

  it("game-state 與 character-create 也受限；計數表每人每 bucket 只有一列", async () => {
    const id = await player();
    const r = { bucket: "game-state" as const, limit: 2, windowMs: 60_000 };
    expect((await readState(env.db, id, { rateLimit: r })).ok).toBe(true);
    expect((await readState(env.db, id, { rateLimit: r })).ok).toBe(true);
    const third = await readState(env.db, id, { rateLimit: r });
    expect(third.ok ? "OK" : third.error.code).toBe("RATE_LIMITED");
    const c = { bucket: "character-create" as const, limit: 1, windowMs: 60_000 };
    expect((await createCharacter(env.db, id, { rateLimit: c })).ok).toBe(false); // CHARACTER_EXISTS
    const limited = await createCharacter(env.db, id, { rateLimit: c });
    expect(limited.ok ? "OK" : limited.error.code).toBe("RATE_LIMITED");
    const rows = await env.pg.query("select bucket from private.rate_limits where user_id = $1 order by bucket", [id]);
    expect(rows.rows.map((x) => (x as { bucket: string }).bucket)).toEqual(["character-create", "game-state"]);
  });

  it("預設值涵蓋三個 API，且大於正常同步的需求", () => {
    expect(Object.keys(DEFAULT_RATE_LIMITS).sort()).toEqual(["character-create", "game-action", "game-state"]);
    expect(DEFAULT_RATE_LIMITS["game-action"].limit / (DEFAULT_RATE_LIMITS["game-action"].windowMs / 1000)).toBeGreaterThanOrEqual(1);
  });
});

describe("Action Log 分層保存", () => {
  it("compaction：settle 整筆刪除；交易只保留冪等識別；之後以原 key 重送 → REQUEST_EXPIRED（不重新執行）", async () => {
    const id = await player(100);
    const settleKey = randomUUID();
    const sellKey = randomUUID();
    await handleGameRequest(env.db, { playerId: id, requestId: settleKey, command: { type: "settle" } });
    const sold = await handleGameRequest(env.db, { playerId: id, requestId: sellKey, command: sell(10) });
    expect(sold.response.ok).toBe(true);
    const r = await compact(id);
    expect(r.rows[0]).toMatchObject({ action_log_compact: { deletedSettle: 1, compacted: 1 } });
    const row = (await env.pg.query("select response, response_ok, compacted_at, request_hash from public.action_log where player_id = $1", [id])).rows;
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ response: null, response_ok: true });
    // 原 key 重送：不重新執行（不會再賣 10 個）
    const again = await handleGameRequest(env.db, { playerId: id, requestId: sellKey, command: sell(10) });
    expect(again.response.ok ? "OK" : again.response.error.code).toBe("REQUEST_EXPIRED");
    expect(!again.response.ok && again.response.expired).toMatchObject({ processed: true, ok: true });
    expect(await stoneOf(id)).toBe(90);
    // 不同內容 → mismatch（request_hash 永久保留）
    const other = await handleGameRequest(env.db, { playerId: id, requestId: sellKey, command: sell(1) });
    expect(other.response.ok ? "OK" : other.response.error.code).toBe("IDEMPOTENCY_MISMATCH");
    // settle 的 key 被刪除後重送：重新結算到現在（沒有 Client 指定的效果，不會重複發放）
    expect((await handleGameRequest(env.db, { playerId: id, requestId: settleKey, command: { type: "settle" } })).response.ok).toBe(true);
  });

  it("當初被拒絕的交易壓縮後：expired.ok = false；重複壓縮不改變", async () => {
    const id = await player(5);
    const key = randomUUID();
    const r = await handleGameRequest(env.db, { playerId: id, requestId: key, command: sell(50) });
    expect(r.response.ok ? "OK" : r.response.error.code).toBe("INSUFFICIENT_ITEMS");
    await compact(id);
    await compact(id);
    const again = await handleGameRequest(env.db, { playerId: id, requestId: key, command: sell(50) });
    expect(!again.response.ok && again.response.expired).toMatchObject({ processed: true, ok: false });
  });

  it("保存期限內的紀錄不受影響；冪等識別不可被改寫；負的期限被拒絕", async () => {
    const id = await player(10);
    const key = randomUUID();
    await handleGameRequest(env.db, { playerId: id, requestId: key, command: sell() });
    await env.pg.query("select private.action_log_compact(interval '30 days', $1::uuid)", [id]);
    expect((await handleGameRequest(env.db, { playerId: id, requestId: key, command: sell() })).replayed).toBe(true);
    await expect(env.pg.query("update public.action_log set request_hash = repeat('0', 64) where player_id = $1", [id])).rejects.toThrow(/immutable/);
    await expect(env.pg.query("update public.action_log set response = '{}'::jsonb where player_id = $1", [id])).rejects.toThrow(/compacted/);
    await expect(env.pg.query("select private.action_log_compact(interval '-1 day')")).rejects.toThrow(/negative/);
  });

  it("積壓清除（Review P1）：> 5,000 筆過期 settle + > 5,000 筆過期交易 → 分批（每批 commit）清完；交易只壓縮、冪等鍵保留；有上限、下一次接續", async () => {
    const id = await player();
    const N = 6_000;
    const seed = (command: string) =>
      env.pg.query(
        `insert into public.action_log (player_id, idempotency_key, request_hash, command, committed, state_version_after, response, created_at)
         select $1::uuid, gen_random_uuid(), repeat('a', 64), $2::text, false, null, jsonb_build_object('ok', g % 2 = 0, 'command', $2::text), now() - interval '40 days'
         from generate_series(1, $3::int) g`,
        [id, command, N],
      );
    await seed("settle");
    await seed("sell_items");
    await handleGameRequest(env.db, { playerId: id, requestId: randomUUID(), command: { type: "settle" } }); // 期限內：不受影響
    const backlog = async () => (await env.pg.query<{ b: { settleToDelete: number; responsesToCompact: number; oldestPending: string | null } }>("select private.action_log_backlog() as b")).rows[0]!.b;
    expect(await backlog()).toMatchObject({ settleToDelete: N, responsesToCompact: N });
    // 有上限的一次執行：3 批 × 1,000
    await env.pg.exec("call private.action_log_drain(interval '30 days', 1000, 3)");
    expect(await backlog()).toMatchObject({ settleToDelete: N - 3_000, responsesToCompact: N - 3_000 });
    // 下一次（排程每小時）接續清完
    await env.pg.exec("call private.action_log_drain(interval '30 days', 1000, 500)");
    expect(await backlog()).toEqual({ settleToDelete: 0, responsesToCompact: 0, oldestPending: null });
    const rows = (await env.pg.query<{ command: string; n: number; compacted: number; ok: number }>(
      `select command, count(*)::int as n, count(*) filter (where response is null)::int as compacted, count(*) filter (where response_ok)::int as ok
       from public.action_log where player_id = $1 group by command order by command`, [id])).rows;
    expect(rows).toEqual([
      { command: "sell_items", n: N, compacted: N, ok: N / 2 }, // 冪等鍵全部保留，成功與否記錄正確
      { command: "settle", n: 1, compacted: 0, ok: 0 }, // 只剩期限內的那一筆（未壓縮：response 仍在，response_ok 只在壓縮時寫入）
    ]);
  });

  it("作廢探詢：未知的 key 不執行、寫下作廢紀錄；原始請求晚到也不執行；已處理的 key 回原本的結果", async () => {
    const id = await player(20);
    const key = randomUUID();
    const probe = await handleGameRequest(env.db, { playerId: id, requestId: key, command: sell(5) }, { expireIfUnknown: true });
    expect(!probe.response.ok && probe.response.expired).toEqual({ processed: false, ok: null, processedAt: null });
    expect(probe.stored).toBe(true);
    const late = await handleGameRequest(env.db, { playerId: id, requestId: key, command: sell(5) });
    expect(late.replayed).toBe(true);
    expect(late.response.ok ? "OK" : late.response.error.code).toBe("REQUEST_EXPIRED");
    expect(await stoneOf(id)).toBe(20);
    const done = randomUUID();
    await handleGameRequest(env.db, { playerId: id, requestId: done, command: sell(2) });
    const probeDone = await handleGameRequest(env.db, { playerId: id, requestId: done, command: sell(2) }, { expireIfUnknown: true });
    expect(probeDone.replayed).toBe(true);
    expect(probeDone.response.ok).toBe(true);
    expect(await stoneOf(id)).toBe(18);
  });
});

describe("Supabase 權限稽核（回歸測試）", () => {
  it("所有 public / private 函式都固定 search_path；SECURITY DEFINER 函式不可被 anon / authenticated 執行", async () => {
    const fns = (
      await env.pg.query<{ schema: string; name: string; definer: boolean; config: string[] | null; anon: boolean; authed: boolean; service: boolean }>(`
        select n.nspname as schema, p.proname as name, p.prosecdef as definer, p.proconfig as config,
               has_function_privilege('anon', p.oid, 'execute') as anon,
               has_function_privilege('authenticated', p.oid, 'execute') as authed,
               has_function_privilege('service_role', p.oid, 'execute') as service
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'private') and p.prokind = 'f'`)
    ).rows;
    expect(fns.length).toBeGreaterThan(15);
    for (const f of fns) {
      expect(f.config ?? [], `${f.schema}.${f.name} search_path`).toContain('search_path=""');
      if (f.definer) {
        expect(f.anon, `${f.schema}.${f.name} anon`).toBe(false);
        expect(f.authed, `${f.schema}.${f.name} authenticated`).toBe(false);
      }
      if (f.schema === "private") expect(f.service, `${f.schema}.${f.name} service_role`).toBe(false);
    }
    // 含 COMMIT 的 procedure 不能有 SET 子句：本體開頭必須清空 search_path，且不可被任何 API 角色執行
    const procs = (await env.pg.query<{ name: string; src: string; anon: boolean; authed: boolean; service: boolean }>(`
      select p.proname as name, p.prosrc as src,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as authed,
             has_function_privilege('service_role', p.oid, 'execute') as service
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and p.prokind = 'p'`)).rows;
    expect(procs.map((p) => p.name)).toEqual(["action_log_drain"]);
    for (const p of procs) {
      expect(p.src).toContain("set_config('search_path', '', false)");
      expect([p.anon, p.authed, p.service]).toEqual([false, false, false]);
    }
    const publicRpc = fns.filter((f) => f.schema === "public" && f.name.startsWith("game_")).map((f) => f.name).sort();
    expect(publicRpc).toEqual(["game_commit", "game_create_player", "game_load_snapshot", "game_rate_limit"]);
    for (const f of fns.filter((x) => x.schema === "public" && x.name.startsWith("game_"))) expect(f.service).toBe(true);
  });

  it("所有資料表都啟用 RLS；Client 角色沒有任何寫入權限；private 表連 service_role 都不能直接存取", async () => {
    const tables = (
      await env.pg.query<{ schema: string; name: string; rls: boolean }>(`
        select n.nspname as schema, c.relname as name, c.relrowsecurity as rls
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('public', 'private') and c.relkind = 'r'`)
    ).rows;
    for (const t of tables) {
      expect(t.rls, `${t.schema}.${t.name} RLS`).toBe(true);
      for (const role of ["anon", "authenticated"]) {
        for (const priv of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
          const r = await env.pg.query<{ ok: boolean }>(`select has_table_privilege($1, $2, $3) as ok`, [role, `${t.schema}.${t.name}`, priv]);
          expect(r.rows[0]!.ok, `${role} ${priv} ${t.schema}.${t.name}`).toBe(false);
        }
      }
      if (t.schema === "private") {
        const r = await env.pg.query<{ ok: boolean }>(`select has_table_privilege('service_role', $1, 'SELECT') as ok`, [`${t.schema}.${t.name}`]);
        expect(r.rows[0]!.ok, `service_role SELECT ${t.schema}.${t.name}`).toBe(false);
      }
    }
    expect(tables.map((t) => `${t.schema}.${t.name}`)).toEqual(expect.arrayContaining(["private.player_secrets", "private.market_secret", "private.rate_limits", "public.action_log"]));
  });

  it("migration 不使用動態 SQL（execute / format）", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const dir = resolve(import.meta.dirname, "../../../supabase/migrations");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql"))) {
      const sql = readFileSync(resolve(dir, f), "utf8").replace(/--.*$/gm, "");
      expect(/\bexecute\s+(format|'|\$|\w+\s*\|\|)/i.test(sql), f).toBe(false);
    }
  });
});
