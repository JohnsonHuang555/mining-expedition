# Phase 1 驗收：Docker-first 開發環境

對應 PR #2 review 的 P1 要求。每一項都列出驗證方式、目前狀態與失敗時的診斷方式。

**狀態說明**

- ✅ CI（Linux）：在 GitHub Actions 的 `docker integration (Linux)` job 實際執行通過（Ubuntu + Docker Engine，非 Docker Desktop）。
- ⏳ Docker Desktop：尚未在 Docker Desktop（macOS / Windows）上驗證，需要在本機執行。
- ❌：已知失敗。

## 驗收項目

| # | 項目 | 驗證方式 | CI（Linux） | Docker Desktop |
|---|---|---|---|---|
| 1 | 建立及啟動開發容器 | `docker compose build`、`docker compose run --rm dev pnpm install` | ✅ | ⏳ |
| 2 | Supabase CLI 透過 Docker socket 啟動服務 | `docker compose run --rm dev pnpm supabase:start` | ✅ | ⏳ |
| 3 | Next.js 呼叫真實 Supabase Local | `verify:env` 的「Web（next dev）→ Edge Function / PostgREST」 | ✅ | ⏳ |
| 4 | Edge Runtime 匯入 `packages/game-engine`、`packages/game-data` | `verify:env` 的「Edge Function → packages/game-engine + Postgres」 | ✅ | ⏳ |
| 5 | PostgREST、Edge Function、Postgres 全鏈路 | `verify:env` 全部 ✅ | ✅ | ⏳ |
| 6a | Hot Reload：Next.js 重新載入 `packages/` | `verify:hot-reload` 第 1 項 | ✅ | ⏳ |
| 6b | Hot Reload：Edge Runtime 重新載入 `packages/` | `verify:hot-reload` 第 2 項（`policy = "oneshot"`） | ✅ | ⏳ |
| 7 | 正式環境健康檢查不洩漏內部資訊 | `verify:env` 的「Web /api/health 只回傳 ok」；production 模式下診斷端點 404 | ✅ | — |

CI 的完整紀錄：PR #2 的 Checks → `docker integration (Linux)`，其中 `diagnose` 步驟的輸出包含工具版本、socket 權限、容器、網路、Edge Runtime 掛載與日誌。

## 在 Docker Desktop 上驗收

在 repo 根目錄執行（macOS 終端機，或 Windows 的 WSL2）：

```bash
cp .env.example .env
docker compose build
docker compose run --rm dev pnpm install
docker compose run --rm dev pnpm supabase:start
docker compose run --rm dev pnpm env:sync
docker compose up -d web
docker compose run --rm dev pnpm verify:env          # 預期 5 個 ✅
docker compose run --rm dev pnpm verify:hot-reload   # 預期 2 個 ✅
docker compose run --rm dev pnpm diagnose            # 不論成功或失敗都請附上
```

另外手動確認一次編輯器存檔的 Hot Reload：

1. 打開 http://127.0.0.1:3000，記下表格上方的 `DEV_MARKER`。
2. 用你平常的編輯器把 `packages/game-engine/src/dev-marker.ts` 的值改成別的字串並存檔。
3. 重新整理頁面，`DEV_MARKER` 應該更新；`curl http://127.0.0.1:54321/functions/v1/health` 的 `devMarker` 也應該更新。
4. 改回 `"initial"`。

## 失敗時的診斷

| 失敗的步驟 | 先看什麼 | 常見原因 |
|---|---|---|
| `docker compose build` | build 輸出 | 下載 Supabase CLI（github.com）或 Docker 映像被擋 |
| `supabase:start` 出現 `permission denied ... docker.sock` | `diagnose` 的「Docker socket 權限」 | Docker Desktop 的 socket 屬於 root：入口腳本應改用 `/var/run/docker-node.sock` 代理，確認 `DOCKER_HOST` |
| `supabase:start` 健康檢查逾時 | `diagnose` 的「Supabase 容器」 | Docker Desktop 的 host network 行為與 Linux 不同（`dev` 容器以 `127.0.0.1` 連服務） |
| `up -d web` 找不到 `supabase_network_mining-expedition` | — | 還沒執行 `supabase:start` |
| `verify:env` 的 Edge Function 項目失敗 | `diagnose` 的「Edge Runtime 掛載」「Edge Runtime 最近日誌」 | 掛載清單沒有 `packages/` 的檔案（路徑不一致），或匯入錯誤 |
| `verify:env` 的 Web 項目失敗 | `diagnose` 的「web 最近日誌」 | `apps/web/.env.local` 未產生或過期：重新 `env:sync` 並 `docker compose restart web` |
| `verify:hot-reload` 的 web 項目失敗 | — | 檔案監看收不到事件：`.env` 設 `WATCHPACK_POLLING=true` 後 `docker compose up -d web` |
| `verify:hot-reload` 的 edge 項目失敗 | `diagnose` 的「Edge Runtime 掛載」 | 見下方「已知限制」 |

## CI 實測得到的事實（Linux）

| 項目 | 結果 |
|---|---|
| Supabase CLI 2.122.1 在容器內透過 socket 啟動全部服務 | 可行 |
| Socket 權限 | Linux 的 socket 屬於 `docker` 群組，入口腳本以群組方式授權給 `node`（UID 對應到 repo 擁有者 1001） |
| Edge Runtime 掛載 | `supabase/functions` 整個資料夾，加上**被匯入的 `packages/` 檔案逐一單獨掛載**（啟動時計算） |
| 本地金鑰格式 | `supabase status` 提供 `sb_publishable_…` / `sb_secret_…`；`env:sync` 使用 publishable key |
| 對外綁定 | Supabase CLI 發布的埠綁定 **`0.0.0.0`**（54321 API、54322 Postgres、54323 Studio、54324 Mailpit、54327 Analytics） |

## 已知限制

1. **新增 `packages/` 檔案後要重新啟動 Supabase**：Edge Runtime 只掛載啟動當下被匯入的檔案。新增檔案或新的匯入後，執行 `dev pnpm supabase:stop && dev pnpm supabase:start`。
2. **編輯器的「安全存檔」可能讓 Edge Runtime 看不到變更**：單一檔案的 bind mount 綁定的是原本的檔案；若編輯器以「寫入暫存檔再改名」方式存檔（例如 JetBrains 的 safe write），容器內仍是舊內容。VS Code 預設直接覆寫，不受影響。遇到時重新啟動 Supabase，或關閉 safe write。
3. **本地 Supabase 對區網開放**：埠綁定 `0.0.0.0`，同一網路的其他裝置可以連到本地 Supabase（使用公開的本地預設金鑰）。在不信任的網路上開發時，請啟用作業系統防火牆，或在不用時 `supabase:stop`。
