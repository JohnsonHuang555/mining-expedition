/** GBS §24：遊戲數值版本。任何 GBS 數值變更都要加 1，並在 GBS §24.1 記錄 */
export const DATA_VERSION = 1;

/**
 * TECHNICAL_SPEC §4 / §6：亂數消耗方式的版本。
 * 改變逐方塊種子、sfc32 初始化或任何一層的亂數消耗順序時加 1，並保留舊版確定性快照。
 */
export const RNG_VERSION = 1;
