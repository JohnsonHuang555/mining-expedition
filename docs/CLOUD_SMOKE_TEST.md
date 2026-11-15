# 《挖礦探險隊》Cloud Smoke Test（Staging）

**Version 1.0（PR #16）** — 在 Supabase Cloud Staging + Vercel `staging` 分支 Preview 上驗證核心流程、安全與可靠性。
**狀態：尚未執行**（Cloud 資源尚未建立）。結果表在 §5，執行後填寫；不得在未執行時標示 Passed。

---

## 1. 原則

- 只使用專用的 Staging 測試帳號（`SMOKE_USER_A`、`SMOKE_USER_B`，以及手動測試用的帳號）；不使用、不修改其他測試者的資料。
- 不在共享的 Staging 上壓測、長時間鎖資料列或模擬資料庫故障（這些已在 CI 的 Supabase Local 驗證：`tests/integration/reliability.test.ts`）。
- 自動化測試不保存 trace / 截圖（會包含輸入的密碼）；手動測試截圖前先確認畫面沒有 token、密碼或連線字串。
- 限流檢查預設關閉；開啟時最多 30 個唯讀請求（`SMOKE_RATE_LIMIT=1`）。

## 2. 自動化（Staging deploy workflow 或本機）

```sh
# API（Node + vitest；只在 STAGING_SMOKE=1 時執行）
STAGING_SMOKE=1 STAGING_SUPABASE_URL=... STAGING_SUPABASE_ANON_KEY=... STAGING_WEB_ORIGIN=... \
SMOKE_USER_A_EMAIL=... SMOKE_USER_A_PASSWORD=... SMOKE_USER_B_EMAIL=... SMOKE_USER_B_PASSWORD=... \
pnpm --filter @mining/integration-tests exec vitest run staging-smoke.test.ts

# 瀏覽器（Playwright，desktop + mobile）
STAGING_WEB_URL=https://... SMOKE_USER_A_EMAIL=... ... pnpm --filter @mining/e2e test:cloud
```

（在本機執行時，用密碼管理器的 CLI 或 shell 的 `read -s` 帶入密碼，不要寫進 shell history 或檔案。）

| 檔案 | 檢查 |
|---|---|
| `tests/integration/staging-smoke.test.ts` | health；未登入 / 無效 JWT / anon key 當 JWT → 401；game-state 與市場報價（Asia/Taipei、12 件）；同一 Request ID 重送 → Idempotent-Replayed、不同內容 → 409；報價過期 → 409；跨玩家讀寫隔離、body 帶 playerId → 400；CORS 允許 / 拒絕（多個拒絕案例：其他網域、http、網域偽裝、其他 Vercel 網址、`null`）；（選用）限流 429 + Retry-After 與恢復；延遲摘要 `SMOKE_LATENCY` |
| `tests/e2e/cloud/cloud-smoke.spec.ts` | 部署版本（`/api/version` = `EXPECTED_COMMIT`、`env=preview`、`ref=staging`）；封閉測試登入畫面；登入（第一次建立角色）；同步；重新整理保留；市場（歷史已讀取）、背包、圖鑑；登出；換帳號後顯示的是新帳號（不殘留） |
| `supabase/ops/ops-report.sql` | Cloud cron 執行結果、積壓、市場、連線 |

## 3. 需求對照（17 項）

| # | 項目 | 方式 |
|---|---|---|
| 1 | 開啟 Vercel Staging（`staging` 分支 Branch URL；`/api/version` 是部署的 commit） | 瀏覽器自動化 + 手動 |
| 2 | 註冊及登入 | 公開註冊關閉：受邀帳號登入（自動化）；註冊被拒的訊息（手動） |
| 3 | 建立角色 | 自動化（第一次登入） |
| 4 | 正常挖礦 | 自動化（同步）+ 手動觀察進度 |
| 5 | 購買及升級裝備 | 手動（需要累積資源；不以 SQL 改資料） |
| 6 | 重整後資料存在 | 自動化 |
| 7 | 關閉後重新登入，領取離線報告 | 手動（離開 > 5 分鐘後回來） |
| 8 | 寶物掉落與揭曉 | 手動（機率事件；首次保護需要 4 小時有效挖掘） |
| 9 | 圖鑑與套組加成 | 自動化（頁面可讀）+ 手動（取得寶物後） |
| 10 | 市場價格讀取與出售 | 自動化（報價）+ 手動（持有寶物後出售） |
| 11 | 報價過期重新確認 | 自動化（API：舊市場日 → 409）；UI 跨日需在台灣 00:00 前後手動測試 |
| 12 | 同 Request ID 不重複交易 | 自動化（API） |
| 13 | 多分頁操作 | 手動（兩個分頁同時出售礦物 → 只有一筆成功） |
| 14 | Rate Limit 與 Retry-After | 自動化（選用，≤ 30 個唯讀請求） |
| 15 | 未登入與跨玩家隔離 | 自動化（API + PostgREST） |
| 16 | Cloud cron 結果 | `ops-report.sql`（至少經過一個整點與一次台灣 00:01） |
| 17 | Desktop / Mobile | 瀏覽器自動化兩個 project + 手機實機手動 |

## 4. 低負載效能量測計畫（需要擁有者批准後才執行）

| 量測 | 方法 | 上限 / 預算 |
|---|---|---|
| Cold / Warm start | 函式閒置 ≥ 15 分鐘後第一次 `health`，接著連續 10 次 | 每個函式 11 個請求 |
| `game-state` latency | 測試帳號 A，每 2 秒 1 次 × 50 | 50 個請求（低於限流 20 / 10 秒） |
| `game-action` latency | `settle` 每 3 秒 1 次 × 50（每次新的 Request ID） | 50 個請求；action_log 增加 50 列 |
| 多玩家同時同步 | 2 個測試帳號 × 3 個分頁，正常遊玩 10 分鐘 | 約 2 × 3 × 10 分鐘 / 10 秒 ≈ 360 個請求 |
| PostgreSQL 連線數 | 量測期間每分鐘執行 `ops-report.sql` 的連線段落 | 唯讀 |
| RPC 8 秒逾時 | **不在共享 Staging 測試**（需要鎖資料列）；只觀察 Logs 中是否自然出現 `timed out` | — |
| Action Log cron 耗時與積壓 | `cron.job_run_details`（24 小時） | 唯讀 |
| Cloud 是否出現空回應 503 | 上述所有請求中統計沒有 JSON 內容的 5xx | — |

總量約 600 個請求、單一帳號最高約 0.5 req/s；以 Supabase / Vercel 的 Free 或 Pro 額度都在可忽略的範圍（實際費用以帳單為準）。結果只記錄實際量到的數字，不以本機 benchmark 推估。

## 5. 結果（執行後填寫）

| 項目 | 狀態 | 日期 / 版本 | 證據（不含密鑰的 log 摘錄、workflow run 連結、截圖） |
|---|---|---|---|
| API smoke | ⏳ Blocked：Cloud 資源尚未建立 | | |
| 瀏覽器 smoke（desktop / mobile） | ⏳ Blocked | | |
| 手動項目（5、7、8、10、11、13、17） | ⏳ Blocked | | |
| Cloud cron（market / action log） | ⏳ Blocked | | |
| 效能量測 | ⏳ Blocked（需要批准預算） | | |
| 備份還原演練 | ⏳ Blocked（需要隔離專案） | | |
