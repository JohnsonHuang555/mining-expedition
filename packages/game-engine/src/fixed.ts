/**
 * 定點整數工具（TECHNICAL_SPEC §5）。
 *
 * 規則：Power ×10、Speed ×1000、Hardness 為整數、時間為毫秒。
 * 只使用整數運算，讓 Node（Next.js）與 Deno（Edge Functions）得到完全相同的結果。
 */

/** 工作量的縮放：完成一個方塊需要 Hardness × 10^7（TECHNICAL_SPEC §5） */
export const WORK_SCALE = 10_000_000;

/**
 * Hardness 的上限：`Hardness × WORK_SCALE` 必須是 safe integer，
 * 結算時的工作量才能用 Number 精確表示（2^53 − 1 ≈ 9.0 × 10^15）。
 * MVP 最大的 Hardness 是 32,500，遠低於此值。
 */
export const MAX_HARDNESS = Math.floor(Number.MAX_SAFE_INTEGER / WORK_SCALE);

/**
 * 挖開一個方塊需要的毫秒數：ceil(Hardness × 10^7 / (power10 × speed1000))。
 *
 * - 以 BigInt 做乘法與無條件進位的除法，結果的正確性不依賴浮點捨入（Node 與 Deno 一致）。
 * - 輸入或中間值超出 safe integer 範圍時丟出 RangeError，避免溢位的值進入結算。
 */
export function blockMs(hardness: number, power10: number, speed1000: number): number {
  assertPositiveInt("hardness", hardness);
  assertPositiveInt("power10", power10);
  assertPositiveInt("speed1000", speed1000);
  if (hardness > MAX_HARDNESS) {
    throw new RangeError(`hardness must be <= ${MAX_HARDNESS}, got ${hardness}`);
  }
  const rate = BigInt(power10) * BigInt(speed1000);
  if (rate > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`power10 × speed1000 exceeds MAX_SAFE_INTEGER (${power10} × ${speed1000})`);
  }
  const work = BigInt(hardness) * BigInt(WORK_SCALE);
  return Number((work + rate - 1n) / rate);
}

/** GBS §4.2（D19：P6）：Power 等於需求時可以挖 */
export function canMine(power10: number, requiredPower10: number): boolean {
  return power10 >= requiredPower10;
}

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer, got ${value}`);
  }
}
