# 《挖礦探險隊》Security & Reliability

**Version 1.0（PR #15 Reliability & Security Hardening）**

本文件記錄交易正確性、濫用防護與錯誤處理的設計決策。實作細節以 `docs/TECHNICAL_SPEC.md` §10.6–§10.11 為準。
**只描述已實作並有測試的防護**；尚未處理的風險列在最後一節。

---

## 1. 信任邊界

| 元件 | 信任 | 說明 |
|---|---|---|
| 瀏覽器（Next.js、GameController、localStorage） | ❌ | 只送出「意圖」（指令 + Idempotency-Key）；金幣、物品、價格、時間、playerId 都不接受 |
| Edge Functions（`character-create` / `game-state` / `game-action`） | ✅ | 以 `auth.getUser(JWT)` 取得 user id；Service Role Key 只在這裡 |
| PostgreSQL（RPC、RLS、trigger） | ✅ | 最終的冪等、CAS、約束與權限 |

## 2. 稽核結果（PR #15）

| 項目 | 結果 | 證據（自動化測試） |
|---|---|---|
| 玩家身分 | 只來自已驗證 JWT；body 帶 `playerId` 或多餘欄位 → 400 | `tests/integration/edge.test.ts`、`reliability.test.ts` |
| RLS | 所有 public / private 資料表都啟用；Client 角色沒有 INSERT / UPDATE / DELETE / TRUNCATE | `packages/game-server/test/pglite-reliability.test.ts`（逐表檢查）、`tests/integration/rls.test.ts` |
| 跨玩家存取 | A 讀不到、改不了 B | `rls.test.ts`、`reliability.test.ts` |
| RPC 權限 | `game_*` 只有 service_role 可執行；`private.*` 連 service_role 都不能 | `pglite-reliability.test.ts`（pg_proc 逐一檢查） |
| SECURITY DEFINER / search_path | 所有 public / private 函式都 `set search_path = ''` | 同上 |
| 密鑰表 | `player_secrets`、`market_secret`、`rate_limits`：任何 API 角色都不能讀 | 同上 |
| 寶物實例 / 市場價格 / 玩家狀態的修改 | 只經由 `game_commit`（service_role）；市場價格只新增（trigger） | `pglite-rls.test.ts`、`pglite-market.test.ts` |
| SQL injection | migration 沒有動態 SQL；RPC 參數化；指令由引擎 `parseCommand` 嚴格驗證（多餘欄位拒絕） | `pglite-reliability.test.ts`（掃描 `execute format/…`）、`actions.test.ts` |
| 回應與 log 洩漏 | 回應不含密鑰、SQL、堆疊；log 不寫 token / 密鑰 / 狀態內容 | `edge.test.ts`（FORBIDDEN 字串）、`reliability.test.ts`（DB 失敗回應） |

**發現並修正的問題**

| 等級 | 問題 | 修正 |
|---|---|---|
| P1 | `action_log` 無限成長，且沒有安全的清理方式（settle 每幾秒寫一筆完整回應） | §3 分層保存 |
| P1 | 沒有任何 API rate limit | §4 |
| P2 | RPC 沒有逾時：資料庫卡住時 Edge 請求一直等待 | 8 秒逾時 → `SERVER_BUSY`（結果不確定，以同一個 key 調和） |
| P2 | 錯誤 log 缺少可追查的欄位（requestId、command、code、耗時） | §5 |
| P2 | Client 的未確認操作沒有有效期限（幾週後才送達的舊請求會被當成新交易執行） | §3.3 |

## 3. Idempotency 與 Action Log Retention

### 3.1 威脅模型

| 情境 | 風險 | 防護 |
|---|---|---|
| 回應遺失後以同一個 key 重送 | 重複扣款 / 發放 | `action_log (player_id, idempotency_key)` 唯一 + 同一交易提交；重送回傳保存的回應 |
| 同一個 key 並行送出（多分頁 / 自動重試） | 雙重執行 | 唯一鍵 + `players` 列鎖 + CAS（`state_version`） |
| 同一個 key、不同內容 | 以舊 key 執行新交易 | `request_hash` → `IDEMPOTENCY_MISMATCH`（壓縮後仍保留 hash） |
| **紀錄被清理後，以舊 key 重送** | 伺服器把已執行的交易當成新的 → 重複扣款 | 交易類指令的冪等識別**永久保留**；只清除回應內容 → `REQUEST_EXPIRED`，不重新執行 |
| 很久以前送出、從未到達的請求晚到 | 玩家早已不記得的交易被執行 | Client 7 天有效期限 + 伺服器確認作廢（§3.3） |
| Client 自行判斷成功 / 失敗 | 畫面與伺服器不一致 | Client 只依伺服器回應；不確定時保留紀錄並調和 |

### 3.2 方案比較（選擇：分層保存）

| 方案 | 安全性 | 成本（單人開發、低流量 MVP） | 結論 |
|---|---|---|---|
| A. 永久保留所有紀錄 | 安全 | settle 每 5–20 秒一筆完整回應（數 KB）：每位活躍玩家每天 MB 級 | 不採用（儲存成本隨時間無限成長） |
| B. 保留 N 天後整筆刪除 | **不安全**：刪除後同一個 key 會被重新執行 | 低 | 不採用 |
| **C. 分層：交易的冪等識別永久保留、回應保留 30 天；settle 30 天後刪除** | 安全：已使用的 key 永遠不會再執行 | 交易每筆約 150 bytes 永久；settle 不永久保存 | **採用** |
| D. 以 UUIDv7 的時間戳拒絕舊 key | 依賴 Client 時鐘；時鐘錯誤的裝置無法遊玩 | 低 | 不採用（改用 §3.3 的伺服器確認） |

