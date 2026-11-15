/**
 * 寶物揭曉佇列（只影響 UI，不影響任何入帳）。
 *
 * 來源：伺服器確認後的寶物實例（block_completed / report_claimed 事件；沒有事件時以持有清單的差異補上）。
 *
 * 去重鍵：instanceId（`d<digCounter>`，同一位玩家永不重複；同種寶物取得兩次是兩個不同的 key，合法顯示兩次）。
 *
 * 保存（v2，PR #12 Review P1）：依使用者、**每個實例各自一個 key**，不再對單一 JSON 做 read-modify-write，
 * 因此多個分頁同時入列 / 略過不會互相覆蓋（單一 key 的寫入是原子的）：
 * - `q:<instanceId>`：待播放項目。入列 = 只寫自己的 key。
 * - `s:<instanceId>`：已播放紀錄。略過 = 先寫 s，再刪 q。
 * - **已播放優先**：讀取時同時有 q 與 s 的項目視為已播放（並清掉 q）。所以「A 略過 X」與「B 以舊快照入列 X」交錯時，
 *   X 不會回來；兩個分頁分別入列 X、Y 也不會遺失任何一筆。
 * - 待播放項目**不截斷**（不會靜默遺失）：全部保留到看完 / 略過；儲存空間不足時該筆只保留在記憶體（本分頁仍會播放）。
 * - 已播放紀錄最多保留 SEEN_LIMIT 筆：清理在同帳號的 Web Lock 內進行，先把 floor（最大的被淘汰 digCounter，只增不減）寫好，
 *   再刪除較舊的紀錄；digCounter ≤ floor 視為已播放。瀏覽器不支援 Web Lock 時不清理（保守：只會多佔一點空間，不會重播）。
 */

import { ARTIFACTS, type ArtifactId, type ArtifactRarity, ARTIFACT_IDS } from "@mining/game-data";

export interface RevealItem {
  /** = instanceId */
  key: string;
  digCounter: number;
  artifactId: ArtifactId;
  rarity: ArtifactRarity;
  /** 只有伺服器事件 / 報告明確標示時才為 true（持有清單推得的一律 false，PR #12 Review P2） */
  isNewDiscovery: boolean;
  /** 首次寶物保護發放（來自實例的 source，確定） */
  protection: boolean;
  origin: "online" | "offline";
}

export const SEEN_LIMIT = 200;
export const revealNamespace = (userId: string) => `mining-expedition:reveal:v2:${userId}:`;
export const legacyRevealKey = (userId: string) => `mining-expedition:reveal:v1:${userId}`;

export function digOf(instanceId: string): number {
  const m = /^d(\d+)$/.exec(instanceId);
  return m ? Number(m[1]) : -1;
}

/** 依使用者分區的 key-value 儲存（每個 key 的讀寫各自原子） */
export interface RevealStore {
  get(key: string): string | null;
  /** 寫入失敗（例如空間不足）回傳 false */
  set(key: string, value: string): boolean;
  remove(key: string): void;
  keys(): string[];
  subscribe?(fn: () => void): () => void;
  /** 同帳號互斥（Web Lock）；不支援時回傳 null */
  withLock?(fn: () => void): Promise<boolean> | null;
}

export function browserRevealStore(userId: string): RevealStore {
  const ns = revealNamespace(userId);
  const ls = (): Storage | null => {
    try {
      return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
      return null;
    }
  };
  const store: RevealStore = {
    get: (k) => {
      try {
        return ls()?.getItem(ns + k) ?? null;
      } catch {
        return null;
      }
    },
    set: (k, v) => {
      try {
        const s = ls();
        if (!s) return false;
        s.setItem(ns + k, v);
        return true;
      } catch {
        return false;
      }
    },
    remove: (k) => {
      try {
        ls()?.removeItem(ns + k);
      } catch {
        /* ignore */
      }
    },
    keys: () => {
      const s = ls();
      if (!s) return [];
      const out: string[] = [];
      try {
        for (let i = 0; i < s.length; i++) {
          const k = s.key(i);
          if (k?.startsWith(ns)) out.push(k.slice(ns.length));
        }
      } catch {
        /* ignore */
      }
      return out;
    },
    subscribe: (fn) => {
      if (typeof window === "undefined") return () => {};
      const h = (e: StorageEvent) => (e.key === null || e.key.startsWith(ns)) && fn();
      window.addEventListener("storage", h);
      return () => window.removeEventListener("storage", h);
    },
    withLock: (fn) => {
      const locks = typeof navigator !== "undefined" ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
      if (!locks?.request) return null;
      return locks.request(`${ns}prune`, async () => fn()).then(
        () => true,
        () => false,
      );
    },
  };
  migrateLegacy(store, userId);
  return store;
}

