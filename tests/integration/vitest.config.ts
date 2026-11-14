import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // 每個檔案各自建立玩家，可以平行；同一檔案內依序執行（並行情境自己控制）
    fileParallelism: true,
  },
});
