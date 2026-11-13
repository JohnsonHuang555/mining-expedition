/**
 * SHA-256 / HMAC-SHA256：使用 `@noble/hashes`（已有安全審查、持續維護、零依賴、同步 API，
 * Node / Deno / 瀏覽器皆可用）。TECHNICAL_SPEC §3.4、T4。
 *
 * 用途界線：只用於**遊戲亂數的種子**（逐方塊 HMAC、市場倍率），讓結果可重現且 Client 無法預測。
 * 不用於簽章、身分驗證、密碼雜湊或金鑰派生。
 *
 * 為什麼不用 Web Crypto：`crypto.subtle` 只有非同步 API，結算一次可能有上千個方塊。
 * 實測（Node 22）：`hmac.create` + `clone` 每次約 4 µs，12 小時離線結算的方塊數下總成本為數十毫秒。
 */

import { hmac } from "@noble/hashes/hmac.js";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";

export function sha256(message: Uint8Array): Uint8Array {
  return nobleSha256(message);
}

/** 建立固定金鑰的 HMAC-SHA256 函式：金鑰的 ipad / opad 只處理一次，之後每次呼叫複製狀態 */
export function createHmacSha256(key: Uint8Array): (message: Uint8Array) => Uint8Array {
  const base = hmac.create(nobleSha256, key);
  return (message) => base.clone().update(message).digest();
}

export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  return hmac(nobleSha256, key, message);
}