/** v1（單一 JSON）→ v2（每個實例一個 key）。每一步都是冪等的單 key 寫入，多個分頁同時遷移也安全 */
function migrateLegacy(store: RevealStore, userId: string): void {
  let raw: string | null = null;
  try {
    raw = typeof localStorage === "undefined" ? null : localStorage.getItem(legacyRevealKey(userId));
  } catch {
    return;
  }
  if (!raw) return;
  try {
    const v = JSON.parse(raw) as { queue?: unknown[]; seen?: { key?: unknown }[]; floor?: unknown };
    for (const s of v.seen ?? []) if (typeof s?.key === "string" && digOf(s.key) >= 0) store.set(`s:${s.key}`, "1");
    for (const i of v.queue ?? []) {
      const item = validItem(i);
      if (item && store.get(`s:${item.key}`) === null) store.set(`q:${item.key}`, JSON.stringify(item));
    }
    if (typeof v.floor === "number") raiseFloor(store, v.floor);
  } catch {
    /* 損毀的舊資料：略過 */
  }
  try {
    localStorage.removeItem(legacyRevealKey(userId));
  } catch {
    /* ignore */
  }
}

/** 測試用：記憶體版，可被多個 RevealQueue 共用（模擬同一個瀏覽器的多個分頁） */
export function memoryRevealStore(opts: { locks?: boolean; quota?: number } = {}) {
  const subs = new Set<() => void>();
  const data = new Map<string, string>();
  let chain: Promise<unknown> = Promise.resolve();
  const s = {
    data,
    /** 測試：在下一次 set 之前執行（模擬另一個分頁的操作插入其中） */
    beforeSet: null as null | ((key: string) => void),
    get: (k: string) => data.get(k) ?? null,
    set: (k: string, v: string) => {
      const hook = s.beforeSet;
      if (hook) {
        s.beforeSet = null;
        hook(k);
      }
      if (opts.quota !== undefined && !data.has(k) && data.size >= opts.quota) return false;
      data.set(k, v);
      subs.forEach((f) => f());
      return true;
    },
    remove: (k: string) => {
      data.delete(k);
      subs.forEach((f) => f());
    },
    keys: () => [...data.keys()],
    subscribe: (fn: () => void) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    withLock: (fn: () => void): Promise<boolean> | null => {
      if (opts.locks === false) return null;
      const p = chain.then(() => fn()).then(
        () => true,
        () => false,
      );
      chain = p;
      return p;
    },
  };
  return s;
}

function validItem(i: unknown): RevealItem | null {
  if (!i || typeof i !== "object") return null;
  const v = i as Partial<RevealItem>;
  if (typeof v.key !== "string" || digOf(v.key) < 0) return null;
  if (!(ARTIFACT_IDS as readonly string[]).includes(v.artifactId as string)) return null;
  if (typeof v.isNewDiscovery !== "boolean" || typeof v.protection !== "boolean") return null;
  const artifactId = v.artifactId as ArtifactId;
  return {
    key: v.key,
    digCounter: digOf(v.key),
    artifactId,
    rarity: ARTIFACTS[artifactId].rarity,
    isNewDiscovery: v.isNewDiscovery,
    protection: v.protection,
    origin: v.origin === "offline" ? "offline" : "online",
  };
}

function readFloor(store: RevealStore): number {
  const n = Number(store.get("floor"));
  return Number.isFinite(n) && store.get("floor") !== null ? n : -1;
}

/** floor 只增不減（呼叫端在 Web Lock 內） */
function raiseFloor(store: RevealStore, d: number): boolean {
  if (readFloor(store) >= d) return true;
  return store.set("floor", String(d));
}

export class RevealQueue {
  private readonly store: RevealStore;
  /** 寫入失敗（空間不足）的項目：只保留在本分頁記憶體，仍會播放 */
  private readonly overflow = new Map<string, RevealItem>();
  private readonly localSeen = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private pruning = false;

