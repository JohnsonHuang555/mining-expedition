/**
 * 瀏覽器端 Supabase client（只使用 anon / publishable key；Service Role Key 絕不出現在 Client）。
 * Session 由 supabase-js 保存在 localStorage，並在到期前自動更新（autoRefreshToken）。
 */

import { type SupabaseClient, createClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

export function publicSupabaseEnv(): { url: string; anonKey: string } | null {
  // 必須以完整名稱存取，Next.js 才會在 build 時內嵌
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return url && anonKey ? { url, anonKey } : null;
}

export function getSupabase(): SupabaseClient | null {
  if (client) return client;
  const env = publicSupabaseEnv();
  if (!env) return null;
  client = createClient(env.url, env.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  return client;
}
