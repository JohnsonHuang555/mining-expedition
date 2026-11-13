# 挖礦探險隊 Mining Expedition

以挖掘、收藏與裝備成長為核心的網頁放置遊戲。目前在 **Phase 1：Docker-first monorepo 骨架與環境驗證**，尚未實作遊戲功能。

| 文件 | 內容 |
|---|---|
| [`docs/GDD.md`](docs/GDD.md) | 遊戲企劃 |
| [`docs/GBS.md`](docs/GBS.md) | 遊戲規則與數值 |
| [`docs/TECHNICAL_SPEC.md`](docs/TECHNICAL_SPEC.md) | 技術規格 |
| [`docs/ANALYSIS_REPORT.md`](docs/ANALYSIS_REPORT.md) | 決策紀錄與分析 |

## 專案結構

```text
mining-expedition/
├── apps/web/                      # Next.js 16（App Router）— 部署到 Vercel
├── packages/
│   ├── game-engine/               # 純 TypeScript 遊戲引擎（Web 與 Edge Functions 共用）
│   └── game-data/                 # 靜態遊戲資料、DATA_VERSION
├── supabase/
│   ├── config.toml                # 本地 Supabase 設定
│   ├── migrations/                # 資料庫 migration（部署到 Supabase Cloud）
│   └── functions/health/          # Edge Function（部署到 Supabase Cloud）
├── scripts/
│   ├── balance-sim.ts             # 平衡模擬（開發輔助工具）
│   ├── env-sync.ts                # 產生本地 apps/web/.env.local
│   └── verify-env.ts              # 本地連線驗證
├── docker/entrypoint.sh           # 開發容器入口（權限處理）
├── Dockerfile.dev                 # 開發容器（只用於本地）
└── compose.yaml                   # 本地開發環境（只用於本地）
```

| 元件 | 版本 |
|---|---|
| Node.js | 22（開發容器 `node:22-bookworm-slim`；Vercel 選 22.x） |
| pnpm | 10.34.9 |
| Next.js / React | 16.4.6 / 19.3.1 |
| TypeScript | 5.9.3 |
| Vitest | 5.1.0 |
| Supabase CLI | 2.122.1（v3 是否升級見 TECHNICAL_SPEC §17 T14） |

---

## 本地開發（Docker-first）

本機只需要 **Docker Desktop**、**Git** 與編輯器。Node.js、pnpm、Supabase CLI 都在開發容器內執行；Supabase 的本地服務由容器內的官方 CLI 透過 Docker 啟動。

> 支援 macOS、Linux、Windows（WSL2）。請在 repo 根目錄執行所有指令。

### 第一次啟動

```bash
cp .env.example .env                                   # 1. compose 設定（通常不需修改）
docker compose build                                   # 2. 建立開發容器映像
docker compose run --rm dev pnpm install               # 3. 安裝套件
docker compose run --rm dev pnpm supabase:start        # 4. 啟動 Supabase Local（第一次會下載映像，需要幾分鐘）
docker compose run --rm dev pnpm env:sync              # 5. 產生 apps/web/.env.local
docker compose up -d web                               # 6. 啟動 Next.js（Hot Reload）
docker compose run --rm dev pnpm verify:env            # 7. 驗證 Web / Edge Functions / Postgres 連線
docker compose run --rm dev pnpm verify:hot-reload     # 8. 驗證 Hot Reload
```

全部成功時，第 7 步顯示五個 ✅、第 8 步顯示兩個 ✅。驗收項目與目前狀態見 [`docs/PHASE1_ACCEPTANCE.md`](docs/PHASE1_ACCEPTANCE.md)。

> `web` 會加入 `supabase start` 建立的 Docker 網路，所以一定要先啟動 Supabase（第 4 步）再啟動 web（第 6 步）。

