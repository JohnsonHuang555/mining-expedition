/**
 * 寶物揭曉佇列（只影響 UI，不影響任何入帳）。
 *
 * 來源：伺服器確認後的 PlayerStateView.heldArtifacts 中「新出現」的寶物實例。
 * - 在線：settle / 操作前結算完成的方塊（block_completed 事件提供 isNewDiscovery / 首次保護）。
 * - 離線：claim_report 成功後才會出現在 heldArtifacts（領取前報告中的寶物不入列，D20）。
 * - 其他分頁 / 裝置取得、或拒絕回應（沒有事件）時，以持有清單的差異補上（標記以實例資料推得）。
 *
 * 去重鍵：instanceId（`d<digCounter>`，同一位玩家永不重複；同種寶物取得兩次是兩個不同的 key，合法顯示兩次）。
 * - 待播放的佇列與「已播放」紀錄依使用者保存在 localStorage：重新整理後繼續播放未看完的、已看過的不重播；
 *   多個分頁共用同一份，任一分頁看完 / 略過，其他分頁也移除。
 * - 已播放紀錄最多保留 SEEN_LIMIT 筆；被淘汰的以 floor（最大的被淘汰 digCounter）判定，因為 digCounter 只增不減。
 */

import { ARTIFACTS, type ArtifactId, type ArtifactRarity, ARTIFACT_IDS } from "@mining/game-data";

export interface RevealItem {
  /** = instanceId */
  key: string;
  digCounter: number;
  artifactId: ArtifactId;
  rarity: ArtifactRarity;
  isNewDiscovery: boolean;
  /** 首次寶物保護發放 */
  protection: boolean;
  origin: "online" | "offline";
}

interface Persisted {
  queue: RevealItem[];
  seen: { key: string; d: number }[];
  floor: number;
}

export const SEEN_LIMIT = 200;
export const QUEUE_LIMIT = 50;
export const revealStorageKey = (userId: string) => `mining-expedition:reveal:v1:${userId}`;

export function digOf(instanceId: string): number {
  const m = /^d(\d+)$/.exec(instanceId);
  return m ? Number(m[1]) : -1;
}

export interface RevealPersistence {
  read(): string | null;
  write(v: string | null): void;
  subscribe?(fn: () => void): () => void;
}

export function browserRevealPersistence(userId: string): RevealPersistence {
  const key = revealStorageKey(userId);
  let memory: string | null = null;
  const ls = () => {
    try {
      return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
      return null;
    }
  };
  return {
    read: () => {
      try {
        return ls()?.getItem(key) ?? memory;
      } catch {
        return memory;
      }
    },
    write: (v) => {
      memory = v;
      try {
        if (v === null) ls()?.removeItem(key);
        else ls()?.setItem(key, v);
      } catch {
        /* 只保留在記憶體 */
      }
    },
    subscribe: (fn) => {
      if (typeof window === "undefined") return () => {};
      const h = (e: StorageEvent) => (e.key === null || e.key === key) && fn();
      window.addEventListener("storage", h);
      return () => window.removeEventListener("storage", h);
    },
  };
}

export function memoryRevealPersistence(): RevealPersistence & { value: string | null; notify(): void } {
  const subs = new Set<() => void>();
  const p = {
    value: null as string | null,
    read: () => p.value,
    write: (v: string | null) => {
      p.value = v;
      subs.forEach((f) => f());
    },
    subscribe: (fn: () => void) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    notify: () => subs.forEach((f) => f()),
  };
  return p;
}

function parse(raw: string | null): Persisted {
  const empty: Persisted = { queue: [], seen: [], floor: -1 };
  if (!raw) return empty;
  try {
    const v = JSON.parse(raw) as Partial<Persisted>;
    const queue = Array.isArray(v.queue)
      ? v.queue.filter(
          (i): i is RevealItem =>
            !!i &&
            typeof i.key === "string" &&
            digOf(i.key) >= 0 &&
            (ARTIFACT_IDS as readonly string[]).includes(i.artifactId) &&
            typeof i.isNewDiscovery === "boolean" &&
            typeof i.protection === "boolean",
        ).map((i) => ({ ...i, digCounter: digOf(i.key), rarity: ARTIFACTS[i.artifactId].rarity, origin: i.origin === "offline" ? ("offline" as const) : ("online" as const) }))
      : [];
    const seen = Array.isArray(v.seen) ? v.seen.filter((s) => s && typeof s.key === "string" && typeof s.d === "number") : [];
    return { queue, seen, floor: typeof v.floor === "number" ? v.floor : -1 };
  } catch {
    return empty;
  }
}

export class RevealQueue {
  private readonly p: RevealPersistence;

  constructor(persistence: RevealPersistence = memoryRevealPersistence()) {
    this.p = persistence;
  }

  /** 每次都重新讀取（其他分頁可能剛修改） */
  items(): RevealItem[] {
    return parse(this.p.read()).queue;
  }

  isKnown(key: string): boolean {
    const s = parse(this.p.read());
    return this.known(s, key);
  }

  private known(s: Persisted, key: string): boolean {
    return digOf(key) <= s.floor || s.seen.some((x) => x.key === key) || s.queue.some((x) => x.key === key);
  }

  /** 加入佇列（依 digCounter 排序）；已在佇列中或已播放過的略過。回傳實際加入的筆數 */
  enqueue(items: RevealItem[]): number {
    if (items.length === 0) return 0;
    const s = parse(this.p.read());
    const fresh = items.filter((i, idx) => !this.known(s, i.key) && items.findIndex((x) => x.key === i.key) === idx);
    if (fresh.length === 0) return 0;
    s.queue = [...s.queue, ...fresh].sort((a, b) => a.digCounter - b.digCounter).slice(-QUEUE_LIMIT);
    this.p.write(JSON.stringify(s));
    return fresh.length;
  }

  /** 看完 / 略過一筆：移出佇列並記為已播放 */
  dismiss(key: string): void {
    this.dismissMany([key]);
  }

  dismissAll(): void {
    this.dismissMany(this.items().map((i) => i.key));
  }

  private dismissMany(keys: string[]): void {
    if (keys.length === 0) return;
    const s = parse(this.p.read());
    const set = new Set(keys);
    s.queue = s.queue.filter((i) => !set.has(i.key));
    for (const k of keys) if (!s.seen.some((x) => x.key === k)) s.seen.push({ key: k, d: digOf(k) });
    s.seen.sort((a, b) => a.d - b.d);
    while (s.seen.length > SEEN_LIMIT) {
      const old = s.seen.shift()!;
      s.floor = Math.max(s.floor, old.d);
    }
    this.p.write(JSON.stringify(s));
  }

  subscribe(fn: () => void): () => void {
    return this.p.subscribe?.(fn) ?? (() => {});
  }
}
