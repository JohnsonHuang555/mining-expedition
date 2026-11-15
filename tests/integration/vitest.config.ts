import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // 每個檔案各自建立玩家，可以平行；同一檔案內依序執行（並行情境自己控制）
    fileParallelism: true,
    // Supabase Local 的 Edge Runtime 在太多檔案同時呼叫時，偶爾回傳沒有內容的 503（worker connection closed）。
    // 限制同時執行的檔案數，降低對單一 Edge Runtime 容器的負載（檔案內的並行情境不受影響）。
    maxWorkers: 3,
  },
});
