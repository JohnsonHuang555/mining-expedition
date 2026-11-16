# 《挖礦探險隊》Operations Runbook（測試環境，單人維護）

**Version 2.0** — 日常檢查、監控、備份還原、回滾與常見故障。部署流程見 `docs/DEPLOYMENT.md`。
所有 SQL 都是唯讀（`begin read only … rollback`），除非標示「會修改」。
資料庫連線字串只放在密碼管理器，需要時在終端機臨時 `export CLOUD_DB_URL`，不要寫入檔案或貼到任何地方。
下方的 `dev` 是 `docker compose run --rm dev` 的別名（README）。

---

## 1. 每日 / 每次部署後的檢查

```sh
dev pnpm cloud status                                         # 目標、migration、函式、網站版本、health
docker compose run --rm -e CLOUD_DB_URL dev pnpm cloud verify # 結構、權限、排程（不符合就失敗）
docker compose run --rm -e CLOUD_DB_URL dev pnpm cloud report # 排程結果、積壓、市場、連線
```

不想在本機使用連線字串：把 `supabase/ops/verify-cloud.sql`、`supabase/ops/ops-report.sql`（刪除 `\echo` 行）貼到 Supabase Dashboard → SQL Editor 執行，結果相同。

| 指標 | 正常 | 異常時 |
|---|---|---|
| `market-daily-prices` 最近 24 小時 | 1 次 succeeded | §4.1 |
| `action-log-compact` 最近 24 小時 | 約 24 次 succeeded；`max_seconds` 遠小於 1 小時 | §4.2 |
| `private.action_log_backlog()` | `settleToDelete`、`responsesToCompact` 接近 0；`oldestPending` 為 null 或不到 2 小時前 | §4.2 |
| 今天的市場價格 | 12 筆 | §4.1 |
| 連線數 | 遠低於方案上限（Dashboard → Database → Connections） | §6 |

## 2. 監控（以平台內建功能為主）

| 項目 | 來源 | 怎麼看 |
|---|---|---|
| Edge Function 4xx / 5xx、延遲 | Supabase Dashboard → Edge Functions → 函式 → **Invocations / Logs**（status、執行時間） | 依 status 篩選；P50 / P95 以平台實際提供的圖表為準 |
| `SERVER_BUSY`、`RATE_LIMITED`、`MARKET_UNAVAILABLE`、`REQUEST_EXPIRED`、`db_error`、RPC 逾時 | Edge Function **Logs**（結構化 JSON：`event`、`code`、`status`、`requestId`、`command`、`durationMs`） | 搜尋 `request_failed`、`request_rejected`、`rate_limited`、`db_error`、`market_unavailable`、`request_expired`；逾時為 `db_error` 且訊息含 `timed out` |
| Auth 失敗 | Dashboard → Authentication → **Logs**；Edge 401（`UNAUTHORIZED`）在 Invocations | 401 激增 → 可能是 token 過期或惡意 JWT |
| Cron 失敗 / 耗時 | `cron.job_run_details`（`ops-report.sql`） | `status <> 'succeeded'`、`max_seconds` |
| Action Log 積壓 | `select private.action_log_backlog();` | 見 §1 |
| 前端錯誤、Web Vitals | Vercel Dashboard → Deployments → Logs / Speed Insights（依方案） | |

**限制（如實記錄）**

- Supabase Free 方案的 API / Database log 只保留 1 天，且沒有 Log Drain 與 Metrics endpoint；長期統計需要升級方案或自行彙整。
- 本專案沒有實作自訂告警服務；Dashboard 內建告警的可用性依方案而定。
- 本文件沒有任何實測的延遲或錯誤率數字；實測結果記錄在 PR 與 `docs/CLOUD_SMOKE_TEST.md` 的結果表。

**低成本替代方案（尚未啟用，需要另外授權）**

- 每週（或每次部署後）手動執行 `dev pnpm cloud report`，看 cron 失敗與積壓。
- 之後若要自動化：GitHub Actions 排程執行 `ops-report.sql` 需要一個**唯讀**的資料庫角色與 GitHub secret，與「CI 不使用雲端密鑰」的原則衝突，需要另外決定。
- Smoke test 的 `SMOKE_LATENCY` 輸出（每次部署的少量樣本）作為延遲的粗略趨勢，不代表負載下的表現。

## 3. 錯誤碼與處理

見 `docs/SECURITY_RELIABILITY.md` §5 與 `TECHNICAL_SPEC.md` §10.11。運維重點：

