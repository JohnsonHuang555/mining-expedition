/**
 * 環境變數（TECHNICAL_SPEC §15）。
 *
 * | 變數 | 本地（Docker） | 正式（Vercel） |
 * |---|---|---|
 * | NEXT_PUBLIC_SUPABASE_URL | http://127.0.0.1:54321（瀏覽器用） | https://<ref>.supabase.co |
 * | NEXT_PUBLIC_SUPABASE_ANON_KEY | `pnpm env:sync` 從 supabase status 產生 | Supabase Cloud 的 publishable / anon key |
 * | SUPABASE_INTERNAL_URL | http://supabase_kong_mining-expedition:8000（web 容器經 Supabase 的 Docker 網路） | 不設定，改用 NEXT_PUBLIC_SUPABASE_URL |
 */

export interface SupabaseEnv {
  /** 瀏覽器使用的 URL */
  publicUrl: string;
  /** Next.js 伺服器端使用的 URL（容器內與瀏覽器看到的位址不同） */
  serverUrl: string;
  anonKey: string;
}

export function readSupabaseEnv(): SupabaseEnv | { missing: string[] } {
  const publicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const missing: string[] = [];
  if (!publicUrl) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!anonKey) missing.push("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  if (!publicUrl || !anonKey) return { missing };
  const serverUrl = process.env.SUPABASE_INTERNAL_URL || publicUrl;
  return { publicUrl, serverUrl, anonKey };
}