settle 可以整筆刪除的原因：settle 沒有 Client 指定的效果，只是把狀態結算到「現在」；同一個 key 再次送出只會再結算到現在，獎勵依經過的時間計算，不會重複發放。

### 3.3 未確認操作（Pending Action）安全協定

1. 每個玩家操作在送出前寫入 localStorage（每筆一個 key，`createdAt` = 第一次送出的時間），結果確定才刪除。
2. 結果不確定（網路、逾時、5xx、回應損壞、Rate limit）→ 保留，之後以**同一個 key** 重送 / 調和；不同的新操作在不確定的紀錄解決前不會送出。
3. 超過 7 天（`PENDING_MAX_AGE_MS`）→ 改送 `Idempotency-Expire: true`：
   - key 已存在 → 回傳原本的結果（或 `REQUEST_EXPIRED` 附當初成功與否）。
   - key 不存在 → **不執行**，在同一交易中寫下作廢紀錄；之後同一個 key 的原始請求只會得到作廢結果。
4. `REQUEST_EXPIRED` 是伺服器的確定答案：Client 清除紀錄、依 `expired` 顯示、重新讀取狀態。

### 3.4 部署與 migration

- `20261117000000_reliability.sql` 只新增欄位、索引、trigger、資料表與函式；**不修改或刪除既有紀錄**（既有 response 仍在，30 天後才壓縮）。
- `game_load_snapshot` 新版接受舊的三參數呼叫（新參數有預設值）：**先套用 migration，再部署 Edge Functions**；反過來（新 Edge + 舊資料庫）會因參數不存在而失敗。
- 回滾：Edge Functions 可以回到前一版（新資料庫相容）。資料庫若要回滾：壓縮過的紀錄 `response` 為 null，舊版 `game_load_snapshot` 會把它當成 `replay` 回傳 null → **不可在壓縮執行後回滾資料庫**；回滾前先停用 `action-log-compact` 排程。
- pg_cron：`action-log-compact` 每週一 03:17（台灣）壓縮 30 天前的紀錄，每次最多 5,000 筆各類；沒有 pg_cron 時不清理（安全，只是不節省空間）。

## 4. API Rate Limit

- **伺服器端、資料庫計數**，以已驗證的 user id 為鍵；不使用 IP header。
- 預設：`game-action` 30 / 10 秒、`game-state` 20 / 10 秒、`character-create` 5 / 60 秒（環境變數 `GAME_RATE_LIMIT_*` 可覆寫）。
- 重送（replay / expired）與作廢探詢不計數、不阻擋：合法的重試與調和不會因限流而卡住。
- 超限：429 `RATE_LIMITED`、`Retry-After`、`retryAfterMs`；伺服器沒有執行、沒有保存。Client 以同一個 key 在 Retry-After 後重試（10 秒內在 API Client 內等待；更長的由 Controller 排程，未確認紀錄保留）。
- 額外成本：`game-state` / `game-action` 不增加資料庫往返（在 `game_load_snapshot` 內），每次一個單列 upsert；`character-create` 多一次 RPC。

**限制（未處理）**

- 無效 JWT：由 `auth.getUser` 拒絕（401），不經過資料庫；但每次都會呼叫 Auth 服務，沒有 IP 層級的限制。
- 大量註冊：依賴 Supabase Auth 平台預設的限制，本專案尚未自訂 `[auth.rate_limit]`。
- 固定視窗在邊界處最多允許 2 倍的瞬間流量。
- 分散式攻擊 / DDoS 依賴平台（Supabase gateway）。

## 5. 錯誤分類與 log

見 `TECHNICAL_SPEC.md` §10.11 的表格。重點：

- **不確定 ≠ 失敗**：`SERVER_BUSY`、`VERSION_CONFLICT`、`INTERNAL_ERROR`、網路錯誤、回應損壞 → 保留未確認紀錄，以同一個 key 調和。
- **確定未執行**：規則拒絕（已保存）、`RATE_LIMITED`、`MARKET_UNAVAILABLE`（未保存，但伺服器保證這個 key 沒有提交）。
- Edge log 欄位：`event`、`fn`、`status`、`code`、`requestId`、`command`、`userId`、`attempts`、`durationMs`；資料庫錯誤只記錄訊息與 SQLSTATE。不記錄 token、Authorization header、密鑰或玩家狀態內容。

## 6. 尚未解決的風險

| 風險 | 影響 | 計畫 |
|---|---|---|
| Supabase Local 的 Edge Runtime 在高並行時偶發空回應 503 | CI 偶發失敗；正式環境需實測 | Cloud 部署時壓測與監控 |
| 沒有 IP 層級的限流與機器人偵測 | 大量無效 JWT 會消耗 Auth 服務 | 依賴平台；上線後依流量評估 |
| Auth 註冊限制未自訂 | 大量建立帳號 | Cloud 部署前設定 `[auth.rate_limit]` / CAPTCHA |
| action_log 的交易冪等識別永久保留 | 每筆約 150 bytes，隨交易數線性成長 | 量大時再評估分區 / 冷儲存（不可刪除） |
| 市場密鑰沒有備份 / 輪替流程 | 遺失後無法重現同一條價格序列（已產生的價格保留） | 部署文件 |
| 沒有營運 Dashboard / 告警 | 問題需要從 log 追查 | 後續 PR |