  constructor(store: RevealStore = memoryRevealStore()) {
    this.store = store;
  }

  private isSeen(key: string, floor = readFloor(this.store)): boolean {
    return digOf(key) <= floor || this.localSeen.has(key) || this.store.get(`s:${key}`) !== null;
  }

  /** 每次都重新讀取（其他分頁可能剛修改）；依 digCounter 排序 */
  items(): RevealItem[] {
    const floor = readFloor(this.store);
    const out = new Map<string, RevealItem>();
    for (const k of this.store.keys()) {
      if (!k.startsWith("q:")) continue;
      const key = k.slice(2);
      if (this.isSeen(key, floor)) {
        this.store.remove(k); // 已播放優先：清掉晚到的舊入列
        continue;
      }
      let item: RevealItem | null = null;
      try {
        item = validItem(JSON.parse(this.store.get(k) ?? "null"));
      } catch {
        item = null;
      }
      if (item && item.key === key) out.set(key, item);
      else this.store.remove(k);
    }
    for (const [key, item] of this.overflow) {
      if (this.isSeen(key, floor)) this.overflow.delete(key);
      else if (!out.has(key)) out.set(key, item);
    }
    return [...out.values()].sort((a, b) => a.digCounter - b.digCounter);
  }

  isKnown(key: string): boolean {
    return this.isSeen(key) || this.store.get(`q:${key}`) !== null || this.overflow.has(key);
  }

  /** 加入佇列；已在佇列中或已播放過的略過。不截斷。回傳實際加入（可播放）的筆數 */
  enqueue(items: RevealItem[]): number {
    let added = 0;
    const done = new Set<string>();
    for (const i of items) {
      if (done.has(i.key) || digOf(i.key) < 0) continue;
      done.add(i.key);
      if (this.isKnown(i.key)) continue;
      const item: RevealItem = { ...i, digCounter: digOf(i.key), rarity: ARTIFACTS[i.artifactId].rarity };
      if (!this.store.set(`q:${i.key}`, JSON.stringify(item))) this.overflow.set(i.key, item);
      added++;
    }
    if (added > 0) this.emit();
    return added;
  }

  /** 看完 / 略過一筆：先記為已播放，再移出佇列 */
  dismiss(key: string): void {
    this.dismissMany([key]);
  }

  dismissAll(): void {
    this.dismissMany(this.items().map((i) => i.key));
  }

  private dismissMany(keys: string[]): void {
    if (keys.length === 0) return;
    for (const k of keys) {
      if (!this.store.set(`s:${k}`, "1")) this.localSeen.add(k); // 空間不足：至少本分頁不重播
      this.store.remove(`q:${k}`);
      this.overflow.delete(k);
    }
    this.emit();
    this.prune();
  }

  /** 已播放紀錄超過上限：在 Web Lock 內先提高 floor、再刪除較舊的紀錄（不支援 Web Lock 時不清理） */
  prune(): Promise<void> {
    const seenKeys = () => this.store.keys().filter((k) => k.startsWith("s:"));
    if (this.pruning || seenKeys().length <= SEEN_LIMIT || !this.store.withLock) return Promise.resolve();
    const run = this.store.withLock(() => {
      const all = seenKeys()
        .map((k) => ({ k, d: digOf(k.slice(2)) }))
        .sort((a, b) => a.d - b.d);
      const evict = all.slice(0, Math.max(0, all.length - SEEN_LIMIT));
      if (evict.length === 0) return;
      const floor = evict[evict.length - 1]!.d;
      // 待播放中、digCounter ≤ floor 的項目不能被 floor 吃掉：保留到播放後
      const pending = this.items().some((i) => i.digCounter <= floor);
      if (pending) return;
      if (!raiseFloor(this.store, floor)) return;
      for (const e of evict) this.store.remove(e.k);
    });
    if (!run) return Promise.resolve();
    this.pruning = true;
    return run.then(() => {
      this.pruning = false;
    });
  }

  private emit(): void {
    this.listeners.forEach((f) => f());
  }

  /** 本分頁的變更與其他分頁（storage event）的變更 */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    const off = this.store.subscribe?.(fn) ?? (() => {});
    return () => {
      this.listeners.delete(fn);
      off();
    };
  }
}
