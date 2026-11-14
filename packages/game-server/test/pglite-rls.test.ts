/**
 * RLS 與權限（PGlite 以 set role 模擬 PostgREST 的 anon / authenticated / service_role）。
 * CI 另外在真正的 Supabase Local 經由 PostgREST 驗證（tests/integration/rls.test.ts）。
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createCharacter } from "../src/index.ts";
import { type PgliteSupabase, startPgliteSupabase } from "./support/pglite-supabase.ts";

let env: PgliteSupabase;
const A = randomUUID();
const B = randomUUID();
beforeAll(async () => {
  env = await startPgliteSupabase();
  for (const id of [A, B]) {
    await env.createAuthUser(id);
    await createCharacter(env.db, id);
  }
}, 60_000);

const denied = /permission denied/;

describe("RLS 與權限", () => {
  it("anon 讀不到任何玩家資料", async () => {
    await expect(env.asRole("anon", null, "select * from public.players")).rejects.toThrow(denied);
    await expect(env.asRole("anon", null, "select * from public.player_inventory")).rejects.toThrow(denied);
  });

  it("authenticated 只讀得到自己的資料", async () => {
    for (const t of ["players", "player_pickaxes", "first_treasure"]) {
      const col = t === "players" ? "id" : "player_id";
      const rows = await env.asRole<{ pid: string }>("authenticated", A, `select ${col}::text as pid from public.${t}`);
      expect(rows.map((r) => r.pid)).toEqual([A]);
    }
    expect(await env.asRole("authenticated", A, "select * from public.players where id = $1", [B])).toEqual([]);
  });

  it("Client 不能修改金幣、物品、深度、裝備、報告", async () => {
    await expect(env.asRole("authenticated", A, "update public.players set coins = 999999 where id = $1", [A])).rejects.toThrow(denied);
    await expect(env.asRole("authenticated", A, "update public.players set frontier_block_index = 3000 where id = $1", [A])).rejects.toThrow(denied);
    await expect(env.asRole("authenticated", A, "insert into public.player_inventory values ($1, 'ruby', 100)", [A])).rejects.toThrow(denied);
    await expect(env.asRole("authenticated", A, "update public.player_pickaxes set level = 5 where player_id = $1", [A])).rejects.toThrow(denied);
    await expect(env.asRole("authenticated", A, "delete from public.offline_reports where player_id = $1", [A])).rejects.toThrow(denied);
    await expect(env.asRole("authenticated", A, "insert into public.market_prices values (current_date, 'a_z1_map', 1500000)")).rejects.toThrow(denied);
  });

  it("Client 讀不到 RNG 密鑰與操作紀錄", async () => {
    await expect(env.asRole("authenticated", A, "select * from private.player_secrets")).rejects.toThrow(denied);
    await expect(env.asRole("authenticated", A, "select * from public.action_log")).rejects.toThrow(denied);
    // service_role 也不能直接讀密鑰資料表（只經由 game_load_snapshot）
    await expect(env.asRole("service_role", null, "select * from private.player_secrets")).rejects.toThrow(denied);
  });

  it("anon / authenticated 不能呼叫特權 RPC", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(env.asRole(role, A, "select public.game_load_snapshot($1, null, null)", [A])).rejects.toThrow(denied);
      await expect(env.asRole(role, A, "select public.game_create_player($1, '{}'::jsonb)", [A])).rejects.toThrow(denied);
      await expect(
        env.asRole(role, A, "select public.game_commit($1, 0, gen_random_uuid(), repeat('0', 64), 'x', null, null, null, '{}'::jsonb)", [A]),
      ).rejects.toThrow(denied);
      await expect(env.asRole(role, A, "select private.player_state_json($1)", [A])).rejects.toThrow(denied);
    }
  });

  it("service_role 可以呼叫 RPC；authenticated 可以讀市場價格", async () => {
    const r = await env.asRole<{ r: { status: string } }>("service_role", null, "select public.game_load_snapshot($1, null, null) as r", [A]);
    expect(r[0]!.r.status).toBe("ok");
    expect(await env.asRole("authenticated", A, "select * from public.market_prices")).toEqual([]);
  });
});