| 現象 | 先看 | 可能原因 |
|---|---|---|
| 大量 `SERVER_BUSY` / 逾時 | Edge Logs 的 `db_error`；Dashboard 的 DB CPU / 連線 | 資料庫負載、鎖等待、連線耗盡 |
| 大量 `RATE_LIMITED` | 是否集中在少數使用者 | 自動化腳本 / 多分頁異常；必要時調整 `GAME_RATE_LIMIT_*`（Edge secret） |
| `MARKET_UNAVAILABLE` | `ops-report.sql` 的市場段落、cron 失敗訊息 | `private.market_secret` 遺失、`market_ensure` 錯誤 |
| `REQUEST_EXPIRED` | 正常（舊的未確認操作或已壓縮的紀錄） | 若異常大量：Client 時間錯誤或舊版前端 |
| 401 激增 | Auth Logs | token 過期 / 被撤銷、惡意 JWT |
| 空回應 5xx（沒有 JSON） | Edge Invocations | Edge Runtime 暫時錯誤（Supabase Local 曾發生；Cloud 是否發生需要實測） |

## 4. 排程

### 4.1 Market Daily Prices

- 檢查：`select jobname, schedule, active from cron.job where jobname = 'market-daily-prices';`（每天 UTC 16:01 = 台灣 00:01）。
- 補產（會修改，但冪等；只產生缺少的日期，既有價格不變）：`select private.market_ensure(private.market_date(now()));`
- 排程遺漏也不影響正確性：第一個讀取或交易請求會在同一個交易內產生當日價格。
- 一般玩家無法觸發或重新抽價：`market_ensure` 只有 postgres 可以執行（`verify-cloud.sql` 檢查權限）。

### 4.2 Action Log Compaction

- 排程：每小時第 17 分 `call private.action_log_drain(interval '30 days')`；每批 2,000 列、最多 500 批、每批 commit。
- 檢查耗時與失敗：`ops-report.sql` 的 cron 段落。
- 積壓持續增加時：
  1. 確認 job 為 active、最近的 `return_message`。
  2. 若單次執行接近 1 小時或與其他工作互相影響：**不要直接加大批次**；先在離峰時段手動執行較小的批次（會修改）：`call private.action_log_drain(interval '30 days', 1000, 100);`，觀察 DB CPU 與鎖等待，再調整排程（另開 PR）。
  3. 永久的冪等識別（settle 以外）不會被刪除；不要手動 `delete from public.action_log`。

## 5. Backup / Restore

### 5.1 方案能力（2026-11 查詢，以 Supabase 官方頁面為準）

| 方案 | 每日備份 | PITR |
|---|---|---|
| Free | 官方建議自行以 `supabase db dump` 匯出並保存在其他地方 | 無 |
| Pro | 可存取最近 7 天 | 付費加購 |
| Team / Enterprise | 14 天 / 最多 30 天 | 付費加購 |

注意：每日備份不包含自訂角色的密碼；Dashboard 的還原會覆蓋**同一個專案**，所以演練時要還原到另一個專案（下方的邏輯備份流程）。

### 5.2 邏輯備份（所有方案適用）

```sh
dev pnpm cloud backup
# 等同於（輸出到 backups/<ref>-<時間>/，已 gitignore，檔案權限 600）：
#   supabase db dump --linked -f roles.sql --role-only
#   supabase db dump --linked -f schema.sql
#   supabase db dump --linked -f data.sql --use-copy --data-only --schema public,private,supabase_migrations
```

輸出檔含玩家資料與 `private` 密鑰表：只存放在加密的位置（加密磁碟、密碼管理器附件），不提交 Git、不上傳到公開位置。建議在每次套用 migration 之前執行一次。

必須包含並在還原後檢查：

| 資料 | 位置 |
|---|---|
| 玩家狀態、裝備、背包 | `public.players`、`player_pickaxes`、`player_inventory` |
| 寶物實例、圖鑑、首次保護 | `public.artifact_instances`、`artifact_discoveries`、`first_treasure` |
| 離線報告 | `public.offline_reports` |
| 冪等紀錄 | `public.action_log` |
| 市場價格歷史 | `public.market_prices` |
| 密鑰 | `private.player_secrets`、`private.market_secret` |
| Migration history | `supabase_migrations.schema_migrations` |
| 使用者帳號 | `auth.users`（`supabase db dump` 預設不含 auth schema；需要時另外以 `--schema auth` 匯出，並評估個資處理） |

