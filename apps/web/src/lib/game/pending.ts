/**
 * 未確認的玩家操作（結果不確定的 Action）與跨分頁協調。
 *
 * 一個操作送出前先保存 { requestId, command }；只有得到伺服器的確定結果（成功、或已保存的遊戲規則拒絕）後才刪除。
 * 網路錯誤、逾時、不合法回應、503 / 409 / 500 / 401 都「不代表伺服器沒有提交」，所以保留，之後以同一個 requestId 重送：
 * 伺服器的 action_log 會回傳原本的結果（已提交）或第一次執行（未提交），不會重複套用。
 *
 * 跨分頁（v2）：
 * - **每個操作一筆紀錄**（key 含 userId 與 requestId）：分頁只新增 / 刪除自己的那一筆，不會覆蓋其他分頁的未確認交易。
 * - 讀取一律直接讀 storage（不快取），並訂閱 `storage` 事件讓其他分頁的變化即時反映在畫面。
 * - 同一位使用者的玩家操作以 Web Locks（`navigator.locks`）在分頁之間排隊（見 ActionLock）。
 *   鎖只是為了體驗與減少重送；**正確性不依賴鎖**：鎖不可用 / 失效時，最壞情況是兩個分頁以同一個 requestId
 *   同時重送，由伺服器 action_log 保證只套用一次。
 * - 分頁崩潰 / 關閉：Web Locks 由瀏覽器自動釋放；未確認紀錄留在 storage，任何分頁下一次同步或重新開啟時調和。
 * - 離線：紀錄保留，恢復連線（online 事件 / 退避排程）後調和。
 */

import { type GameCommand, canonicalCommandJson, parseCommand } from "@mining/game-engine";

export interface PendingAction {
  requestId: string;
  command: GameCommand;
  /** 第一次送出的本機時間（epoch ms，只用於排序與顯示） */
  createdAt: number;
}

export interface PendingStore {
  /** 這位使用者所有未確認操作（舊 → 新），每次都重新讀取 storage */
  list(): PendingAction[];
  put(p: PendingAction): void;
  remove(requestId: string): void;
  /** 其他分頁修改時通知 */
  subscribe?(fn: () => void): () => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const pendingKeyPrefix = (userId: string) => `mining-expedition:pending-action:v2:${userId}:`;
export const pendingStorageKey = (userId: string, requestId: string) => `${pendingKeyPrefix(userId)}${requestId}`;
/** v1：每位使用者只有一筆（會被其他分頁覆蓋）。讀取時轉成 v2 */
export const legacyPendingStorageKey = (userId: string) => `mining-expedition:pending-action:v1:${userId}`;

export function sameCommand(a: GameCommand, b: GameCommand): boolean {
  return canonicalCommandJson(a) === canonicalCommandJson(b);
}

/** 讀回的資料不可信（可能被手動修改或來自舊版）：格式不對就丟棄 */
export function parsePending(raw: string | null): PendingAction | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<PendingAction>;
    if (typeof v.requestId !== "string" || !UUID.test(v.requestId)) return null;
    const parsed = parseCommand(v.command);
    if (!parsed.ok || parsed.command.type === "settle") return null;
    return { requestId: v.requestId, command: parsed.command, createdAt: typeof v.createdAt === "number" ? v.createdAt : 0 };
  } catch {
    return null;
  }
}

const byAge = (a: PendingAction, b: PendingAction) => a.createdAt - b.createdAt || a.requestId.localeCompare(b.requestId);

