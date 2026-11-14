/** 真正的 Supabase Local backend：RPC 經由 PostgREST（service_role），使用者經由 Auth admin API，檢查用 postgres 連線 */
import { randomUUID } from "node:crypto";
import { supabaseGameDb } from "@mining/game-server";
import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import pg from "pg";
import type { Backend } from "../../../packages/game-server/test/scenarios.ts";
import { supabaseEnv } from "./env.ts";

export const env = supabaseEnv();
const opts = { auth: { persistSession: false, autoRefreshToken: false } };

export const service: SupabaseClient = createClient(env.apiUrl, env.serviceRoleKey, opts);
export const anon: SupabaseClient = createClient(env.apiUrl, env.anonKey, opts);
export const pool = new pg.Pool({ connectionString: env.dbUrl, max: 8 });

export const PASSWORD = "integration-test-password";

export async function createUser(): Promise<{ id: string; email: string }> {
  const email = `it-${randomUUID()}@example.test`;
  const { data, error } = await service.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  return { id: data.user.id, email };
}

/** 以使用者身分登入（取得真正的 JWT），回傳只帶 anon key + 使用者 session 的 client */
export async function signIn(email: string): Promise<{ client: SupabaseClient; accessToken: string }> {
  const client = createClient(env.apiUrl, env.anonKey, opts);
  const { data, error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session) throw new Error(`signIn: ${error?.message}`);
  return { client, accessToken: data.session.access_token };
}

export const realBackend: Backend = {
  name: "supabase-local",
  db: supabaseGameDb(service),
  concurrent: true,
  newUser: async () => (await createUser()).id,
  sql: async (q, p) => (await pool.query(q, p)).rows,
};
