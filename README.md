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
├── apps/web/                      # Next.js 16（App Router、Tailwind CSS 4、Zustand）— 部署到 Vercel
│   └── src/
│       ├── app/                   # 路由：/（遊戲）、/login、/dev（只在 next dev）
│       ├── components/            # auth/（登入）、game/（主畫面、離線報告、建立角色）、ui/（像素元件）
│       └── lib/                   # auth/（Supabase Browser Client、Session）、game/（API Client、Store、同步控制器）
├── packages/
│   ├── game-engine/               # 純 TypeScript 遊戲引擎（Web 與 Edge Functions 共用）
│   ├── game-data/                 # 靜態遊戲資料、DATA_VERSION
│   └── game-server/               # 伺服器協調層：載入快照 → executeRequest → 原子提交（Node / Deno 共用）
├── tests/integration/             # 真正的 Supabase Local 整合測試（RLS、RPC、冪等、並行、Edge Functions、Web Client）
├── tests/e2e/                     # Playwright：瀏覽器 → Next.js → Supabase Local 的端到端測試與畫面截圖
├── supabase/
│   ├── config.toml                # 本地 Supabase 設定
│   ├── migrations/                # 資料庫 migration：玩家 schema、RLS、RPC（部署到 Supabase Cloud）
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

> 支援 macOS、Linux、Windows（WSL2 或 PowerShell，見下方「Windows（PowerShell）」）。請在 repo 根目錄執行所有指令。

### 第一次啟動

```bash
cp .env.example .env                                   # 1. compose 設定（通常不需修改）
docker compose build                                   # 2. 建立開發容器映像
docker compose run --rm dev pnpm install               # 3. 安裝套件
docker compose up --no-start web                       # 3a. 建立 Supabase 網路（只綁定 127.0.0.1）與 web 容器，不啟動
docker compose run --rm dev pnpm supabase:start        # 4. 啟動 Supabase Local（第一次會下載映像，需要幾分鐘）
docker compose run --rm dev pnpm env:sync              # 5. 產生 apps/web/.env.local
docker compose up -d web                               # 6. 啟動 Next.js（Hot Reload）
docker compose run --rm dev pnpm verify:env            # 7. 驗證 Web / Edge Functions / Postgres 連線
docker compose run --rm dev pnpm verify:hot-reload     # 8. 驗證 Hot Reload
```

全部成功時，第 7 步顯示七個 ✅（含「埠只綁定 loopback」與「非 loopback 介面連不到」）、第 8 步顯示兩個 ✅。驗收項目與目前狀態見 [`docs/PHASE1_ACCEPTANCE.md`](docs/PHASE1_ACCEPTANCE.md)。

> `web` 會加入 Supabase 的 Docker 網路，所以一定要先啟動 Supabase（第 4 步）再啟動 web（第 6 步）。
> Supabase 的網路 `supabase_network_mining-expedition` 由 compose 建立（第 3a 步），並設定發布的埠只綁定 `127.0.0.1`；`supabase start` 會沿用這個網路。`pnpm supabase:start` 啟動前會檢查網路存在且設定正確，否則拒絕啟動（避免 CLI 自建一個綁定 `0.0.0.0` 的網路）。`docker compose down` 之後要再次啟動時，也要先做第 3a 步。`supabase start` 結尾的 `All services bind to 0.0.0.0` 是 CLI 固定的提示文字，實際綁定以 `verify:env` 為準。
>
> **從舊版設定升級**（網路由 `supabase start` 或手動 `docker network create` 建立過）：compose 會出現 `network ... was found but has incorrect label`。執行一次：
> ```bash
> docker rm -f $(docker ps -aq --filter label=com.supabase.cli.project=mining-expedition)   # 移除 Supabase 容器（資料 volume 保留）
> docker compose rm -sf web
> docker network rm supabase_network_mining-expedition
> ```
> 再從第 3a 步重新啟動。

#### Windows（PowerShell）

不使用 WSL2 時，可直接在 PowerShell 執行上面的指令（`cp` 可用 `Copy-Item`），但需要：

