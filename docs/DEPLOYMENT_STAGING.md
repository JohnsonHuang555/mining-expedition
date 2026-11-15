# 《挖礦探險隊》Cloud Staging 部署

**Version 1.0（PR #16）** — 對象：未參與開發、第一次建立 Staging 的人。

> **狀態**：本文件與 repository 內的設定、腳本、workflow 已準備好；**Cloud 資源尚未建立、尚未部署**。
> 「部署設定已準備好」與「實際 Cloud 部署成功」是不同的狀態；實際部署的結果記錄在 PR 與 §9 的驗收表。

---

## 1. Deployment Readiness Audit（PR #16 時的盤點）

### 1.1 可以直接使用（已在 repository 中）

| 項目 | 現況 |
|---|---|
| Next.js Monorepo build | `apps/web` 的 `next build` 在 CI 通過；`outputFileTracingRoot` / `turbopack.root` 指向 monorepo 根目錄；共用 packages 以 `transpilePackages` 轉譯 |
| Package manager | pnpm（`packageManager: pnpm@10.34.9`、根目錄 `pnpm-lock.yaml`、`pnpm-workspace.yaml`） |
| Node.js | `engines.node = ">=22.18.0 <23"`（PR #16 加上上限，讓 Vercel 選 22.x） |
| Browser 只拿到公開金鑰 | 前端只讀 `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`；CI 檢查 `.next/static` 不含 service role 等字串 |
| Migrations | 6 個 migration，CI 每次以 `supabase db reset` 從空資料庫重建；PR #16 **不新增 migration** |
| pg_cron 排程 | migration 只在 pg_cron 已安裝時建立 `market-daily-prices`、`action-log-compact` |
| Edge Functions | `health`、`character-create`、`game-state`、`game-action`；以 `deno.json` 匯入 `packages/`（CI 的 Supabase Local 已驗證可執行） |
| 安全機制 | JWT 驗證、RLS、RPC 權限、rate limit、冪等、RPC 逾時（PR #8–#15） |
| 驗證 / 監控 SQL | PR #16 新增 `supabase/ops/verify-staging.sql`（唯讀，不符合就失敗）、`supabase/ops/ops-report.sql`（唯讀報告），在 CI 的 Supabase Local 上測試 |
| CORS 允許清單 | PR #16：`GAME_API_ALLOWED_ORIGIN` 支援多個 origin 與 Vercel Preview 樣式；**Cloud 上沒有設定時拒絕所有瀏覽器 origin（fail closed）**，只有本地允許 `*` |
| Web 部署分支 | PR #16：Staging Web = **`staging` 分支**的 Vercel Preview；`apps/web/vercel.json` 的 Ignored Build Step 略過 main（Vercel Production）與其他分支；`/api/version` 回報部署的 commit |
| 封閉測試登入畫面 | PR #16：`NEXT_PUBLIC_SIGNUP_ENABLED=false` 隱藏註冊分頁 |
| 部署 workflow | PR #16：`.github/workflows/staging-deploy.yml`（手動、只部署 main、Environment 保護、目標檢查） |

### 1.2 缺少、或只能在 Cloud 上確認

| 項目 | 說明 |
|---|---|
| Edge Function 打包 `supabase/functions` 以外的檔案 | 本地 Edge Runtime 可以執行；`supabase functions deploy` 在 Cloud 的打包需要實際部署確認（§5 步驟 7 的 smoke 會驗證）。若失敗：改用 `--use-docker` 或把 import map 指向的套件打包進函式目錄（需另開 PR） |
| Edge Function 預設的環境變數 | 程式使用 `SUPABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY`（Supabase 自動提供）。專案若只啟用新的 publishable / secret key，需要在部署後以 smoke test 確認這三個變數存在 |
| pg_cron 在 Cloud 已啟用 | migration 只在擴充套件可用時建立排程；Cloud 需確認 `pg_cron` 已安裝且兩個 job 存在（`verify-staging.sql` 會檢查） |
| 含 COMMIT 的 procedure 由 pg_cron 執行 | 本地已驗證；Cloud 需查看 `cron.job_run_details` 的實際結果 |
| Auth 設定 | 關閉公開註冊、Redirect URLs、Auth rate limit、（選用）CAPTCHA：都在 Supabase Dashboard |
| 備份 / 還原 | 依方案而定（§7）；演練需要另一個可拋棄的專案 |
| 監控與告警 | 以 Supabase / Vercel 內建 Logs 為主；告警能力依方案（`docs/OPERATIONS_RUNBOOK.md`） |

