/**
 * 《挖礦探險隊》遊戲引擎：純 TypeScript，不依賴 React、Zustand、Next.js 或 Deno API。
 *
 * Phase 1 只提供版本資訊與定點數工具，用來驗證 Next.js 與 Supabase Edge Functions
 * 都能匯入同一份原始碼。import 一律寫副檔名（`./fixed.ts`），Node 與 Deno 才能共用。
 */

import { DATA_VERSION, RNG_VERSION } from "@mining/game-data";

export { MAX_HARDNESS, WORK_SCALE, blockMs, canMine } from "./fixed.ts";
export { DEV_MARKER } from "./dev-marker.ts";

export const ENGINE_VERSION = "0.1.0";

export interface EngineInfo {
  engineVersion: string;
  dataVersion: number;
  rngVersion: number;
}

export function engineInfo(): EngineInfo {
  return { engineVersion: ENGINE_VERSION, dataVersion: DATA_VERSION, rngVersion: RNG_VERSION };
}
