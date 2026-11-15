/**
 * 寶物揭曉 × 真實 Supabase Local（Edge Functions、PostgreSQL）。
 * 掉落由伺服器結算：測試只預先找出會產生指定寶物的 RNG 密鑰並寫入 private.player_secrets（規則不變）。
 */
import { randomUUID } from "node:crypto";
import type { PlayerGameState } from "@mining/game-engine";
import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import { createGameApi } from "../../apps/web/src/lib/game/api.ts";
import { GameController } from "../../apps/web/src/lib/game/controller.ts";
import { RevealQueue, memoryRevealPersistence } from "../../apps/web/src/lib/game/reveal.ts";
import { createGameStore } from "../../apps/web/src/lib/game/store.ts";
import { findSecret, firstBlockDrops, nearlyDone } from "../../apps/web/test/support/rig-drops.ts";
import { PASSWORD, env, pool, realBackend } from "./src/backend.ts";

const HOUR = 3_600_000;
afterAll(async () => pool.end());

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

function tab(supabase: SupabaseClient, reveals = memoryRevealPersistence(), fetchImpl?: typeof fetch) {
  const store = createGameStore();
  const api = createGameApi({
    functionsUrl: env.functionsUrl,
    anonKey: env.anonKey,
    getAccessToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
    refreshAccessToken: async () => null,
    retryDelaysMs: [200, 400],
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  const controller = new GameController({ api, store, channel: null, reveals: new RevealQueue(reveals) });
  return { store, controller, reveals };
}

async function player() {
  const storage = memoryStorage();
  const supabase = createClient(env.apiUrl, env.anonKey, { auth: { persistSession: true, autoRefreshToken: false, storage, storageKey: "sb-reveal" } });
  const email = `reveal-${randomUUID()}@example.test`;
  const { data, error } = await supabase.auth.signUp({ email, password: PASSWORD });
  if (error || !data.user) throw new Error(`signUp: ${error?.message}`);
  const t = tab(supabase);
  await t.controller.createCharacter();
  return { id: data.user.id, supabase, t, storage };
}

async function snapshot(id: string): Promise<PlayerGameState> {
  const s = await realBackend.db.loadSnapshot(id, null, null);
  if (s.status !== "ok") throw new Error(s.status);
  return s.state as PlayerGameState;
}

const setSecret = (id: string, secret: Uint8Array) => pool.query(`update private.player_secrets set rng_secret = $2 where player_id = $1`, [id, Buffer.from(secret)]);

/** 讓下一個方塊在 1.5 秒內完成，並選好會產生指定結果的密鑰 */
async function rigNextBlock(id: string, want: Parameters<typeof findSecret>[2], label: string) {
  const s0 = await snapshot(id);
  const nd = nearlyDone(s0, 1_500);
  await pool.query(`update public.players set block_work = $2, block_ms = $3 where id = $1`, [id, nd.blockWork, nd.blockMs]);
  const s1 = await snapshot(id);
  await setSecret(id, findSecret(s1, s1.lastSettledAt + 2_000, want, label));
  await new Promise((r) => setTimeout(r, 2_100));
}

const actionCount = async (id: string, command: string) => (await pool.query(`select count(*)::int as n from public.action_log where player_id = $1 and command = $2`, [id, command])).rows[0].n as number;

describe("寶物揭曉（真實 Supabase Local）", () => {
  it("在線取得 Legendary、再取得 Epic：伺服器確認後才入列；與 heldArtifacts / discoveredArtifacts 一致", async () => {
    const p = await player();
    expect(p.t.store.getState().reveals).toEqual([]);
    await p.t.controller.retryBootstrap();
    await rigNextBlock(p.id, firstBlockDrops("legendary"), `it-leg-${p.id}`);
    await p.t.controller.sync();
    const [leg] = p.t.store.getState().reveals;
    expect(leg).toMatchObject({ rarity: "legendary", isNewDiscovery: true, origin: "online" });
    await rigNextBlock(p.id, firstBlockDrops("epic"), `it-epic-${p.id}`);
    await p.t.controller.sync();
    const reveals = p.t.store.getState().reveals;
    expect(reveals.map((r) => r.rarity)).toEqual(["legendary", "epic"]);
    const db = await pool.query(`select instance_id, artifact_id from public.artifact_instances where player_id = $1 order by dig_counter`, [p.id]);
    expect(db.rows.map((r) => r.instance_id)).toEqual(reveals.map((r) => r.key));
    expect(db.rows.map((r) => r.artifact_id)).toEqual(reveals.map((r) => r.artifactId));
    const disc = await pool.query(`select artifact_id from public.artifact_discoveries where player_id = $1`, [p.id]);
    expect(new Set(disc.rows.map((r) => r.artifact_id))).toEqual(new Set(reveals.map((r) => r.artifactId)));
  });

  it("首次寶物保護（在線）：揭曉帶保護標記；結算回應遺失後重送（Replay）不重複揭曉、不重複入帳", async () => {
    const p = await player();
    await pool.query(`update public.first_treasure set effective_mining_ms = $2 where player_id = $1`, [p.id, 4 * HOUR - 1_000]);
    await p.t.controller.retryBootstrap();
    await rigNextBlock(p.id, (x) => !!x.blocks[0]?.protection, `it-prot-${p.id}`);
    // 第一次回應遺失：API Client 以同一個 key 重送，伺服器回傳 action_log 中的同一個回應
    let lost = 0;
    const lossy: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (lost === 0 && String(init?.body).includes('"settle"')) {
        lost++;
        throw new TypeError("response lost");
      }
      return res;
    };
    const t = tab(p.supabase, memoryRevealPersistence(), lossy);
    await t.controller.bootstrap(); // bootstrap 的 settle：第一次回應遺失 → 重送 → replay
    expect(lost).toBe(1);
    expect(t.store.getState().reveals).toHaveLength(1);
    expect(t.store.getState().reveals[0]).toMatchObject({ protection: true, isNewDiscovery: true });
    await t.controller.sync();
    expect(t.store.getState().reveals).toHaveLength(1);
    expect((await pool.query(`select count(*)::int as n from public.artifact_instances where player_id = $1`, [p.id])).rows[0].n).toBe(1);
  });

  it("離線一次取得多件寶物：領取前不入列；領取回應遺失 → 以同一個 Request ID 調和 → 依序揭曉一次；重新整理不重播", async () => {
    const p = await player();
    await pool.query(`update public.first_treasure set effective_mining_ms = $2 where player_id = $1`, [p.id, 4 * HOUR - 30_000]);
    const s0 = await snapshot(p.id);
    const secret = findSecret(
      s0,
      s0.lastSettledAt + 10 * 60_000,
      (x) => !!x.report && x.report.rewards.artifacts.some((a) => a.source === "first_treasure_protection") && x.report.rewards.artifacts.some((a) => a.artifactId === "a_z1_heart"),
      `it-off-${p.id}`,
    );
    await setSecret(p.id, secret);
    await pool.query(`update public.players set created_at_ms = created_at_ms - $2, last_settled_at_ms = last_settled_at_ms - $2 where id = $1`, [p.id, 10 * 60_000]);

    const persistence = memoryRevealPersistence(); // 同一個瀏覽器的 localStorage
    const lossy: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (String(init?.body).includes("claim_report")) throw new TypeError("response lost");
      return res;
    };
    const a = tab(p.supabase, persistence, lossy);
    await a.controller.bootstrap();
    const report = a.store.getState().view!.state.pendingOfflineReport!;
    expect(report.rewards.artifacts.length).toBeGreaterThanOrEqual(2);
    expect(a.store.getState().reveals).toEqual([]); // 領取前不入列
    expect(await a.controller.claimReport()).toBe(false); // 已提交，回應全部遺失
    expect(a.store.getState().reveals).toEqual([]);
    expect(await actionCount(p.id, "claim_report")).toBe(1);
    const pendingClaim = a.store.getState().pending!;
    a.controller.dispose();

    // 重新整理（同一份未確認操作與揭曉保存）：bootstrap 以同一個 Request ID 調和
    const { memoryPendingStore } = await import("../../apps/web/src/lib/game/pending.ts");
    const pendingStore = memoryPendingStore([pendingClaim]);
    const store = createGameStore();
    const api = createGameApi({ functionsUrl: env.functionsUrl, anonKey: env.anonKey, getAccessToken: async () => (await p.supabase.auth.getSession()).data.session?.access_token ?? null, refreshAccessToken: async () => null });
    const b = new GameController({ api, store, channel: null, pendingStore, reveals: new RevealQueue(persistence) });
    await b.bootstrap();
    const reveals = store.getState().reveals;
    expect(reveals.map((r) => r.key)).toEqual(report.rewards.artifacts.map((x) => x.instanceId));
    expect(reveals.some((r) => r.protection)).toBe(true);
    expect(reveals.some((r) => r.rarity === "legendary")).toBe(true);
    expect(await actionCount(p.id, "claim_report")).toBe(1);
    const held = await pool.query(`select instance_id from public.artifact_instances where player_id = $1 order by dig_counter`, [p.id]);
    expect(held.rows.map((r) => r.instance_id)).toEqual(report.rewards.artifacts.map((x) => x.instanceId));
    b.dismissAllReveals();
    b.dispose();

    // 再重新整理一次：不重播
    const c = tab(p.supabase, persistence);
    await c.controller.bootstrap();
    expect(c.store.getState().reveals).toEqual([]);
  });
});

void createClient;
void PASSWORD;