### 1.3 必須由專案擁有者手動建立的雲端資源

1. Supabase：一個**新的、只給 Staging 使用**的專案（不可與未來的 Production 共用）；另一個**可拋棄的**還原演練專案（演練時才建立，結束後刪除）。
2. Vercel：一個 Project（Root Directory `apps/web`），連結 GitHub repository；**Production Branch 維持 `main`**（Vercel 預設），Staging 使用 `staging` 分支的 Preview。
   GitHub：`staging` 分支由 Staging deploy workflow 建立與更新（不要手動 push）；建議用 ruleset 禁止 force push 與刪除。
3. GitHub：Environment `staging`（secrets / variables、Required reviewers、Deployment branches = main）。
4. 兩個專用的 Staging 測試帳號（smoke test 用），以及受邀的封閉測試帳號。

---

## 2. 架構

```
GitHub main（已審核、已合併的 commit X）
 └─ Actions「Staging deploy」（手動 + 人工批准；在 main 上執行）
        │ ① supabase CLI（access token、DB password：只在 Environment staging）→ migration、Edge Functions（commit X）
        │ ② fast-forward：staging 分支 ← X（只允許 fast-forward）
        │ ③ 等待 Vercel 以 X 完成建置：GET $STAGING_WEB_URL/api/version == {commit: X, env: preview, ref: staging}
        │ ④ smoke（API + 瀏覽器）
        ▼
 Vercel（Production Branch = main → 目前略過；staging 分支 → Preview + Preview 專用環境變數）
   https://<project>-git-staging-<team>.vercel.app（Next.js，apps/web）── 瀏覽器只拿 publishable/anon key
        │ HTTPS（Bearer JWT；CORS 只允許這個 origin）
        ▼
   Supabase Cloud Staging 專案
     ├─ Auth（Email / Password；公開註冊關閉；邀請 / 手動建立帳號）
     ├─ Edge Functions：health / character-create / game-state / game-action（service role 只在這裡）
     └─ PostgreSQL（獨立）：RLS、RPC、private 密鑰表、pg_cron（market-daily-prices、action-log-compact）
```

- 為什麼不是「main = Preview」：Vercel 的 Git 整合把 **Production Branch（預設 `main`）** 的部署當作 **Production** 環境（使用 Production 環境變數），不會產生 Preview。所以 Staging 改用固定的 `staging` 分支：它的 Preview 有固定的分支網址（`<project>-git-staging-<team>.vercel.app`），並使用 Preview 環境變數。main 的 Production 部署與其他分支的 Preview 由 Ignored Build Step 略過（`scripts/vercel-ignore-build.mjs`；CI 有回歸測試）。
- Edge 與 Web 是同一版本：workflow 從 main 的 commit X 部署 Edge，把 `staging` 分支推到同一個 X，並在 smoke 之前確認 `/api/version` 回報 X。`staging` 分支只會在 workflow 被批准時更新，不會自動同步 main。
- 不建立 VM、Kubernetes 或獨立的 Node API server。
- Staging 與 Production（未來）**不共用**資料庫、Service Role Key、RNG secret（每位玩家，在資料庫內產生）或 market secret（每個資料庫各自產生）。

## 3. 誰做什麼

