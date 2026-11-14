/** 不依賴 atob / Buffer 的 base64 解碼與 hex 編碼（Node 與 Deno 共用） */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = new Map([...ALPHABET].map((c, i) => [c, i]));

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, "");
  if (clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new RangeError("invalid base64");
  const pad = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((clean.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = [0, 1, 2, 3].map((k) => (clean[i + k] === "=" ? 0 : LOOKUP.get(clean[i + k]!)!));
    const v = (n[0]! << 18) | (n[1]! << 12) | (n[2]! << 6) | n[3]!;
    if (o < out.length) out[o++] = (v >> 16) & 0xff;
    if (o < out.length) out[o++] = (v >> 8) & 0xff;
    if (o < out.length) out[o++] = v & 0xff;
  }
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

const UTF8 = new (globalThis as unknown as { TextEncoder: new () => { encode(s: string): Uint8Array } }).TextEncoder();
export const utf8 = (s: string): Uint8Array => UTF8.encode(s);
