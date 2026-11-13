import { type RandomSource, uniformInt } from "./random-source.ts";

/** RNG_VERSION 1：初始化後先丟棄的輸出數 */
export const SFC32_WARMUP = 12;

/**
 * sfc32（Chris Doty-Humphrey, PractRand）。32-bit 整數運算，Node / Deno / Postgres 皆可重現。
 * 狀態 (a, b, c, d)，d 為計數器。
 */
export class Sfc32 implements RandomSource {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(a: number, b: number, c: number, d: number, warmup = SFC32_WARMUP) {
    this.a = a >>> 0;
    this.b = b >>> 0;
    this.c = c >>> 0;
    this.d = d >>> 0;
    for (let i = 0; i < warmup; i++) this.nextUint32();
  }

  nextUint32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  nextInt(n: number): number {
    return uniformInt(() => this.nextUint32(), n);
  }
}
