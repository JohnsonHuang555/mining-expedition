/**
 * 遊戲同步控制器（TECHNICAL_SPEC §12.3）：所有對伺服器的狀態操作都經過這裡。
 *
 * - 同時只允許一個會改變狀態的操作；自動同步（settle）在已有操作進行中時合併到該操作，不另外送出。
 * - 每個獨立操作產生一個新的 Idempotency-Key，重試（API Client 內的退避、或玩家按「重試」領取同一份報告）沿用同一個。
 * - 排程：setTimeout 鏈（不是 setInterval），一次只會有一個計時器；分頁隱藏時暫停，回到前景立即同步。
 *   - 心跳：最長 HEARTBEAT_MS 一定同步一次（在線門檻 300 秒，GBS §15）
 *   - 預測目前方塊完成時：完成時間 + 300ms，但距離上次同步至少 BLOCK_SYNC_MIN_MS
 *   - 失敗：指數退避（最長 30 秒）；瀏覽器 online 事件時立即重試
 * - 不在 Client 補算任何成果：超過 300 秒沒有同步（例如背景分頁）時，由伺服器產生離線報告，這是預期行為。
 * - 多分頁：成功提交後經 BroadcastChannel 通知 stateVersion；其他分頁看到較新的版本時重新讀取伺服器狀態。
 * - 可以在 React Strict Mode 下重複 start / stop：bootstrap 只執行一次，計時器只會有一個。
 */

import type { MiningMode } from "@mining/game-data";
import { type GameCommand, type ZoneIndex, predictBlockProgress } from "@mining/game-engine";
import { type ApiResult, type GameApi, newRequestId } from "./api";
import { type BusyOp, type GameStore, initialUiState, lootFromEvents, mergeLoot } from "./store";

export const HEARTBEAT_MS = 20_000;
export const BLOCK_SYNC_MIN_MS = 10_000;
export const BLOCK_SYNC_SLACK_MS = 300;
export const MAX_BACKOFF_MS = 30_000;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SyncChannel {
  post(stateVersion: number): void;
  subscribe(fn: (stateVersion: number) => void): () => void;
}

export interface ControllerOptions {
  api: GameApi;
  store: GameStore;
  clock?: Clock;
  channel?: SyncChannel | null;
  /** 登入失效（token 更新失敗）：導向登入頁 */
  onSignedOut?(): void;
  /** 分頁是否在前景 */
  isVisible?(): boolean;
}

const browserClock: Clock = {
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function browserChannel(name = "mining-expedition:state"): SyncChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  const ch = new BroadcastChannel(name);
  return {
    post: (v) => ch.postMessage({ type: "committed", stateVersion: v }),
    subscribe: (fn) => {
      const h = (e: MessageEvent) => {
        if (e.data?.type === "committed" && typeof e.data.stateVersion === "number") fn(e.data.stateVersion);
      };
      ch.addEventListener("message", h);
      return () => ch.removeEventListener("message", h);
    },
  };
}

const MESSAGES: Partial<Record<string, string>> = {
  NETWORK: "連線中斷，正在重試…",
  SERVER_BUSY: "伺服器忙碌，正在重試…",
  VERSION_CONFLICT: "其他裝置同時操作，正在重新同步…",
  INTERNAL_ERROR: "伺服器狀態異常，請稍後再試",
  BAD_RESPONSE: "伺服器回應異常，正在重試…",
  REPORT_PENDING: "請先領取探險報告",
  REPORT_ALREADY_CLAIMED: "這份報告已經領取過了（可能在其他分頁），已重新同步",
  INSUFFICIENT_COINS: "金幣不足",
  ZONE_LOCKED: "礦區尚未解鎖",
  PREREQUISITE_MISSING: "尚未達成條件",
};
export const messageFor = (code: string, fallback?: string) => MESSAGES[code] ?? fallback ?? "操作失敗";

