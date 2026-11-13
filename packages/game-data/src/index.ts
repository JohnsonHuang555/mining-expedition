/**
 * 靜態遊戲資料（GBS v1.3）。
 *
 * Phase 1 只放版本號，確認 Next.js 與 Edge Functions 都能匯入這個 package。
 * 完整數值表在 Phase 2 依 GBS 加入；任何數值變更都要依 GBS §24 將 DATA_VERSION 加 1。
 */

/** GBS §24：MVP v1.0 初始數值 */
export const DATA_VERSION = 1;

/** TECHNICAL_SPEC §4：亂數消耗順序的版本 */
export const RNG_VERSION = 1;
