-- =============================================================================
-- Cloud 資料庫驗證（唯讀；任何一項不符合就 raise exception（執行失敗並列出問題））
-- 用法：pnpm cloud verify（或貼到 Supabase Dashboard → SQL Editor 執行；沒有錯誤 = 通過）
-- 不輸出任何密鑰內容（只檢查是否存在）。不寫入任何資料。
-- =============================================================================

begin read only;

do $verify$
declare
  r record;
  n integer;
  problems text[] := '{}';
begin
  -- 1. 必要的資料表存在且啟用 RLS
  for r in select unnest(array[
      'public.players', 'public.player_pickaxes', 'public.player_inventory', 'public.artifact_instances',
      'public.artifact_discoveries', 'public.first_treasure', 'public.offline_reports', 'public.action_log',
      'public.market_prices', 'private.player_secrets', 'private.market_secret', 'private.rate_limits']) as t loop
    select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
      where s.nspname || '.' || c.relname = r.t and c.relkind = 'r' and c.relrowsecurity;
    if n <> 1 then problems := problems || format('table %s missing or RLS disabled', r.t); end if;
  end loop;

  -- 2. Client 角色沒有任何寫入權限
  for r in select s.nspname || '.' || c.relname as t from pg_class c join pg_namespace s on s.oid = c.relnamespace
      where s.nspname in ('public', 'private') and c.relkind = 'r' loop
    if has_table_privilege('anon', r.t, 'INSERT,UPDATE,DELETE,TRUNCATE') or has_table_privilege('authenticated', r.t, 'INSERT,UPDATE,DELETE,TRUNCATE') then
      problems := problems || format('client role can write %s', r.t);
    end if;
  end loop;

  -- 3. 函式：search_path 固定；SECURITY DEFINER 不給 anon / authenticated；private 連 service_role 都不能；game_* 只給 service_role
  for r in select n.nspname as schema, p.proname as name, p.oid, p.prosecdef as definer, p.proconfig as config, p.prokind as kind
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private') loop
    if r.kind = 'f' and not coalesce('search_path=""' = any(r.config), false) then
      problems := problems || format('%s.%s has no fixed search_path', r.schema, r.name);
    end if;
    if (r.definer or r.name like 'game\_%') and (has_function_privilege('anon', r.oid, 'execute') or has_function_privilege('authenticated', r.oid, 'execute')) then
      problems := problems || format('%s.%s is executable by a client role', r.schema, r.name);
    end if;
    if r.schema = 'private' and has_function_privilege('service_role', r.oid, 'execute') then
      problems := problems || format('private.%s is executable by service_role', r.name);
    end if;
    if r.schema = 'public' and r.name like 'game\_%' and not has_function_privilege('service_role', r.oid, 'execute') then
      problems := problems || format('public.%s is not executable by service_role', r.name);
    end if;
  end loop;

  -- 4. 密鑰存在（不讀取內容）
  select count(*) into n from private.market_secret;
  if n <> 1 then problems := problems || 'private.market_secret must have exactly one row'::text; end if;

  -- 5. 索引
  for r in select unnest(array['action_log_settle_created_at', 'action_log_uncompacted_created_at']) as i loop
    if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = r.i) then
      problems := problems || format('index %s missing', r.i);
    end if;
  end loop;

  -- 6. pg_cron 與排程
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    problems := problems || 'pg_cron extension is not installed'::text;
  else
    if not exists (select 1 from cron.job where jobname = 'market-daily-prices' and active and schedule = '1 16 * * *'
                   and command = 'select private.market_ensure(private.market_date(now()))') then
      problems := problems || 'cron job market-daily-prices missing, inactive or changed'::text;
    end if;
    if not exists (select 1 from cron.job where jobname = 'action-log-compact' and active and schedule = '17 * * * *'
                   and command = 'call private.action_log_drain(interval ''30 days'')') then
      problems := problems || 'cron job action-log-compact missing, inactive or changed'::text;
    end if;
  end if;

  if array_length(problems, 1) > 0 then
    raise exception 'cloud verification failed: %', array_to_string(problems, '; ');
  end if;
  raise notice 'cloud verification passed';
end $verify$;

-- 摘要（非密鑰）
select (select count(*) from supabase_migrations.schema_migrations) as migrations_applied,
       (select max(version) from supabase_migrations.schema_migrations) as latest_migration,
       (select count(*) from public.market_prices where price_date = private.market_date(now())) as market_today_rows;

rollback;