export class GameController {
  private readonly api: GameApi;
  private readonly store: GameStore;
  private readonly clock: Clock;
  private readonly channel: SyncChannel | null;
  private readonly opts: ControllerOptions;
  private op: Promise<unknown> | null = null;
  private timer: unknown = null;
  private active = 0;
  private booted: Promise<void> | null = null;
  private unsubscribe: (() => void) | null = null;
  private lastSyncAt = -Infinity;
  /** 同一份報告的領取沿用同一個 key（玩家按重試、或網路逾時後重送） */
  private claimKeys = new Map<string, string>();
  private disposed = false;

  constructor(opts: ControllerOptions) {
    this.opts = opts;
    this.api = opts.api;
    this.store = opts.store;
    this.clock = opts.clock ?? browserClock;
    this.channel = opts.channel === undefined ? browserChannel() : opts.channel;
  }

  get state() {
    return this.store.getState();
  }

  // ---------------------------------------------------------------- 生命週期

  /** 掛載畫面時呼叫；可重複呼叫（Strict Mode） */
  start(): void {
    this.active++;
    if (this.active === 1) {
      this.unsubscribe = this.channel?.subscribe((v) => void this.onRemoteCommit(v)) ?? null;
      void this.bootstrap().then(() => this.schedule());
    }
  }

