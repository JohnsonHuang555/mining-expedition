-- 玩家資料持久化：schema、約束、RLS、權限（TECHNICAL_SPEC §8；PR #5）
--
-- 原則
-- - 玩家身分 = auth.users.id。Client（anon / authenticated）只能 SELECT 自己的公開資料，不能寫入任何資料表。
-- - 所有寫入只經由 service_role 專用的 RPC（20261114000100_player_rpc.sql），在單一交易內原子提交。
-- - RNG 密鑰放在 private schema（不在 PostgREST 公開的 schema 中，也沒有任何 Client 權限）。
-- - 所有數量 / 時間 / 工作量為 bigint，並以 check 限制在 JS safe integer（2^53 − 1）內，
--   讓 jsonb → JavaScript number 的轉換永遠精確（TECHNICAL_SPEC §8.5）。
-- - 遊戲 ID 以 check 限制在已知清單（GBS §24：ID 只能新增、不能刪除；新增 ID 需要新的 migration）。
--   packages/game-server/test/schema-ids.test.ts 檢查這些清單與 @mining/game-data 一致。

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
-- private 只給 security definer 函式（擁有者）使用；service_role 也不能直接讀取密鑰資料表

-- ---------------------------------------------------------------------------
-- players：玩家核心狀態（PlayerGameState 的純量欄位與 mining）
-- ---------------------------------------------------------------------------

create table public.players (
  id                     uuid primary key references auth.users (id) on delete cascade,
  schema_version         integer  not null check (schema_version = 1),
  state_version          bigint   not null check (state_version between 0 and 9007199254740991),
  data_version           integer  not null check (data_version >= 1),
  rng_version            integer  not null check (rng_version >= 1),
  created_at_ms          bigint   not null check (created_at_ms between 0 and 9007199254740991),
  last_settled_at_ms     bigint   not null check (last_settled_at_ms between 0 and 9007199254740991),
  coins                  bigint   not null check (coins between 0 and 9007199254740991),
  equipped_pickaxe       text     not null,
  unlocked_zone          smallint not null check (unlocked_zone between 0 and 2),
  mining_mode            text     not null check (mining_mode in ('frontier', 'revisit', 'rework')),
  revisit_zone           smallint check (revisit_zone between 0 and 2),
  rework_band            smallint check (rework_band between 0 and 29),
  frontier_block_index   integer  not null check (frontier_block_index between 0 and 3000),
  dig_counter            bigint   not null check (dig_counter between 0 and 9007199254740991),
  block_work             bigint   not null check (block_work between 0 and 9007199254740991),
  block_ms               bigint   not null check (block_ms between 0 and 9007199254740991),
  last_claimed_report_id text     check (last_claimed_report_id ~ '^r[0-9]+$'),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  check (last_settled_at_ms >= created_at_ms),
  check (dig_counter >= frontier_block_index),
  check ((mining_mode = 'revisit') = (revisit_zone is not null)),
  check ((mining_mode = 'rework') = (rework_band is not null)),
  check ((block_work = 0) = (block_ms = 0)),
  check (unlocked_zone * 1000 <= frontier_block_index),
  check (frontier_block_index <= (unlocked_zone + 1) * 1000)
);

-- ---------------------------------------------------------------------------
-- RNG 密鑰（private；只有 security definer RPC 讀取）
-- ---------------------------------------------------------------------------

