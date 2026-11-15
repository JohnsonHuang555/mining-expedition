-- =============================================================================
-- 寶物市場：每日倍率的產生與保存（GBS §13、TECHNICAL_SPEC §6.3 / §9）
--
-- - 市場日：Asia/Taipei（固定 UTC+8）00:00 更新（GBS §13，提案 P24–P26）。
-- - 每件寶物各自逐日遞推：m(today) = clamp(m(yesterday) + floor(0.35 × (1 − m(yesterday))) + ε, Min, Max)，
--   ε = (u mod (2·Step + 1)) − Step，u = HMAC-SHA256(market secret, 'market:' ‖ YYYY-MM-DD ‖ ':' ‖ artifactId) 前 48 bits。
--   全部是 ppm 整數；與 packages/game-engine/src/market.ts 的參考實作逐位元一致（整合測試比對）。
-- - 沒有前一日紀錄時 m(yesterday) = 1,000,000（GBS 未定義初始值，待確認）。
-- - 同一市場日、同一寶物只有一筆（主鍵），只新增不修改：重複執行、多個 Worker 並行都不會改變既有價格。
-- - 正確性不依賴排程：交易與讀取時若當日價格不存在，先在同一個交易中產生（延遲生成）；
--   pg_cron 每天 Asia/Taipei 00:01 預先產生，只是優化。
-- - 密鑰只存在資料庫的 private schema（與玩家的 rng_secret 相同保護），任何 API 角色都讀不到；
--   Client 無法觸發「重新抽價」：價格只取決於密鑰與日期，產生多少次結果都一樣。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 市場密鑰（每個環境各自產生；不經過應用程式、不出現在環境變數）
-- ---------------------------------------------------------------------------

create table private.market_secret (
  id     boolean primary key default true check (id),
  secret bytea   not null check (length(secret) = 32)
);
insert into private.market_secret (secret) values (extensions.gen_random_bytes(32));

revoke all on table private.market_secret from public, anon, authenticated, service_role;
alter table private.market_secret enable row level security;

-- 已產生的價格不可修改或刪除（只新增）
create or replace function private.market_prices_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'market prices are immutable' using errcode = 'P0001';
end $$;

create trigger market_prices_immutable
  before update or delete on public.market_prices
  for each row execute function private.market_prices_immutable();

-- ---------------------------------------------------------------------------
-- 市場日與遞推
-- ---------------------------------------------------------------------------

create or replace function private.market_date(p_at timestamptz) returns date
language sql immutable set search_path = '' as $$
  select (p_at at time zone 'Asia/Taipei')::date
$$;

create or replace function private.market_next_refresh_ms(p_date date) returns bigint
language sql immutable set search_path = '' as $$
  select floor(extract(epoch from ((p_date + 1)::timestamp at time zone 'Asia/Taipei')) * 1000)::bigint
$$;

-- 寶物 ID → 稀有度（與 @mining/game-data ARTIFACTS 一致；schema-ids 測試檢查）
create or replace function private.market_artifacts() returns table (artifact_id text, rarity text)
language sql immutable set search_path = '' as $$
  select * from (values
    ('a_z1_lantern', 'epic'), ('a_z1_badge', 'epic'), ('a_z1_map', 'epic'), ('a_z1_heart', 'legendary'),
    ('a_z2_orb', 'epic'), ('a_z2_crown', 'epic'), ('a_z2_mural', 'epic'), ('a_z2_heart', 'legendary'),
    ('a_z3_emblem', 'epic'), ('a_z3_ring', 'epic'), ('a_z3_tablet', 'epic'), ('a_z3_crown', 'legendary')
  ) as t(artifact_id, rarity)
$$;

create or replace function private.market_next_ppm(p_prev integer, p_rarity text, p_digest bytea) returns integer
language plpgsql immutable set search_path = '' as $$
declare
  v_step bigint := case p_rarity when 'epic' then 120000 when 'legendary' then 180000 end;
  v_min  integer := case p_rarity when 'epic' then 800000 when 'legendary' then 700000 end;
  v_max  integer := case p_rarity when 'epic' then 1300000 when 'legendary' then 1500000 end;
  v_u    bigint := 0;
  v_eps  bigint;
  v_drift bigint;
begin
  if v_step is null then raise exception 'unknown rarity %', p_rarity; end if;
  for i in 0..5 loop
    v_u := v_u * 256 + get_byte(p_digest, i);
  end loop;
  v_eps := (v_u % (2 * v_step + 1)) - v_step;
  v_drift := floor((35 * (1000000 - p_prev::bigint))::numeric / 100)::bigint;
  return greatest(v_min, least(v_max, p_prev + v_drift + v_eps))::integer;
end $$;

-- ---------------------------------------------------------------------------
-- 產生到指定市場日（冪等、可並行）。回傳新增的列數
-- ---------------------------------------------------------------------------

create or replace function private.market_ensure(p_date date) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_secret bytea;
  v_inserted integer := 0;
  v_n integer;
  a record;
  v_last record;
  v_day date;
  v_prev integer;