  stop(): void {
    this.active = Math.max(0, this.active - 1);
    if (this.active === 0) {
      this.clearTimer();
      this.unsubscribe?.();
      this.unsubscribe = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.active = 0;
    this.clearTimer();
    this.unsubscribe?.();
  }

  /** 登入後第一次載入：game-state → 沒有角色則顯示建立畫面；有角色則立即結算到現在。只執行一次 */
  bootstrap(): Promise<void> {
    this.booted ??= this.exclusive("bootstrap", async () => {
      const r = await this.api.getState();
      if (!r.ok) {
        if (r.code === "CHARACTER_NOT_FOUND") return this.set({ phase: "no_character" });
        return this.handleFailure(r, "bootstrap");
      }
      this.applyView(r, false);
      this.set({ phase: "ready" });
      if (!r.body.state.state.pendingOfflineReport) await this.doSettle();
    }).catch(() => {
      this.booted = null; // 失敗時允許重新開始
    });
    return this.booted;
  }

  /** 重新載入（例如錯誤畫面的「重試」） */
  retryBootstrap(): Promise<void> {
    this.booted = null;
    this.set({ error: null, phase: "booting" });
    return this.bootstrap().then(() => this.schedule());
  }

  // ---------------------------------------------------------------- 玩家操作

  createCharacter(): Promise<boolean> {
    return this.userOp("create", async () => {
      const r = await this.api.createCharacter();
      if (!r.ok && r.code !== "CHARACTER_EXISTS") {
        this.handleFailure(r, "create");
        return false;
      }
      // 201 或已存在（其他分頁 / 重送）都進入遊戲；之後以伺服器狀態為準
      this.booted = null;
      this.set({ phase: "booting" });
      return true;
    }).then(async (ok) => {
      if (ok) {
        await this.bootstrap();
        this.schedule();
      }
      return ok;
    });
  }

  /** 立即同步（按鈕、回到前景、定時） */
  sync(): Promise<void> {
    if (this.op) return this.op.then(() => undefined); // 合併到進行中的操作
    if (this.state.phase !== "ready") return Promise.resolve();
    return this.exclusive("settle", () => this.doSettle()).then(() => this.schedule());
  }

  claimReport(): Promise<boolean> {
    const report = this.state.view?.state.pendingOfflineReport;
    if (!report) return Promise.resolve(false);
    const key = this.claimKeys.get(report.reportId) ?? newRequestId();
    this.claimKeys.set(report.reportId, key);
    return this.userOp("claim", async () => {
      const r = await this.api.action({ type: "claim_report", reportId: report.reportId }, key);
      if (r.ok) {
        this.claimKeys.delete(report.reportId);
        this.applyOk(r);
        return true;
      }
      if (r.code === "REPORT_ALREADY_CLAIMED" || r.code === "REPORT_NOT_FOUND") {
        this.claimKeys.delete(report.reportId);
        this.set({ notice: messageFor("REPORT_ALREADY_CLAIMED") });
        await this.doRefresh();
        return false;
      }
      this.handleFailure(r, "claim");
      return false;
    }).then((ok) => {
      this.schedule();
      return ok;
    });
  }

  selectMode(mode: MiningMode, zone?: ZoneIndex): Promise<boolean> {
    const command: GameCommand = mode === "revisit" ? { type: "select_mining_mode", mode, zone: zone! } : { type: "select_mining_mode", mode };
    return this.command("mode", command);
  }

  unlockZone(zone: 1 | 2): Promise<boolean> {
    return this.command("unlock", { type: "unlock_zone", zone });
  }

  dismissNotice(): void {
    this.set({ notice: null });
  }

  // ---------------------------------------------------------------- 內部

  private command(op: BusyOp, command: GameCommand): Promise<boolean> {
    return this.userOp(op, async () => {
      const r = await this.api.action(command, newRequestId());
      if (r.ok) {
        this.applyOk(r);
        return true;
      }
      this.handleFailure(r, op);
      return false;
    }).then((ok) => {
      this.schedule();
      return ok;
    });
  }

  /** 玩家操作：有其他操作進行中、或有待領取報告（claim 除外）時不送出 */
  private userOp<T>(op: BusyOp, fn: () => Promise<T>): Promise<T | false> {
    if (this.op) return Promise.resolve(false);
    if (op !== "claim" && op !== "create" && this.state.view?.state.pendingOfflineReport) {
      this.set({ notice: messageFor("REPORT_PENDING") });
      return Promise.resolve(false);
    }
    return this.exclusive(op, fn);
  }

  private exclusive<T>(op: BusyOp, fn: () => Promise<T>): Promise<T> {
    this.clearTimer();
    this.set({ busy: op });
    const p = fn().finally(() => {
      if (this.op === p) this.op = null;
      this.set({ busy: null });
    });
    this.op = p;
    return p;
  }

  private async doSettle(): Promise<void> {
    const r = await this.api.action({ type: "settle" }, newRequestId());
    if (r.ok) return this.applyOk(r);
    this.handleFailure(r, "settle");
    if (r.code === "REPORT_PENDING" || r.code === "VERSION_CONFLICT") await this.doRefresh();
  }

  private async doRefresh(): Promise<void> {
    const r = await this.api.getState();
    if (r.ok) {
      this.applyView(r, false);
      this.markSyncOk();
    } else this.handleFailure(r, "refresh");
  }

  private applyOk(r: Extract<ApiResult, { ok: true }>): void {
    const { body } = r;
    this.applyView(r, true);
    const blocks = lootFromEvents(body.events);
    const s = this.state;
    this.set({
      recentLoot: mergeLoot(s.recentLoot, blocks),
      lastSettlement: body.settlement && body.settlement.kind !== "noop" ? { summary: body.settlement, blocks, at: this.clock.now() } : s.lastSettlement,
    });
    this.markSyncOk();
    this.channel?.post(body.stateVersion);
  }

  private applyView(r: Extract<ApiResult, { ok: true }>, fresh: boolean): void {
    this.set({ view: r.body.state, fresh, receivedAt: this.clock.now(), phase: "ready", error: null });
  }

  private markSyncOk(): void {
    this.lastSyncAt = this.clock.now();
    this.set({ sync: { ok: true, lastOkAt: this.lastSyncAt, failures: 0, message: null } });
  }

  private handleFailure(r: Extract<ApiResult, { ok: false }>, op: BusyOp | "bootstrap"): void {
    if (r.code === "UNAUTHORIZED") {
      this.signedOut();
      return;
    }
    if (r.code === "CHARACTER_NOT_FOUND") {
      this.set({ phase: "no_character" });
      return;
    }
    // 遊戲規則拒絕時附上的狀態：顯示，但不是「現在」的狀態（不預測）
    if (r.body?.state) this.set({ view: r.body.state, fresh: false, receivedAt: this.clock.now() });
    const transient = r.code === "NETWORK" || r.code === "SERVER_BUSY" || r.code === "VERSION_CONFLICT" || r.code === "BAD_RESPONSE";
    if (transient) {
      const failures = this.state.sync.failures + 1;
      this.set({ sync: { ...this.state.sync, ok: false, failures, message: messageFor(r.code) } });
      if (op === "bootstrap" && !this.state.view) this.set({ phase: "error", error: messageFor(r.code) });
      return;
    }
    if (r.code === "INTERNAL_ERROR") {
      this.set({ error: messageFor(r.code), ...(op === "bootstrap" && !this.state.view ? { phase: "error" as const } : {}) });
      return;
    }
    this.set({ notice: messageFor(r.code, r.message) });
  }

  private signedOut(): void {
    this.clearTimer();
    this.booted = null;
    this.claimKeys.clear();
    this.store.setState({ ...initialUiState(), phase: "signed_out" });
    this.opts.onSignedOut?.();
  }

  /** 其他分頁提交了較新的狀態：重新讀取（唯讀），再盡快結算 */
  private async onRemoteCommit(stateVersion: number): Promise<void> {
    const mine = this.state.view?.state.stateVersion ?? -1;
    if (stateVersion <= mine || this.op || this.state.phase !== "ready") return;
    await this.exclusive("refresh", () => this.doRefresh());
    this.schedule(2_000);
  }

  /** 回到前景 / 恢復網路 */
  onResume(): void {
    if (this.active === 0) return;
    if (this.state.phase === "error") void this.retryBootstrap();
    else void this.sync();
  }

  onHidden(): void {
    this.clearTimer();
  }

  /** 下一次自動同步的延遲（毫秒）；null = 不排程 */
  nextDelay(): number | null {
    const s = this.state;
    if (this.disposed || this.active === 0) return null;
    if (this.opts.isVisible && !this.opts.isVisible()) return null;
    // 第一次載入因網路失敗：退避後自動重新載入
    if (s.phase === "error" && !s.sync.ok) return Math.min(MAX_BACKOFF_MS, 5_000 * 2 ** Math.max(0, s.sync.failures - 1));
    if (s.phase !== "ready" || !s.view) return null;
    if (s.view.state.pendingOfflineReport) return null; // D24：暫停；等玩家領取
    if (!s.sync.ok) return Math.min(MAX_BACKOFF_MS, 5_000 * 2 ** Math.max(0, s.sync.failures - 1));
    const sinceSync = this.clock.now() - this.lastSyncAt;
    let target = HEARTBEAT_MS;
    if (s.fresh) {
      const p = predictBlockProgress(s.view.state, this.clock.now() - s.receivedAt);
      if (p.msToNextBlock !== null) target = Math.min(HEARTBEAT_MS, Math.max(BLOCK_SYNC_MIN_MS, sinceSync + p.msToNextBlock + BLOCK_SYNC_SLACK_MS));
    } else {
      target = Math.min(HEARTBEAT_MS, 2_000 + Math.max(0, sinceSync)); // 狀態不是最新：盡快結算
    }
    return Math.max(0, target - Math.max(0, sinceSync));
  }

  private schedule(override?: number): void {
    this.clearTimer();
    const delay = override ?? this.nextDelay();
    if (delay === null) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (this.state.phase === "error") void this.retryBootstrap();
      else void this.sync();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private set(patch: Partial<ReturnType<GameStore["getState"]>>): void {
    this.store.setState(patch);
  }
}
