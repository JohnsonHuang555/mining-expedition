-- Supabase Integration（2/2）review：同一玩家同時建立角色時，穩定回傳 201 / 409。
-- 只變更 game_create_player 的開頭（加上 advisory lock），其餘與 20261114000100 相同。
-- create or replace 保留既有權限（只有 service_role 可以執行）。

create or replace function public.game_create_player(p_player_id uuid, p_state jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_now bigint := private.now_ms();
begin
  if p_player_id is null or p_state is null then
    raise exception 'player id and state are required' using errcode = 'invalid_parameter_value';
  end if;
  -- 同一玩家的建立請求依序執行：不存在的列無法以 for update 鎖住，兩個同時的建立都會看到「不存在」，
  -- 後到者再撞上主鍵衝突（變成 500 / SERVER_BUSY）。改以交易層級的 advisory lock 排隊，
  -- 後到者在前者提交後才繼續，並看到已存在的角色（409 CHARACTER_EXISTS）。
  perform pg_advisory_xact_lock(hashtextextended('game_create_player:' || p_player_id::text, 0));
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
