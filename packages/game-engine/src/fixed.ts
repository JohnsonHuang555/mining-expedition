/**
 * 定點整數工具（TECHNICAL_SPEC §5）。
 *
 * 規則：Power ×10、Speed ×1000、Hardness 為整數、時間為毫秒。
 * 只使用整數運算，讓 Node（Next.js）與 Deno（Edge Functions）得到完全相同的結果。
 */

/** 挖開一個方塊需要的毫秒數：ceil(Hardness × 10^7 / (power10 × speed1000)) */
export function blockMs(hardness: number, power10: number, speed1000: number): number {
  assertPositiveInt("hardness", hardness);
  assertPositiveInt("power10", power10);
  assertPositiveInt("speed1000", speed1000);
  const work = hardness * 10_000_000;
  const rate = power10 * speed1000;
  return Math.ceil(work / rate);
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