begin
  -- 快速路徑：當日 12 件都已存在（大多數請求），不取鎖
  if (select count(*) from public.market_prices m where m.price_date = p_date) >= (select count(*) from private.market_artifacts()) then
    return 0;
  end if;
  -- 多個 Worker（排程、多個請求）同時產生：依序執行；值是確定的，主鍵 + do nothing 再保證不覆蓋
  perform pg_advisory_xact_lock(hashtext('mining-expedition:market'));
  select s.secret into v_secret from private.market_secret s;
  if v_secret is null then
    raise exception 'market secret missing' using errcode = 'P0001';
  end if;
  for a in select * from private.market_artifacts() loop
    select m.price_date, m.multiplier_ppm into v_last
      from public.market_prices m
      where m.artifact_id = a.artifact_id and m.price_date <= p_date
      order by m.price_date desc limit 1;
    if found and v_last.price_date = p_date then
      continue;
    end if;
    if found then
      v_day := v_last.price_date + 1;
      v_prev := v_last.multiplier_ppm;
    else
      v_day := p_date; -- 第一個市場日
      v_prev := 1000000;
    end if;
    while v_day <= p_date loop
      v_prev := private.market_next_ppm(
        v_prev, a.rarity,
        extensions.hmac(convert_to('market:' || to_char(v_day, 'YYYY-MM-DD') || ':' || a.artifact_id, 'UTF8'), v_secret, 'sha256'));
      insert into public.market_prices (price_date, artifact_id, multiplier_ppm)
        values (v_day, a.artifact_id, v_prev)
        on conflict (price_date, artifact_id) do nothing;
      get diagnostics v_n = row_count;
      v_inserted := v_inserted + v_n;
      v_day := v_day + 1;
    end loop;
  end loop;
  return v_inserted;
end $$;

-- 讀取報價（今天 + 最多 6 天歷史）。今天不存在時先嘗試產生；產生失敗只影響寶物出售（multipliersPpm 為空）
create or replace function private.market_quote(p_at timestamptz) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_date date := private.market_date(p_at);
begin
  begin
    perform private.market_ensure(v_date);
  exception when others then
    raise warning 'market_ensure(%) failed: % (%)', v_date, sqlerrm, sqlstate;
  end;
  return jsonb_build_object(
    'date', to_char(v_date, 'YYYY-MM-DD'),
    'nextRefreshAt', private.market_next_refresh_ms(v_date),
    'multipliersPpm', coalesce((
      select jsonb_object_agg(m.artifact_id, m.multiplier_ppm) from public.market_prices m where m.price_date = v_date), '{}'::jsonb),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object('date', to_char(d.price_date, 'YYYY-MM-DD'), 'multipliersPpm', d.m) order by d.price_date desc)
      from (
        select m.price_date, jsonb_object_agg(m.artifact_id, m.multiplier_ppm) as m
        from public.market_prices m
        where m.price_date between v_date - 6 and v_date - 1
        group by m.price_date
      ) d), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------
-- 快照：加入市場（改為 volatile：可能需要產生當日價格）
-- ---------------------------------------------------------------------------

create or replace function public.game_load_snapshot(p_player_id uuid, p_idempotency_key uuid, p_request_hash text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_log record;
  v_secret bytea;
begin
  if p_idempotency_key is not null then
    select l.request_hash, l.response into v_log
      from public.action_log l where l.player_id = p_player_id and l.idempotency_key = p_idempotency_key;
    if found then
      if v_log.request_hash = p_request_hash then
        return jsonb_build_object('status', 'replay', 'response', v_log.response);
      end if;
      return jsonb_build_object('status', 'mismatch');
    end if;
  end if;
  select s.rng_secret into v_secret from private.player_secrets s where s.player_id = p_player_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  -- serverNow 與市場日來自同一個交易時間（now()），跨日瞬間也一致
  return jsonb_build_object(
    'status', 'ok',
    'state', private.player_state_json(p_player_id),
    'rngSecret', encode(v_secret, 'base64'),
    'serverNow', private.now_ms(),
    'market', private.market_quote(now()));
end $$;

-- ---------------------------------------------------------------------------
-- 權限：只有 service_role 可以呼叫公開 RPC；private 函式沒有任何 API 角色可呼叫
-- ---------------------------------------------------------------------------

revoke all on function private.market_prices_immutable() from public, anon, authenticated, service_role;
revoke all on function private.market_date(timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.market_next_refresh_ms(date) from public, anon, authenticated, service_role;
revoke all on function private.market_artifacts() from public, anon, authenticated, service_role;
revoke all on function private.market_next_ppm(integer, text, bytea) from public, anon, authenticated, service_role;
revoke all on function private.market_ensure(date) from public, anon, authenticated, service_role;
revoke all on function private.market_quote(timestamptz) from public, anon, authenticated, service_role;

revoke all on function public.game_load_snapshot(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.game_load_snapshot(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 每日預先產生（pg_cron；有安裝才排程。只是優化，沒跑到也不影響正確性）
-- UTC 16:01 = Asia/Taipei 00:01
-- ---------------------------------------------------------------------------

do $cron$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('market-daily-prices', '1 16 * * *', 'select private.market_ensure(private.market_date(now()))');
  end if;
end $cron$;
