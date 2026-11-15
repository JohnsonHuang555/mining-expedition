import { describe, expect, it } from "vitest";
import { createGameApi } from "@/lib/game/api";
import { MemoryBackend } from "@/lib/game/dev/memory-backend";
import { apiResponseIssue } from "@/lib/game/validate";

async function realResponse() {
  const backend = new MemoryBackend();
  const id = crypto.randomUUID();
  const token = backend.addUser(id);
  const api = createGameApi({ functionsUrl: "http://e/functions/v1", anonKey: "a", fetch: backend.fetch, getAccessToken: async () => token, refreshAccessToken: async () => null });
  await api.createCharacter();
  backend.advance(120_000);
  const r = await api.action({ type: "settle" }, crypto.randomUUID());
  if (!r.ok) throw new Error("settle");
  return r.body;
}

describe("apiResponseIssue", () => {
  it("伺服器的正常回應通過；回傳的就是原物件（不複製）", async () => {
    const body = await realResponse();
    expect(apiResponseIssue(body)).toBeNull();
    expect(apiResponseIssue({ ok: false, requestId: null, command: null, error: { code: "SERVER_BUSY", message: "x" } })).toBeNull();
  });

  it("缺少或型別錯誤的欄位 → 回報路徑", async () => {
    const good = await realResponse();
    const cases: [string, (b: Record<string, unknown>) => void][] = [
      ["ok", (b) => delete b.ok],
      ["stateVersion", (b) => (b.stateVersion = "1")],
      ["state", (b) => delete b.state],
      ["events", (b) => (b.events = null)],
      ["settlement", (b) => (b.settlement = { kind: "online" })],
      ["state.state.coins", (b) => ((b.state as { state: Record<string, unknown> }).state.coins = -1)],
      ["state.state.inventory", (b) => ((b.state as { state: Record<string, unknown> }).state.inventory = { stone: "3" })],
      ["state.stats", (b) => delete (b.state as Record<string, unknown>).stats],
      ["stateVersion(mismatch)", (b) => (b.stateVersion = (b.stateVersion as number) + 1)],
    ];
    for (const [path, mutate] of cases) {
      const b = structuredClone(good) as unknown as Record<string, unknown>;
      mutate(b);
      expect(apiResponseIssue(b), path).toContain(path.split("(")[0]!.split(".")[0]);
    }
    expect(apiResponseIssue(null)).toBe("body");
    expect(apiResponseIssue([])).toBe("body");
    expect(apiResponseIssue({ ok: false })).toBe("error");
    expect(apiResponseIssue({ ok: false, error: { code: 1, message: "x" } })).toBe("error");
  });

  it("API Client：不合法的 JSON 或 ok 與狀態碼不一致 → BAD_RESPONSE（不丟例外）", async () => {
    const responses = [new Response("not json", { status: 200 }), new Response(JSON.stringify({ ok: true }), { status: 200 }), new Response(JSON.stringify({ ok: false, requestId: null, command: null, error: { code: "X", message: "y" } }), { status: 200 })];
    const api = createGameApi({
      functionsUrl: "http://e/functions/v1",
      anonKey: "a",
      fetch: async () => responses.shift()!,
      getAccessToken: async () => "t",
      refreshAccessToken: async () => null,
      retryDelaysMs: [],
    });
    for (let i = 0; i < 3; i++) expect(await api.action({ type: "settle" }, crypto.randomUUID())).toMatchObject({ ok: false, code: "BAD_RESPONSE" });
  });
});
