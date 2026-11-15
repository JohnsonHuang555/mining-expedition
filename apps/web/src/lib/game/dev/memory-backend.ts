/**
 * 開發 / 測試用的記憶體後端：以 fetch 介面模擬三個 Edge Function（HTTP 狀態碼、Idempotent-Replayed、401），
 * 內部直接使用 @mining/game-server 的 handleGameRequest / createCharacter / readState（與正式伺服器相同的程式碼），
 * 只把資料庫換成記憶體。只用於 /dev/preview（正式環境 404）與單元測試，絕不用於正式遊戲。
 *
 * 可注入：伺服器時間、網路錯誤 / 503、回應延遲；可直接改玩家狀態（測試準備）。
 */

import { ARTIFACT_IDS, type ArtifactId } from "@mining/game-data";
import { type PlayerGameState, addMarketDays, cloneState, marketDateOf, marketMultiplierFor, nextMarketRefreshAt, sha256 } from "@mining/game-engine";
import { type ApiResponse, type CommitArgs, type GameDb, type MarketSnapshot, createCharacter, handleGameRequest, httpStatus, readState } from "@mining/game-server";

interface Row {
  state: PlayerGameState;
  secret: string;
}

export type Fault = "network" | "busy" | "unauthorized" | "drop_response" | "malformed" | "malformed_after_commit";

export class MemoryBackend {
  now: number;
  readonly players = new Map<string, Row>();
  readonly log = new Map<string, { hash: string; response: ApiResponse }>();
  readonly tokens = new Map<string, string>();
  /** 接下來的請求依序套用的故障 */
  readonly faults: Fault[] = [];
  /** 只套用在符合條件的請求上的故障（times 次） */
  readonly rules: { match: (fn: string, body: unknown) => boolean; fault: Fault; times: number }[] = [];
  /** 每個請求的人工延遲（毫秒） */
  latencyMs = 0;
  readonly requests: { fn: string; key: string | null; body: unknown; status: number | "network" }[] = [];

  /** 每日市場倍率（與資料庫相同的演算法：引擎參考實作；只新增不修改） */
  readonly market = new Map<string, Partial<Record<ArtifactId, number>>>();
  private readonly marketSecret = sha256(new TextEncoder().encode("dev-memory-market"));
  /** 測試：模擬當日價格無法產生 */
  marketUnavailable = false;

  constructor(now = Date.UTC(2026, 10, 14, 12)) {
    this.now = now;
  }

  addUser(userId: string, token = `token-${userId}`): string {
    this.tokens.set(token, userId);
    return token;
  }

  advance(ms: number): void {
    this.now += ms;
  }

  /** 測試準備：直接修改玩家狀態（等同測試中用 SQL 準備資料） */
  mutate(userId: string, fn: (s: PlayerGameState) => void): void {
    const row = this.players.get(userId);
    if (!row) throw new Error("no player");
    fn(row.state);
  }

  /** 時光倒流：讓玩家像是已離開 ms 毫秒 */
  rewind(userId: string, ms: number): void {
    this.mutate(userId, (s) => {
      s.createdAt -= ms;
      s.lastSettledAt -= ms;
    });
  }

  /** 延遲生成到指定市場日（等同 private.market_ensure） */
  ensureMarket(date: string): void {
    if (this.marketUnavailable || this.market.has(date)) return;
    const dates = [...this.market.keys()].filter((d) => d < date).sort();
    let day = dates.length ? addMarketDays(dates[dates.length - 1]!, 1) : date;
    while (day <= date) {
      const prev = this.market.get(addMarketDays(day, -1));
      const row: Partial<Record<ArtifactId, number>> = {};
      for (const id of ARTIFACT_IDS) row[id] = marketMultiplierFor(this.marketSecret, day, id, prev?.[id] ?? 1_000_000);
      this.market.set(day, row);
      day = addMarketDays(day, 1);
    }
  }

  marketSnapshot(): MarketSnapshot {
    const date = marketDateOf(this.now);
    this.ensureMarket(date);
    const history = [];
    for (let i = 1; i <= 6; i++) {
      const d = addMarketDays(date, -i);
      const m = this.market.get(d);
      if (m) history.push({ date: d, multipliersPpm: { ...m } });
    }
    // marketUnavailable：模擬當日價格無法產生（伺服器回空的倍率；出售回 MARKET_UNAVAILABLE）
    const today = this.marketUnavailable ? {} : { ...(this.market.get(date) ?? {}) };
    return { date, nextRefreshAt: nextMarketRefreshAt(this.now), multipliersPpm: today, history };
  }

