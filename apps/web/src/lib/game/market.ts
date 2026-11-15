/**
 * 市場畫面的「顯示用」計算（不重新實作定價：倍率只來自伺服器報價，售價公式用引擎的 artifactSalePrice）。
 *
 * - 報價（GameUiState.market）只是報價：出售時帶上它的 marketDate，伺服器在交易時以當日倍率決定成交價。
 * - 漲跌只在「伺服器歷史中確實有昨天」時計算；沒有就沒有（不與基礎價比較、不產生假資料）。
 * - 套組影響用引擎的 activeSets（與伺服器結算相同的規則，D3）比較出售前後的持有數量；只是預測，以伺服器回應為準。
 */

import { ARTIFACTS, ARTIFACT_IDS, type ArtifactId, type ArtifactRarity, SETS, type SetId } from "@mining/game-data";
import { type ArtifactInstance, MAX_ARTIFACTS_PER_SALE, type MarketQuote, type PlayerGameState, activeSets, addMarketDays, artifactSalePrice, heldCounts } from "@mining/game-engine";
import { setBonusText } from "./collection";

export { MAX_ARTIFACTS_PER_SALE };

export type QuoteStatus =
  /** 尚未收到任何報價 */
  | "none"
  /** 伺服器回報當日價格無法取得（multipliersPpm 為空） */
  | "unavailable"
  /** 本機時間已超過 nextRefreshAt：可能已換日，等待伺服器的新報價（只是顯示；成交合法性由伺服器判斷） */
  | "refreshing"
  | "valid";

export function quoteStatus(market: MarketQuote | null, nowMs: number): QuoteStatus {
  if (!market) return "none";
  if (Object.keys(market.multipliersPpm).length === 0) return "unavailable";
  if (nowMs >= market.nextRefreshAt) return "refreshing";
  return "valid";
}

export interface PricePoint {
  date: string;
  multiplierPpm: number;
  price: number;
}

export type Direction = "up" | "down" | "flat";
export interface DayChange {
  yesterday: PricePoint;
  /** 今日相對昨日（售價）的變化率，例如 0.052 = +5.2% */
  ratio: number;
  direction: Direction;
}

/** 伺服器提供的真實歷史（舊 → 新），最後一筆是今天（有報價時）。不補任何缺少的日期 */
export function priceHistory(market: MarketQuote | null, id: ArtifactId): PricePoint[] {
  if (!market) return [];
  const points: PricePoint[] = [];
  for (const h of [...(market.history ?? [])].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    const m = h.multipliersPpm[id];
    if (m !== undefined && h.date < market.date) points.push({ date: h.date, multiplierPpm: m, price: artifactSalePrice(id, m) });
  }
  const today = market.multipliersPpm[id];
  if (today !== undefined) points.push({ date: market.date, multiplierPpm: today, price: artifactSalePrice(id, today) });
  return points;
}

/** 今日 vs 昨日：只有「今天有報價、且歷史中確實有昨天」時才有值 */
export function dayChange(market: MarketQuote | null, id: ArtifactId): DayChange | null {
  if (!market || market.multipliersPpm[id] === undefined) return null;
  const yDate = addMarketDays(market.date, -1);
  const y = market.history?.find((h) => h.date === yDate)?.multipliersPpm[id];
  if (y === undefined) return null;
  const today = artifactSalePrice(id, market.multipliersPpm[id]!);
  const yesterday = artifactSalePrice(id, y);
  const ratio = yesterday === 0 ? 0 : (today - yesterday) / yesterday;
  return { yesterday: { date: yDate, multiplierPpm: y, price: yesterday }, ratio, direction: today > yesterday ? "up" : today < yesterday ? "down" : "flat" };
}

export const formatMultiplier = (ppm: number): string => `×${(ppm / 1_000_000).toFixed(2)}`;
export function formatChange(c: DayChange): string {
  if (c.direction === "flat") return "持平";
  const pct = (Math.abs(c.ratio) * 100).toFixed(1);
  return c.direction === "up" ? `▲ ${pct}%` : `▼ ${pct}%`;
}

export interface MarketRow {
  id: ArtifactId;
  name: string;
  rarity: ArtifactRarity;
  zone: 0 | 1 | 2;
  set: SetId | null;
  baseValue: number;
  discovered: boolean;
  /** 目前持有的實例（digCounter 由舊到新） */
  instances: ArtifactInstance[];
  /** 今日倍率與售價；當日報價缺少時為 null（不可出售、不顯示假價格） */
  multiplierPpm: number | null;
  price: number | null;
  /** 屬於目前生效中的套組 */
  inActiveSet: boolean;
}

