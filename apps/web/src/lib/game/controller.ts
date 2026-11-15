/**
 * 遊戲同步控制器（TECHNICAL_SPEC §12.3、§12.6）：所有對伺服器的狀態操作都經過這裡。
 *
 * - 同時只允許一個會改變狀態的操作；自動同步（settle）在已有操作進行中時合併到該操作，不另外送出。
 * - 玩家操作（領取、切換模式、解鎖、出售、購買、裝備、強化、製作）一律經過 perform()：
 *   送出前把 { requestId, command } 存成「未確認操作」（依使用者保存在 storage）；
 *   只有得到伺服器的確定結果才清除。網路錯誤 / 逾時 / 不合法回應 / 503 / 衝突都保留，
 *   之後（玩家重試、下一次同步、重新整理頁面）以同一個 requestId 重送，由伺服器的 action_log 調和，
 *   不會因為回應遺失而重複購買或出售。未確認期間不接受其他玩家操作。
 * - 自動結算（settle）不需要保存：重複結算不會重複發放（結算只依伺服器時間推進）。
 * - 排程：setTimeout 鏈，一次只有一個計時器；分頁隱藏時暫停，回到前景立即同步。
 *   - 心跳：最長 HEARTBEAT_MS 一定同步一次（在線門檻 300 秒，GBS §15）
 *   - 預測目前方塊完成時：完成時間 + 300ms，但距離上次同步至少 BLOCK_SYNC_MIN_MS
 *   - 失敗：指數退避（最長 30 秒）；瀏覽器 online 事件時立即重試
 * - 不在 Client 補算任何成果：超過 300 秒沒有同步時由伺服器產生離線報告。
 * - 多分頁：成功提交後經 BroadcastChannel 通知 stateVersion；其他分頁看到較新的版本時重新讀取伺服器狀態。
 * - dispose() 之後不再寫入 store、不再排程、關閉 BroadcastChannel；進行中的請求回來時直接丟棄
 *   （未確認操作仍保存在該使用者的 storage，下次登入同一位使用者時調和）。
 */

import type { MiningMode } from "@mining/game-data";
import { type GameCommand, type ZoneIndex, predictBlockProgress } from "@mining/game-engine";
import { type ApiResult, type GameApi, newRequestId } from "./api";
import { type PendingAction, type PendingStore, memoryPendingStore, sameCommand } from "./pending";
import { type BusyOp, type GameStore, type GameUiState, initialUiState, lootFromEvents, mergeLoot } from "./store";

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
  close(): void;
}

export interface ControllerOptions {
  api: GameApi;
  store: GameStore;
  clock?: Clock;
  channel?: SyncChannel | null;
  /** 這位使用者的未確認操作保存處（預設：只在記憶體） */
  pendingStore?: PendingStore;
  /** 登入失效（token 更新失敗）：導向登入頁 */
  onSignedOut?(): void;
  /** 分頁是否在前景 */
  isVisible?(): boolean;
}

export type ActionOutcome = "ok" | "rejected" | "uncertain" | "blocked";
type ActionEvents = import("@mining/game-engine").GameEvent[];

