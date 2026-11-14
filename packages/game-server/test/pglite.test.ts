/**
 * 本機快速整合測試：PGlite + 真實 migration（單一連線，不含並行情境）。
 * CI 另外在真正的 Supabase Local 上執行同一組情境（tests/integration）。
 */
import { randomUUID } from "node:crypto";
import { beforeAll } from "vitest";
import { type Backend, defineScenarios } from "./scenarios.ts";
import { type PgliteSupabase, startPgliteSupabase } from "./support/pglite-supabase.ts";

let env: PgliteSupabase;
let backend: Backend;
beforeAll(async () => {
  env = await startPgliteSupabase();
  backend = {
    name: "pglite",
    db: env.db,
    concurrent: false,
    newUser: async () => {
      const id = randomUUID();
      await env.createAuthUser(id);
      return id;
    },
    sql: async (q, p) => (await env.pg.query(q, p)).rows as never,
  };
}, 60_000);

function pglite(): Backend {
  return backend ?? ({ name: "pglite", concurrent: false } as Backend);
}
defineScenarios(pglite);
