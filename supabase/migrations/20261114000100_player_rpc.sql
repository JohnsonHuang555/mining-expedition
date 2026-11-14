-- 玩家資料 RPC：建立角色、載入快照、原子提交（TECHNICAL_SPEC §10.4、§10.6；PR #5）
--
-- - 全部是 security definer、search_path = ''，只授權給 service_role。
--   Edge Function 先驗證使用者 JWT，再以驗證後的 user id 呼叫；Client 不能直接呼叫這些函式。
-- - game_commit 在單一交易中完成：鎖定玩家列 → 冪等檢查 → CAS（state_version）→ 寫入所有資料表 →
--   建立 / 領取報告 → 寫入 action_log。任何錯誤都會讓整個交易 rollback。
-- - 狀態的 JSON 格式即 @mining/game-engine 的 PlayerGameState（schemaVersion 1）。

-- 伺服器時間（毫秒）：唯一的時間來源
create or replace function private.now_ms() returns bigint
language sql stable set search_path = '' as $$
  select floor(extract(epoch from now()) * 1000)::bigint
$$;

-- ---------------------------------------------------------------------------
-- 資料列 → PlayerGameState（jsonb）
-- ---------------------------------------------------------------------------

create or replace function private.player_state_json(p_player_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'schemaVersion', p.schema_version,
    'playerId', p.id::text,
    'stateVersion', p.state_version,
    'dataVersion', p.data_version,
    'rngVersion', p.rng_version,
    'createdAt', p.created_at_ms,
    'lastSettledAt', p.last_settled_at_ms,
    'coins', p.coins,
    'equippedPickaxe', p.equipped_pickaxe,
    'pickaxes', coalesce((select jsonb_object_agg(k.pickaxe_id, k.level) from public.player_pickaxes k where k.player_id = p.id), '{}'::jsonb),
    'unlockedZone', p.unlocked_zone,
    'mining', jsonb_build_object(
      'mode', p.mining_mode,
      'revisitZone', p.revisit_zone,
      'reworkBand', p.rework_band,
      'frontierBlockIndex', p.frontier_block_index,
      'digCounter', p.dig_counter,
      'blockWork', p.block_work,
      'blockMs', p.block_ms),
    'inventory', coalesce((select jsonb_object_agg(i.item_id, i.quantity) from public.player_inventory i where i.player_id = p.id), '{}'::jsonb),
    'heldArtifacts', coalesce((
      select jsonb_agg(jsonb_build_object(
          'instanceId', a.instance_id,
          'artifactId', a.artifact_id,
          'obtainedAt', a.obtained_at_ms,
          'mode', a.mode,
          'band', a.band,
          'frontierBlockIndex', a.frontier_block_index,
          'digCounter', a.dig_counter,
          'source', a.source) order by a.dig_counter)
      from public.artifact_instances a where a.player_id = p.id and a.status = 'held'), '[]'::jsonb),
    'discoveredArtifacts', coalesce((
      select jsonb_object_agg(d.artifact_id, jsonb_build_object(
          'firstDiscoveredAt', d.first_discovered_at_ms,
          'firstBand', d.first_band,
          'totalFound', d.total_found))
      from public.artifact_discoveries d where d.player_id = p.id), '{}'::jsonb),
    'firstTreasure', (
      select jsonb_build_object(
          'status', f.status,
          'effectiveMiningMs', f.effective_mining_ms,
          'resolvedAt', f.resolved_at_ms,
          'artifactInstanceId', f.artifact_instance_id,
          'reportId', f.report_id)
      from public.first_treasure f where f.player_id = p.id),
    'pendingOfflineReport', (select r.report from public.offline_reports r where r.player_id = p.id and r.status = 'pending'),
    'lastClaimedReportId', p.last_claimed_report_id)
  from public.players p
  where p.id = p_player_id
$$;

-- ---------------------------------------------------------------------------
-- PlayerGameState（jsonb）→ 資料列（只在 game_commit 內呼叫；已鎖定玩家列）
-- ---------------------------------------------------------------------------
-- 型別轉換失敗（小數、超過 bigint、錯型別）或任何約束違反都會丟出錯誤，讓整個交易 rollback。

