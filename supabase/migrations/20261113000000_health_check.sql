-- Phase 1：健康檢查用的 Database Function。不含任何遊戲資料。
--
-- health_ping：回傳固定的 {"pong": true}，不回傳版本、時間或任何內部資訊。
--   Web 與 Edge Function 都以 anon key 經 PostgREST 呼叫，**不需要 service role**。
--
-- Supabase 預設會把 public schema 新函式的 EXECUTE 權限給 anon / authenticated，
-- 這裡先 revoke 再明確 grant（TECHNICAL_SPEC §11）。
--
-- 註：這個 migration 尚未發布到任何環境（PR #2 審查中），所以直接修改；
-- 發布後的 migration 只能新增，不能改寫（TECHNICAL_SPEC §13）。

create or replace function public.health_ping()
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $$
  select '{"pong": true}'::jsonb;
$$;

revoke all on function public.health_ping() from public;
grant execute on function public.health_ping() to anon, authenticated, service_role;
