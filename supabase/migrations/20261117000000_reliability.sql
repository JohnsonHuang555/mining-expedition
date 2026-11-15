-- =============================================================================
-- Reliability & Security Hardening（PR #15，TECHNICAL_SPEC §10.7–§10.9、docs/SECURITY_RELIABILITY.md）
--
-- 1. action_log 分層保存：
--    - 交易類指令（settle 以外）的冪等識別（player_id、idempotency_key、request_hash、command、committed、成功與否）
--      **永久保留**；超過保存期限只清掉 response 內容（compaction）。之後以同一個 key 重送 → status 'expired'
--      （附當初是否成功），**絕不重新執行**。
--    - settle 沒有 Client 指定的效果（只把時間推進到「現在」），重新執行不會重複發放：超過期限整筆刪除。
--    - 不刪除任何玩家資料；舊紀錄不需要回填（response 仍在）。
-- 2. Rate limit：每位使用者、每個 bucket 的固定視窗計數（private.rate_limits，每人每 bucket 一列）。
--    在既有的 game_load_snapshot 內執行（不增加資料庫往返）；重送（replay）與已過期的 key 在計數之前就回傳，不受限。
-- 部署順序：先套用本 migration，再部署 Edge Functions（新函式仍接受舊的三參數呼叫）。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- action_log：可壓縮的回應
-- ---------------------------------------------------------------------------

alter table public.action_log alter column response drop not null;
alter table public.action_log add column response_ok boolean;
alter table public.action_log add column compacted_at timestamptz;
alter table public.action_log add constraint action_log_response_or_compacted
  check (response is not null or (compacted_at is not null and response_ok is not null));
create index action_log_created_at on public.action_log (created_at);

-- 已保存的紀錄不可被改寫（只允許 compaction：清掉 response、記下成功與否）
create or replace function private.action_log_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.player_id is distinct from old.player_id or new.idempotency_key is distinct from old.idempotency_key
     or new.request_hash is distinct from old.request_hash or new.command is distinct from old.command
     or new.committed is distinct from old.committed or new.state_version_after is distinct from old.state_version_after
     or new.created_at is distinct from old.created_at then
    raise exception 'action_log identity is immutable' using errcode = 'P0001';
  end if;
  if new.response is not null and new.response is distinct from old.response then
    raise exception 'action_log responses can only be compacted' using errcode = 'P0001';
  end if;
  if old.response is null and (new.response_ok is distinct from old.response_ok) then
    raise exception 'compacted action_log rows are immutable' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger action_log_guard before update on public.action_log
  for each row execute function private.action_log_guard();

-- 保存期限以外的紀錄：settle 刪除；其他清掉 response（保留冪等識別）。p_player 只用於測試（null = 全部）
create or replace function private.action_log_compact(p_older_than interval, p_player uuid default null, p_batch integer default 5000)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_cutoff timestamptz := now() - p_older_than;
  v_deleted integer;
  v_compacted integer;
begin
  if p_older_than < interval '0' then
    raise exception 'retention must not be negative' using errcode = 'invalid_parameter_value';
  end if;
  delete from public.action_log l
    where l.id in (
      select x.id from public.action_log x
      where x.command = 'settle' and x.created_at < v_cutoff and (p_player is null or x.player_id = p_player)
      order by x.id limit p_batch);
  get diagnostics v_deleted = row_count;
  update public.action_log l
    set response_ok = coalesce((l.response ->> 'ok')::boolean, false), compacted_at = now(), response = null
    where l.id in (
      select x.id from public.action_log x
      where x.command <> 'settle' and x.response is not null and x.created_at < v_cutoff and (p_player is null or x.player_id = p_player)
      order by x.id limit p_batch);
  get diagnostics v_compacted = row_count;
  return jsonb_build_object('deletedSettle', v_deleted, 'compacted', v_compacted);
end $$;

-- ---------------------------------------------------------------------------
-- Rate limit
-- ---------------------------------------------------------------------------

create table private.rate_limits (
  user_id      uuid    not null,
  bucket       text    not null check (bucket in ('game-action', 'game-state', 'character-create')),
  window_start bigint  not null,
  hits         integer not null check (hits >= 1),
  primary key (user_id, bucket)
);
revoke all on table private.rate_limits from public, anon, authenticated, service_role;
alter table private.rate_limits enable row level security;

-- 計一次；回傳 0 = 允許，> 0 = 超限（還要等多少毫秒）。每位使用者每個 bucket 只有一列（不會無限成長）
create or replace function private.rate_limit_hit(p_user uuid, p_bucket text, p_limit integer, p_window_ms integer) returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_now bigint := private.now_ms();
  v_window bigint;
  v_hits integer;