1. **Git 以 LF 檢出**：repo 的 `.gitattributes` 已強制 LF。若在加入 `.gitattributes` 之前就 clone，執行一次 `git rm -r --cached -q . && git reset --hard`（會捨棄未提交的變更）重新檢出，否則容器會出現 `/usr/bin/env: 'bash\r': No such file or directory`。
2. **在 `.env` 設定 `PROJECT_ROOT`** 為 Docker Desktop VM 內的磁碟路徑：`/run/desktop/mnt/host/<小寫磁碟代號>/<路徑>`，例如 repo 在 `D:\code\mining-expedition` 時：
   ```
   PROJECT_ROOT=/run/desktop/mnt/host/d/code/mining-expedition
   ```
   PowerShell 沒有 `PWD` 環境變數，compose 會顯示多個 `The "PWD" variable is not set` 警告，設定 `PROJECT_ROOT` 後可忽略。

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
| Analytics 關閉 | `supabase/config.toml` 設 `[analytics] enabled = false`：Vector 會從宿主掛載 `DOCKER_HOST` 指向的 socket，而 Docker Desktop 上那是只存在於開發容器內的代理 socket，Vector 會失敗。代價是 Studio 的 Logs 頁面沒有資料；函式日誌用 `docker logs supabase_edge_runtime_mining-expedition` |
| 相同路徑掛載 | Repo 以宿主上的絕對路徑掛載到容器內。Supabase CLI 傳給 Docker 的 bind mount 路徑因此在宿主上也成立 |
| 網路 | `dev`、`functions` 使用 host network，讓 Supabase CLI 以 `127.0.0.1` 連到它啟動的服務；`web` 加入 Supabase 的 Docker 網路，直接連 API gateway 容器 |
| 對外埠 | 全部只綁定 `127.0.0.1`，區網連不到。`web` 由 compose 指定 `127.0.0.1:3000`；Supabase CLI 發布埠時不指定 IP（Docker 預設 `0.0.0.0`），因此 compose 建立的 Supabase 網路設定 `com.docker.network.bridge.host_binding_ipv4=127.0.0.1`，讓未指定 IP 的埠改綁 loopback。`verify:env` 以 `docker inspect` 檢查綁定，並從宿主的每個非 loopback IPv4 實際連線確認被拒 |
| 與正式部署的關係 | `Dockerfile.dev`、`compose.yaml`、`docker/` 只用於本地；Vercel 與 Supabase Cloud 都不會讀取 |

### 健康檢查與診斷

| 端點 | 本地（`next dev`） | 正式（Vercel production / preview） |
|---|---|---|
| `GET /api/health` | `{"ok": true}` / 503 `{"ok": false}` | 相同；失敗原因只寫入伺服器日誌 |
| `GET /api/dev/diagnostics`、`/dev` 的診斷表 | 引擎版本、延遲、錯誤細節 | 404 |
| `/dev/preview?scene=new\|mining\|blocked_power\|blocked_unlock\|report` | 以記憶體後端（與伺服器相同的 game-server 程式碼）預覽各種畫面，不需要登入 | 不存在（`page.dev.tsx` 不會被 build） |
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
| `supabase:start` 出現 `❌ 找不到 Docker 網路 supabase_network_mining-expedition` | 先 `docker compose up --no-start web`（第 3a 步） |
| `network supabase_network_mining-expedition was found but has incorrect label` | 網路不是由 compose 建立：見上方「從舊版設定升級」 |
| `verify:env` 的「埠只綁定 loopback」或「非 loopback 介面連不到」失敗 | 同上，網路缺少 `host_binding_ipv4` 選項；`docker network inspect supabase_network_mining-expedition --format '{{json .Options}}'` 確認 |
| `docker compose down` 出現 `network ... has active endpoints` | Supabase 仍在執行：先 `dev pnpm supabase:stop` 再 `docker compose down` |
| 容器啟動時出現 `/usr/bin/env: 'bash\r': No such file or directory` | 檔案以 CRLF 檢出（Windows）：見「Windows（PowerShell）」第 1 點 |
| `supabase start` 出現 `supabase_vector_... container is not ready: unhealthy` | 確認 `supabase/config.toml` 的 `[analytics] enabled = false` 沒有被改掉 |
| 任何驗證失敗 | 執行 `dev pnpm diagnose`，把輸出與 `verify:env` / `verify:hot-reload` 的結果一起回報 |
| 埠已被占用（3000 / 54321–54324） | 在 `.env` 改 `WEB_PORT`；Supabase 的埠在 `supabase/config.toml` |
| 想完全重來 | `dev supabase stop --no-backup && docker compose down -v` |

---

## 測試與建置

```bash
dev pnpm typecheck   # 所有 packages、apps 與 scripts 的型別檢查
dev pnpm test        # Vitest：game-engine（規則）＋ game-server（PGlite 上的真實 migration：RPC、RLS、冪等；不需要 Docker）
dev pnpm build       # 依序建置所有 workspace（packages 型別檢查 + next build）
dev pnpm check       # 以上三項
dev pnpm --filter @mining/game-engine coverage   # 引擎涵蓋率（門檻見 packages/game-engine/vitest.config.ts）
dev pnpm sim         # 平衡模擬（使用正式的 settle / applyAction；全部報表單一程序約 40 分鐘，可用 --only 分段）
```

引擎的確定性快照在 `packages/game-engine/test/fixtures/golden-v1.json`。Node（Vitest）與 Deno（CI）都必須產生完全相同的結果；只有 `RNG_VERSION` 或 `DATA_VERSION` 改變時才重新產生（`node packages/game-engine/test/golden-cli.ts > …/golden-v<N>.json`，舊快照保留）。

### 資料庫整合測試（真正的 Supabase Local）

需要先依「第一次啟動」執行 `dev pnpm supabase:start`。測試會自動從 `supabase status` 取得 URL 與金鑰（只在開發容器內使用，不寫入任何檔案）。

```bash
dev supabase db reset        # 從乾淨的資料庫重新套用所有 migration（會清除本地資料）
dev pnpm test:integration    # RLS / RPC / Auth / 冪等 / CAS / 並行 / 遊戲邏輯持久化
```

