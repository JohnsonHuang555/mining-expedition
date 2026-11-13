-- Phase 1：連線檢查用的 Database Function。不含任何遊戲資料。
--
-- health_check：只給 service_role（Edge Function 使用），回傳伺服器時間與 Postgres 版本。
-- health_ping ：給 anon / authenticated（Web 經 PostgREST 呼叫），只回傳 pong 與伺服器時間。
--
-- Supabase 預設會把 public schema 新函式的 EXECUTE 權限給 anon / authenticated，
-- 所以先 revoke 再明確 grant（TECHNICAL_SPEC §11：客戶端只能用明確開放的函式）。

create or replace function public.health_check()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'ok', true,
    'server_now', now(),
    'postgres', current_setting('server_version')
  );
$$;

revoke all on function public.health_check() from public, anon, authenticated;
grant execute on function public.health_check() to service_role;

create or replace function public.health_ping()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object('pong', true, 'server_now', now());
$$;

revoke all on function public.health_ping() from public;
grant execute on function public.health_ping() to anon, authenticated, service_role;
