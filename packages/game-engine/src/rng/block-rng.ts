/**
 * 逐方塊亂數（TECHNICAL_SPEC §6.2，RNG_VERSION 1）。
 *
 *   digest = HMAC-SHA256(key = rngSecret, msg = UTF-8("block:" + digCounter 十進位))
 *   (a, b, c, d) = digest[0..15] 依序拆成 4 個 big-endian uint32
 *   rng = sfc32(a, b, c, d)，先丟棄 12 個輸出
 *
 * 每個方塊的結果只取決於 (rngSecret, digCounter)，不需要儲存 PRNG 狀態，
 * 切換模式或放棄未完成方塊都無法重抽（D16）。
 */

import type { RandomSource } from "./random-source.ts";
import { Sfc32 } from "./sfc32.ts";
import { createHmacSha256 } from "./sha256.ts";

const PREFIX = [0x62, 0x6c, 0x6f, 0x63, 0x6b, 0x3a]; // "block:"

/** UTF-8("block:" + digCounter 十進位)。內容只有 ASCII，直接編碼（與 TextEncoder 結果相同） */
export function blockMessage(digCounter: number): Uint8Array {
  if (!Number.isSafeInteger(digCounter) || digCounter < 0) {
    throw new RangeError(`digCounter must be a non-negative safe integer, got ${digCounter}`);
  }
  const digits = String(digCounter);
  const out = new Uint8Array(PREFIX.length + digits.length);
  out.set(PREFIX);
  for (let i = 0; i < digits.length; i++) out[PREFIX.length + i] = digits.charCodeAt(i);
  return out;
}

/** digest 前 16 bytes → 4 個 big-endian uint32 */
export function seedWords(digest: Uint8Array): [number, number, number, number] {
  if (digest.length < 16) throw new RangeError("digest must be at least 16 bytes");
  const word = (i: number) =>
    ((digest[i]! << 24) | (digest[i + 1]! << 16) | (digest[i + 2]! << 8) | digest[i + 3]!) >>> 0;
  return [word(0), word(4), word(8), word(12)];
}

/**
 * 建立某位玩家的方塊亂數產生器。rngSecret 由伺服器保存（32 bytes，TECHNICAL_SPEC §8.3）。
 * 回傳的函式可重複呼叫：同一個 digCounter 永遠得到相同序列。
 */
export function createBlockRng(rngSecret: Uint8Array): (digCounter: number) => RandomSource {
  if (rngSecret.length === 0) throw new RangeError("rngSecret must not be empty");
  const hmac = createHmacSha256(rngSecret);
  return (digCounter) => {
    const [a, b, c, d] = seedWords(hmac(blockMessage(digCounter)));
    return new Sfc32(a, b, c, d);
  };
}
