# 《挖礦探險隊》部署指南（單人開發版）

**Version 2.0** — 取代 PR #16 的 Staging 流程（`staging` 分支、GitHub Environment、Staging deploy workflow）。

這份文件給一個人維護的專案使用：照著做就能完成第一次部署。之後的日常部署只需要「merge main」或「一行指令」。

> **測試用途聲明**
> Vercel 會把 `main` 部署成 **Production Deployment**，這只是 Vercel 的名詞。它連接的是**測試用的 Supabase 專案**，目前只開放給受邀的封閉測試帳號，**尚未正式對玩家開放**：
> - 公開註冊已關閉（Supabase Auth + 畫面上不顯示註冊）。
> - 登入畫面顯示「TEST・封閉測試環境」。
> - 所有頁面都回傳 `X-Robots-Tag: noindex, nofollow`，不被搜尋引擎收錄。
> - 如果連網站本身都要限制，見 [§5 限制公開存取](#5-限制公開存取)。
>
> 正式上線時要建立**另一個** Supabase 專案，不可與這個測試專案共用資料庫、密鑰或帳號（[§8](#8-正式上線之前)）。

---

## 1. 架構

```
GitHub main ──(Vercel Git 整合，自動)──► Vercel：Next.js（apps/web）
     │                                     │ 瀏覽器只拿 publishable / anon key
     │                                     ▼ HTTPS（JWT；CORS 只允許 Vercel 網址）
     │                          Supabase Cloud（測試專案）
     │                            ├─ Auth（Email / Password；註冊關閉）
     │                            ├─ Edge Functions：health / character-create / game-state / game-action
     │                            │    （service role 只在這裡，由平台提供）
     │                            └─ PostgreSQL：RLS、RPC、private 密鑰表、pg_cron
     │                                     ▲
     │                                     │ 你在本機確認後執行：pnpm cloud ...
     └─ GitHub Actions：只跑 CI（型別、單元、整合、E2E、安全檢查），**不部署任何東西**
```

| 誰 | 做什麼 | 什麼時候 |
|---|---|---|
| Vercel | 建置並部署 `apps/web` | `main` 每次有新 commit（自動） |
| 你（本機 + Supabase CLI） | migration、Edge Functions、Edge secrets | 後端有變更時，手動執行並確認 |
| GitHub Actions | CI | 每個 PR / push；不需要任何雲端密鑰 |

保留的安全機制（都沒有因為簡化而移除）：CORS 允許清單（Cloud 未設定時拒絕所有 origin）、JWT 驗證、RLS、Client 不可寫入資料表、不信任 Client 的 `playerId`、Rate Limit、Action Log 與冪等（Idempotency-Key）、RPC 逾時、pg_cron 排程、資料庫驗證 SQL、備份與回滾程序。

---

## 2. 第一次設定（約 40 分鐘）

> 不要把 access token、資料庫密碼、service_role / secret key 貼到對話、Issue、PR、commit 或截圖。
> 這份流程只需要兩個「公開」的值：Project URL 與 publishable / anon key。

### 2.1 建立 Supabase 專案

1. [Supabase Dashboard](https://supabase.com/dashboard) → **New project**
   - 名稱：`mining-expedition-test`
   - Region：離測試者最近（台灣：Tokyo `ap-northeast-1` 或 Singapore `ap-southeast-1`）
   - Database password：產生後存到密碼管理器（日常部署**不需要**它）
2. 記下 **Project ref**（Project Settings → General，20 個小寫英文字母；不是密鑰）。
3. **Database → Extensions**：確認 `pg_cron` 已啟用（若沒有就啟用）。`pgcrypto` 預設可用。
4. **Authentication → Sign In / Providers → Email**：
   - **關閉「Allow new users to sign up」**（封閉測試）。
   - Confirm email：建議開啟。
5. Project Settings → **API Keys**：記下 **Project URL** 與 **publishable / anon key**（公開的）。
   **service_role / secret key 不需要複製到任何地方**（Edge Functions 由平台自動提供）。

Site URL 等 Vercel 網址確定後再設定（§2.3 第 6 步）。

### 2.2 建立 Vercel 專案

1. [Vercel](https://vercel.com/new) → **Add New → Project** → 匯入 GitHub repository。
2. 設定：

| 設定 | 值 |
|---|---|
| Root Directory | `apps/web` |
| Include files outside the root directory in the Build Step | **開啟**（共用程式在 `packages/`） |
| Framework Preset | Next.js（自動偵測） |
| Install / Build / Output Command | 保持預設 |
| Node.js Version | 22.x |
| Production Branch | `main`（預設） |

3. **Environment Variables**（最少只需要前兩個；都勾選 **Production**）：

| 名稱 | 值 | 必要 | 說明 |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<project-ref>.supabase.co` | ✅ | §2.1 的 Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | publishable / anon key | ✅ | 公開的 key；**絕對不要**放 service_role / secret key |
| `NEXT_PUBLIC_SIGNUP_ENABLED` | `false` | 建議 | 隱藏註冊分頁（真正的限制是 Supabase 的「關閉註冊」） |
| `NEXT_PUBLIC_APP_ENV` | `test` | 建議 | 登入畫面顯示「TEST・封閉測試環境」 |
| `ENABLE_EXPERIMENTAL_COREPACK` | `1` | 選填 | 讓 Vercel 使用 `packageManager` 指定的 pnpm 版本 |

   不要設定：任何 service role / secret key、資料庫密碼、`SUPABASE_INTERNAL_URL`（只有本地 Docker 使用）。
   `NEXT_PUBLIC_*` 會在**建置時**寫進網站，修改後要 Redeploy 才生效。

4. **Deploy**。完成後記下網址，例如 `https://mining-expedition.vercel.app`（Settings → Domains 的 Production Domain）。
5. 確認：開啟 `https://<你的網址>/api/version`，應看到 `{"commit":"…","ref":"main","env":"production"}`。
   （這需要 Settings → Environment Variables 的「Automatically expose System Environment Variables」保持開啟，這是預設值。）
6. 回到 Supabase → **Authentication → URL Configuration**：
   - Site URL：`https://<你的網址>`
   - Redirect URLs：`https://<你的網址>/**`
7. （選用）**Settings → Build and Deployment → Ignored Build Step** 選「Only build production」：PR 不會產生 Preview 部署（Preview 沒有設定環境變數，也不在 CORS 允許清單內，所以預設用不到）。

### 2.3 本機設定（開發容器）

所有指令都在開發容器內執行（內建固定版本的 Supabase CLI v2）。建議設定別名（README 已說明）：

```sh
alias dev='docker compose run --rm dev'
```

1. 建立部署設定（**不會**提交到 Git）：

   ```sh
   cp .env.cloud.example .env.cloud
   ```

   填寫：

   | 名稱 | 值 |
   |---|---|
   | `CLOUD_PROJECT_REF` | §2.1 的 Project ref |
   | `CLOUD_WEB_URL` | §2.2 的 Vercel 網址 |
   | `CLOUD_SUPABASE_ANON_KEY` | publishable / anon key（公開的） |
   | `CLOUD_BLOCKED_REFS` | 先留空；有正式環境後填入它的 ref，腳本會永遠拒絕部署到那裡 |

2. 登入 Supabase CLI（token 存在 Docker volume `supabase-cli-auth`，不在 repo 內）：

   ```sh
   dev supabase login
   ```

   依畫面指示在瀏覽器完成登入，或貼上 Account → Access Tokens 建立的 token（貼在終端機，不要貼到對話）。

3. 連結專案並檢查：

   ```sh
   dev pnpm cloud link       # 只寫入本機 supabase/.temp；若詢問資料庫密碼可直接 Enter 略過
   dev pnpm cloud status     # 唯讀：顯示目標、migration、secrets 名稱、函式、網站版本
   ```

### 2.4 第一次部署後端

順序：**資料庫 → Edge secrets → Edge Functions → 驗證 → smoke**。每個會修改遠端的指令都要你再輸入一次 project ref。

```sh
git switch main && git pull                 # 只部署已合併的 main

dev pnpm cloud db                           # ① 唯讀 dry-run：列出待套用的 migration 與「計畫 ID」
# 確認清單正確後：
dev pnpm cloud db --apply --ref <ref> --plan <計畫 ID>     # ② 套用 migration（沒有 reset）

dev pnpm cloud secrets --ref <ref>          # ③ Edge secrets：CORS 允許清單 = CLOUD_WEB_URL
dev pnpm cloud functions --ref <ref>        # ④ 部署 4 個 Edge Functions，並檢查 health
dev pnpm cloud verify                       # ⑤ 資料庫安全驗證（見下方）
dev pnpm cloud smoke                        # ⑥ 最小 smoke test
```

**⑤ 資料庫驗證**（唯讀；檢查 RLS、Client 沒有寫入權限、函式權限、密鑰表、索引、兩個 cron job）有兩種做法：

- **最簡單**：Supabase Dashboard → **SQL Editor** → 貼上 `supabase/ops/verify-cloud.sql` 的全部內容 → Run。沒有錯誤 = 通過；有問題會列出每一項。
- **指令**：在同一個終端機臨時提供連線字串（Dashboard → Connect → Session pooler），不寫入任何檔案：

  ```sh
  read -rs CLOUD_DB_URL && export CLOUD_DB_URL     # 貼上後按 Enter（不會顯示）
  docker compose run --rm -e CLOUD_DB_URL dev pnpm cloud verify
  unset CLOUD_DB_URL
  ```

**⑥ smoke test** 不需要任何帳號就能跑基本檢查（health、未登入 → 401、CORS 只允許你的網址）。想多測登入後的流程，建立一個測試帳號（§2.5），在終端機臨時提供：

```sh
export SMOKE_USER_EMAIL=... ; read -rs SMOKE_USER_PASSWORD && export SMOKE_USER_PASSWORD
docker compose run --rm -e SMOKE_USER_EMAIL -e SMOKE_USER_PASSWORD dev pnpm cloud smoke
```

最後開啟 Vercel 網址，用測試帳號登入、挖礦、同步、重新整理，確認資料保留（[`docs/CLOUD_SMOKE_TEST.md`](CLOUD_SMOKE_TEST.md) 有 5 分鐘的手動清單）。

### 2.5 建立測試帳號

公開註冊已關閉，帳號由你建立：Supabase → **Authentication → Users → Add user**（Create new user，勾選 Auto Confirm），或 **Invite user** 寄邀請信。不需要兩組專用帳號才能部署；smoke 帳號是選用的。

---

## 3. 日常部署

### 3.1 只改前端

PR 通過 CI → merge 到 `main` → Vercel 自動部署。完成。
（確認：`/api/version` 的 `commit` 是新的 main。）

### 3.2 只改後端（migration / Edge Functions）

PR 通過 CI 並 merge 之後：

```sh
git switch main && git pull
dev pnpm cloud db                                        # 有新 migration 才需要
dev pnpm cloud db --apply --ref <ref> --plan <計畫 ID>
dev pnpm cloud functions --ref <ref>                     # 有改 supabase/functions 或 packages/ 才需要
dev pnpm cloud smoke
```

- 只改了一個函式：`dev pnpm cloud functions --ref <ref> --only game-action`。
- `packages/game-engine`、`packages/game-server` 是 Edge Functions 的一部分：改了它們也要重新部署函式。
- 改了限流、逾時或網址：更新 `.env.cloud` 後 `dev pnpm cloud secrets --ref <ref>`。

### 3.3 前後端都改

原則：**新的後端必須能服務舊的前端**，所以通常是「先後端、後前端」。

| 情況 | 做法 |
|---|---|
| 後端向下相容（新增 RPC / 欄位 / 函式，舊前端不受影響）— **最常見** | 分兩個 PR：先 merge 後端 PR 並執行 §3.2，確認 smoke 通過，再 merge 前端 PR（Vercel 自動部署） |
| 同一個 PR 同時改兩邊 | merge 前先**暫停 Vercel 自動部署**（下方），merge → 執行 §3.2 → 恢復自動部署並 Redeploy 最新的 main |
| 後端不相容（會讓舊前端壞掉） | 盡量拆成相容的步驟（先加新的、再移除舊的）。真的無法拆時用「暫停」流程，並接受部署期間的短暫中斷（目前是封閉測試） |

**暫停 Vercel 自動部署**：Vercel → Settings → Build and Deployment → **Ignored Build Step** 改成「Don't build anything」（選項名稱以後台為準）。恢復時改回原本的設定（「Automatic」或「Only build production」），再到 Deployments 對最新的 main 按 **Redeploy**。
（`apps/web/vercel.json` 刻意不設定 `ignoreCommand`，否則會覆蓋後台的這個設定。）

### 3.4 與 Claude Code 一起部署

你可以請 Claude Code 代為執行，但每次遠端修改都由你確認：

1. Claude 執行唯讀的 `pnpm cloud db`（或 `status`），把 migration 清單與計畫 ID 給你看。
2. 你確認目標 project ref 與清單後，明確回覆「可以套用」。
3. Claude 才執行 `pnpm cloud db --apply --ref <ref> --plan <id>`。計畫 ID 不同（例如中間多了 migration）就會被拒絕，必須重新確認。

`--ref` 與 `--plan` 就是你的確認；腳本在非互動模式下不會再詢問。

---

## 4. 部署工具的安全檢查（`scripts/cloud/deploy.ts`）

| 檢查 | 說明 |
|---|---|
| 目標專案 | 會修改遠端的指令都需要 `--ref`，且必須等於 `.env.cloud` 的 `CLOUD_PROJECT_REF`、等於 `supabase link` 的專案、不在 `CLOUD_BLOCKED_REFS` |
| 程式碼來源 | 必須沒有未提交的變更，且 HEAD = `origin/main`（緊急時可加 `--allow-unmerged` 略過後者，前者不能略過） |
| Migration | 一律先 dry-run；`--apply` 需要 dry-run 的計畫 ID（含 migration 檔名與內容的雜湊），計畫改變就拒絕 |
| 禁止的指令 | `db reset`、`migration repair`、`migration squash`、`db pull`、`--db-url` 一律拒絕；沒有任何會刪除玩家資料的指令 |
| Supabase CLI | 只接受 v2（開發容器內建 2.122.1）；v3 的遠端指令語法不同 |
| Edge secrets | 只接受固定的名稱；CORS 只接受完整的 https origin（不可用 `*`）；透過權限 600 的暫存檔交給 CLI，結束後刪除，不出現在指令列 |
| Edge Functions | 部署前確認 Cloud 已設定 `GAME_API_ALLOWED_ORIGIN`；部署後檢查 health |
| 密鑰 | 不讀取、不輸出 access token、資料庫密碼、service role key；資料庫連線字串只接受環境變數 |

CI 的 `scripts/cloud/config-audit.test.ts` 會檢查：GitHub Actions 沒有任何部署步驟或雲端密鑰、`vercel.json` 不會略過 main 且有 noindex、部署腳本沒有 reset、設定檔與備份不會被提交、Edge CORS 在 Cloud 未設定時拒絕所有 origin。

---

## 5. 限制公開存取

預設的保護：公開註冊關閉（沒有帳號無法遊玩）、noindex。網站本身（登入頁）仍然公開。需要更嚴格時：

| 選項 | 效果 | 成本 / 注意 |
|---|---|---|
| **A. 維持預設**（建議，封閉測試） | 任何人能看到登入頁，但只有你建立的帳號能登入 | 免費；Supabase Auth 是真正的門檻 |
| **B. Vercel Authentication：All Deployments** | Settings → Deployment Protection → Vercel Authentication，範圍選 **All Deployments**：連 Production 網址都要先登入 Vercel 帳號 | Vercel 已改為所有方案免費提供（2026 年）；只有 Vercel 團隊成員能進入，Hobby 方案的團隊只有你自己 → 適合「只有我自己測」 |
| **C. Password Protection** | 用一組密碼分享給測試者 | Hobby 不提供；Pro 需付費加購 |
| **D. 暫時不對外** | 開啟 B；或在 Vercel 刪除專案（資料都在 Supabase，不受影響，之後可重新建立） | 測試告一段落時使用 |

開啟 B 之後，`pnpm --filter @mining/e2e test:cloud`（瀏覽器 smoke）需要 Protection Bypass for Automation 的 secret（只在終端機臨時設定 `VERCEL_AUTOMATION_BYPASS_SECRET`）。API smoke 不受影響（直接呼叫 Supabase）。

---

## 6. 回滾、備份、排程

詳細步驟在 [`docs/OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md)。摘要：

| 項目 | 做法 |
|---|---|
| 前端回滾 | Vercel → Deployments → 上一個正常的 Production 部署 → **Instant Rollback**（Hobby 方案可能只能回到前一個部署，以後台為準）；之後在 main revert 該 PR，避免下次部署又帶回問題 |
| Edge Functions 回滾 | `git switch --detach <上一個正常的 commit>` → `dev pnpm cloud functions --ref <ref> --allow-unmerged` → 回到 main 並 revert |
| 資料庫 | 只能往前修（新的 migration）；**禁止 `db reset`** |
| 備份 | `dev pnpm cloud backup`（唯讀 `supabase db dump`，輸出到 `backups/`，已 gitignore；含玩家資料，請放在加密的位置）。Free 方案沒有可下載的每日備份 |
| 還原演練 | 只在另外建立的、可拋棄的專案進行，不覆蓋測試專案 |
| Cron 驗證 | `dev pnpm cloud verify`（排程存在且設定正確）+ `dev pnpm cloud report`（最近 24 小時的執行結果、積壓、今天的市場價格）；或把 SQL 貼到 SQL Editor |

---

## 7. 指令速查

| 指令 | 會修改遠端？ | 用途 |
|---|---|---|
| `dev pnpm cloud status` | 否 | 目標、migration、secrets 名稱、函式、網站版本 |
| `dev pnpm cloud link` | 否（只寫本機） | 連結 `CLOUD_PROJECT_REF` |
| `dev pnpm cloud db` | 否 | dry-run 與計畫 ID |
| `dev pnpm cloud db --apply --ref <ref> --plan <id>` | **是** | 套用 migration |
| `dev pnpm cloud secrets --ref <ref>` | **是** | Edge secrets（CORS、限流、逾時） |
| `dev pnpm cloud functions --ref <ref> [--only a,b]` | **是** | 部署 Edge Functions |
| `dev pnpm cloud verify` | 否 | 資料庫安全驗證（需要 `CLOUD_DB_URL`，或用 SQL Editor） |
| `dev pnpm cloud report` | 否 | 營運報告 |
| `dev pnpm cloud smoke` | 測試帳號的遊戲狀態會前進（同步） | 最小 smoke test |
| `dev pnpm cloud backup` | 否 | 邏輯備份到 `backups/` |

常見錯誤：

| 訊息 | 處理 |
|---|---|
| `尚未連結專案` / `目前連結的專案是…` | `dev pnpm cloud link` |
| `不是 origin/main` | `git switch main && git pull` |
| `計畫已改變` | 重新執行 `dev pnpm cloud db` 並確認新的清單 |
| `需要 Supabase CLI v2` | 在開發容器內執行（`dev pnpm cloud …`） |
| `dry-run 失敗` | 遠端 migration 歷史與本地不同：先 `dev pnpm cloud status` 找原因，**不要**用 `migration repair` 硬改 |
| `尚未設定 GAME_API_ALLOWED_ORIGIN` | `dev pnpm cloud secrets --ref <ref>` |
| 瀏覽器 CORS 錯誤 | `.env.cloud` 的 `CLOUD_WEB_URL` 是否等於實際網址 → `dev pnpm cloud secrets --ref <ref>` |
| 登入後跳回登入頁 | Supabase 的 Site URL / Redirect URLs 是否為 Vercel 網址 |

更多故障排除：[`docs/OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md) §7。

---

## 8. 正式上線之前

這套流程是為「一個人 + 一個測試專案」設計的。正式開放玩家前：

1. 建立**另一個** Supabase 專案（資料庫、RNG secret、market secret、帳號都獨立），把它的 ref 加入測試環境 `.env.cloud` 的 `CLOUD_BLOCKED_REFS`。
2. 決定 Vercel 的環境劃分（例如正式環境用 Production、測試改用另一個 Vercel 專案），並移除 `apps/web/vercel.json` 的 noindex。
3. 視需要恢復更嚴格的流程（受保護的部署、多人審核、自動化部署）；PR #16 的 Staging workflow 可以在 Git 歷史中找到。
