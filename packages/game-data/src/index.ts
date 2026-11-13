/**
 * 《挖礦探險隊》靜態遊戲資料（GBS v1.3，DATA_VERSION 1）。
 *
 * 只放資料與型別，不含任何計算邏輯（計算在 @mining/game-engine）。
 * 任何數值變更都要依 GBS §24 將 DATA_VERSION 加 1。
 */

export * from "./version.ts";
export * from "./depth.ts";
export * from "./items.ts";
export * from "./artifacts.ts";
export * from "./zones.ts";
export * from "./pickaxes.ts";
export * from "./rules.ts";
