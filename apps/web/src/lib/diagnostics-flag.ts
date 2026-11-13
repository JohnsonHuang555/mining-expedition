/**
 * 本地診斷只在 `next dev`（NODE_ENV = development）啟用。
 *
 * Vercel 的 Production 與 Preview 都以 production 模式執行，所以診斷頁面與 API 一律回傳 404，
 * 也沒有可以在正式環境打開它的環境變數。
 */
export function diagnosticsEnabled(): boolean {
  return process.env.NODE_ENV === "development";
}