export function marketRows(state: PlayerGameState, market: MarketQuote | null): MarketRow[] {
  const active = new Set(activeSets(heldCounts(state)));
  return ARTIFACT_IDS.map((id) => {
    const def = ARTIFACTS[id];
    const m = market?.multipliersPpm[id];
    return {
      id,
      name: def.name,
      rarity: def.rarity,
      zone: def.zone,
      set: def.set,
      baseValue: def.baseValue,
      discovered: state.discoveredArtifacts[id] !== undefined,
      instances: state.heldArtifacts.filter((a) => a.artifactId === id).sort((a, b) => a.digCounter - b.digCounter),
      multiplierPpm: m ?? null,
      price: m === undefined ? null : artifactSalePrice(id, m),
      inActiveSet: def.set !== null && active.has(def.set),
    };
  });
}

/**
 * 選擇某種寶物的 n 件：回傳要出售的實例 ID（一律是 heldArtifacts 中的 instanceId，不使用 artifactId）。
 * 先賣較新取得的（保留最早取得的那一件；實例之間沒有能力差異）。
 */
export function pickInstances(row: Pick<MarketRow, "instances">, n: number): string[] {
  const k = Math.max(0, Math.min(Math.floor(n), row.instances.length));
  return row.instances.slice(row.instances.length - k).map((a) => a.instanceId);
}

export interface SaleLine {
  id: ArtifactId;
  name: string;
  instanceIds: string[];
  /** 單價（今日報價；null = 沒有報價） */
  unitPrice: number | null;
  subtotal: number | null;
  heldBefore: number;
  remaining: number;
}

export interface LostSet {
  id: SetId;
  name: string;
  bonus: string;
}

export interface SalePlan {
  lines: SaleLine[];
  instanceIds: string[];
  count: number;
  /** 預估總收入（今日報價；任何一件沒有報價時為 null） */
  total: number | null;
  /** 出售後會失去的套組（出售前生效、出售後不再生效） */
  lostSets: LostSet[];
  /** 已不在持有中的實例（例如其他分頁已出售）：不會送出 */
  missing: string[];
  tooMany: boolean;
}

/** 依目前持有狀態與報價，計算出售的預估與影響（不修改任何狀態） */
export function planSale(state: PlayerGameState, market: MarketQuote | null, selected: readonly string[]): SalePlan {
  const held = new Map(state.heldArtifacts.map((a) => [a.instanceId, a]));
  const ids = [...new Set(selected)].filter((id) => held.has(id));
  const missing = [...new Set(selected)].filter((id) => !held.has(id));
  const before = heldCounts(state);
  const after = { ...before };
  const byArtifact = new Map<ArtifactId, string[]>();
  for (const id of ids) {
    const a = held.get(id)!;
    after[a.artifactId] = (after[a.artifactId] ?? 0) - 1;
    byArtifact.set(a.artifactId, [...(byArtifact.get(a.artifactId) ?? []), id]);
  }
  let total: number | null = 0;
  const lines: SaleLine[] = ARTIFACT_IDS.filter((id) => byArtifact.has(id)).map((id) => {
    const instanceIds = byArtifact.get(id)!;
    const m = market?.multipliersPpm[id];
    const unitPrice = m === undefined ? null : artifactSalePrice(id, m);
    const subtotal = unitPrice === null ? null : unitPrice * instanceIds.length;
    total = total === null || subtotal === null ? null : total + subtotal;
    return { id, name: ARTIFACTS[id].name, instanceIds, unitPrice, subtotal, heldBefore: before[id] ?? 0, remaining: after[id] ?? 0 };
  });
  const activeAfter = new Set(activeSets(after));
  const lostSets = activeSets(before)
    .filter((s) => !activeAfter.has(s))
    .map((s) => ({ id: s, name: SETS[s].name, bonus: setBonusText(SETS[s]) }));
  return { lines, instanceIds: ids, count: ids.length, total: ids.length === 0 ? 0 : total, lostSets, missing, tooMany: ids.length > MAX_ARTIFACTS_PER_SALE };
}

/** 市場日的顯示（伺服器的市場日字串；不使用本機日期） */
export function formatMarketDate(date: string): string {
  const [y, m, d] = date.split("-");
  return `${y}/${m}/${d}`;
}

/** 下一次更新的顯示：固定以台灣時間表示（市場日的時區），與玩家裝置的時區無關 */
export function formatRefreshTime(epochMs: number): string {
  const t = new Date(epochMs + 8 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(t.getUTCMonth() + 1)}/${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}（台灣時間）`;
}

export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}
