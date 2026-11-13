/**
 * SHA-256（FIPS 180-4）與 HMAC-SHA256（RFC 2104），純 TypeScript、同步、無相依套件。
 *
 * 為什麼不用 Web Crypto：`crypto.subtle` 只有非同步 API，結算一次可能要處理上千個方塊；
 * 為什麼不用 node:crypto：Deno（Edge Functions）與瀏覽器沒有相同的同步 API。
 * 正確性以 RFC 4231 測試向量與 node:crypto 交叉比對驗證（test/rng.test.ts）。
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const IV = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);

const BLOCK_BYTES = 64;
const W = new Uint32Array(64);

/** 壓縮一個 64-byte 區塊到 state（就地修改） */
function compress(state: Uint32Array, block: Uint8Array, offset: number): void {
  for (let i = 0; i < 16; i++) {
    const j = offset + i * 4;
    W[i] = ((block[j]! << 24) | (block[j + 1]! << 16) | (block[j + 2]! << 8) | block[j + 3]!) >>> 0;
  }
  for (let i = 16; i < 64; i++) {
    const w15 = W[i - 15]!;
    const w2 = W[i - 2]!;
    const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
    const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
    W[i] = (W[i - 16]! + s0 + W[i - 7]! + s1) >>> 0;
  }
  let a = state[0]!, b = state[1]!, c = state[2]!, d = state[3]!;
  let e = state[4]!, f = state[5]!, g = state[6]!, h = state[7]!;
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const t1 = (h + S1 + ch + K[i]! + W[i]!) >>> 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) >>> 0;
    h = g; g = f; f = e; e = (d + t1) >>> 0;
    d = c; c = b; b = a; a = (t1 + t2) >>> 0;
  }
  state[0] = (state[0]! + a) >>> 0; state[1] = (state[1]! + b) >>> 0;
  state[2] = (state[2]! + c) >>> 0; state[3] = (state[3]! + d) >>> 0;
  state[4] = (state[4]! + e) >>> 0; state[5] = (state[5]! + f) >>> 0;
  state[6] = (state[6]! + g) >>> 0; state[7] = (state[7]! + h) >>> 0;
}

/**
 * 從已處理 `prefixBytes` 個位元組的 state 繼續雜湊 message（prefixBytes 必須是 64 的倍數）。
 * HMAC 用它快取 ipad / opad 區塊，每個方塊只需 2 次壓縮。
 */
const STATE = new Uint32Array(8);
const TAIL = new Uint8Array(BLOCK_BYTES * 2);

function finish(initial: Uint32Array, prefixBytes: number, message: Uint8Array): Uint8Array {
  // 同步、不可重入：共用暫存區以避免每次配置記憶體（結算時每個方塊呼叫 2 次）
  const state = STATE;
  state.set(initial);
  const full = message.length - (message.length % BLOCK_BYTES);
  for (let off = 0; off < full; off += BLOCK_BYTES) compress(state, message, off);
  const restLen = message.length - full;
  const padLen = restLen < 56 ? BLOCK_BYTES : BLOCK_BYTES * 2;
  const tail = TAIL;
  tail.fill(0, 0, padLen);
  tail.set(message.subarray(full));
  tail[restLen] = 0x80;
  const bitLen = (prefixBytes + message.length) * 8;
  // 長度欄位為 64-bit big-endian；訊息長度遠小於 2^53 bits
  const hi = Math.floor(bitLen / 0x1_0000_0000);
  const lo = bitLen >>> 0;
  tail[padLen - 8] = hi >>> 24; tail[padLen - 7] = hi >>> 16; tail[padLen - 6] = hi >>> 8; tail[padLen - 5] = hi;
  tail[padLen - 4] = lo >>> 24; tail[padLen - 3] = lo >>> 16; tail[padLen - 2] = lo >>> 8; tail[padLen - 1] = lo;
  for (let off = 0; off < padLen; off += BLOCK_BYTES) compress(state, tail, off);
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    const v = state[i]!;
    out[i * 4] = v >>> 24; out[i * 4 + 1] = v >>> 16; out[i * 4 + 2] = v >>> 8; out[i * 4 + 3] = v;
  }
  return out;
}

export function sha256(message: Uint8Array): Uint8Array {
  return finish(IV, 0, message);
}

/** 建立固定金鑰的 HMAC-SHA256 函式（快取 ipad / opad 狀態） */
export function createHmacSha256(key: Uint8Array): (message: Uint8Array) => Uint8Array {
  const k = new Uint8Array(BLOCK_BYTES);
  k.set(key.length > BLOCK_BYTES ? sha256(key) : key);
  const ipad = new Uint8Array(BLOCK_BYTES);
  const opad = new Uint8Array(BLOCK_BYTES);
  for (let i = 0; i < BLOCK_BYTES; i++) {
    ipad[i] = k[i]! ^ 0x36;
    opad[i] = k[i]! ^ 0x5c;
  }
  const inner = new Uint32Array(IV);
  compress(inner, ipad, 0);
  const outer = new Uint32Array(IV);
  compress(outer, opad, 0);
  return (message) => finish(outer, BLOCK_BYTES, finish(inner, BLOCK_BYTES, message));
}

export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  return createHmacSha256(key)(message);
}