create table private.player_secrets (
  player_id  uuid primary key references public.players (id) on delete cascade,
  rng_secret bytea not null check (octet_length(rng_secret) = 32),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 十字鎬、物品
-- ---------------------------------------------------------------------------

create table public.player_pickaxes (
  player_id  uuid     not null references public.players (id) on delete cascade,
  pickaxe_id text     not null check (pickaxe_id in ('pick_wood', 'pick_stone', 'pick_iron', 'pick_gold', 'pick_diamond')),
  level      smallint not null check (level between 1 and 5),
  primary key (player_id, pickaxe_id)
);

-- 裝備中的十字鎬必須已擁有（建立角色時同一交易插入，所以延後到 commit 檢查）
alter table public.players
  add constraint players_equipped_pickaxe_owned
  foreign key (id, equipped_pickaxe) references public.player_pickaxes (player_id, pickaxe_id)
  deferrable initially deferred;

create table public.player_inventory (
  player_id uuid   not null references public.players (id) on delete cascade,
  item_id   text   not null check (item_id in (
    'stone', 'coal', 'copper', 'iron_ore', 'silver', 'gold', 'amethyst', 'sapphire', 'ruby',
    'iron_ingot', 'reinforce_stone', 'refined_crystal')),
  quantity  bigint not null check (quantity between 1 and 9007199254740991),
  primary key (player_id, item_id)
);

-- ---------------------------------------------------------------------------
-- 寶物實例（持有中與已出售；已出售的實例保留，避免同一個 ID 被重新建立）
-- ---------------------------------------------------------------------------

create table public.artifact_instances (
  player_id            uuid     not null references public.players (id) on delete cascade,
  instance_id          text     not null check (instance_id ~ '^d[0-9]+$'),
  artifact_id          text     not null check (artifact_id in (
    'a_z1_lantern', 'a_z1_badge', 'a_z1_map', 'a_z1_heart',
    'a_z2_orb', 'a_z2_crown', 'a_z2_mural', 'a_z2_heart',
    'a_z3_emblem', 'a_z3_ring', 'a_z3_tablet', 'a_z3_crown')),
  obtained_at_ms       bigint   not null check (obtained_at_ms between 0 and 9007199254740991),
  mode                 text     not null check (mode in ('frontier', 'revisit', 'rework')),
  band                 smallint not null check (band between 0 and 29),
  frontier_block_index integer  check (frontier_block_index between 0 and 2999),
  dig_counter          bigint   not null check (dig_counter between 0 and 9007199254740991),
  source               text     not null check (source in ('drop', 'first_treasure_protection')),
  status               text     not null default 'held' check (status in ('held', 'sold')),
  sold_at_ms           bigint   check (sold_at_ms between 0 and 9007199254740991),
  source_report_id     text     check (source_report_id ~ '^r[0-9]+$'),
  primary key (player_id, instance_id),
  check (instance_id = 'd' || dig_counter::text),            -- 實例 ID 由方塊序號決定（TECHNICAL_SPEC §8.1）
  check ((status = 'sold') = (sold_at_ms is not null)),
  check ((mode = 'frontier') = (frontier_block_index is not null))
);

create index artifact_instances_held on public.artifact_instances (player_id, dig_counter) where status = 'held';

-- 圖鑑：永久保留
create table public.artifact_discoveries (
  player_id              uuid     not null references public.players (id) on delete cascade,
  artifact_id            text     not null check (artifact_id in (
    'a_z1_lantern', 'a_z1_badge', 'a_z1_map', 'a_z1_heart',
    'a_z2_orb', 'a_z2_crown', 'a_z2_mural', 'a_z2_heart',
    'a_z3_emblem', 'a_z3_ring', 'a_z3_tablet', 'a_z3_crown')),
  first_discovered_at_ms bigint   not null check (first_discovered_at_ms between 0 and 9007199254740991),
  first_band             smallint not null check (first_band between 0 and 29),
  total_found            bigint   not null check (total_found between 1 and 9007199254740991),
  primary key (player_id, artifact_id)
);

-- ---------------------------------------------------------------------------
-- 首次寶物保護（GBS §7.7；D17、D18）
-- ---------------------------------------------------------------------------

create table public.first_treasure (
  player_id            uuid   primary key references public.players (id) on delete cascade,
  status               text   not null check (status in ('pending', 'obtained', 'granted')),
  effective_mining_ms  bigint not null check (effective_mining_ms between 0 and 9007199254740991),
  resolved_at_ms       bigint check (resolved_at_ms between 0 and 9007199254740991),
  artifact_instance_id text   check (artifact_instance_id ~ '^d[0-9]+$'),
  report_id            text   check (report_id ~ '^r[0-9]+$'),
  check ((status = 'pending') = (resolved_at_ms is null)),
  check ((status = 'pending') = (artifact_instance_id is null)),
  check (status <> 'pending' or report_id is null)
);

-- 狀態只能從 pending 轉出一次；轉出後的結果不可改變（只有 report_id 可在領取時清除）
create or replace function private.first_treasure_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.status <> 'pending' then
    if new.status <> old.status
       or new.resolved_at_ms is distinct from old.resolved_at_ms
       or new.artifact_instance_id is distinct from old.artifact_instance_id then
      raise exception 'first_treasure is already resolved (% → %)', old.status, new.status using errcode = 'check_violation';
    end if;
    if new.report_id is distinct from old.report_id and new.report_id is not null then
      raise exception 'first_treasure.report_id can only be cleared' using errcode = 'check_violation';
    end if;
  end if;
  if new.effective_mining_ms < old.effective_mining_ms then
    raise exception 'first_treasure.effective_mining_ms cannot decrease' using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger first_treasure_guard before update on public.first_treasure
  for each row execute function private.first_treasure_guard();

-- ---------------------------------------------------------------------------
-- 離線報告（D20、D23、D24）
-- ---------------------------------------------------------------------------

create table public.offline_reports (
  player_id        uuid   not null references public.players (id) on delete cascade,
  report_id        text   not null check (report_id ~ '^r[0-9]+$'),
  status           text   not null check (status in ('pending', 'claimed')),
  period_start_ms  bigint not null check (period_start_ms between 0 and 9007199254740991),
  period_end_ms    bigint not null check (period_end_ms between 0 and 9007199254740991),
  blocks_mined     bigint not null check (blocks_mined between 1 and 9007199254740991), -- D23：沒有方塊就沒有報告
  coins            bigint not null check (coins between 0 and 9007199254740991),
  report           jsonb  not null,                                                    -- 完整 OfflineReport（領取只做加法）
  created_at       timestamptz not null default now(),
  claimed_at       timestamptz,
  claimed_at_ms    bigint check (claimed_at_ms between 0 and 9007199254740991),
  primary key (player_id, report_id),
  check (period_end_ms > period_start_ms),
  check ((status = 'claimed') = (claimed_at_ms is not null)),
  check (report ->> 'reportId' = report_id)
);

-- 每位玩家最多一份待領取報告（TECHNICAL_SPEC §8.4）
create unique index offline_reports_one_pending on public.offline_reports (player_id) where status = 'pending';

-- ---------------------------------------------------------------------------
-- 操作紀錄（冪等，TECHNICAL_SPEC §10.6）
-- ---------------------------------------------------------------------------

create table public.action_log (
  id                  bigint generated always as identity primary key,
  player_id           uuid    not null references public.players (id) on delete cascade,
  idempotency_key     uuid    not null,
  request_hash        text    not null check (request_hash ~ '^[0-9a-f]{64}$'),
  command             text    not null check (char_length(command) between 1 and 64),
  committed           boolean not null,          -- true = 與狀態同一交易提交；false = 沒有狀態變化（只保存回應）
  state_version_after bigint  check (state_version_after between 0 and 9007199254740991),
  response            jsonb   not null,
  created_at          timestamptz not null default now(),
  unique (player_id, idempotency_key),
  check (committed = (state_version_after is not null))
);

-- ---------------------------------------------------------------------------
-- 市場倍率（GBS §13；每日排程在之後的 PR）
-- ---------------------------------------------------------------------------

create table public.market_prices (
  price_date     date    not null,
  artifact_id    text    not null check (artifact_id in (
    'a_z1_lantern', 'a_z1_badge', 'a_z1_map', 'a_z1_heart',
    'a_z2_orb', 'a_z2_crown', 'a_z2_mural', 'a_z2_heart',
    'a_z3_emblem', 'a_z3_ring', 'a_z3_tablet', 'a_z3_crown')),
  multiplier_ppm integer not null check (multiplier_ppm between 700000 and 1500000),
  created_at     timestamptz not null default now(),
  primary key (price_date, artifact_id)
);

-- ---------------------------------------------------------------------------
-- 權限：Client 只能讀自己的資料；任何寫入只經由 service_role 的 RPC
-- ---------------------------------------------------------------------------
-- Supabase 的 default privileges 會把 public 新資料表的全部權限給 anon / authenticated，先全部收回。

revoke all on table
  public.players, public.player_pickaxes, public.player_inventory, public.artifact_instances,
  public.artifact_discoveries, public.first_treasure, public.offline_reports, public.action_log, public.market_prices
from public, anon, authenticated;
revoke all on table private.player_secrets from public, anon, authenticated, service_role;

grant select on table
  public.players, public.player_pickaxes, public.player_inventory, public.artifact_instances,
  public.artifact_discoveries, public.first_treasure, public.offline_reports, public.market_prices
to authenticated;
-- action_log 含回應快照：Client 不可直接讀取（重送時由 API 回傳）

alter table public.players              enable row level security;
alter table public.player_pickaxes      enable row level security;
alter table public.player_inventory     enable row level security;
alter table public.artifact_instances   enable row level security;
alter table public.artifact_discoveries enable row level security;
alter table public.first_treasure       enable row level security;
alter table public.offline_reports      enable row level security;
alter table public.action_log           enable row level security;
alter table public.market_prices        enable row level security;
alter table private.player_secrets      enable row level security;

-- 讀取政策：只有自己的資料（(select auth.uid()) 讓 Postgres 每個查詢只計算一次）
create policy players_select_own              on public.players              for select to authenticated using (id = (select auth.uid()));
create policy player_pickaxes_select_own      on public.player_pickaxes      for select to authenticated using (player_id = (select auth.uid()));
create policy player_inventory_select_own     on public.player_inventory     for select to authenticated using (player_id = (select auth.uid()));
create policy artifact_instances_select_own   on public.artifact_instances   for select to authenticated using (player_id = (select auth.uid()));
create policy artifact_discoveries_select_own on public.artifact_discoveries for select to authenticated using (player_id = (select auth.uid()));
create policy first_treasure_select_own       on public.first_treasure       for select to authenticated using (player_id = (select auth.uid()));
create policy offline_reports_select_own      on public.offline_reports      for select to authenticated using (player_id = (select auth.uid()));
create policy market_prices_select_all        on public.market_prices        for select to authenticated using (true);
-- action_log、player_secrets：沒有任何 Client 政策