| 服務 | 網址 |
|---|---|
| Web | http://127.0.0.1:3000（`next dev` 時顯示本地環境診斷） |
| Supabase API | http://127.0.0.1:54321 |
| Supabase Studio | http://127.0.0.1:54323 |
| Postgres | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` |

### 常用指令

建議先設定別名：`alias dev='docker compose run --rm dev'`

| 指令 | 用途 |
|---|---|
| `docker compose up -d web` / `docker compose logs -f web` | 啟動 Next.js / 查看日誌 |
| `docker compose stop web` | 停止 Next.js |
| `dev pnpm supabase:start` / `dev pnpm supabase:stop` | 啟動 / 停止 Supabase（資料保留） |
| `dev pnpm supabase:status` | 查看 Supabase 網址與本地金鑰 |
| `dev pnpm db:reset` | 重建本地資料庫並重新套用 migrations（**會清除本地資料**） |
| `dev pnpm verify:env` | 連線驗證 |
| `dev pnpm verify:hot-reload` | Hot Reload 驗證（暫時改寫 `packages/game-engine/src/dev-marker.ts`，結束後還原） |
| `dev pnpm diagnose` | 收集 Docker / Supabase 狀態（金鑰會遮蔽），回報問題時使用 |
| `dev pnpm check` | typecheck + test + build |
| `dev pnpm sim` | 平衡模擬（參數見 `scripts/balance-sim.ts` 開頭） |
| `dev bash` | 進入開發容器 |
| `docker compose --profile functions up functions` | 選用：以 `supabase functions serve` 執行 Edge Functions |

### Hot Reload

- **Web**：`apps/web`、`packages/*` 的變更會自動重新載入。若偵測不到檔案變更，在 `.env` 設 `WATCHPACK_POLLING=true` 後 `docker compose up -d web`。
- **Edge Functions**：`supabase start` 以 `oneshot` 模式提供函式，每個請求都會重新載入，包含 `packages/` 的變更。**在 `packages/` 新增檔案或新的匯入後，要 `dev pnpm supabase:stop && dev pnpm supabase:start`**（CLI 只掛載啟動當下被匯入的檔案）。

### 資料持久化

| 資料 | 位置 | 清除方式 |
|---|---|---|
| Postgres | Supabase CLI 建立的 Docker volume | `dev supabase stop --no-backup` 或 `dev pnpm db:reset` |
| pnpm store | compose volume `pnpm-store` | `docker compose down -v` |
| node_modules | repo 內（bind mount） | 刪除資料夾後重新 `dev pnpm install` |

`supabase stop` 不加參數時，資料會保留到下次 `supabase start`。

### 環境變數

| 變數 | 本地（Docker + Supabase Local） | 正式（Vercel + Supabase Cloud） |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `http://127.0.0.1:54321`（`pnpm env:sync` 產生） | `https://<project-ref>.supabase.co`（Vercel 設定） |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 本地金鑰（`pnpm env:sync` 產生） | Supabase Cloud 的 publishable / anon key（Vercel 設定） |
| `SUPABASE_INTERNAL_URL` | `http://supabase_kong_mining-expedition:8000`（web 容器經 Supabase 的 Docker 網路使用） | **不設定**（自動改用 `NEXT_PUBLIC_SUPABASE_URL`） |
| `EDGE_DIAGNOSTICS`（Edge Functions） | `supabase/config.toml` 的 `[edge_runtime.secrets]` 設為 `true` | **不設定**（健康檢查只回傳 `{"ok": boolean}`） |
| `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`（Edge Functions） | CLI 自動注入 | Supabase Cloud 自動注入 |
| 自訂 secret（Edge Functions） | `supabase/functions/.env` | `supabase secrets set` |

- 本地與正式使用不同的檔案與設定位置，彼此不會互相讀取。
- `.env`、`apps/web/.env.local`、`supabase/functions/.env` 都在 `.gitignore`；只提交 `*.example`。
- 本地金鑰是 Supabase CLI 產生的開發用金鑰，不能用於正式環境。

### Docker 設計與安全性

| 項目 | 說明 |
|---|---|
| Docker socket | Supabase CLI 需要 Docker 才能啟動本地服務，所以 `dev` 與 `functions` 會掛載 `/var/run/docker.sock`。**這等同把宿主 Docker 的完整權限交給容器**：只在這兩個服務使用，不要在容器內執行來源不明的程式碼。`web` 不掛載 socket |
| 非 root 執行 | 入口腳本把容器內的 `node` 使用者對應到 repo 擁有者的 UID / GID，再以 `node` 執行指令。socket 屬於 root 時（Docker Desktop 常見），改用只有 `node` 可存取的代理 socket |
| 相同路徑掛載 | Repo 以宿主上的絕對路徑掛載到容器內。Supabase CLI 傳給 Docker 的 bind mount 路徑因此在宿主上也成立 |
| 網路 | `dev`、`functions` 使用 host network，讓 Supabase CLI 以 `127.0.0.1` 連到它啟動的服務；`web` 加入 Supabase 的 Docker 網路，直接連 API gateway 容器 |
| 對外埠 | `web` 只綁定 `127.0.0.1:3000`。**Supabase CLI 發布的埠綁定 `0.0.0.0`**，同一網路的裝置可以連到本地 Supabase；在不信任的網路請啟用防火牆，或不用時 `supabase:stop` |
| 與正式部署的關係 | `Dockerfile.dev`、`compose.yaml`、`docker/` 只用於本地；Vercel 與 Supabase Cloud 都不會讀取 |

### 健康檢查與診斷

| 端點 | 本地（`next dev`） | 正式（Vercel production / preview） |
|---|---|---|
| `GET /api/health` | `{"ok": true}` / 503 `{"ok": false}` | 相同；失敗原因只寫入伺服器日誌 |
| `GET /api/dev/diagnostics`、`/` 的診斷表 | 引擎版本、延遲、錯誤細節 | 404 / 只顯示「開發中」 |
| `GET /functions/v1/health` | 加上引擎資訊與資料庫細節（`EDGE_DIAGNOSTICS=true`） | 只回傳 `{"ok": boolean}` |

- 所有健康檢查都只使用 anon key 呼叫 `health_ping`（回傳固定的 `{"pong": true}`），不使用 service role，也不回傳 PostgreSQL 版本。
- 診斷只依 `NODE_ENV === "development"` 開啟，沒有可在正式環境打開的開關。

### 疑難排解

| 狀況 | 處理 |
|---|---|
| `verify:env` 的 Edge Function 項目失敗，日誌出現匯入錯誤（例如 `InvalidWorkerCreation`） | Edge Function 匯入 `packages/` 在本地 `functions serve` 不相容（TECHNICAL_SPEC §17 T15）。請回報錯誤訊息；備案是建置時把引擎複製到 `supabase/functions/_shared/` |
| `supabase start` 出現 `permission denied ... docker.sock` | `docker compose run --rm dev docker info` 確認容器能存取 Docker；回報輸出 |
| `supabase start` 等待健康檢查逾時 | 確認 Docker Desktop 支援 host network（Settings → Resources → Network → Enable host networking），或回報日誌 |
| `web` 連不到 Supabase | 重新執行 `dev pnpm env:sync`，再 `docker compose restart web` |
| `docker compose up -d web` 出現 `network supabase_network_mining-expedition declared as external, but could not be found` | 先執行 `dev pnpm supabase:start` |
| 任何驗證失敗 | 執行 `dev pnpm diagnose`，把輸出與 `verify:env` / `verify:hot-reload` 的結果一起回報 |
| 埠已被占用（3000 / 54321–54324） | 在 `.env` 改 `WEB_PORT`；Supabase 的埠在 `supabase/config.toml` |
| 想完全重來 | `dev supabase stop --no-backup && docker compose down -v` |

---

## 測試與建置

```bash
dev pnpm typecheck   # 所有 packages、apps 與 scripts 的型別檢查
dev pnpm test        # Vitest（packages/game-engine）
dev pnpm build       # 依序建置所有 workspace（packages 型別檢查 + next build）
dev pnpm check       # 以上三項
```

`pnpm build` 不需要 Supabase 或 Docker 網路，也可以在任何有 Node 22 與 pnpm 的環境（例如 CI、Vercel）執行。

### CI（GitHub Actions）

`.github/workflows/ci.yml` 在每個 PR 與 `main` 的 push 執行：

| Job | 內容 |
|---|---|
| install / typecheck / test / build | `pnpm install --frozen-lockfile` → `pnpm typecheck` → `pnpm test` → `pnpm build`（Node 22，不使用 Docker） |
| deno check (Edge Functions) | 以 Deno 型別檢查 Edge Function（含匯入 `packages/`） |
| docker integration (Linux) | 依上方「第一次啟動」步驟，在 Linux runner 以開發容器啟動 Supabase Local，執行 `verify:env`、`verify:hot-reload`、`diagnose`。**只代表 Linux + Docker Engine，不代表 Docker Desktop** |

---

## 部署（正式環境）

正式環境：**Vercel**（`apps/web`）+ **Supabase Cloud**（資料庫與 Edge Functions）。兩者獨立部署，都不使用 Docker 開發設定。

> 目前只確認了部署相容性，尚未建立正式的 Vercel 或 Supabase 專案。

### Vercel（apps/web）

| 設定 | 值 |
|---|---|
| Root Directory | `apps/web` |
| Include source files outside of the Root Directory in the Build Step | **啟用**（需要讀取 `packages/`） |
| Framework Preset | Next.js |
| Install Command | 預設（Vercel 依 repo 根目錄的 `pnpm-lock.yaml` 使用 pnpm 安裝整個 workspace） |
| Build Command | 預設（`next build`，即 `apps/web` 的 `pnpm build`） |
| Output Directory | 預設 |
| Node.js Version | 22.x |
| Environment Variables | `NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_ANON_KEY`（Production 與 Preview 指向不同的 Supabase 專案） |

- 共用 packages 以 TypeScript 原始碼提供，由 `next.config.ts` 的 `transpilePackages` 轉譯；`outputFileTracingRoot` / `turbopack.root` 指向 monorepo 根目錄。
- 若要讓 Vercel 使用與本地相同的 pnpm 版本（`packageManager: pnpm@10.34.9`），可加環境變數 `ENABLE_EXPERIMENTAL_COREPACK=1`。
- 不要設定 `SUPABASE_INTERNAL_URL`。

本地模擬 Vercel 的建置方式（不需要 Vercel 帳號）：

```bash
dev bash -c "cd apps/web && pnpm install --frozen-lockfile && pnpm build"
```

### Supabase Cloud（資料庫與 Edge Functions）

在開發容器內執行（第一次需要 `supabase login`）：

```bash
dev supabase login
dev supabase link --project-ref <project-ref>
dev supabase db push                                   # 套用 supabase/migrations
dev supabase functions deploy health --use-api         # 由 Supabase 伺服器端打包，可匯入 packages/
dev supabase secrets set --env-file supabase/functions/.env   # 之後有自訂 secret 時
```

- `--use-api` 由 Supabase 伺服器端打包，不需要本地 Docker；只要匯入的檔案位於 git repo 內，`supabase/` 以外的檔案也會一起上傳。
- Migration 與 Edge Functions 可分別部署，也不依賴 Vercel。
- 以上指令是 Supabase CLI v2 的寫法；若升級到 v3，連到雲端的資料庫指令需要加 `--remote`，非互動環境需要 `--yes`。

---

## 開發流程

- 所有開發在 feature branch 進行，完成後開 Pull Request，不直接推送 `main`。
- 修改遊戲數值時，依 `docs/GBS.md` §24 更新 `DATA_VERSION` 並執行平衡模擬。