begin
  if p_limit is null or p_window_ms is null or p_limit < 1 or p_window_ms < 1000 then
    raise exception 'invalid rate limit' using errcode = 'invalid_parameter_value';
  end if;
  v_window := v_now - (v_now % p_window_ms);
  insert into private.rate_limits as r (user_id, bucket, window_start, hits)
    values (p_user, p_bucket, v_window, 1)
    on conflict (user_id, bucket) do update
      set hits = case when r.window_start = excluded.window_start then r.hits + 1 else 1 end,
          window_start = excluded.window_start
    returning r.hits into v_hits;
  if v_hits > p_limit then
    return greatest(1, v_window + p_window_ms - v_now);
  end if;
  return 0;
end $$;

-- character-create 用（其他 API 在 game_load_snapshot 內計數）
create or replace function public.game_rate_limit(p_user uuid, p_bucket text, p_limit integer, p_window_ms integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_wait bigint := private.rate_limit_hit(p_user, p_bucket, p_limit, p_window_ms);
begin
  if v_wait > 0 then
    return jsonb_build_object('status', 'rate_limited', 'retryAfterMs', v_wait);
  end if;
  return jsonb_build_object('status', 'ok');
end $$;

-- ---------------------------------------------------------------------------
-- 快照：已壓縮的紀錄 → expired；rate limit（在重送判斷之後）
-- ---------------------------------------------------------------------------

drop function public.game_load_snapshot(uuid, uuid, text);

create function public.game_load_snapshot(
  p_player_id uuid,
  p_idempotency_key uuid,
  p_request_hash text,
  p_rate_bucket text default null,
  p_rate_limit integer default null,
  p_rate_window_ms integer default null
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_log record;
  v_secret bytea;
  v_wait bigint;
begin
  if p_idempotency_key is not null then
    select l.request_hash, l.response, l.response_ok, l.committed, l.created_at into v_log
      from public.action_log l where l.player_id = p_player_id and l.idempotency_key = p_idempotency_key;
    if found then
      if v_log.request_hash <> p_request_hash then
        return jsonb_build_object('status', 'mismatch');
      end if;
      if v_log.response is null then
        -- 已處理過，但詳細回應已超過保存期限：絕不重新執行
        return jsonb_build_object('status', 'expired', 'ok', v_log.response_ok, 'committed', v_log.committed,
          'processedAt', floor(extract(epoch from v_log.created_at) * 1000)::bigint);
      end if;
      return jsonb_build_object('status', 'replay', 'response', v_log.response);
    end if;
  end if;
  -- 重送不受 rate limit；新的請求才計數
  if p_rate_bucket is not null then
    v_wait := private.rate_limit_hit(p_player_id, p_rate_bucket, p_rate_limit, p_rate_window_ms);
    if v_wait > 0 then
      return jsonb_build_object('status', 'rate_limited', 'retryAfterMs', v_wait);
    end if;
  end if;
  select s.rng_secret into v_secret from private.player_secrets s where s.player_id = p_player_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  return jsonb_build_object(
    'status', 'ok',
    'state', private.player_state_json(p_player_id),
    'rngSecret', encode(v_secret, 'base64'),
    'serverNow', private.now_ms(),
    'market', private.market_quote(now()));
end $$;

-- ---------------------------------------------------------------------------
-- 提交：同一個 key 已存在且已壓縮 → expired（不重新執行）
-- ---------------------------------------------------------------------------

create or replace function public.game_commit(
  p_player_id uuid,
  p_expected_version bigint,
  p_idempotency_key uuid,
  p_request_hash text,
  p_command text,
  p_state jsonb,
  p_report_created jsonb,
  p_report_claimed text,
  p_response jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_version bigint;
  v_log record;
  v_new bigint;
  v_pending jsonb;
begin
  if p_idempotency_key is null or p_request_hash is null or p_command is null or p_response is null then
    raise exception 'idempotency key, request hash, command and response are required' using errcode = 'invalid_parameter_value';
  end if;
  if jsonb_typeof(p_state) = 'null' then p_state := null; end if;
  if jsonb_typeof(p_report_created) = 'null' then p_report_created := null; end if;

  select p.state_version into v_version from public.players p where p.id = p_player_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select l.request_hash, l.response, l.response_ok, l.committed, l.created_at into v_log
    from public.action_log l where l.player_id = p_player_id and l.idempotency_key = p_idempotency_key;
  if found then
    if v_log.request_hash <> p_request_hash then
      return jsonb_build_object('status', 'mismatch');
    end if;
    if v_log.response is null then
      return jsonb_build_object('status', 'expired', 'ok', v_log.response_ok, 'committed', v_log.committed,
        'processedAt', floor(extract(epoch from v_log.created_at) * 1000)::bigint);
    end if;
    return jsonb_build_object('status', 'replay', 'response', v_log.response);
  end if;

  if v_version <> p_expected_version then
    return jsonb_build_object('status', 'version_conflict', 'stateVersion', v_version);
  end if;

  if p_state is null then
    if p_report_created is not null or p_report_claimed is not null then
      raise exception 'report changes require a state' using errcode = 'invalid_parameter_value';
    end if;
    insert into public.action_log (player_id, idempotency_key, request_hash, command, committed, state_version_after, response)
      values (p_player_id, p_idempotency_key, p_request_hash, p_command, false, null, p_response);
    return jsonb_build_object('status', 'recorded', 'stateVersion', v_version);
  end if;

  v_new := p_expected_version + 1;
  if (p_state ->> 'stateVersion')::bigint is distinct from v_new then
    raise exception 'state.stateVersion must be expected + 1' using errcode = 'check_violation';
  end if;
  if p_state ->> 'playerId' is distinct from p_player_id::text then
    raise exception 'state.playerId does not match' using errcode = 'check_violation';
  end if;

  perform private.write_player_state(p_player_id, p_state);

  if p_report_claimed is not null then
    update public.offline_reports r set status = 'claimed', claimed_at = now(), claimed_at_ms = (p_state ->> 'lastSettledAt')::bigint
      where r.player_id = p_player_id and r.report_id = p_report_claimed and r.status = 'pending';
    if not found then
      raise exception 'report % is not pending', p_report_claimed using errcode = 'check_violation';
    end if;
    update public.artifact_instances a set source_report_id = p_report_claimed
      where a.player_id = p_player_id and a.source_report_id is null
        and a.instance_id in (
          select x ->> 'instanceId'
          from public.offline_reports r, jsonb_array_elements(r.report #> '{rewards,artifacts}') x
          where r.player_id = p_player_id and r.report_id = p_report_claimed);
  end if;

  if p_report_created is not null then
    if p_report_created is distinct from p_state -> 'pendingOfflineReport' then
      raise exception 'created report must equal state.pendingOfflineReport' using errcode = 'check_violation';
    end if;
    insert into public.offline_reports (player_id, report_id, status, period_start_ms, period_end_ms, blocks_mined, coins, report)
      values (p_player_id, p_report_created ->> 'reportId', 'pending', (p_report_created ->> 'periodStart')::bigint,
              (p_report_created ->> 'periodEnd')::bigint, (p_report_created ->> 'blocksMined')::bigint,
              (p_report_created #>> '{rewards,coins}')::bigint, p_report_created);
  end if;

  v_pending := p_state -> 'pendingOfflineReport';
  if jsonb_typeof(v_pending) = 'object' then
    if not exists (select 1 from public.offline_reports r where r.player_id = p_player_id and r.status = 'pending' and r.report = v_pending) then
      raise exception 'state.pendingOfflineReport does not match the pending report' using errcode = 'check_violation';
    end if;
  elsif exists (select 1 from public.offline_reports r where r.player_id = p_player_id and r.status = 'pending') then
    raise exception 'a pending report exists but the state has none' using errcode = 'check_violation';
  end if;

  insert into public.action_log (player_id, idempotency_key, request_hash, command, committed, state_version_after, response)
    values (p_player_id, p_idempotency_key, p_request_hash, p_command, true, v_new, p_response);

  return jsonb_build_object('status', 'committed', 'stateVersion', v_new);
end $$;

-- ---------------------------------------------------------------------------
-- 權限
-- ---------------------------------------------------------------------------

revoke all on function private.action_log_guard() from public, anon, authenticated, service_role;
revoke all on function private.action_log_compact(interval, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function private.rate_limit_hit(uuid, text, integer, integer) from public, anon, authenticated, service_role;

revoke all on function public.game_rate_limit(uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.game_rate_limit(uuid, text, integer, integer) to service_role;
revoke all on function public.game_load_snapshot(uuid, uuid, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.game_load_snapshot(uuid, uuid, text, text, integer, integer) to service_role;
revoke all on function public.game_commit(uuid, bigint, uuid, text, text, jsonb, jsonb, text, jsonb) from public, anon, authenticated;
grant execute on function public.game_commit(uuid, bigint, uuid, text, text, jsonb, jsonb, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 每週壓縮（pg_cron；有安裝才排程）：保存 30 天。台灣時間週一 03:17（UTC 週日 19:17）
-- ---------------------------------------------------------------------------

do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('action-log-compact', '17 19 * * 0', $job$select private.action_log_compact(interval '30 days')$job$);
  end if;
end $cron$;