- 測試以 Auth admin API 建立真實使用者並登入取得 JWT，經由 PostgREST 驗證權限；以 postgres 連線（`supabase status` 的 `DB_URL`）準備資料與檢查結果。
- 離線時間以「把測試玩家的時間基準往前移」模擬；正式程式碼沒有任何可以改時間的參數。
- `pnpm test` 中的 `packages/game-server` 測試用 PGlite（WASM PostgreSQL）套用同一份 migration，可在沒有 Docker 的環境快速執行；但它是單一連線、PG18，**正式驗證以 Supabase Local 為準**（CI 兩者都跑）。

### 玩遊戲（瀏覽器）

依「第一次啟動」啟動 Supabase Local 與 web 後，打開 <http://127.0.0.1:3000>：

1. 未登入會導向 `/login`；用任意 Email / 密碼（至少 6 字元）註冊。本地不寄驗證信，註冊後直接登入。
2. 第一次登入顯示「建立礦工」，按「開始探險」。
3. 挖礦主畫面每 20 秒（或預估方塊完成時）向伺服器同步一次；進度條是本地預估，資源只在同步後出現。
4. 離開超過 5 分鐘再回來，會先顯示「探險報告」，領取後才繼續挖掘。

想看離線報告不用真的等：在 Studio（<http://127.0.0.1:54323>）或 `psql` 執行
`update public.players set created_at_ms = created_at_ms - 3*3600000, last_settled_at_ms = last_settled_at_ms - 3*3600000 where id = '<user id>';`
再重新整理（只限本地測試資料）。

### 前端測試

```bash
dev pnpm --filter @mining/web test   # API Client、同步控制器、元件（Vitest + jsdom，記憶體後端，不需要 Supabase）
dev pnpm test:integration            # 含 tests/integration/web-client.test.ts：Web Client × 真實 Auth / Edge Functions
```

瀏覽器 E2E（Playwright 官方 image，不需在宿主安裝瀏覽器；需要 web 與 Supabase Local 已啟動）：

```bash
docker run --rm --network host --ipc=host -v "$PWD:$PWD" -w "$PWD/tests/e2e" \
  mcr.microsoft.com/playwright:v1.65.1-noble npx playwright test
```

截圖輸出到 `tests/e2e/screenshots/`（桌面與手機）。`--network host` 需要 Linux 或 Docker Desktop 4.34+ 的 host networking。

### 遊戲 API（Edge Functions）

`dev pnpm supabase:start` 會一併啟動 Edge Runtime，以下三個函式即可透過 `http://127.0.0.1:54321/functions/v1/<name>` 呼叫（詳細規格見 `docs/TECHNICAL_SPEC.md` §10）：

| 函式 | 方法 | 說明 |
|---|---|---|
| `character-create` | POST | 建立角色（空 body） |
| `game-state` | GET | 讀取目前狀態（唯讀，不結算） |
| `game-action` | POST | `Idempotency-Key: <uuid>` + `{ "command": { "type": "settle" } }` 等所有改變狀態的操作 |

每個請求都要帶 `Authorization: Bearer <使用者 access token>` 與 `apikey: <anon key>`。玩家身分只取自驗證後的 JWT。`dev pnpm test:integration` 包含 `tests/integration/edge.test.ts`：以 HTTP 呼叫真正的 Edge Runtime，測試權限、冪等、並行、遊戲邏輯，以及 12 小時最壞情境的效能（輸出 `EDGE_BENCHMARK` 一行 JSON）。

`pnpm build` 不需要 Supabase 或 Docker 網路，也可以在任何有 Node 22 與 pnpm 的環境（例如 CI、Vercel）執行。

### CI（GitHub Actions）

`.github/workflows/ci.yml` 在每個 PR 與 `main` 的 push 執行：

| Job | 內容 |
|---|---|
| install / typecheck / test / build | `pnpm install --frozen-lockfile` → `pnpm typecheck` → `pnpm test` → 引擎涵蓋率門檻（lines ≥ 90%）→ 引擎快照（Node）→ 模擬器 smoke run → `pnpm build` → 檢查瀏覽器 bundle 不含伺服器端識別字（Node 22，不使用 Docker） |
| deno check (Edge Functions) / engine determinism | 以 Deno 型別檢查 Edge Function（含匯入 `packages/`）與引擎；Deno 執行引擎快照並與 Node 使用的 fixture 比對 |
| docker integration (Linux) | 在開發容器內執行 `pnpm typecheck && pnpm test`；再依上方「第一次啟動」步驟啟動 Supabase Local，執行 `verify:env`、`verify:hot-reload`；`supabase db reset`（migration 可從乾淨資料庫重建）；`pnpm test:integration`（真實 Supabase 整合測試，含 Edge Functions HTTP 測試、效能實測、Web Client）；Playwright E2E（官方 Docker image，截圖上傳為 artifact `e2e-screenshots`）；`diagnose`。**只代表 Linux + Docker Engine，不代表 Docker Desktop** |

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
