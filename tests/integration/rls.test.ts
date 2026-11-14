/**
 * Auth / RLS / 權限：在真正的 Supabase Local 上，以真實 JWT 經由 PostgREST 驗證。
 */
import { randomUUID } from "node:crypto";
import { createCharacter } from "@mining/game-server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anon, createUser, pool, realBackend, service, signIn } from "./src/backend.ts";

let A: { id: string; client: SupabaseClient };
let B: { id: string; client: SupabaseClient };

beforeAll(async () => {
  const mk = async () => {
    const u = await createUser();
    await createCharacter(realBackend.db, u.id);
    return { id: u.id, client: (await signIn(u.email)).client };
  };
  [A, B] = await Promise.all([mk(), mk()]);
});
afterAll(async () => pool.end());

const PLAYER_TABLES = ["players", "player_pickaxes", "player_inventory", "artifact_instances", "artifact_discoveries", "first_treasure", "offline_reports"];

describe("Auth 與 RLS（PostgREST + 真實 JWT）", () => {
  it("未登入（anon）讀不到任何玩家資料", async () => {
    for (const t of PLAYER_TABLES) {
      const { data, error } = await anon.from(t).select("*");
      // 沒有 SELECT 權限 → permission denied
      expect(error?.code, t).toBe("42501");
      expect(data).toBeNull();
    }
  });

  it("A 只讀得到自己的資料，讀不到 B", async () => {
    const { data: me } = await A.client.from("players").select("id, coins, frontier_block_index");
    expect(me).toEqual([{ id: A.id, coins: 0, frontier_block_index: 0 }]);
    const { data: other } = await A.client.from("players").select("id").eq("id", B.id);
    expect(other).toEqual([]);
    const { data: picks } = await A.client.from("player_pickaxes").select("player_id");
    expect(new Set(picks!.map((r) => r.player_id))).toEqual(new Set([A.id]));
  });

  it("Client 不能修改金幣、物品、深度、裝備、報告與操作紀錄", async () => {
    const attempts = [
      A.client.from("players").update({ coins: 999_999 }).eq("id", A.id),
      A.client.from("players").update({ frontier_block_index: 3000 }).eq("id", A.id),
      A.client.from("players").update({ equipped_pickaxe: "pick_diamond" }).eq("id", A.id),
      A.client.from("player_inventory").insert({ player_id: A.id, item_id: "ruby", quantity: 100 }),
      A.client.from("player_pickaxes").upsert({ player_id: A.id, pickaxe_id: "pick_diamond", level: 5 }),
      A.client.from("artifact_instances").delete().eq("player_id", A.id),
      A.client.from("offline_reports").update({ status: "claimed" }).eq("player_id", A.id),
      A.client.from("first_treasure").update({ status: "granted" }).eq("player_id", A.id),
      A.client.from("market_prices").insert({ price_date: "2026-01-01", artifact_id: "a_z1_map", multiplier_ppm: 1_500_000 }),
      // 改別人的資料也一樣
      A.client.from("players").update({ coins: 0 }).eq("id", B.id),
    ];
    for (const q of attempts) {
      const { error } = await q;
      expect(error?.code).toBe("42501");
    }
    const { rows } = await pool.query("select coins, frontier_block_index, equipped_pickaxe from public.players where id = $1", [A.id]);
    expect(rows[0]).toEqual({ coins: "0", frontier_block_index: 0, equipped_pickaxe: "pick_wood" });
  });

  it("Client 讀不到 RNG 密鑰與操作紀錄（private schema 不公開；action_log 沒有權限）", async () => {
    const secrets = await A.client.schema("private" as never).from("player_secrets").select("*");
    expect(secrets.error).not.toBeNull();
    expect(secrets.data).toBeNull();
    const log = await A.client.from("action_log").select("*");
    expect(log.error?.code).toBe("42501");
    // service_role 經由 PostgREST 也讀不到密鑰資料表（只有 game_load_snapshot 內部讀取）
    const viaService = await service.schema("private" as never).from("player_secrets").select("*");
    expect(viaService.error).not.toBeNull();
  });

  it("未授權使用者（anon / authenticated）不能呼叫特權 RPC，也不能代替別人操作", async () => {
    const calls = (c: SupabaseClient) => [
      c.rpc("game_load_snapshot", { p_player_id: A.id, p_idempotency_key: null, p_request_hash: null }),
      c.rpc("game_create_player", { p_player_id: A.id, p_state: {} }),
      c.rpc("game_commit", {
        p_player_id: B.id, p_expected_version: 0, p_idempotency_key: randomUUID(), p_request_hash: "0".repeat(64),
        p_command: "x", p_state: null, p_report_created: null, p_report_claimed: null, p_response: {},
      }),
    ];
    for (const c of [anon, A.client]) {
      for (const q of calls(c)) {
        const { data, error } = await q;
        expect(data).toBeNull();
        expect(error?.code).toBe("42501");
      }
    }
    const { rows } = await pool.query("select count(*)::int as n from public.action_log where player_id = $1", [B.id]);
    expect(rows[0].n).toBe(0);
  });

  it("service_role 的 RPC 可以使用；authenticated 可以讀市場價格", async () => {
    const { data, error } = await service.rpc("game_load_snapshot", { p_player_id: A.id, p_idempotency_key: null, p_request_hash: null });
    expect(error).toBeNull();
    expect((data as { status: string }).status).toBe("ok");
    const m = await A.client.from("market_prices").select("*");
    expect(m.error).toBeNull();
  });

  it("回應不含 RNG 密鑰", async () => {
    const snap = await realBackend.db.loadSnapshot(A.id, null, null);
    if (snap.status !== "ok") throw new Error("load");
    const { handleGameRequest } = await import("@mining/game-server");
    const r = await handleGameRequest(realBackend.db, { playerId: A.id, requestId: randomUUID(), command: { type: "settle" } });
    expect(JSON.stringify(r.response)).not.toContain(snap.rngSecret);
    const stored = await pool.query("select response::text as r from public.action_log where player_id = $1", [A.id]);
    for (const row of stored.rows) expect(row.r).not.toContain(snap.rngSecret);
  });
});