/** localStorage（每筆操作一個 key）；無法使用 storage 時退回記憶體（同一個分頁內仍然有效） */
export function browserPendingStore(userId: string, storageOverride?: Storage | null): PendingStore {
  const prefix = pendingKeyPrefix(userId);
  const memory = new Map<string, PendingAction>();
  const storage = (): Storage | null => {
    if (storageOverride !== undefined) return storageOverride;
    try {
      return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
      return null;
    }
  };
  const migrateLegacy = (s: Storage) => {
    const legacy = parsePending(s.getItem(legacyPendingStorageKey(userId)));
    if (legacy) s.setItem(pendingStorageKey(userId, legacy.requestId), JSON.stringify(legacy));
    s.removeItem(legacyPendingStorageKey(userId));
  };
  return {
    list() {
      const s = storage();
      if (!s) return [...memory.values()].sort(byAge);
      try {
        migrateLegacy(s);
        const out: PendingAction[] = [];
        for (let i = 0; i < s.length; i++) {
          const k = s.key(i);
          if (!k?.startsWith(prefix)) continue;
          const p = parsePending(s.getItem(k));
          if (p && k === prefix + p.requestId) out.push(p);
          else s.removeItem(k); // 格式錯誤的紀錄
        }
        // storage 寫入失敗時只存在記憶體的紀錄也要算進來
        for (const p of memory.values()) if (!out.some((x) => x.requestId === p.requestId)) out.push(p);
        return out.sort(byAge);
      } catch {
        return [...memory.values()].sort(byAge);
      }
    },
    put(p) {
      memory.set(p.requestId, p);
      try {
        storage()?.setItem(pendingStorageKey(userId, p.requestId), JSON.stringify(p));
        if (storage()) memory.delete(p.requestId);
      } catch {
        /* 私密模式或容量不足：只保留在記憶體 */
      }
    },
    remove(requestId) {
      memory.delete(requestId);
      try {
        storage()?.removeItem(pendingStorageKey(userId, requestId));
      } catch {
        /* ignore */
      }
    },
    subscribe(fn) {
      if (typeof window === "undefined") return () => {};
      const h = (e: StorageEvent) => {
        if (e.key === null || e.key.startsWith(prefix)) fn();
      };
      window.addEventListener("storage", h);
      return () => window.removeEventListener("storage", h);
    },
  };
}

/** 測試用：同一個物件可以給多個 Controller（模擬共用 storage 的多個分頁） */
export function memoryPendingStore(initial: PendingAction[] = []): PendingStore & { records: Map<string, PendingAction>; notify(): void } {
  const records = new Map(initial.map((p) => [p.requestId, p]));
  const subs = new Set<() => void>();
  return {
    records,
    list: () => [...records.values()].sort(byAge),
    put: (p) => {
      records.set(p.requestId, p);
      subs.forEach((f) => f());
    },
    remove: (id) => {
      records.delete(id);
      subs.forEach((f) => f());
    },
    subscribe: (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    notify: () => subs.forEach((f) => f()),
  };
}

// ---------------------------------------------------------------- 跨分頁鎖

export const LOCK_TIMEOUT = Symbol("lock-timeout");

export interface ActionLock {
  /** 取得這位使用者的交易鎖後執行 fn；等待超過 timeoutMs 回傳 LOCK_TIMEOUT（不執行 fn） */
  run<T>(fn: () => Promise<T>, timeoutMs?: number): Promise<T | typeof LOCK_TIMEOUT>;
}

/** Web Locks API（同一個 origin 的所有分頁共用；分頁關閉或崩潰時瀏覽器自動釋放）。不支援時只在分頁內排隊 */
export function browserActionLock(userId: string): ActionLock {
  const name = `mining-expedition:actions:${userId}`;
  const local = memoryActionLock();
  const locks = typeof navigator !== "undefined" ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
  if (!locks?.request) return local;
  return {
    async run(fn, timeoutMs = 20_000) {
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        return await locks.request(name, { signal }, () => fn());
      } catch (e) {
        if (signal.aborted) return LOCK_TIMEOUT;
        throw e;
      }
    },
  };
}

/** 記憶體中的 FIFO 鎖（測試時給多個 Controller 共用，模擬 Web Locks） */
export function memoryActionLock(): ActionLock & { held: boolean } {
  let tail: Promise<unknown> = Promise.resolve();
  const lock = {
    held: false,
    async run<T>(fn: () => Promise<T>, timeoutMs = 20_000): Promise<T | typeof LOCK_TIMEOUT> {
      const prev = tail;
      let release!: () => void;
      const mine = new Promise<void>((r) => (release = r));
      tail = prev.then(() => mine);
      let handle: ReturnType<typeof setTimeout> | undefined;
      const timer = new Promise<typeof LOCK_TIMEOUT>((r) => (handle = setTimeout(() => r(LOCK_TIMEOUT), timeoutMs)));
      const acquired = await Promise.race([prev.then(() => "ok" as const), timer]);
      clearTimeout(handle);
      if (acquired === LOCK_TIMEOUT) {
        // 不再等待，但仍讓佇列在前一個釋放後繼續
        void prev.then(release);
        return LOCK_TIMEOUT;
      }
      lock.held = true;
      try {
        return await fn();
      } finally {
        lock.held = false;
        release();
      }
    },
  };
  return lock;
}