create or replace function private.write_player_state(p_player_id uuid, s jsonb) returns void
language plpgsql set search_path = '' as $$
declare
  v_created bigint;
begin
  select created_at_ms into v_created from public.players where id = p_player_id;
  if (s ->> 'createdAt')::bigint is distinct from v_created then
    raise exception 'createdAt is immutable' using errcode = 'check_violation';
  end if;

  update public.players set
    schema_version         = (s ->> 'schemaVersion')::integer,
    state_version          = (s ->> 'stateVersion')::bigint,
    data_version           = (s ->> 'dataVersion')::integer,
    rng_version            = (s ->> 'rngVersion')::integer,
    last_settled_at_ms     = (s ->> 'lastSettledAt')::bigint,
    coins                  = (s ->> 'coins')::bigint,
    equipped_pickaxe       = s ->> 'equippedPickaxe',
    unlocked_zone          = (s ->> 'unlockedZone')::smallint,
    mining_mode            = s #>> '{mining,mode}',
    revisit_zone           = (s #>> '{mining,revisitZone}')::smallint,
    rework_band            = (s #>> '{mining,reworkBand}')::smallint,
    frontier_block_index   = (s #>> '{mining,frontierBlockIndex}')::integer,
    dig_counter            = (s #>> '{mining,digCounter}')::bigint,
    block_work             = (s #>> '{mining,blockWork}')::bigint,
    block_ms               = (s #>> '{mining,blockMs}')::bigint,
    last_claimed_report_id = s ->> 'lastClaimedReportId',
    updated_at             = now()
  where id = p_player_id;

  -- 十字鎬：只能新增或升級，不能消失或降級
  if exists (
    select 1 from public.player_pickaxes k
    where k.player_id = p_player_id
      and (not (s -> 'pickaxes') ? k.pickaxe_id or ((s -> 'pickaxes') ->> k.pickaxe_id)::smallint < k.level)
  ) then
    raise exception 'pickaxes cannot be removed or downgraded' using errcode = 'check_violation';
  end if;
  insert into public.player_pickaxes (player_id, pickaxe_id, level)
    select p_player_id, e.key, e.value::text::smallint from jsonb_each(s -> 'pickaxes') e
  on conflict (player_id, pickaxe_id) do update set level = excluded.level
    where public.player_pickaxes.level is distinct from excluded.level;

  -- 物品：以狀態為準
  delete from public.player_inventory i
    where i.player_id = p_player_id and not (s -> 'inventory') ? i.item_id;
  insert into public.player_inventory (player_id, item_id, quantity)
    select p_player_id, e.key, e.value::text::bigint from jsonb_each(s -> 'inventory') e
  on conflict (player_id, item_id) do update set quantity = excluded.quantity
    where public.player_inventory.quantity is distinct from excluded.quantity;

  -- 寶物：不在狀態中的持有實例 → 已出售；新的實例 → 插入。已出售的實例不能再出現（同一個 ID 不能重建）
  if exists (
    select 1 from jsonb_array_elements(s -> 'heldArtifacts') x
    join public.artifact_instances a on a.player_id = p_player_id and a.instance_id = x ->> 'instanceId'
    where a.status <> 'held' or a.artifact_id <> x ->> 'artifactId' or a.dig_counter <> (x ->> 'digCounter')::bigint
  ) then
    raise exception 'artifact instance conflict (sold or changed instance reappeared)' using errcode = 'check_violation';
  end if;
  update public.artifact_instances a set status = 'sold', sold_at_ms = (s ->> 'lastSettledAt')::bigint
    where a.player_id = p_player_id and a.status = 'held'
      and not exists (select 1 from jsonb_array_elements(s -> 'heldArtifacts') x where x ->> 'instanceId' = a.instance_id);
  insert into public.artifact_instances (player_id, instance_id, artifact_id, obtained_at_ms, mode, band, frontier_block_index, dig_counter, source)
    select p_player_id, x ->> 'instanceId', x ->> 'artifactId', (x ->> 'obtainedAt')::bigint, x ->> 'mode',
           (x ->> 'band')::smallint, (x ->> 'frontierBlockIndex')::integer, (x ->> 'digCounter')::bigint, x ->> 'source'
    from jsonb_array_elements(s -> 'heldArtifacts') x
    where not exists (select 1 from public.artifact_instances a where a.player_id = p_player_id and a.instance_id = x ->> 'instanceId');

  -- 圖鑑：永久保留；第一次發現的紀錄不可改變；totalFound 不可減少
  if exists (
    select 1 from public.artifact_discoveries d
    where d.player_id = p_player_id
      and (not (s -> 'discoveredArtifacts') ? d.artifact_id
           or ((s -> 'discoveredArtifacts') #>> array[d.artifact_id, 'totalFound'])::bigint < d.total_found
           or ((s -> 'discoveredArtifacts') #>> array[d.artifact_id, 'firstDiscoveredAt'])::bigint <> d.first_discovered_at_ms
           or ((s -> 'discoveredArtifacts') #>> array[d.artifact_id, 'firstBand'])::smallint <> d.first_band)
  ) then
    raise exception 'discoveries are permanent' using errcode = 'check_violation';
  end if;
  insert into public.artifact_discoveries (player_id, artifact_id, first_discovered_at_ms, first_band, total_found)
    select p_player_id, e.key, (e.value ->> 'firstDiscoveredAt')::bigint, (e.value ->> 'firstBand')::smallint, (e.value ->> 'totalFound')::bigint
    from jsonb_each(s -> 'discoveredArtifacts') e
  on conflict (player_id, artifact_id) do update set total_found = excluded.total_found
    where public.artifact_discoveries.total_found is distinct from excluded.total_found;

  -- 首次寶物保護（trigger 保證只能從 pending 轉出一次）
  update public.first_treasure set
    status               = s #>> '{firstTreasure,status}',
    effective_mining_ms  = (s #>> '{firstTreasure,effectiveMiningMs}')::bigint,
    resolved_at_ms       = (s #>> '{firstTreasure,resolvedAt}')::bigint,
    artifact_instance_id = s #>> '{firstTreasure,artifactInstanceId}',
    report_id            = s #>> '{firstTreasure,reportId}'
  where player_id = p_player_id;
end $$;

-- ---------------------------------------------------------------------------
-- RPC：建立角色
-- ---------------------------------------------------------------------------
-- p_state = createInitialState(playerId, …) 的結果；時間一律改為資料庫時間。
-- 已存在時不覆寫（冪等），回傳 status = 'exists'。

create or replace function public.game_create_player(p_player_id uuid, p_state jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_now bigint := private.now_ms();
begin
  if p_player_id is null or p_state is null then
    raise exception 'player id and state are required' using errcode = 'invalid_parameter_value';
  end if;
  perform 1 from public.players where id = p_player_id for update;
  if found then
    return jsonb_build_object('status', 'exists', 'state', private.player_state_json(p_player_id));
  end if;
  if not exists (select 1 from auth.users u where u.id = p_player_id) then
    return jsonb_build_object('status', 'no_auth_user');
  end if;
  -- 只接受初始狀態（D10：木製 Lv1、0m、沒有資源）
  if p_state ->> 'playerId' <> p_player_id::text
     or (p_state ->> 'stateVersion')::bigint <> 0
     or (p_state ->> 'coins')::bigint <> 0
     or p_state -> 'pickaxes' <> '{"pick_wood": 1}'::jsonb
     or p_state ->> 'equippedPickaxe' <> 'pick_wood'
     or p_state -> 'inventory' <> '{}'::jsonb
     or p_state -> 'heldArtifacts' <> '[]'::jsonb
     or p_state -> 'discoveredArtifacts' <> '{}'::jsonb
     or (p_state ->> 'unlockedZone')::smallint <> 0
     or p_state -> 'mining' <> '{"mode": "frontier", "revisitZone": null, "reworkBand": null, "frontierBlockIndex": 0, "digCounter": 0, "blockWork": 0, "blockMs": 0}'::jsonb
     or p_state -> 'firstTreasure' <> '{"status": "pending", "effectiveMiningMs": 0, "resolvedAt": null, "artifactInstanceId": null, "reportId": null}'::jsonb
     or p_state -> 'pendingOfflineReport' <> 'null'::jsonb
     or p_state -> 'lastClaimedReportId' <> 'null'::jsonb then
    raise exception 'not an initial state' using errcode = 'check_violation';
  end if;

  insert into public.players (id, schema_version, state_version, data_version, rng_version, created_at_ms, last_settled_at_ms,
                              coins, equipped_pickaxe, unlocked_zone, mining_mode, revisit_zone, rework_band,
                              frontier_block_index, dig_counter, block_work, block_ms, last_claimed_report_id)
  values (p_player_id, (p_state ->> 'schemaVersion')::integer, 0, (p_state ->> 'dataVersion')::integer, (p_state ->> 'rngVersion')::integer,
          v_now, v_now, 0, 'pick_wood', 0, 'frontier', null, null, 0, 0, 0, 0, null);
  insert into public.player_pickaxes (player_id, pickaxe_id, level) values (p_player_id, 'pick_wood', 1);
  insert into public.first_treasure (player_id, status, effective_mining_ms) values (p_player_id, 'pending', 0);
  -- 密鑰在資料庫內產生，只由 game_load_snapshot 交給伺服器端（不經過 Client）
  insert into private.player_secrets (player_id, rng_secret) values (p_player_id, extensions.gen_random_bytes(32));

  return jsonb_build_object('status', 'created', 'state', private.player_state_json(p_player_id));
end $$;

-- ---------------------------------------------------------------------------
-- RPC：載入快照
-- ---------------------------------------------------------------------------
-- status：
--   replay   — 同一 key + 同一 request_hash 已處理過：回傳原本的 response
--   mismatch — 同一 key 對應不同的指令（IDEMPOTENCY_MISMATCH）
--   not_found — 尚未建立角色
--   ok       — state（PlayerGameState）、rngSecret（base64）、serverNow（ms）、market（今日倍率 ppm）
-- p_idempotency_key 為 null 時不查 action_log（唯讀查詢用）。

create or replace function public.game_load_snapshot(p_player_id uuid, p_idempotency_key uuid, p_request_hash text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
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
  return jsonb_build_object(
    'status', 'ok',
    'state', private.player_state_json(p_player_id),
    'rngSecret', encode(v_secret, 'base64'),
    'serverNow', private.now_ms(),
    'market', coalesce((
      select jsonb_object_agg(m.artifact_id, m.multiplier_ppm) from public.market_prices m
      where m.price_date = (now() at time zone 'Asia/Taipei')::date), '{}'::jsonb));
end $$;

-- ---------------------------------------------------------------------------
-- RPC：原子提交
-- ---------------------------------------------------------------------------
-- p_state = null：沒有狀態變化（RequestResult.commit = null），只保存回應，讓同一個 key 重送得到同一個結果。
-- status：committed | recorded | replay | mismatch | version_conflict | not_found

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
  -- PostgREST 可能把 JSON null 傳成 jsonb 'null'：統一視為 SQL NULL
  if jsonb_typeof(p_state) = 'null' then p_state := null; end if;
  if jsonb_typeof(p_report_created) = 'null' then p_report_created := null; end if;

  -- 1. 鎖定玩家列：同一位玩家的提交依序執行（同一個 key 並行送出時，第二個會在這裡等待並看到第一個的紀錄）
  select p.state_version into v_version from public.players p where p.id = p_player_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- 2. 冪等：同一個 key 已經處理過
  select l.request_hash, l.response into v_log
    from public.action_log l where l.player_id = p_player_id and l.idempotency_key = p_idempotency_key;
  if found then
    if v_log.request_hash = p_request_hash then
      return jsonb_build_object('status', 'replay', 'response', v_log.response);
    end if;
    return jsonb_build_object('status', 'mismatch');
  end if;

  -- 3. CAS：回應必須根據最新的狀態計算（包含沒有狀態變化的回應，避免保存根據過時快照做出的拒絕）
  if v_version <> p_expected_version then
    return jsonb_build_object('status', 'version_conflict', 'stateVersion', v_version);
  end if;

  -- 4a. 沒有狀態變化：只保存回應
  if p_state is null then
    if p_report_created is not null or p_report_claimed is not null then
      raise exception 'report changes require a state' using errcode = 'invalid_parameter_value';
    end if;
    insert into public.action_log (player_id, idempotency_key, request_hash, command, committed, state_version_after, response)
      values (p_player_id, p_idempotency_key, p_request_hash, p_command, false, null, p_response);
    return jsonb_build_object('status', 'recorded', 'stateVersion', v_version);
  end if;

  -- 4b. 新版本 = 舊版本 + 1
  v_new := p_expected_version + 1;
  if (p_state ->> 'stateVersion')::bigint is distinct from v_new then
    raise exception 'state.stateVersion must be expected + 1' using errcode = 'check_violation';
  end if;
  if p_state ->> 'playerId' is distinct from p_player_id::text then
    raise exception 'state.playerId does not match' using errcode = 'check_violation';
  end if;

  -- 5. 寫入全部狀態
  perform private.write_player_state(p_player_id, p_state);

  -- 6. 報告：領取（pending → claimed，只能一次）
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

  -- 7. 報告：建立（部分唯一索引保證最多一份 pending）
  if p_report_created is not null then
    if p_report_created is distinct from p_state -> 'pendingOfflineReport' then
      raise exception 'created report must equal state.pendingOfflineReport' using errcode = 'check_violation';
    end if;
    insert into public.offline_reports (player_id, report_id, status, period_start_ms, period_end_ms, blocks_mined, coins, report)
      values (p_player_id, p_report_created ->> 'reportId', 'pending', (p_report_created ->> 'periodStart')::bigint,
              (p_report_created ->> 'periodEnd')::bigint, (p_report_created ->> 'blocksMined')::bigint,
              (p_report_created #>> '{rewards,coins}')::bigint, p_report_created);
  end if;

  -- 8. 狀態與報告表一致
  v_pending := p_state -> 'pendingOfflineReport';
  if jsonb_typeof(v_pending) = 'object' then
    if not exists (select 1 from public.offline_reports r where r.player_id = p_player_id and r.status = 'pending' and r.report = v_pending) then
      raise exception 'state.pendingOfflineReport does not match the pending report' using errcode = 'check_violation';
    end if;
  elsif exists (select 1 from public.offline_reports r where r.player_id = p_player_id and r.status = 'pending') then
    raise exception 'a pending report exists but the state has none' using errcode = 'check_violation';
  end if;

  -- 9. 操作紀錄（與狀態同一個交易）
  insert into public.action_log (player_id, idempotency_key, request_hash, command, committed, state_version_after, response)
    values (p_player_id, p_idempotency_key, p_request_hash, p_command, true, v_new, p_response);

  return jsonb_build_object('status', 'committed', 'stateVersion', v_new);
end $$;

-- ---------------------------------------------------------------------------
-- 權限：Supabase 預設把 public 函式的 EXECUTE 給 public / anon / authenticated，全部收回
-- ---------------------------------------------------------------------------

revoke all on function private.now_ms() from public, anon, authenticated, service_role;
revoke all on function private.player_state_json(uuid) from public, anon, authenticated, service_role;
revoke all on function private.write_player_state(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function private.first_treasure_guard() from public, anon, authenticated, service_role;

revoke all on function public.game_create_player(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.game_load_snapshot(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.game_commit(uuid, bigint, uuid, text, text, jsonb, jsonb, text, jsonb) from public, anon, authenticated;

grant execute on function public.game_create_player(uuid, jsonb) to service_role;
grant execute on function public.game_load_snapshot(uuid, uuid, text) to service_role;
grant execute on function public.game_commit(uuid, bigint, uuid, text, text, jsonb, jsonb, text, jsonb) to service_role;