| 類別 | 內容 |
|---|---|
| **A. Repository（已完成）** | 設定、腳本、workflow、驗證 SQL、smoke test、文件（本 PR） |
| **B. 後台（專案擁有者）** | 建立 Supabase Staging 專案、Auth 設定、建立測試帳號；建立 Vercel Project 與環境變數；GitHub Environment 與 secrets（§4） |
| **C. 取得權限後才能執行** | 遠端 migration、Edge Function 部署、Cloud smoke、cron 結果、備份還原演練、效能量測（§5–§8；每一項都要先由擁有者明確授權目標專案） |

## 4. 後台設定 SOP（B）

> 不要把任何密鑰貼到對話、Issue、PR、commit、截圖或 CI log。密鑰只放在 Supabase / Vercel / GitHub 的 secret 欄位。

### 4.1 Supabase Staging 專案

1. Dashboard → **New project**：名稱 `mining-expedition-staging`、Region 選離測試者最近的區域（台灣：`ap-northeast-1` Tokyo 或 `ap-southeast-1` Singapore）、設定資料庫密碼（存到密碼管理器，之後放進 GitHub secret `STAGING_DB_PASSWORD`）。
2. 記下 **Project ref**（Settings → General；20 個小寫英文字母）。這不是密鑰。
3. **Database → Extensions**：確認 `pg_cron`、`pgcrypto` 可用（migration 會建立；若 `pg_cron` 未出現在清單，先在這裡啟用再部署）。
4. **Authentication → Sign In / Providers → Email**：
   - **關閉「Allow new users to sign up」**（封閉測試，不開放公開註冊）。
   - Confirm email：建議開啟（受邀帳號會收到確認信）。
5. **Authentication → URL Configuration**：
   - Site URL：`staging` 分支的固定網址（例：`https://mining-expedition-git-staging-<team>.vercel.app`；以 Vercel 後台 Deployment 頁面顯示的 Branch URL 為準）。
   - Redirect URLs：只加入 `https://mining-expedition-git-staging-<team>.vercel.app/**`（不使用萬用字元；其他分支不會建置）。
6. **Authentication → Rate Limits**：檢查註冊 / 登入的限制（保留預設或調低）；公開註冊關閉後主要影響登入嘗試。
7. （選用）**Authentication → Bot and Abuse Protection → CAPTCHA**：封閉測試且註冊關閉時可先不啟用；若之後開放註冊，前端需要接 hCaptcha / Turnstile（另開 PR）。
8. **建立測試帳號**：Authentication → Users → **Add user**（Create new user，勾選 Auto Confirm）：
   - `SMOKE_USER_A`、`SMOKE_USER_B`：只給自動化 smoke test 使用（密碼放 GitHub secrets）。
   - 封閉測試者：用 **Invite user**（需要寄信）或 Add user 後私下告知密碼。
9. Settings → API：記下 **Project URL** 與 **publishable / anon key**（公開，可放在 Vercel 與 GitHub variables）。**service_role / secret key 不需要複製到任何地方**（Edge Functions 由平台自動提供）。
10. Settings → Database → Connection string：複製 **Session pooler** 的連線字串（含密碼）→ GitHub secret `STAGING_DB_URL`（只用於唯讀驗證與報告）。

### 4.2 Vercel Project

1. **Add New → Project** → 匯入 GitHub repository。
2. **Root Directory**：`apps/web`；保持「Include files outside the root directory in the Build Step」開啟（共用 packages 在 `packages/`）。
3. **Framework Preset**：Next.js（自動偵測）。**Install / Build / Output** 保持預設（Vercel 依 `pnpm-lock.yaml` 執行 `pnpm install`，build 為 `next build`，輸出 `.next`）；不需要自訂 build 腳本。
4. **Node.js Version**：22.x（`package.json` 的 engines 也限制在 22.x）。
5. pnpm 版本：建議在 Environment Variables 加上 `ENABLE_EXPERIMENTAL_COREPACK=1`，讓 Vercel 依 `packageManager` 使用同一版 pnpm。
6. **Settings → Environments → Production → Branch Tracking**：Production Branch 維持 `main`（不要改成 `staging`）。目前 main 的 Production 建置會被 `apps/web/vercel.json` 的 Ignored Build Step 略過（Deployments 列表顯示 Canceled / Ignored），所以不會有 Production 網站；正式上線時另開 PR 決定（設定 `MINING_ALLOW_PRODUCTION_BUILD=1` 與 Production 環境變數）。
   **Settings → Git → Ignored Build Step**：保持「Automatic」/ 不要覆寫（使用 `vercel.json` 的 `ignoreCommand`）。
