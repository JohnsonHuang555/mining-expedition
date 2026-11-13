/**
 * 引擎唯一依賴的亂數介面（TECHNICAL_SPEC §6.1）。測試可注入固定序列。
 */
export interface RandomSource {
  /** [0, 2^32) 的均勻整數 */
  nextUint32(): number;
  /** [0, n) 的均勻整數，使用拒絕取樣避免取模偏差 */
  nextInt(n: number): number;
}

const TWO_32 = 0x1_0000_0000;

/**
 * 以拒絕取樣把 nextUint32 轉成 [0, n)：
 * 只接受小於 `2^32 − (2^32 mod n)` 的值，再取 mod n。
 * 每次拒絕都會多消耗一個 uint32（屬於 RNG_VERSION 1 的定義）。
 */
export function uniformInt(nextUint32: () => number, n: number): number {
  if (!Number.isSafeInteger(n) || n <= 0 || n > TWO_32) {
    throw new RangeError(`nextInt bound must be an integer in [1, 2^32], got ${n}`);
  }
  const limit = TWO_32 - (TWO_32 % n);
  for (;;) {
    const x = nextUint32();
    if (x < limit) return x % n;
  }
}

/**
 * 依序回傳固定 uint32 的亂數來源（測試用）。用完時丟出錯誤，
 * 讓測試能驗證「消耗了幾次、順序為何」。
 */
export class SequenceSource implements RandomSource {
  readonly values: readonly number[];
  consumed = 0;

  constructor(values: readonly number[]) {
    this.values = values;
  }

  nextUint32(): number {
    const v = this.values[this.consumed];
    if (v === undefined) throw new Error(`SequenceSource exhausted after ${this.consumed} values`);
    this.consumed++;
    return v >>> 0;
  }

  nextInt(n: number): number {
    return uniformInt(() => this.nextUint32(), n);
  }
}
