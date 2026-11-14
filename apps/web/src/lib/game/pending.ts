/**
 * 未確認的玩家操作（結果不確定的 Action）。
 *
 * 一個操作送出前先保存 { requestId, command }；只有得到伺服器的確定結果（成功、或已保存的遊戲規則拒絕）後才清除。
 * 網路錯誤、逾時、不合法回應、503 / 409 衝突都「不代表伺服器沒有提交」，所以保留，之後以同一個 requestId 重送：
 * 伺服器的 action_log 會回傳原本的結果（已提交）或第一次執行（未提交），不會重複套用。
 *
 * 依使用者分開保存（key 含 userId）：換帳號不會讀到上一位玩家的操作；重新整理頁面後可以恢復並調和。
 */

import { type GameCommand, canonicalCommandJson, parseCommand } from "@mining/game-engine";

export interface PendingAction {
  requestId: string;
  command: GameCommand;
  /** 第一次送出的本機時間（epoch ms，只用於顯示） */
  createdAt: number;
}

export interface PendingStore {
  load(): PendingAction | null;
  save(p: PendingAction | null): void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const pendingStorageKey = (userId: string) => `mining-expedition:pending-action:v1:${userId}`;

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

/** localStorage（每位使用者一個 key）；無法使用 storage 時退回記憶體（同一個分頁內仍然有效） */
export function browserPendingStore(userId: string): PendingStore {
  const key = pendingStorageKey(userId);
  let memory: PendingAction | null = null;
  const storage = (): Storage | null => {
    try {
      return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
      return null;
    }
  };
  return {
    load() {
      try {
        return parsePending(storage()?.getItem(key) ?? null) ?? memory;
      } catch {
        return memory;
      }
    },
    save(p) {
      memory = p;
      try {
        if (p) storage()?.setItem(key, JSON.stringify(p));
        else storage()?.removeItem(key);
      } catch {
        /* 私密模式或容量不足：只保留在記憶體 */
      }
    },
  };
}

export function memoryPendingStore(initial: PendingAction | null = null): PendingStore & { value: PendingAction | null } {
  const s = {
    value: initial,
    load: () => s.value,
    save: (p: PendingAction | null) => void (s.value = p),
  };
  return s;
}
