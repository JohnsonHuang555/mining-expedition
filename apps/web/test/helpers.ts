import { createGameApi } from "@/lib/game/api";
import { type Clock, GameController, type SyncChannel } from "@/lib/game/controller";
import { MemoryBackend } from "@/lib/game/dev/memory-backend";
import { createGameStore } from "@/lib/game/store";

/** 手動推進的時鐘：計時器只在 tick() 時觸發 */
export class FakeClock implements Clock {
  t = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private seq = 0;
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  };
  clearTimeout = (h: unknown) => void this.timers.delete(h as number);
  get pending(): number[] {
    return [...this.timers.values()].map((x) => x.at - this.t).sort((a, b) => a - b);
  }
  /** 推進時間並執行到期的計時器 */
  async tick(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      const next = [...this.timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.t = next[1].at;
      this.timers.delete(next[0]);
      next[1].fn();
      await flush();
    }
    this.t = end;
  }
}

export const flush = async (n = 20) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

export function sharedChannel(): () => SyncChannel {
  const subs = new Set<(v: number) => void>();
  return () => {
    const mine = new Set<(v: number) => void>();
    return {
      post: (v) => {
        for (const s of subs) if (!mine.has(s)) s(v);
      },
      subscribe: (fn) => {
        subs.add(fn);
        mine.add(fn);
        return () => {
          subs.delete(fn);
          mine.delete(fn);
        };
      },
    };
  };
}

export interface Rig {
  backend: MemoryBackend;
  userId: string;
  token: string;
  clock: FakeClock;
  controller: GameController;
  store: ReturnType<typeof createGameStore>;
  signedOut: number;
  refreshes: number;
}

/** 一個使用者 + 一個分頁（API Client + Store + Controller），後端是記憶體版的 Edge Functions */
export function rig(opts: { backend?: MemoryBackend; userId?: string; channel?: SyncChannel | null; refresh?: () => string | null } = {}): Rig {
  const backend = opts.backend ?? new MemoryBackend();
  const userId = opts.userId ?? crypto.randomUUID();
  let token = backend.addUser(userId);
  const clock = new FakeClock();
  const store = createGameStore();
  const r: Partial<Rig> = { backend, userId, token, clock, store, signedOut: 0, refreshes: 0 };
  const api = createGameApi({
    functionsUrl: "http://edge.test/functions/v1",
    anonKey: "anon",
    fetch: backend.fetch,
    sleep: async () => {},
    getAccessToken: async () => token,
    refreshAccessToken: async () => {
      r.refreshes!++;
      const next = opts.refresh ? opts.refresh() : null;
      if (next) token = next;
      return next;
    },
  });
  r.controller = new GameController({ api, store, clock, channel: opts.channel ?? null, onSignedOut: () => void r.signedOut!++ });
  return r as Rig;
}