7. **Environment Variables**（只設定 **Preview** 環境，並把 **Git Branch 設為 `staging`**（branch-specific）；Production 環境留空，直到正式上線另行設定）：

| 名稱 | 值 | 環境 |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Staging Project URL | Preview（branch `staging`） |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Staging publishable / anon key | Preview（branch `staging`） |
| `NEXT_PUBLIC_SIGNUP_ENABLED` | `false` | Preview（branch `staging`） |
| `NEXT_PUBLIC_APP_ENV` | `staging` | Preview（branch `staging`） |
| `ENABLE_EXPERIMENTAL_COREPACK` | `1` | Preview |

   **不要**設定任何 service role / secret key、資料庫密碼或 `SUPABASE_INTERNAL_URL`。
8. （選用）**Deployment Protection**：開啟後 Preview 需要 Vercel 登入；自動化測試用 **Protection Bypass for Automation** 產生的 secret（GitHub secret `VERCEL_AUTOMATION_BYPASS_SECRET`）。可用選項依 Vercel 方案而定，以後台實際顯示為準。
9. 第一次執行 Staging deploy workflow 後（它會建立 `staging` 分支），在 Vercel → Deployments 找到 `staging` 分支的部署，記下 **Branch URL**（`https://<project>-git-staging-<team>.vercel.app`）。這個網址在每次更新 `staging` 時都不變。
10. 確認：`curl <Branch URL>/api/version` 回傳 `{"commit":"<main 的 SHA>","ref":"staging","env":"preview"}`；Deployments 列表中 main 的部署是 Ignored / Canceled（不是 Ready）。

### 4.3 GitHub Environment `staging`

Settings → Environments → **New environment** `staging`：

- **Required reviewers**：自己（每次部署都需要按下批准）。
- **Deployment branches and tags**：Selected branches → `main`（workflow 只在 main 執行；`staging` 分支由它更新）。
- **Environment secrets**：

| Secret | 內容 |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | Supabase 個人 access token（Account → Access Tokens；建議只給這個用途） |
| `STAGING_DB_PASSWORD` | Staging 資料庫密碼 |
| `STAGING_DB_URL` | Session pooler 連線字串（含密碼） |
| `SMOKE_USER_A_EMAIL` / `SMOKE_USER_A_PASSWORD` | smoke 測試帳號 A |
| `SMOKE_USER_B_EMAIL` / `SMOKE_USER_B_PASSWORD` | smoke 測試帳號 B |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | （選用）Vercel Deployment Protection bypass |

- **Environment variables**（非密鑰）：

| Variable | 內容 |
|---|---|
| `STAGING_PROJECT_REF` | Staging project ref |
| `PRODUCTION_PROJECT_REF` | （未來）Production project ref；設定後 guard 會拒絕誤用 |
| `STAGING_SUPABASE_URL` | Staging Project URL |
| `STAGING_SUPABASE_ANON_KEY` | Staging publishable / anon key（公開） |
| `STAGING_WEB_URL` | `staging` 分支的 Branch URL（例：`https://mining-expedition-git-staging-<team>.vercel.app`） |
| `STAGING_WEB_ORIGIN` | 同上的 origin（不含路徑） |
| `STAGING_ALLOWED_ORIGINS` | Edge CORS 允許清單：**只放上面那個 origin**（例：`https://mining-expedition-git-staging-<team>.vercel.app`；不需要萬用字元） |