### 5.3 還原演練（只在可拋棄的隔離專案）

1. 建立新的 Supabase 專案 `mining-expedition-restore-drill`（**不是**測試專案；不要把它設定成 `.env.cloud` 的 `CLOUD_PROJECT_REF`）。
2. 依序還原：roles → schema → data（`psql "$DRILL_DB_URL" -v ON_ERROR_STOP=1 -f ...`）。
3. 驗證：
   - `verify-cloud.sql` 通過（cron job 需要重新建立：還原 schema 不會自動建立 pg_cron job，需比對 `cron.job`）。
   - 玩家資產一致：抽樣比對 `players.coins`、`artifact_instances` 數量、`offline_reports` 狀態與備份前的查詢結果。
   - **冪等性**：從 `action_log` 取一筆已提交的交易，以同一個 player 的同一個 `idempotency_key` 呼叫 `game_load_snapshot(player, key, request_hash)` → 必須是 `replay` 或 `expired`，不可是 `ok`（即不會重新執行）。
   - 市場：`market_secret` 相同 → 下一個市場日的價格與原環境產生的一致。
4. 演練結束後刪除專案。

**狀態**：尚未執行（需要建立隔離專案與授權）→ 驗收為 **Blocked**。

## 6. Rollback

| 層 | 方式 |
|---|---|
| Web（Vercel） | 立即：Vercel → Deployments → 上一個正常的部署 → **Instant Rollback**（Hobby 方案可能只能回到前一個部署）。之後：在 main revert 有問題的 PR（merge 後 Vercel 自動部署修正版） |
| Edge Functions | `git switch --detach <上一個正常的 commit>` → `dev pnpm cloud functions --ref <ref> --allow-unmerged`（仍會檢查目標與未提交變更）→ `git switch main`，再 revert 並正常部署 |
| 資料庫 | 只能往前修正（新 migration）。PR #15 的壓縮執行後不可回滾到舊版函式（`docs/SECURITY_RELIABILITY.md` §3.5）；必要時先 `select cron.unschedule('action-log-compact');`（會修改） |
| 資料錯誤 | 從備份還原到隔離專案 → 比對 → 決定修正方式；**不要在任何 Cloud 專案使用 `supabase db reset`**（部署腳本也會拒絕） |
| 前後端版本不一致 | 用 `dev pnpm cloud status` 比對 Vercel 的 `/api/version` 與本機 HEAD；依 `docs/DEPLOYMENT.md` §3.3 的順序補部署 |

## 7. 常見故障

| 症狀 | 檢查 | 處理 |
|---|---|---|
| Vercel build 找不到 `@mining/*` | Root Directory 是否為 `apps/web`、「Include files outside the root directory」是否開啟 | 開啟後重新部署 |
| 瀏覽器 CORS 錯誤 | Edge secret `GAME_API_ALLOWED_ORIGIN` 是否等於 Vercel 網址的 origin（Cloud 上沒有設定時會拒絕所有 origin；Edge log 有 `cors_not_configured`） | 更正 `.env.cloud` 的 `CLOUD_WEB_URL` → `dev pnpm cloud secrets --ref <ref>` |
| 登入後立刻被登出 | Auth Logs；Site URL / Redirect URLs | 設為 Vercel 網址（`docs/DEPLOYMENT.md` §2.2） |
| merge 之後 Vercel 沒有部署 | Vercel → Deployments（是否 Canceled / Ignored）；Settings → Ignored Build Step 是否還停在「暫停」 | 恢復設定後對最新的 main 按 Redeploy |
| 網站顯示「缺少環境變數」或 health 503 | Vercel 的 `NEXT_PUBLIC_SUPABASE_URL` / `ANON_KEY` 是否設定在 Production | 設定後 Redeploy（`NEXT_PUBLIC_*` 在建置時寫入） |
| 註冊顯示「封閉測試」 | 預期行為（`NEXT_PUBLIC_SIGNUP_ENABLED=false` 與 Auth 關閉註冊） | 以 Dashboard 建立 / 邀請帳號 |
| `verify-cloud.sql` 失敗 | 錯誤訊息列出每一項 | 依項目修正（權限 / cron / 索引）；不要手動改 schema，改用 migration |
| cron job 不存在 | `pg_cron` 是否在 migration 之前啟用 | 啟用後重新套用排程（另開 migration 或依 migration 中的 `cron.schedule` 指令手動建立，並記錄） |
| Free 專案被暫停 | Dashboard 顯示 Paused | Restore；長期測試建議 Pro |
