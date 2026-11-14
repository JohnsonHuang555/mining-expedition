/** 與 packages/game-server/test/pglite.test.ts 相同的情境，在真正的 Supabase Local（PostgREST + PostgreSQL 17）上執行，含並行 */
import { afterAll } from "vitest";
import { defineScenarios } from "../../packages/game-server/test/scenarios.ts";
import { pool, realBackend } from "./src/backend.ts";

afterAll(async () => pool.end());
defineScenarios(function supabaseLocal() {
  return realBackend;
});