  state(userId: string): PlayerGameState | null {
    const r = this.players.get(userId);
    return r ? cloneState(r.state) : null;
  }

  db(): GameDb {
    return {
      createPlayer: async (playerId, initial) => {
        const existing = this.players.get(playerId);
        if (existing) return { status: "exists", state: cloneState(existing.state) };
        const state = { ...cloneState(initial), createdAt: this.now, lastSettledAt: this.now };
        const secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
        this.players.set(playerId, { state, secret });
        return { status: "created", state: cloneState(state) };
      },
      loadSnapshot: async (playerId, key, hash) => {
        if (key) {
          const l = this.log.get(`${playerId}:${key}`);
          if (l) return l.hash === hash ? { status: "replay", response: structuredClone(l.response) } : { status: "mismatch" };
        }
        const row = this.players.get(playerId);
        if (!row) return { status: "not_found" };
        return { status: "ok", state: cloneState(row.state), rngSecret: row.secret, serverNow: this.now, market: this.marketSnapshot() };
      },
      commit: async (a: CommitArgs) => {
        const k = `${a.playerId}:${a.idempotencyKey}`;
        const l = this.log.get(k);
        if (l) return l.hash === a.requestHash ? { status: "replay", response: structuredClone(l.response) } : { status: "mismatch" };
        const row = this.players.get(a.playerId);
        if (!row) return { status: "not_found" };
        if (row.state.stateVersion !== a.expectedVersion) return { status: "version_conflict", stateVersion: row.state.stateVersion };
        if (a.state) row.state = cloneState(a.state);
        this.log.set(k, { hash: a.requestHash, response: structuredClone(a.response) });
        return { status: a.state ? "committed" : "recorded", stateVersion: row.state.stateVersion };
      },
    };
  }

  /** 模擬 `${functionsUrl}/<fn>` */
  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const fn = url.pathname.split("/").pop() ?? "";
    const headers = new Headers(init.headers);
    const key = headers.get("Idempotency-Key");
    const body = typeof init.body === "string" && init.body ? JSON.parse(init.body) : undefined;
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    const rule = this.rules.find((r) => r.times > 0 && r.match(fn, body));
    if (rule) rule.times--;
    const fault = rule ? rule.fault : this.faults.shift();
    if (fault === "network") {
      this.requests.push({ fn, key, body, status: "network" });
      throw new TypeError("Failed to fetch");
    }
    const respond = (status: number, payload: unknown, extra: Record<string, string> = {}) => {
      this.requests.push({ fn, key, body, status });
      return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json", ...extra } });
    };
    if (fault === "malformed") return respond(200, { ok: true, requestId: key, command: "settle" }); // state / events 缺少
    if (fault === "busy") return respond(503, { ok: false, requestId: key, command: null, error: { code: "SERVER_BUSY", message: "try again" } });
    const token = /^Bearer (.+)$/.exec(headers.get("Authorization") ?? "")?.[1];
    const userId = token ? this.tokens.get(token) : undefined;
    if (fault === "unauthorized" || !userId) return respond(401, { ok: false, requestId: null, command: null, error: { code: "UNAUTHORIZED", message: "sign in required" } });

    const db = this.db();
    let r: ApiResponse;
    let replayed = false;
    if (fn === "character-create") {
      r = await createCharacter(db, userId);
      if (fault === "drop_response") return this.dropped(fn, key, body);
      return respond(r.ok ? 201 : httpStatus(r), r);
    }
    if (fn === "game-state") {
      r = await readState(db, userId);
    } else if (fn === "game-action") {
      if (!key) return respond(400, { ok: false, requestId: null, command: null, error: { code: "INVALID_REQUEST", message: "Idempotency-Key header is required" } });
      const out = await handleGameRequest(db, { playerId: userId, requestId: key, command: body?.command });
      r = out.response;
      replayed = out.replayed;
    } else {
      return respond(404, {});
    }
    // 伺服器已提交，但回應在網路上遺失（逾時）：Client 必須用同一個 key 重送
    if (fault === "drop_response") return this.dropped(fn, key, body);
    // 伺服器已提交，但回應在途中損壞
    if (fault === "malformed_after_commit") return respond(200, { ...r, state: { state: null } });
    return respond(httpStatus(r), r, { "Idempotent-Replayed": String(replayed) });
  };

  private dropped(fn: string, key: string | null, body: unknown): never {
    this.requests.push({ fn, key, body, status: "network" });
    throw new TypeError("network timeout after commit");
  }

  /** 已套用（committed）的 action 數 */
  committedActions(userId: string): number {
    return [...this.log.keys()].filter((k) => k.startsWith(`${userId}:`)).length;
  }
}
