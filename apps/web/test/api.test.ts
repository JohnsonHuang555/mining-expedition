import { describe, expect, it } from "vitest";
import { createGameApi, newRequestId } from "@/lib/game/api";
import { MemoryBackend } from "@/lib/game/dev/memory-backend";

function setup(opts: { refresh?: () => string | null; token?: string | null } = {}) {
  const backend = new MemoryBackend();
  const userId = crypto.randomUUID();
  const token = backend.addUser(userId);
  let current: string | null = opts.token === undefined ? token : opts.token;
  const calls = { refresh: 0, unauthorized: 0, sleeps: [] as number[] };
  const api = createGameApi({
    functionsUrl: "http://edge.test/functions/v1",
    anonKey: "anon",
    fetch: backend.fetch,
    sleep: async (ms) => void calls.sleeps.push(ms),
    getAccessToken: async () => current,
    refreshAccessToken: async () => {
      calls.refresh++;
      const next = opts.refresh?.() ?? null;
      if (next) current = next;
      return next;
    },
    onUnauthorized: () => void calls.unauthorized++,
  });
  return { backend, userId, token, api, calls, setToken: (t: string | null) => (current = t) };
}

describe("遊戲 API Client", () => {
  it("沒有角色：game-state → CHARACTER_NOT_FOUND；建立 201；再次建立 409 CHARACTER_EXISTS", async () => {
    const { api } = setup();
    expect(await api.getState()).toMatchObject({ ok: false, status: 404, code: "CHARACTER_NOT_FOUND" });
    expect(await api.createCharacter()).toMatchObject({ ok: true, status: 201 });
    expect(await api.createCharacter()).toMatchObject({ ok: false, status: 409, code: "CHARACTER_EXISTS" });
    const s = await api.getState();
    expect(s.ok && s.body.state.state).toMatchObject({ coins: 0, equippedPickaxe: "pick_wood" });
  });

  it("不送任何 playerId：身分只由 Bearer token 決定", async () => {
    const { api, backend } = setup();
    await api.createCharacter();
    await api.action({ type: "settle" }, newRequestId());
    for (const r of backend.requests) expect(JSON.stringify(r.body ?? {})).not.toMatch(/player/i);
  });

  it("未登入（沒有 token）→ UNAUTHORIZED，不送出請求", async () => {
    const { api, backend, calls } = setup({ token: null });
    expect(await api.getState()).toMatchObject({ ok: false, code: "UNAUTHORIZED" });
    expect(backend.requests).toHaveLength(0);
    expect(calls.unauthorized).toBe(1);
  });

  it("401：更新一次 token 後以同一個 Idempotency-Key 重送；更新失敗則回報登入失效", async () => {
    const ok = setup({ refresh: () => "token-new" });
    await ok.api.createCharacter();
    ok.backend.addUser(ok.userId, "token-new");
    ok.backend.tokens.delete(ok.token); // 舊 token 失效
    const key = newRequestId();
    const r = await ok.api.action({ type: "settle" }, key);
    expect(r.ok).toBe(true);
    expect(ok.calls.refresh).toBe(1);
    expect(ok.backend.requests.filter((x) => x.fn === "game-action").map((x) => x.key)).toEqual([key, key]);

    const bad = setup({ refresh: () => null });
    await bad.api.createCharacter();
    bad.backend.tokens.clear();
    expect(await bad.api.action({ type: "settle" }, newRequestId())).toMatchObject({ ok: false, code: "UNAUTHORIZED" });
    expect(bad.calls).toMatchObject({ refresh: 1, unauthorized: 1 });
  });

  it("網路錯誤與 503：以同一個 key 退避重試，最後成功；只套用一次", async () => {
    const { api, backend, userId } = setup();
    await api.createCharacter();
    backend.mutate(userId, (s) => void (s.coins = 100));
    backend.faults.push("network", "busy");
    const key = newRequestId();
    const r = await api.action({ type: "select_mining_mode", mode: "frontier" }, key);
    expect(r.ok).toBe(true);
    const keys = backend.requests.filter((x) => x.fn === "game-action").map((x) => x.key);
    expect(keys).toEqual([key, key, key]);
    expect(backend.committedActions(userId)).toBe(1);
  });

  it("伺服器已提交但回應遺失（逾時）：同一個 key 重送拿到相同回應（Idempotent-Replayed），不重複套用", async () => {
    const { api, backend, userId } = setup();
    await api.createCharacter();
    backend.mutate(userId, (s) => {
      s.coins = 1000;
      s.inventory = { stone: 100 };
    });
    backend.faults.push("drop_response");
    const key = newRequestId();
    const r = await api.action({ type: "purchase_pickaxe", pickaxeId: "pick_stone" }, key);
    expect(r).toMatchObject({ ok: true, replayed: true });
    expect(backend.state(userId)!.pickaxes).toEqual({ pick_wood: 1, pick_stone: 1 });
    expect(backend.state(userId)!.coins).toBe(r.ok ? r.body.state.state.coins : -1);
    const again = await api.action({ type: "purchase_pickaxe", pickaxeId: "pick_stone" }, key);
    expect(again).toMatchObject({ ok: true, replayed: true });
    expect(again.ok && again.body).toEqual(r.ok && r.body);
  });

  it("重試次數用完仍失敗：回傳 NETWORK（呼叫端稍後以新操作再試）", async () => {
    const { api, backend, calls } = setup();
    await api.createCharacter();
    backend.faults.push("network", "network", "network", "network");
    expect(await api.action({ type: "settle" }, newRequestId())).toMatchObject({ ok: false, code: "NETWORK", status: null });
    expect(calls.sleeps).toEqual([500, 1_500, 3_500]);
  });

  it("同一個 key 用於不同指令 → IDEMPOTENCY_MISMATCH（不重試）", async () => {
    const { api } = setup();
    await api.createCharacter();
    const key = newRequestId();
    await api.action({ type: "settle" }, key);
    expect(await api.action({ type: "select_mining_mode", mode: "frontier" }, key)).toMatchObject({ ok: false, status: 409, code: "IDEMPOTENCY_MISMATCH" });
  });
});