第一次部署前 `staging` 分支還不存在、Branch URL 也還沒有：可以先填預期的網址（`<project>-git-staging-<team>.vercel.app`），第一次執行後到 Vercel 核對；不一致就更正 variables 並重新執行。

## 5. 部署順序（C；每次都要先由擁有者授權目標專案）

由 GitHub → Actions → **Staging deploy** → Run workflow（branch：`main`），輸入 Staging project ref，按下 Environment 的批准。workflow 依序執行（任何一步失敗就停止，摘要逐步列出結果）：

1. Pre-flight：typecheck + unit tests。
2. **Guard**：`scripts/staging/guard.ts`：輸入的 ref 必須等於 `STAGING_PROJECT_REF`、不得等於 `PRODUCTION_PROJECT_REF`；`supabase link` 之後再檢查一次連結的專案。
3. `supabase migration list --linked`：比對遠端與本地的 migration history。
4. `supabase db push --linked --dry-run`：列出將套用的 migration。
5. `supabase db push --linked`：套用（**不使用 `db reset`**；任何 Staging / Production 都禁止 reset）。
6. **Verify**：`psql -f supabase/ops/verify-staging.sql`（唯讀）：資料表與 RLS、Client 沒有寫入權限、函式 search_path 與執行權限、`market_secret` 存在、索引、兩個 cron job 的排程與指令。
7. `supabase secrets set GAME_API_ALLOWED_ORIGIN=...`；`supabase functions deploy health character-create game-state game-action`（Edge = commit X）。
8. **Promote Web**：`git push origin X:refs/heads/staging`；只允許 fast-forward（若 `staging` 不是 X 的祖先，代表有人直接 push 了 `staging`，workflow 停止）。Vercel 的 Git 整合因此建置 `staging` 的 Preview。
9. **版本核對**：每 15 秒查詢 `$STAGING_WEB_URL/api/version`，最多 15 分鐘，直到 `commit == X`；同時要求 `env == preview`、`ref == staging`。沒有等到就失敗（smoke 不會在舊版本上執行）。
10. **Smoke**：API（`tests/integration/staging-smoke.test.ts`）與瀏覽器（`tests/e2e/cloud/cloud-smoke.spec.ts`，desktop + mobile）。
11. **Ops report**：`supabase/ops/ops-report.sql`（排程結果、積壓、市場、連線）。

手動執行（本機，需要 Supabase CLI 已登入）：

```sh
export STAGING_PROJECT_REF=<ref> CONFIRM_PROJECT_REF=<ref>   # 不是密鑰
node scripts/staging/guard.ts
supabase link --project-ref "$STAGING_PROJECT_REF" && node scripts/staging/guard.ts
supabase migration list --linked
supabase db push --linked --dry-run
supabase db push --linked
psql "$STAGING_DB_URL" -v ON_ERROR_STOP=1 -q -f supabase/ops/verify-staging.sql
```

### Migration 規則

- 新的 migration 必須能從空資料庫重建（CI 每次 `supabase db reset` 驗證），而且只能往前（不修改已套用的檔案）。
- 部署順序：**migration → Edge Functions → Web**（新 Edge 可能需要新的 RPC；舊 Edge 與新資料庫相容）。Web 只在 workflow 推進 `staging` 分支時更新，所以在 Edge 部署完成之前，Staging 網站仍是上一個版本。
- 只想重新部署 Web（例如 Vercel 建置失敗後重試）：重新執行 workflow，取消勾選 `apply_migrations` / `deploy_functions`；**不要**直接 push `staging` 分支。

## 6. CI/CD 安全設計