const browserClock: Clock = {
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function browserChannel(name = "mining-expedition:state"): SyncChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  const ch = new BroadcastChannel(name);
  let closed = false;
  return {
    post: (v) => {
      if (!closed) ch.postMessage({ type: "committed", stateVersion: v });
    },
    subscribe: (fn) => {
      const h = (e: MessageEvent) => {
        if (e.data?.type === "committed" && typeof e.data.stateVersion === "number") fn(e.data.stateVersion);
      };
      ch.addEventListener("message", h);
      return () => ch.removeEventListener("message", h);
    },
    close: () => {
      closed = true;
      ch.close();
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
  INSUFFICIENT_ITEMS: "素材或物品不足",
  ZONE_LOCKED: "礦區尚未解鎖",
  PREREQUISITE_MISSING: "尚未達成條件",
  MAX_LEVEL: "已達最高等級",
  INVALID_REQUEST: "操作內容不正確",
  UNCERTAIN: "網路不穩，操作結果尚未確認；恢復連線後會以同一筆請求自動確認（不會重複扣款）",
  PENDING_OTHER: "上一個操作的結果尚未確認，確認後才能進行其他操作",
};
export const messageFor = (code: string, fallback?: string) => MESSAGES[code] ?? fallback ?? "操作失敗";

/** 沒有得到伺服器確定結果的錯誤：不能假設伺服器沒有提交 */
const UNCERTAIN = new Set(["NETWORK", "BAD_RESPONSE", "SERVER_BUSY", "VERSION_CONFLICT", "INTERNAL_ERROR", "UNAUTHORIZED"]);
const isUncertain = (r: Extract<ApiResult, { ok: false }>) => r.body === null || UNCERTAIN.has(r.code);

const OP_OF: Record<GameCommand["type"], BusyOp> = {
  settle: "settle",
  claim_report: "claim",
  select_mining_mode: "mode",
  unlock_zone: "unlock",
  sell_items: "sell",
  sell_artifacts: "sell",
  purchase_pickaxe: "buy",
  equip_pickaxe: "equip",
  upgrade_pickaxe: "upgrade",
  craft: "craft",
};

export class GameController {
  private readonly api: GameApi;
  private readonly store: GameStore;
  private readonly clock: Clock;
  private readonly channel: SyncChannel | null;
  private readonly pendingStore: PendingStore;
  private readonly opts: ControllerOptions;
  private op: Promise<unknown> | null = null;
  private timer: unknown = null;
  private active = 0;
  private booted: Promise<void> | null = null;
  private unsubscribe: (() => void) | null = null;
  private lastSyncAt = -Infinity;
  private disposed = false;

  constructor(opts: ControllerOptions) {
    this.opts = opts;
    this.api = opts.api;
    this.store = opts.store;
    this.clock = opts.clock ?? browserClock;
    this.channel = opts.channel === undefined ? browserChannel() : opts.channel;
    this.pendingStore = opts.pendingStore ?? memoryPendingStore();
    // 重新整理前未確認的操作：恢復，bootstrap 時調和
    const restored = this.pendingStore.load();
    if (restored) this.set({ pending: restored });
  }

  get state(): GameUiState {
    return this.store.getState();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  // ---------------------------------------------------------------- 生命週期

  /** 掛載畫面時呼叫；可重複呼叫（Strict Mode） */
  start(): void {
    if (this.disposed) return;
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

  /** 永久停止：不再寫入 store、清除計時器、關閉 BroadcastChannel。進行中的請求結果會被丟棄 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active = 0;
    this.clearTimer();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.channel?.close();
  }

  /** 登入後第一次載入：game-state → 沒有角色顯示建立畫面；有角色則先調和未確認操作，再結算到現在。只執行一次 */
  bootstrap(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.booted ??= this.exclusive("bootstrap", async () => {
      const r = await this.api.getState();
      if (this.disposed) return;
      if (!r.ok) {
        if (r.code === "CHARACTER_NOT_FOUND") return this.set({ phase: "no_character" });
        return this.handleFailure(r, "bootstrap");
      }
      this.applyView(r, false);
      this.set({ phase: "ready" });
      if (this.state.pending) {
        const o = await this.send(this.state.pending);
        if (o === "uncertain") return;
      }
      if (!this.state.view?.state.pendingOfflineReport) await this.doSettle();
    }).catch(() => {
      this.booted = null; // 失敗時允許重新開始
    });
    return this.booted;
  }

  /** 重新載入（例如錯誤畫面的「重試」） */
  retryBootstrap(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.booted = null;
    this.set({ error: null, phase: "booting" });
    return this.bootstrap().then(() => this.schedule());
  }

  // ---------------------------------------------------------------- 玩家操作

  createCharacter(): Promise<boolean> {
    if (this.disposed || this.op) return Promise.resolve(false);
    return this.exclusive("create", async () => {
      const r = await this.api.createCharacter();
      if (this.disposed) return false;
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

  /** 立即同步（按鈕、回到前景、定時）：先調和未確認操作，再結算 */
  sync(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.op) return this.op.then(() => undefined); // 合併到進行中的操作
    if (this.state.phase !== "ready") return Promise.resolve();
    const pending = this.state.pending;
    return this.exclusive(pending ? "reconcile" : "settle", async () => {
      if (pending) {
        const o = await this.send(pending);
        if (o === "uncertain" || this.state.view?.state.pendingOfflineReport) return;
      }
      await this.doSettle();
    }).then(() => this.schedule());
  }

  /**
   * 送出一個玩家操作。
   * - 有其他操作進行中 / 有待領取報告（領取除外）/ 有「不同的」未確認操作 → blocked（不送出）
   * - 與未確認操作相同的指令 → 沿用同一個 requestId（重試）
   */
  perform(command: GameCommand): Promise<ActionOutcome> {
    if (this.disposed || command.type === "settle") return Promise.resolve("blocked");
    if (this.op) return Promise.resolve("blocked");
    const pending = this.state.pending;
    if (pending && !sameCommand(pending.command, command)) {
      this.set({ notice: messageFor("PENDING_OTHER") });
      return Promise.resolve("blocked");
    }
    if (command.type !== "claim_report" && this.state.view?.state.pendingOfflineReport) {
      this.set({ notice: messageFor("REPORT_PENDING") });
      return Promise.resolve("blocked");
    }
    const action: PendingAction = pending ?? { requestId: newRequestId(), command, createdAt: Date.now() };
    return this.exclusive(OP_OF[command.type], () => this.send(action)).then((o) => {
      this.schedule();
      return o;
    });
  }

  claimReport(): Promise<boolean> {
    const report = this.state.view?.state.pendingOfflineReport;
    if (!report) return Promise.resolve(false);
    return this.perform({ type: "claim_report", reportId: report.reportId }).then((o) => o === "ok");
  }

  selectMode(mode: MiningMode, zone?: ZoneIndex): Promise<boolean> {
    const command: GameCommand = mode === "revisit" ? { type: "select_mining_mode", mode, zone: zone! } : { type: "select_mining_mode", mode };
    return this.perform(command).then((o) => o === "ok");
  }

  unlockZone(zone: 1 | 2): Promise<boolean> {
    return this.perform({ type: "unlock_zone", zone }).then((o) => o === "ok");
  }

  dismissNotice(): void {
    this.set({ notice: null });
  }

  // ---------------------------------------------------------------- 內部

  private setPending(p: PendingAction | null): void {
    if (this.disposed) return;
    this.pendingStore.save(p);
    this.set({ pending: p });
  }

  /** 以 action.requestId 送出（或重送）；依結果決定是否清除未確認操作 */
  private async send(action: PendingAction): Promise<ActionOutcome> {
    this.setPending(action);
    const r = await this.api.action(action.command, action.requestId);
    if (this.disposed) return "uncertain"; // 已登出 / 換帳號：不寫入任何畫面狀態；未確認操作留在該使用者的 storage
    const result = (outcome: "ok" | "rejected" | "uncertain", message: string | null, events: ActionEvents = []) =>
      this.set({ lastAction: { requestId: action.requestId, command: action.command.type, outcome, message, events, at: Date.now() } });

    if (r.ok) {
      this.setPending(null);
      this.applyOk(r);
      // 只保留這個操作本身的事件（不含操作前的在線結算方塊）
      result("ok", null, r.body.events.filter((e) => e.type !== "block_completed" && e.type !== "mining_stopped"));
      return "ok";
    }
    if (isUncertain(r)) {
      if (r.code === "UNAUTHORIZED") {
        this.handleFailure(r, "reconcile");
        return "uncertain";
      }
      this.handleFailure(r, "reconcile");
      this.set({ notice: messageFor("UNCERTAIN") });
      result("uncertain", messageFor("UNCERTAIN"));
      return "uncertain";
    }
    // 伺服器確定的拒絕（已保存在 action_log 的回應）：沒有任何變更，可以清除
    this.setPending(null);
    result("rejected", messageFor(r.code, r.message));
    if (r.code === "REPORT_ALREADY_CLAIMED" || r.code === "REPORT_NOT_FOUND") {
      this.set({ notice: messageFor("REPORT_ALREADY_CLAIMED") });
      await this.doRefresh();
      return "rejected";
    }
    this.handleFailure(r, "reconcile");
    if (r.code === "REPORT_PENDING") await this.doRefresh();
    return "rejected";
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
    if (this.disposed) return;
    if (r.ok) return this.applyOk(r);
    this.handleFailure(r, "settle");
    if (r.code === "REPORT_PENDING" || r.code === "VERSION_CONFLICT") await this.doRefresh();
  }

  private async doRefresh(): Promise<void> {
    const r = await this.api.getState();
    if (this.disposed) return;
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

  private handleFailure(r: Extract<ApiResult, { ok: false }>, op: BusyOp): void {
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
    // 未確認操作保留在這位使用者的 storage（同一位使用者重新登入時調和），但不留在畫面狀態
    this.store.setState({ ...initialUiState(), phase: "signed_out" });
    this.opts.onSignedOut?.();
  }

  /** 其他分頁提交了較新的狀態：重新讀取（唯讀），再盡快結算 */
  private async onRemoteCommit(stateVersion: number): Promise<void> {
    if (this.disposed) return;
    const mine = this.state.view?.state.stateVersion ?? -1;
    if (stateVersion <= mine || this.op || this.state.phase !== "ready") return;
    await this.exclusive("refresh", () => this.doRefresh());
    this.schedule(2_000);
  }

  /** 回到前景 / 恢復網路 */
  onResume(): void {
    if (this.active === 0 || this.disposed) return;
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
    if (s.pending) return 5_000; // 未確認操作：盡快調和
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
    if (this.disposed) return;
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

  /** dispose 之後的任何寫入都丟棄（舊請求回來時不得覆蓋畫面） */
  private set(patch: Partial<GameUiState>): void {
    if (this.disposed) return;
    this.store.setState(patch);
  }
}
