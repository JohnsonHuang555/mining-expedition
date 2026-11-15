/**
 * 測試用：找出一個 RNG 密鑰，讓「伺服器接下來的結算」產生指定的寶物。
 *
 * 不修改任何遊戲規則：用與伺服器相同的引擎 settle 在本機模擬同一個狀態（RNG 只由密鑰與 digCounter 決定），
 * 逐一嘗試密鑰直到結果符合，再把密鑰寫進玩家（記憶體後端 / 資料庫 private.player_secrets）。
 * 之後真正的結算（Edge Function 或記憶體後端）會產生同樣的方塊結果。
 */
import { type BlockRecord, type OfflineReport, type PlayerGameState, blockWork, createBlockRng, currentStats, miningPosition, settle, sha256, workRate } from "@mining/game-engine";

export interface Simulated {
  blocks: BlockRecord[];
  report: OfflineReport | null;
}

export function simulate(state: PlayerGameState, secret: Uint8Array, serverNow: number): Simulated {
  const r = settle(state, { serverNow, rng: createBlockRng(secret), options: { recordBlocks: true } });
  if (!r.ok) throw new Error(`settle: ${r.error.code}`);
  return { blocks: r.blocks, report: r.report };
}

export function findSecret(state: PlayerGameState, serverNow: number, want: (s: Simulated) => boolean, label = "rig", maxTries = 400_000): Uint8Array {
  for (let i = 0; i < maxTries; i++) {
    const secret = sha256(new TextEncoder().encode(`${label}:${i}`));
    if (want(simulate(state, secret, serverNow))) return secret;
  }
  throw new Error(`no secret found for ${label} in ${maxTries} tries`);
}

/** 讓目前的方塊只差 msLeft 毫秒就完成（block_work / block_ms 一起設定，維持狀態合法） */
export function nearlyDone(state: PlayerGameState, msLeft: number): { blockWork: number; blockMs: number } {
  const spot = miningPosition(state).spot;
  if (!spot) throw new Error("not mining");
  const total = blockWork(spot.hardness);
  const rate = workRate(currentStats(state));
  return { blockWork: total - rate * msLeft, blockMs: 5_000 };
}

export const toBase64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

/** 第一個完成的方塊掉落指定稀有度 */
export const firstBlockDrops = (rarity: "epic" | "legendary") => (s: Simulated) => s.blocks[0]?.layer4 === rarity;
