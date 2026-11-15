/**
 * 寶物市場（GBS §13、TECHNICAL_SPEC §6.3 / §9）。
 *
 * 正式的每日倍率由資料庫產生（supabase/migrations/*_market.sql，`private.market_ensure`）；
 * 本檔案是**相同演算法的參考實作**：開發用記憶體後端與測試使用，整合測試逐日比對兩邊結果完全一致。
 *
 * 演算法（全部整數，ppm）：
 *   digest = HMAC-SHA256(key = market secret, msg = "market:" + YYYY-MM-DD + ":" + artifactId)
 *   u      = digest 前 6 bytes（big-endian，48 bits）
 *   ε      = (u mod (2·Step + 1)) − Step                         // U(−Step, +Step)，偏差 < 2⁻²⁸
 *   drift  = floor(35 × (1,000,000 − m(yesterday)) / 100)        // 0.35 × (1 − m)
 *   m      = clamp(m(yesterday) + drift + ε, Min, Max)
 * 沒有前一日紀錄時 m(yesterday) = MARKET_INITIAL_PPM。
 */

import {
  ARTIFACTS,
  type ArtifactId,
  type ArtifactRarity,
  MARKET_INITIAL_PPM,
  MARKET_MULTIPLIER_RANGE_PPM,
  MARKET_REVERSION_PERCENT,
  MARKET_STEP_PPM,
  MARKET_UTC_OFFSET_MS,
} from "@mining/game-data";
import { hmacSha256 } from "./rng/sha256.ts";

const PPM = 1_000_000;
const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** YYYY-MM-DD 且是真實存在的日期 */
export function isMarketDate(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
}

/** 伺服器時間（epoch ms）所屬的市場日（Asia/Taipei，固定 UTC+8） */
export function marketDateOf(epochMs: number): string {
  return new Date(epochMs + MARKET_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

/** 該市場日開始的時間（epoch ms） */
export function marketDayStart(date: string): number {
  if (!isMarketDate(date)) throw new Error(`invalid market date ${date}`);
  return Date.parse(`${date}T00:00:00Z`) - MARKET_UTC_OFFSET_MS;
}

/** 下一次刷新（下一個 Asia/Taipei 00:00） */
export function nextMarketRefreshAt(epochMs: number): number {
  return marketDayStart(marketDateOf(epochMs)) + DAY_MS;
}

export function addMarketDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function marketMessage(date: string, artifactId: ArtifactId): Uint8Array {
  return new TextEncoder().encode(`market:${date}:${artifactId}`);
}

/** 一件寶物從前一日倍率推到今天（GBS §13） */
export function nextMultiplierPpm(prevPpm: number, rarity: ArtifactRarity, digest: Uint8Array): number {
  if (digest.length < 6) throw new Error("digest too short");
  let u = 0;
  for (let i = 0; i < 6; i++) u = u * 256 + digest[i]!; // 48 bits，仍是安全整數
  const step = MARKET_STEP_PPM[rarity];
  const eps = (u % (2 * step + 1)) - step;
  const drift = Math.floor((MARKET_REVERSION_PERCENT * (PPM - prevPpm)) / 100);
  const { min, max } = MARKET_MULTIPLIER_RANGE_PPM[rarity];
  return Math.min(max, Math.max(min, prevPpm + drift + eps));
}

export function marketMultiplierFor(secret: Uint8Array, date: string, artifactId: ArtifactId, prevPpm: number): number {
  return nextMultiplierPpm(prevPpm, ARTIFACTS[artifactId].rarity, hmacSha256(secret, marketMessage(date, artifactId)));
}

/** 寶物的當日售價（GBS §13：floor(BaseValue × multiplier)）。與 sell_artifacts 使用同一個公式 */
export function artifactSalePrice(artifactId: ArtifactId, multiplierPpm: number): number {
  return Math.floor((ARTIFACTS[artifactId].baseValue * multiplierPpm) / PPM);
}

/** 公開的市場報價（API 回應；Client 只能讀取，成交價仍由伺服器在交易時決定） */
export interface MarketQuote {
  /** 市場日（Asia/Taipei） */
  date: string;
  /** 下一次刷新（epoch ms） */
  nextRefreshAt: number;
  /** 當日倍率（ppm）。缺少的寶物代表當日價格尚未產生（不可出售） */
  multipliersPpm: Partial<Record<ArtifactId, number>>;
  /** 較早的市場日（由新到舊，最多 6 天；只在 game-state 回應提供） */
  history?: { date: string; multipliersPpm: Partial<Record<ArtifactId, number>> }[];
}
