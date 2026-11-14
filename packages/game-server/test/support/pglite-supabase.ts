/**
 * 本機快速測試用：以 PGlite（WASM PostgreSQL）模擬 Supabase 的角色、auth schema 與 default privileges，
 * 再套用 supabase/migrations 的真實 migration。
 *
 * 只用於開發時快速驗證 SQL 與 RPC 邏輯。PGlite 是單一連線（無法測並行）、版本為 PG18；
 * 正式的驗證是 CI 中真正啟動的 Supabase Local（tests/integration）。
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import type { CommitArgs, CommitResult, CreateResult, GameDb, LoadResult } from "../../src/index.ts";
import { GameDbError } from "../../src/index.ts";

const MIGRATIONS = resolve(import.meta.dirname, "../../../../supabase/migrations");

const BOOTSTRAP = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
create schema extensions;
create extension pgcrypto schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

export interface PgliteSupabase {
  pg: PGlite;
  db: GameDb;
  createAuthUser(id: string): Promise<void>;
  /** 以指定角色（與 JWT sub）執行 SQL，模擬 PostgREST */
  asRole<T = Record<string, unknown>>(role: "anon" | "authenticated" | "service_role", sub: string | null, sql: string, params?: unknown[]): Promise<T[]>;
}

export async function startPgliteSupabase(): Promise<PgliteSupabase> {
  const pg = new PGlite({ extensions: { pgcrypto } });
  await pg.exec(BOOTSTRAP);
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(resolve(MIGRATIONS, f), "utf8"));
  }

  async function asRole<T>(role: string, sub: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
    return pg.transaction(async (tx) => {
      await tx.exec(`set local role ${role}`);
      await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [sub ?? ""]);
      return (await tx.query<T>(sql, params)).rows;
    });
  }

  async function rpc<T>(fn: string, sql: string, params: unknown[]): Promise<T> {
    try {
      const rows = await asRole<{ r: T }>("service_role", null, `select public.${fn}(${sql}) as r`, params);
      return rows[0]!.r;
    } catch (e) {
      throw new GameDbError(`${fn}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const j = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));
  const db: GameDb = {
    createPlayer: (playerId, state) => rpc<CreateResult>("game_create_player", "$1::uuid, $2::jsonb", [playerId, j(state)]),
    loadSnapshot: (playerId, key, hash) => rpc<LoadResult>("game_load_snapshot", "$1::uuid, $2::uuid, $3::text", [playerId, key, hash]),
    commit: (a: CommitArgs) =>
      rpc<CommitResult>(
        "game_commit",
        "$1::uuid, $2::bigint, $3::uuid, $4::text, $5::text, $6::jsonb, $7::jsonb, $8::text, $9::jsonb",
        [a.playerId, a.expectedVersion, a.idempotencyKey, a.requestHash, a.command, j(a.state), j(a.reportCreated), a.reportClaimed, j(a.response)],
      ),
  };

  return {
    pg,
    db,
    createAuthUser: async (id) => void (await pg.query("insert into auth.users (id) values ($1)", [id])),
    asRole: asRole as PgliteSupabase["asRole"],
  };
}