| 要求 | 做法 |
|---|---|
| 不自動部署 Production | 沒有 Production workflow；Vercel Production Branch（main）的建置由 Ignored Build Step 略過；Production 環境變數留空 |
| Staging Web 是經過審核的 main commit | `staging` 分支只由 workflow 以 fast-forward 推進到被批准的 main commit；不自動同步 |
| Web 與 Edge 是同一版本 | smoke 前核對 `/api/version` 的 commit（瀏覽器 smoke 也會再檢查一次） |
| 「main = Preview」不會回來 | `scripts/staging/config-audit.test.mjs`（CI）：Ignored Build Step 的分支規則、`vercel.json`、workflow 的 promote / 版本核對步驟、文件中沒有 `git-main` 網址 |
| CORS | Cloud 上 `GAME_API_ALLOWED_ORIGIN` 沒有設定 → 拒絕所有瀏覽器 origin；workflow 要求必填；smoke 檢查允許的 origin 與多個拒絕案例 |
| PR CI 不需要 Cloud 密鑰 | `ci.yml` 只用 Supabase Local；`staging-deploy.yml` 只有 `workflow_dispatch` |
| 受保護的 Staging Environment | 密鑰只在 Environment `staging`；Required reviewers；只允許 `main` |
| PR 中不可信的程式碼取得密鑰 | 部署 workflow 不由 `pull_request` / `pull_request_target` 觸發；只部署 `main`（`if: github.ref == 'refs/heads/main'` + Environment branch policy） |
| 順序 | 單一 job：guard → migration → verify → Edge → promote `staging` → 版本核對 → smoke → report |
| 不把部分成功顯示為成功 | 任一步失敗 job 就失敗；Summary 列出每一步的 success / failure / skipped |
| 誤部署 | guard（輸入確認 + 不等於 Production + 連結後再檢查） |

## 7. Backup / Restore（摘要；細節見 `docs/OPERATIONS_RUNBOOK.md` §5）

- Supabase 方案（2026-11 查詢，以官方頁面為準）：Pro 方案可存取最近 7 天的每日備份；PITR 是付費加購。Free 方案官方建議自行用 `supabase db dump` 匯出並保存在其他地方；Free 專案閒置一週會被暫停。
- 必須包含：`public.*`（玩家狀態、寶物實例、離線報告、`action_log`、市場價格）、`private.player_secrets`、`private.market_secret`、`supabase_migrations.schema_migrations`。
- 演練只在**可拋棄的隔離專案**執行；不覆蓋正在使用的 Staging。

## 8. 成本與關閉

| 資源 | 成本（以官方定價為準） | 關閉方式 |
|---|---|---|
| Supabase Staging | Free：$0（有暫停、無每日備份下載）；Pro：每月 $25 起（每日備份 7 天） | Dashboard → Project → Pause / Delete（刪除前先依 runbook 匯出） |
| 還原演練專案 | 演練期間存在；結束後刪除 | Delete project |
| Vercel | Hobby 為個人非商業用途；團隊 / 商業需要 Pro | 刪除 Project 或移除 Git 整合 |
| GitHub Actions | 公開 repository 免費；私人 repository 依分鐘數 | 停用 workflow |

關閉 Staging：停用 Vercel Git 整合 → 停止 GitHub workflow → 匯出資料庫（若需要保留）→ 暫停或刪除 Supabase 專案 → 刪除 GitHub Environment secrets、撤銷 access token。

## 9. 驗收表（實際部署時填寫）

| # | 項目 | 狀態 | 證據 |
|---|---|---|---|
| 1 | Supabase Staging 專案建立、ref 已記錄 | ⏳ 待建立 | |
| 2 | Migration 套用（dry-run → push） | ⏳ Blocked（需要授權與專案） | |
| 3 | verify-staging.sql 通過 | ⏳ Blocked | |
| 4 | Edge Functions 部署、Cloud 打包成功 | ⏳ Blocked | |
| 5 | Vercel `staging` 分支 Preview 建置成功、`/api/version` = 部署的 main commit、main 的 Production 建置被略過 | ⏳ Blocked | |
| 6 | API / 瀏覽器 smoke 通過 | ⏳ Blocked | |
| 7 | cron 兩個 job 在 Cloud 成功執行 | ⏳ Blocked | |
| 8 | 備份還原演練 | ⏳ Blocked | |
| 9 | 效能量測（低負載） | ⏳ Blocked | |
