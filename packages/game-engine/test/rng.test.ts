import { createHash, createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SFC32_WARMUP,
  SequenceSource,
  Sfc32,
  blockMessage,
  createBlockRng,
  hmacSha256,
  seedWords,
  sha256,
  uniformInt,
} from "../src/index.ts";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const bytes = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
const utf8 = (s: string) => new TextEncoder().encode(s);

describe("SHA-256（FIPS 180-4 範例）", () => {
  it("空字串與 abc", () => {
    expect(hex(sha256(utf8("")))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(hex(sha256(utf8("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("各種長度（含 55 / 56 / 64 bytes 的填充邊界）與 node:crypto 相同", () => {
    for (const len of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
      const msg = randomBytes(len);
      expect(hex(sha256(new Uint8Array(msg)))).toBe(createHash("sha256").update(msg).digest("hex"));
    }
  });
});

describe("HMAC-SHA256（RFC 4231）", () => {
  it("Test Case 1、2、6（金鑰長於區塊）、7", () => {
    expect(hex(hmacSha256(bytes("0b".repeat(20)), utf8("Hi There")))).toBe(
      "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    );
    expect(hex(hmacSha256(utf8("Jefe"), utf8("what do ya want for nothing?")))).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
    expect(hex(hmacSha256(bytes("aa".repeat(131)), utf8("Test Using Larger Than Block-Size Key - Hash Key First")))).toBe(
      "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
    );
    expect(
      hex(
        hmacSha256(
          bytes("aa".repeat(131)),
          utf8(
            "This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm.",
          ),
        ),
      ),
    ).toBe("9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2");
  });

  it("隨機金鑰與訊息與 node:crypto 相同", () => {
    for (let i = 0; i < 200; i++) {
      const key = randomBytes(i % 3 === 0 ? 32 : (i * 7) % 150);
      const msg = randomBytes((i * 13) % 200);
      expect(hex(hmacSha256(new Uint8Array(key), new Uint8Array(msg)))).toBe(
        createHmac("sha256", key).update(msg).digest("hex"),
      );
    }
  });
});

describe("RandomSource（TECHNICAL_SPEC §6.1）", () => {
  it("nextInt 以拒絕取樣避免取模偏差：被拒絕的值會多消耗一次", () => {
    // n = 3：2^32 mod 3 = 1 → limit = 2^32 − 1，0xFFFFFFFF 被拒絕
    const src = new SequenceSource([0xffffffff, 5]);
    expect(src.nextInt(3)).toBe(2);
    expect(src.consumed).toBe(2);
    // n = 2^32 不會拒絕
    expect(uniformInt(() => 0xffffffff, 0x1_0000_0000)).toBe(0xffffffff);
  });

  it("拒絕不合法的上界", () => {
    const src = new SequenceSource([1]);
    for (const n of [0, -1, 1.5, 0x1_0000_0001, Number.NaN]) expect(() => src.nextInt(n)).toThrow(RangeError);
  });

  it("sfc32 只用 32-bit 運算；相同種子產生相同序列，warm-up 會丟棄前 12 個輸出", () => {
    const a = new Sfc32(1, 2, 3, 4);
    const b = new Sfc32(1, 2, 3, 4);
    const raw = new Sfc32(1, 2, 3, 4, 0);
    for (let i = 0; i < SFC32_WARMUP; i++) raw.nextUint32();
    for (let i = 0; i < 100; i++) {
      const v = a.nextUint32();
      expect(v).toBe(b.nextUint32());
      expect(v).toBe(raw.nextUint32());
      expect(Number.isInteger(v) && v >= 0 && v < 2 ** 32).toBe(true);
    }
  });
});

describe("逐方塊亂數（TECHNICAL_SPEC §6.2）", () => {
  const secret = new Uint8Array(32).fill(7);

  it("種子 = HMAC-SHA256(secret, 'block:' + digCounter) 前 16 bytes，big-endian", () => {
    expect(new TextDecoder().decode(blockMessage(42))).toBe("block:42");
    const digest = createHmac("sha256", secret).update("block:42").digest();
    const [a, b, c, d] = seedWords(new Uint8Array(digest));
    expect([a, b, c, d]).toEqual([0, 4, 8, 12].map((o) => digest.readUInt32BE(o)));
    const expected = new Sfc32(a, b, c, d);
    const rng = createBlockRng(secret)(42);
    for (let i = 0; i < 10; i++) expect(rng.nextUint32()).toBe(expected.nextUint32());
  });

  it("同一 (secret, digCounter) 永遠得到相同序列；不同序號或密鑰則不同", () => {
    const make = createBlockRng(secret);
    const seq = (r: { nextUint32(): number }) => Array.from({ length: 8 }, () => r.nextUint32());
    expect(seq(make(5))).toEqual(seq(make(5)));
    expect(seq(createBlockRng(secret.slice())(5))).toEqual(seq(make(5)));
    expect(seq(make(5))).not.toEqual(seq(make(6)));
    expect(seq(createBlockRng(new Uint8Array(32).fill(8))(5))).not.toEqual(seq(make(5)));
  });

  it("拒絕負數或非整數的 digCounter", () => {
    expect(() => blockMessage(-1)).toThrow(RangeError);
    expect(() => blockMessage(1.5)).toThrow(RangeError);
    expect(() => createBlockRng(new Uint8Array(0))).toThrow(RangeError);
  });
});
