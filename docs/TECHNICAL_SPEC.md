# 《挖礦探險隊》TECHNICAL_SPEC

**Version 1.6（MVP v1.0 基準）**

| 版本 | 變更 |
|---|---|
| v1.0 | 初版 |
| v1.1 | 四層混合式掉落（D7）、回訪規則（D8）、離線上限 12 小時（D9）、十字鎬與解鎖（D10）；新增 `scripts/balance-sim.ts` |
| v1.2 | 回訪金幣 ×0.5（D12）、金幣依門檻段（D13）、回訪寶物 ×0.5（D14）、只能回訪較淺礦區（D15）、重挖模式（D16）、首次寶物保護（D17） |
| v1.3 | 首次保護 4 小時（D18）；引擎規則測試對照（D19）；離線報告領取流程與防卡住（D20）；架構定案（D21）；Docker-first 開發環境（D22）；數值版本管理 |
| v1.4 | Game Engine Core：§5 補上整數取整與防溢位（BigInt）的精確定義；§6 定義 RNG_VERSION 1 的位元組順序、sfc32 初始化、拒絕取樣與各層區間；HMAC 使用 `@noble/hashes` 2.4.0（T4 定案，含實測與用途界線）；`rngSecret` 必須 32 bytes；GBS §2.3.1 邊界回訪；涵蓋率門檻（T11）；§3.4 依實作更新；§14 測試門檻與實作對齊；模擬器改用共用引擎（§14.4）。**遊戲規則與數值不變** |
| v1.5 | Settlement & Actions Core：§7 依實作更新（`settle` / `applyAction` / `executeRequest`）；§8.1 `PlayerGameState` 定案；新增 §10.6 冪等與原子提交；§14.1.2 測試對照；§14.6 結算 benchmark；決策 D23（空的離線報告不建立）、D24（待領取期間暫停、不補算）；`validateState` 接受不可信輸入。**數值與 RNG_VERSION 不變** |
| v1.18 | 單人部署簡化：Vercel 直接部署 `main`（連接測試用 Supabase、noindex）；移除 Staging deploy workflow 與 `staging` 分支；Supabase 由本機 `pnpm cloud`（`scripts/cloud/deploy.ts`）部署：目標 ref 檢查、dry-run 計畫 ID、禁止 reset；文件 `docs/DEPLOYMENT.md`。CORS / JWT / RLS / Rate Limit / 冪等不變。**遊戲規則不變** |
| v1.17 | Cloud Staging：CORS 允許清單（多個 origin + Vercel Preview 樣式；Cloud 未設定時 fail closed）；Web Staging = `staging` 分支的 Vercel Preview、`/api/version`；部署、營運與 Cloud smoke 文件（`docs/DEPLOYMENT_STAGING.md`、`docs/OPERATIONS_RUNBOOK.md`、`docs/CLOUD_SMOKE_TEST.md`）；Node 版本限制在 22.x。**遊戲規則不變** |
| v1.16 | Reliability & Security Hardening：§10.3 錯誤碼與重試語意（`RATE_LIMITED` 改為伺服器端每位使用者限流、新增 `REQUEST_EXPIRED`）；新增 §10.9 Rate Limit、§10.10 action_log 分層保存與 Request ID 有效期限、§10.11 錯誤分類與 log；§12.14 市場歷史排隊讀取、選擇上限、成交提示。詳細的威脅模型與部署注意事項見 `docs/SECURITY_RELIABILITY.md`。**遊戲規則不變** |
| v1.15 | Market UI & Artifact Trading：新增 §12.14 市場畫面（`/market`）、出售流程、套組失效預測、跨日報價重新確認、價格無法取得時的處理；§12.10 寶物出售 UI 開放。**定價演算法、倍率、基礎價值、套組加成、結算不變** |
| v1.14 | Market Backend & Daily Pricing：§6.3 市場亂數改為資料庫內密鑰（`private.market_secret`）與確定的整數演算法；§8.2 / §8.3 市場資料表、只新增、權限；§9 改為已實作（延遲生成 + pg_cron、並行、失敗處理、報價與成交價）；§10 回應加 `market`、`sell_artifacts` 必須帶 `marketDate`、新錯誤碼 `MARKET_QUOTE_EXPIRED` / `MARKET_UNAVAILABLE`；§12.10 寶物出售後端開放（UI 在 PR #14）。**倍率範圍、Step、均值回歸、基礎價值、掉落、RNG_VERSION 不變** |
| v1.13 | Artifact Reveal：§12.5 改為已實作的揭曉系統（佇列、去重、在線 / 離線資料流）；§12.13 套組旗標改為 `allDiscovered`（圖鑑已發現全部成員）、確認未發現寶物的揭露規則。**遊戲規則、掉落、首次保護、結算與 RNG_VERSION 不變** |
| v1.12 | Collection & Artifact Sets：新增 §12.13 圖鑑與套組畫面（`/collection`）、未發現寶物的揭露規則（待確認）；`browserPendingStore.list()` 先取 key 快照再驗證。**遊戲規則、數值、套組加成與 RNG_VERSION 不變** |
| v1.11 | Client Hardening：§12.6 未確認操作改為每筆一個 key + Web Locks 跨分頁排隊、待領報告的未確認領取優先調和、拒絕回應的 `synced`；新增 §12.11 跨分頁失敗模式、§12.12 帳號切換的 401。**遊戲規則、數值與 RNG_VERSION 不變** |
| v1.10 | Inventory & Workshop：新增 §12.9 背包 / 工坊 / 製作畫面與路由（`/inventory`、`/workshop`，共用 `(game)` layout）、§12.10 出售價格來源。**遊戲規則、數值、成本、配方與 RNG_VERSION 不變** |
| v1.9 | Client Reliability：§12.6 未確認操作（Request ID 持久化與調和）、回應結構驗證；新增 §12.8 Runtime 生命週期。**遊戲規則、數值與 RNG_VERSION 不變** |
| v1.8 | Playable MVP（Auth + Mining UI）：§12 改為已實作的前端（Zustand store、`predictBlockProgress`、同步排程 20 秒心跳 / 方塊完成時同步（間隔 ≥ 10 秒）、路由 `/`、`/login`），新增 §12.6 API Client 與錯誤處理、§12.7 多分頁。**遊戲規則、數值與 RNG_VERSION 不變** |
| v1.7 | Supabase Integration（2/2）：§10.1 / §10.2 改為已實作的 3 個 Edge Function（取代原本一動作一端點的規劃）；新增 §10.7 身分驗證與 verify_jwt 決策、§10.8 Edge Runtime 實測效能。**遊戲規則、數值與 RNG_VERSION 不變** |
| v1.6 | Supabase Integration（1/2）：§8.2–§8.5 依實作的 schema 更新（與 v1.5 草稿的差異見 §8.6）；§10.4 RPC 名稱與流程；§10.6 回應保存規則；§14.5 真實 Supabase Local 整合測試。**遊戲規則、數值與 RNG_VERSION 不變** |

| 項目 | 內容 |
|---|---|
| 依據 | `docs/GDD.md` v1.3、`docs/GBS.md` v1.3.3、已確認決策 D1–D24 |
| 範圍 | MVP：架構、資料模型、API、伺服器結算、測試規範 |
| 標記 | 【決策 Dn】已確認；【GDD】來自企劃；【提案 Tx】技術提案，待審核 |

---

## 1. 原則

1. **伺服器權威**：挖掘、掉落、金幣、物品、離線時間全部由伺服器計算與入帳。Client 只負責 UI、動畫與呈現。【決策 D4】
2. **單一引擎**：遊戲規則只實作一次，以純 TypeScript 撰寫，不依賴 React / Zustand / Next.js。【GDD §9.2】伺服器用它結算，Client 用它的「無亂數部分」做進度預測。
3. **確定性**：同樣的狀態、時間、密鑰，一定得到同樣的結果。
4. **整數運算**：所有會影響結果的數值都用整數或定點數，避免浮點誤差。
5. **冪等**：所有會改變狀態的請求都可以安全重送。

---

## 2. 權威模型 【決策 D4】

| 職責 | Server | Client |
|---|---|---|
| 時間來源 | Postgres `now()` | 只用於顯示 |
| 挖掘進度與方塊完成 | ✅ | 預測顯示（不入帳） |
| 方塊內容（OreType）與掉落 | ✅ | ❌（無法預知） |
| 金幣、物品入帳 | ✅ | ❌ |
| 購買、強化、製作、出售、解鎖 | ✅ 驗證並執行 | 送出請求 |
| 離線時長與上限 | ✅ | ❌ |
| 離線報告產生與領取 | ✅ | 呈現與送出領取 |
| 動畫、音效、提示 | ❌ | ✅ |

Client 唯一能做的是「請伺服器結算到現在」以及「請伺服器執行某個動作」。Client 不傳任何時間、數量或結果。

---

## 3. 系統架構

### 3.1 部署

```mermaid
flowchart LR
    subgraph Browser
        UI[Next.js App<br/>React + Zustand]
        PRED[game-engine<br/>預測模組]
    end
    subgraph Vercel
        NEXT[Next.js<br/>靜態頁面 / SSR]
    end
    subgraph Supabase
        AUTH[Supabase Auth]
        EF[Edge Functions<br/>Deno + game-engine]
        RPC[Postgres RPC<br/>原子提交]
        DB[(PostgreSQL)]
        CRON[pg_cron]
    end
    UI --> NEXT
    UI -- JWT --> EF
    UI -- 唯讀查詢 / RLS --> DB
    UI --> AUTH
    EF -- service role --> RPC
    RPC --> DB
    CRON --> DB
    UI --- PRED
```

### 3.2 為什麼用 Edge Function + Database Function 【決策 D21】

依你的要求優先評估 Supabase Database Function 與 Edge Function：

| 方案 | 說明 | 評估 |
|---|---|---|
| 只用 Database Function（PL/pgSQL） | 規則全部寫在 SQL | ❌ 引擎要用 SQL 再寫一次，違反「單一引擎」，難以測試 |
| 只用 Edge Function | 引擎在 Deno 執行，以多次 API 呼叫寫入 | ❌ supabase-js 沒有多語句交易，無法保證原子性 |
| **Edge Function 計算 + Database Function 提交** | Edge Function 跑 TS 引擎算出結果；呼叫一個 RPC 在單一交易中檢查版本並寫入 | ✅ **採用** |
| Next.js Route Handler | 也能跑 TS 引擎 | 可作為備案；不需要另建後端 |

### 3.3 執行限制

依 Supabase 文件，Edge Function 每個請求的 CPU 時間上限為 2 秒，記憶體 256MB，閒置逾時 150 秒；但另一篇 Supabase 疑難排解文件寫的是 200 毫秒 CPU。**以較保守的 200 毫秒作為設計上限。**

最壞情況估算：離線 12 小時、最快方塊約 6.5 秒 → 約 6,650 個方塊。每個方塊一次 HMAC-SHA256 加數次亂數，預估遠低於 100 毫秒。Phase 1 必須加入效能基準測試（§14.6）。

### 3.4 Repo 結構 【決策 D21】

GDD §9.3 把 `game-engine` 放在 `src/` 內。由於 Edge Function（Deno）也要匯入引擎，改為 pnpm workspace monorepo：

```text
mining-expedition/
├── apps/web/                    # Next.js（GDD §9.3 的 src/ 內容移到這裡）
│   └── src/
│       ├── app/
│       ├── features/
│       ├── stores/
│       └── lib/supabase/
├── packages/
│   ├── game-engine/             # 純 TS，零框架依賴；唯一外部依賴 @noble/hashes
│   │   ├── src/
│   │   │   ├── fixed.ts         # 定點數工具（blockMs、mulDivFloor、BigInt 防溢位）     ✅ Engine Core
│   │   │   ├── rng/             # RandomSource、sfc32、HMAC（@noble/hashes）、逐方塊種子 ✅ Engine Core
│   │   │   ├── stats.ts         # 數值聚合、套組判定                                    ✅ Engine Core
│   │   │   ├── mining.ts        # 深度、門檻、前線 / 回訪 / 重挖位置、工作量            ✅ Engine Core
│   │   │   ├── drop.ts          # 四層掉落、機率（ppm）、期望值                         ✅ Engine Core
│   │   │   ├── protection.ts    # 首次寶物保護的純判定（狀態保存屬於 settle）           ✅ Engine Core
│   │   │   ├── settle/          # 結算（在線 / 離線）                                   Settlement 階段
│   │   │   ├── actions/         # 購買、強化、製作、出售、解鎖                          Actions 階段
│   │   │   ├── market/          # 倍率生成                                              Market 階段
│   │   │   └── collection/      # 圖鑑                                                  Collection 階段
│   │   └── test/                # Vitest；fixtures/golden-v1.json（Node / Deno 共用快照）
│   └── game-data/               # 靜態資料（GBS 數值表），附 DATA_VERSION / RNG_VERSION
├── supabase/
│   ├── migrations/              # SQL schema、RLS、RPC
│   ├── functions/               # Edge Functions
│   └── seed.sql
├── scripts/
│   ├── balance-sim.ts           # 平衡模擬（開發輔助工具，見 §14.4）
│   ├── env-sync.ts              # 從 supabase status 產生 apps/web/.env.local
│   └── verify-env.ts            # Web / Edge Functions / Postgres 連線驗證
├── docker/entrypoint.sh         # 開發容器入口（Docker socket 權限處理）
├── Dockerfile.dev               # 開發容器：Node、pnpm、Supabase CLI、Docker CLI
├── compose.yaml                 # 開發環境（§15）
└── docs/
```

Edge Function 以函式目錄內的 `deno.json` 對應 `@mining/game-engine` 到 `packages/game-engine/src`（相對路徑）。Supabase 自 2025 年起支援從 `supabase/` 以外匯入檔案；但本地 `functions serve` 曾有回報失敗的案例，**需要在 Docker 環境實測**（Phase 1 驗證項目）。若失敗，備案是建置步驟把引擎複製到 `supabase/functions/_shared/`。

- 引擎原始碼的 import 一律寫副檔名（`./fixed.ts`），讓 Node（Next.js、Vitest）與 Deno 都能直接讀取同一份檔案。
- 套件管理：pnpm workspace。【決策 D21】
- 引擎唯一的外部依賴：`@noble/hashes`，版本固定 **2.4.0**（Node 由 `packages/game-engine/package.json`、Deno 由各 `deno.json` 的 import map 對應 `npm:@noble/hashes@2.4.0/hmac.js`、`sha2.js`，兩邊必須同版）。【決策 T4 定案，PR #3】
  - 選擇理由：已有安全審查、持續維護、零依賴、同步 API，Node / Deno / 瀏覽器都能用。不用 Web Crypto，因為 `crypto.subtle` 只有非同步 API。
  - 實測（PR #3）：Node 每方塊（HMAC + 四層掉落）約 4 µs、Deno 約 5–6 µs；與自寫實作的輸出逐位元組相同，所以 RNG_VERSION 與確定性快照不變。12 小時離線結算的實際 CPU 成本在 Settlement 階段以 Edge Function 實測。
  - **用途界線**：只用於遊戲亂數的種子（逐方塊、市場），使結果可重現且 Client 無法預測。不用於簽章、身分驗證、密碼雜湊或金鑰派生。
  - 升級版本時必須：確認 golden 快照不變、Node 與 Deno 同步改版、在 PR 說明。

---

## 4. 靜態遊戲資料

- GBS 的所有數值表（礦區、硬度帶、OreType 權重、掉落表、物品、十字鎬、強化、配方、套組、市場參數）以 TS 常數放在 `packages/game-data`。
- 資料不放資料庫；資料庫只存玩家狀態與 ID 參照。
- `DATA_VERSION`（整數）每次調整數值時加 1。玩家狀態記錄最後一次結算使用的版本。
- 數值變更後，下一次結算直接使用新數值；已入帳的物品、已發現的紀錄不回溯調整。【決策 D19】
- 完整規則見 GBS §24：ID 不可刪除或重用、變更紀錄、模擬驗證。
- `RNG_VERSION`：亂數消耗順序的版本（MVP = 1）。只有改變 §6.2 順序時才加 1，並更新確定性測試快照；舊快照保留，確保舊版本的回放仍可驗證。

---

## 5. 數值表示（定點整數）【提案 T6】

| 數值 | 表示方式 | 範例 |
|---|---|---|
| Power | ×10 整數 `power10` | 木 2.0 → 20；需求 36 → 360 |
| Speed | ×1000 整數 `speed1000` | 1.2 → 1200 |
| Luck | ppm（×1,000,000） | 0.12 → 120,000 |
| 機率 | ppm | 0.5% → 5,000 |
| Hardness | 整數 | 32,500 |
| 時間 | 毫秒整數 | |
| 工作量 | `power10 × speed1000 × ms` | 方塊完成條件：`work ≥ Hardness × 10^7` |

計算規則：

```
levelStep   = Lv − 1
power10     = basePower10 × (100 + 10 × levelStep) / 100            // MVP 數值皆整除
speed1000   = floor( baseSpeed1000 × (100 + 5 × levelStep) / 100
                     × (100 + 3 × speedSetCount) / 100 )
luckPpm     = baseLuckPpm × (100 + 10 × levelStep) / 100 + 20,000 × luckSetCount
rate        = power10 × speed1000                                    // 每毫秒的工作量
blockMs     = ceil( Hardness × 10^7 / rate )
canMine     = power10 ≥ requiredPower10
```

四層掉落的 ppm 計算（GBS §7）：

```
// 第二層：礦物
rarePpm     = floor( rareBasePpm[zone] × (1,000,000 + luckPpm) / 1,000,000 )
bundlePpm   = 150,000
nonePpm     = 1,000,000 − bundlePpm − rarePpm                          // < 0 時拒絕（資料錯誤）

// 第三層：金幣（modeCoinPpm：前線 1,000,000、回訪 500,000【D12】、重挖 500,000【暫定】）
coinPpm     = 100,000
a           = coinAvgBySegment[seg] × modeCoinPpm                     // = Avg × 10^6
coinMin     = floor( (a + 1,000,000) / 2,000,000 )                    // = round(0.5 × Avg)，.5 進位
coinMax     = floor( (3a + 1,000,000) / 2,000,000 )                   // = round(1.5 × Avg)
amount      = coinMin + nextInt(coinMax − coinMin + 1)

// 第四層：寶物（treasurePerHourMilli：0.35/h → 350；modeTreasurePpm：前線 1,000,000、回訪 / 重挖 500,000）
chancePpm   = min( 500,000,
                   floor( treasurePerHourMilli × blockMs × modeTreasurePpm / 3,600,000,000 ) )
legPpm      = floor( chancePpm × 100,000 × (1,000,000 + luckPpm) / 10^12 )   // 單次取整
epicPpm     = floor( chancePpm × 900,000 × (1,000,000 + luckPpm) / 10^12 )
noTreasure  = 1,000,000 − legPpm − epicPpm                             // < 0 時拒絕
```

- **單次取整**：每個公式只在最後 `floor` 一次（先乘後除）。v1.3 的寫法 `chancePpm × 100,000 / 1,000,000 × …` 若逐步整數除法，會多一次取整；v1.4 明確定義為單次取整。
- **BigInt**：`epicPpm` 的中間值最大約 `500,000 × 900,000 × 1,208,000 ≈ 5.4 × 10^17`，超過 `2^53`。引擎以 `mulDivFloor` 計算：乘積 ≤ `2^53 − 1` 時用 Number（以餘數修正捨入，結果精確），否則改用 BigInt；結果超出 safe integer 時丟出錯誤。Postgres 端（若需要）使用 `numeric` 或 `bigint` 的同一順序。
- **blockMs**：第四層使用該方塊**實際的挖掘毫秒數**（換裝備時跨越不同速率的累加值，P5），不是以完成時的數值重算。
- **mode 倍率**以 ppm 表示（`COIN_MODE_MULTIPLIER_PPM`、`TREASURE_MODE_MULTIPLIER_PPM`，`packages/game-data`）。v1.3 的 `(frontier ? 2 : 1) / 2` 是同一個結果的特例寫法。

首次保護：

```
PROTECT_MS  = 14,400,000   // 4 小時有效挖掘時間【決策 D18】
```

> 驗算：`treasurePerHourMilli × blockMs / 3,600` 的單位是 ppm（0.35/h × 1 小時 = 350 × 3,600,000 / 3,600 = 350,000 ppm = 35%）。中間值最大約 `350 × 4×10^5 ≈ 1.4 × 10^8`，在安全整數範圍內。

- 最大值：`32,500 × 10^7 = 3.25 × 10^11`，在 JS 安全整數（2^53）與 Postgres `bigint` 範圍內。
- 強化倍率 `(100 + 10 × levelStep)` 套用在 MVP 的所有基礎值上都能整除；新增資料時需由單元測試保證（§14.1）。

---

## 6. 亂數 【GDD §9.4】【提案 T7】

### 6.1 介面

```ts
interface RandomSource {
  nextUint32(): number;
  /** 回傳 [0, n) 的均勻整數，使用拒絕取樣避免偏差 */
  nextInt(n: number): number;
}
```

引擎只依賴這個介面；測試可以注入固定序列（`SequenceSource`）。

`nextInt(n)`（RNG_VERSION 1）：`limit = 2^32 − (2^32 mod n)`；重複取 `x = nextUint32()` 直到 `x < limit`，回傳 `x mod n`。每次拒絕多消耗一個 uint32。`n` 必須是 1–2^32 的整數。

### 6.2 方塊亂數

每個完成的方塊各自建立一個 PRNG，不需要儲存 PRNG 狀態：

```
digest       = HMAC-SHA256( key = player.rngSecret, msg = UTF-8("block:" + digCounter 的十進位) )
(a, b, c, d) = digest[0..3], digest[4..7], digest[8..11], digest[12..15]，各為 big-endian uint32
rng          = sfc32(a, b, c, d)，先丟棄 12 個輸出（warm-up）
```

RNG_VERSION 1 的精確定義（`packages/game-engine/src/rng/`）：

- sfc32 每步：`t = a + b + d; d = d + 1; a = b ^ (b >>> 9); b = c + (c << 3); c = rotl(c, 21) + t; 輸出 t`（全部 mod 2^32）。
- 加權抽取：一次 `nextInt(Σweight)`，依資料表順序累加，落在 `[累積, 累積 + weight)` 的項目。
- 各層區間（`u = nextInt(1,000,000)`）：
  - 第二層：`[0, bundlePpm)` 礦石包；`[bundlePpm, bundlePpm + rarePpm)` Rare；其餘為無
  - 第三層：`u < coinPpm` 命中
  - 第四層：`[0, legPpm)` Legendary；`[legPpm, legPpm + epicPpm)` Epic；其餘為無
- 跨執行環境快照：`packages/game-engine/test/fixtures/golden-v1.json`。Vitest（Node）與 CI 的 Deno 都必須產生完全相同的結果（§14.2）。

- `digCounter`：玩家每完成一個方塊（前線或回訪）就加 1，只由伺服器遞增。
- `rngSecret`：每位玩家 32 bytes 隨機密鑰，存在 Client 無法讀取的 schema（§8.3）。`createBlockRng` 只接受剛好 32 bytes 的 `Uint8Array`，否則丟出錯誤（避免載入錯誤資料時悄悄產生「合法」的亂數）。
- 因為結果依方塊編號而定，放棄挖到一半的方塊或切換礦區都無法重新抽獎。
- 一個方塊內的亂數消耗順序固定（GBS §4.3、§7）：
  1. 第一層：OreType（1 次）
  2. 第二層：礦物判定（1 次）→ 若為礦石包，再抽 3 次 OreType；若為 Rare，再抽 1 次 Rare 表
  3. 第三層：金幣判定（1 次）→ 若命中，再抽 1 次金額
  4. 第四層：寶物機會（1 次）→ 若為 Epic，再抽 1 次哪一件
- 各層都使用 `nextInt(1,000,000)` 與 ppm 機率比較。
- 前線、回訪、重挖共用同一個 `digCounter`；切換模式只會放棄未完成方塊的進度，不會改變下一個方塊的亂數（D16）。
- 首次寶物保護（GBS §7.7）**不消耗亂數**：在第四層判定之後檢查，若發放就直接加入固定 Epic，所以之後所有方塊的結果與沒有保護時相同（D17）。

### 6.3 市場亂數

```
digest = HMAC-SHA256( key = market secret, msg = "market:" + YYYY-MM-DD + ":" + artifactId )
u      = digest 前 6 bytes（big-endian，48 bits）
ε      = (u mod (2·Step + 1)) − Step                      // U(−Step, +Step)，ppm
drift  = floor(35 × (1,000,000 − m(yesterday)) / 100)     // 0.35 × (1 − m)
m      = clamp(m(yesterday) + drift + ε, Min, Max)         // GBS §13
```

- 【v1.14】密鑰存在資料庫 `private.market_secret`（migration 以 `gen_random_bytes(32)` 產生，每個環境各自一份），與玩家的 `rng_secret` 相同保護：任何 API 角色（含 service_role）都讀不到。原規劃的 Edge Function 環境變數 `MARKET_SECRET` 不再使用：產生在資料庫內完成，pg_cron 不需要網路呼叫或額外的服務憑證。
- SQL（`private.market_next_ppm`、`private.market_ensure`）與引擎參考實作 `packages/game-engine/src/market.ts` 逐位元一致（PGlite 與 Supabase Local 測試逐日比對）。
- 沒有前一日紀錄時 m(yesterday) = 1,000,000（GBS 未定義初始值，**待確認**）。

---

## 7. 結算演算法

實作：`packages/game-engine/src/settle.ts`、`actions.ts`、`request.ts`。全部是純函式：不讀時鐘、不連資料庫、不修改傳入的狀態；相同的（狀態, serverNow, 亂數）永遠得到相同結果。

### 7.1 引擎函式

```ts
// 結算到 serverNow（TECHNICAL_SPEC §7.2）
settle(state: PlayerGameState, ctx: {
  serverNow: number;                                   // Postgres now()，毫秒；唯一時間來源
  rng: (digCounter: number) => RandomSource;           // createBlockRng(rngSecret)；密鑰只在伺服器
  options?: SettleOptions;                             // 只供平衡模擬比較方案；正式結算不傳
}): { ok: true; state; changed; summary; events; report; blocks } | { ok: false; error };

// 套用一個玩家操作；state 必須已結算到現在
applyAction(state, action: GameAction, ctx: { marketMultiplierPpm? }): { ok: true; state; changed; events } | { ok: false; error };

// Edge Function 的唯一入口：先結算再操作，回傳 CAS 提交計畫
executeRequest(state, { requestId, command }, ctx): RequestResult;
```

`GameAction`：`purchase_pickaxe`、`equip_pickaxe`、`upgrade_pickaxe`、`craft`、`sell_items`、`sell_artifacts`、`unlock_zone`、`select_mining_mode`、`claim_report`。請求先經過 `parseAction` / `parseCommand`：只接受已知欄位與合法範圍，多餘欄位（例如成本、價格、深度）一律 `INVALID_REQUEST`。

靜態資料以模組匯入（`@mining/game-data`，綁定 `DATA_VERSION`），不以參數傳入。

### 7.2 流程

```
settle(state, serverNow):
  驗證狀態（validateState）、rngVersion、dataVersion ≤ 引擎版本
  if serverNow < lastSettledAt          → INVALID_TIME
  if pendingOfflineReport 存在          → REPORT_PENDING（待領取期間挖掘暫停，D24）
  elapsed = serverNow − lastSettledAt
  elapsed = 0                           → noop
  elapsed > 300,000（P28）              → 離線：simMs = min(elapsed, 12h)（D9），獎勵進報告
  否則                                   → 在線：simMs = elapsed，獎勵直接入帳

  t = 0
  while t < simMs:
      位置 = miningPosition(state)        // 前線：frontierBlock；回訪 / 重挖：該位置 RequiredPower
      if 不能挖 → stopReason = blocked_power | blocked_unlock | frontier_complete；break
      step = advanceWork(blockWork, hardness, rate, simMs − t)
      t += step.usedMs；blockMs += step.usedMs
      if 未完成 → 保留 blockWork / blockMs；break
      完成方塊（GBS §4.3）：
          drop = rollBlock(rng(digCounter), 位置, blockMs, luck)
          ft   = firstTreasureStep(...)      // 不消耗亂數
          寶物實例 ID = "d" + digCounter
          在線：入帳；套組可能改變 → 下一個方塊重新計算數值
          離線：加入報告；數值整段不變
      digCounter += 1；blockWork = blockMs = 0；前線模式 frontierBlockIndex += 1

  lastSettledAt = serverNow              // 超過 12 小時的部分捨棄
  離線且完成至少 1 個方塊 → pendingOfflineReport = { reportId: "r" + periodStart, ... }
  離線但沒有完成方塊      → 不建立報告，只推進時間（D23）

applyAction(claim_report, serverNow):
  入帳報告內容；lastSettledAt = serverNow     // D24：待領取期間暫停，等待時間不補算
```

```
executeRequest(state, { requestId, command }, ctx):
  claim_report → 不結算，直接 applyAction（領取時間成為新的結算基準，D24）
  其他         → settle → （settle 指令到此為止）→ applyAction（失敗時操作沒有任何效果）
  有變化       → commit = { state: stateVersion + 1, reportCreated, reportClaimed, actionApplied }
  expectedStateVersion = 原 stateVersion（CAS 條件）
```

### 7.3 要點

- **在線與離線共用同一個迴圈**，只差在獎勵入帳方式與 12 小時上限。
- 不因結算頻率產生額外倍率：結算只依實際經過時間（D9）。一次結算與切成多次在線結算的結果完全相同（測試）。
- 第四層使用方塊的**實際**挖掘毫秒（跨越換裝備的累加值，P5）。
- 前線卡關時結算只推進 `lastSettledAt`，沒有產出，也不累積有效挖掘時間。
- 首次保護的狀態變更與報告（或在線入帳）在同一個提交中寫入（§10.6）。離線發放時 `firstTreasure.reportId` 指向該報告，領取時清除；`validateState` 檢查「狀態已更新 ⇒ 寶物在背包或在該報告中」。
- 重挖深度帶依「目前 Power」計算：每個操作後重新確認；前線解除卡關時自動回到前線、深度帶改變時進度歸零（GBS §2.4）。
- 挖掘狀態（mining / blocked_power / blocked_unlock / frontier_complete）是衍生值（`miningPosition`），不儲存。
- `validateState` 接受任何輸入（不可信的資料庫快照）：先檢查每一層的型別與結構，再檢查遊戲不變式；不會丟出例外。結構錯誤時 `settle` / `applyAction` / `executeRequest` 回傳 `INVALID_STATE`。

---

## 8. 資料模型

### 8.1 玩家狀態型別

定義在 `packages/game-engine/src/state.ts`（`PlayerGameState`，`schemaVersion` 1）。只含可序列化的純資料，時間是伺服器毫秒整數，數量是 safe integer；**不含 rngSecret**，可以原樣回傳給玩家（`toPlayerView` 附上數值與挖掘狀態等衍生值）。

| 欄位 | 內容 |
|---|---|
| `playerId`、`schemaVersion`、`stateVersion`、`dataVersion`、`rngVersion` | 身分與版本；`stateVersion` 是樂觀鎖，每次提交 +1 |
| `createdAt`、`lastSettledAt` | 伺服器時間 |
| `coins`、`inventory` | 金幣；可堆疊物品（只存正數） |
| `equippedPickaxe`、`pickaxes` | 裝備中；已擁有（依序前綴）與等級 |
| `unlockedZone` | 已解鎖的最深礦區（0–2） |
| `mining` | `mode`、`revisitZone`、`reworkBand`、`frontierBlockIndex`、`digCounter`、`blockWork`、`blockMs` |
| `heldArtifacts` | 持有中的寶物實例：`instanceId`（`d<digCounter>`）、`artifactId`、`obtainedAt`、`mode`、`band`、`frontierBlockIndex`、`digCounter`、`source`（`drop` / `first_treasure_protection`） |
| `discoveredArtifacts` | 圖鑑：`firstDiscoveredAt`、`firstBand`、`totalFound`（永不刪除） |
| `firstTreasure` | `status`、`effectiveMiningMs`、`resolvedAt`、`artifactInstanceId`、`reportId`（第一件寶物還在待領取報告中時） |
| `pendingOfflineReport` | 待領取報告（完整內容，見下） |
| `lastClaimedReportId` | 重複領取時回傳 `REPORT_ALREADY_CLAIMED` |

`OfflineReport`：`reportId`（`r<periodStart>`）、`periodStart`、`periodEnd`、`simulatedMs`、`discardedMs`、`minedMs`、`idleMs`、`blocksMined`、`mode`、`frontierFrom/To`、`digCounterFrom/To`、`stopReason`、`rewards { coins, items, artifacts[] }`（每件附 `isNewDiscovery`）、`firstTreasureGranted`。

與 v1.4 草稿的差異：

- 寶物實例 ID 由方塊序號決定（`d<digCounter>`），不是 uuid：純函式不能產生亂數 ID，且同一個方塊重算得到同一個 ID（冪等）。資料表主鍵改為 `(player_id, instance_id)`。
- `unlockedZones: ZoneId[]` → `unlockedZone: 0 | 1 | 2`（解鎖必須依序，兩者等價）。
- `mining.status` 不儲存，由 `miningPosition` 計算。
- `depthBlockIndex` → `band` + `frontierBlockIndex`（回訪 / 重挖沒有單一 blockIndex）。
- `collection` → `discoveredArtifacts`；`pendingReportId` → `pendingOfflineReport`（完整報告）。

### 8.2 資料表（schema `public`，Client 只能讀自己的資料）

Migration：`supabase/migrations/20261114000000_player_schema.sql`（schema、約束、RLS）、`20261114000100_player_rpc.sql`（RPC）。

```text
auth.users ─1:1─ players ─1:1─ private.player_secrets
                    ├─1:1─ first_treasure
                    ├─1:N─ player_pickaxes        (players.equipped_pickaxe → player_pickaxes，deferrable FK)
                    ├─1:N─ player_inventory
                    ├─1:N─ artifact_instances     (held / sold)
                    ├─1:N─ artifact_discoveries
                    ├─1:N─ offline_reports        (每位玩家最多 1 份 pending)
                    └─1:N─ action_log             (unique player_id + idempotency_key)
market_prices（全域，依日期）
```

| 資料表 | 主鍵 | 主要欄位 | 約束 |
|---|---|---|---|
| `players` | `id`（= `auth.users.id`，on delete cascade） | `state_version`、`schema_version`、`data_version`、`rng_version`、`created_at_ms`、`last_settled_at_ms`、`coins`、`equipped_pickaxe`、`unlocked_zone`、`mining_mode`、`revisit_zone`、`rework_band`、`frontier_block_index`、`dig_counter`、`block_work`、`block_ms`、`last_claimed_report_id` | 模式與 `revisit_zone` / `rework_band` 一致；`dig_counter ≥ frontier_block_index`；前線不超過未解鎖礦區；`block_work` 與 `block_ms` 同時為 0 |
| `player_pickaxes` | `(player_id, pickaxe_id)` | `level` 1–5 | ID 清單 check；RPC 禁止刪除或降級 |
| `player_inventory` | `(player_id, item_id)` | `quantity` ≥ 1 | ID 清單 check；數量 0 時刪除列 |
| `artifact_instances` | `(player_id, instance_id)` | `artifact_id`、`obtained_at_ms`、`mode`、`band`、`frontier_block_index`、`dig_counter`、`source`、`status`（held / sold）、`sold_at_ms`、`source_report_id` | `instance_id = 'd' ‖ dig_counter`；已出售的實例保留，不能重新出現 |
| `artifact_discoveries` | `(player_id, artifact_id)` | `first_discovered_at_ms`、`first_band`、`total_found` | 永不刪除；首次紀錄不可變；`total_found` 不可減少（RPC 檢查） |
| `first_treasure` | `player_id` | `status`、`effective_mining_ms`、`resolved_at_ms`、`artifact_instance_id`、`report_id` | trigger：只能從 pending 轉出一次，之後結果不可變（`report_id` 只能清除）；有效時間不可減少 |
| `offline_reports` | `(player_id, report_id)` | `status`（pending / claimed）、`period_start_ms`、`period_end_ms`、`blocks_mined` ≥ 1（D23）、`coins`、`report jsonb`（完整 `OfflineReport`）、`claimed_at_ms` | 部分唯一索引 `(player_id) where status = 'pending'` |
| `action_log` | `id` | `player_id`、`idempotency_key uuid`、`request_hash`（SHA-256 hex）、`command`、`committed`、`state_version_after`、`response jsonb` | `unique (player_id, idempotency_key)` |
| `market_prices` | `(price_date, artifact_id)` | `multiplier_ppm` 700,000–1,500,000 | 只新增：trigger 禁止 UPDATE / DELETE（v1.14） |

### 8.3 私有資料與權限

| 對象 | 權限 |
|---|---|
| `private.player_secrets`（`rng_secret bytea`，長度 32） | anon / authenticated / **service_role 都沒有權限**；`private` schema 不在 PostgREST 公開清單中。只有 `game_load_snapshot`（security definer）讀取；密鑰在 `game_create_player` 內以 `extensions.gen_random_bytes(32)` 產生，不經過應用程式 |
| 玩家資料表（`players` 等 7 張） | authenticated：只有 SELECT，RLS `player_id = auth.uid()`；anon：沒有權限；任何 Client 都不能 INSERT / UPDATE / DELETE |
| `action_log` | Client 沒有權限（回應快照只由 API 回傳） |
| `market_prices` | authenticated：SELECT 全部（公開報價）；任何 Client 都不能寫入 |
| `private.market_secret`、`private.market_*` 函式 | 沒有任何 API 角色可讀取 / 呼叫（含 service_role）；只由 `game_load_snapshot` 與 pg_cron（postgres）使用 |
| RPC `game_create_player`、`game_load_snapshot`、`game_commit` | 只有 service_role 可以 EXECUTE（收回 Supabase 預設給 public / anon / authenticated 的權限） |
| `private.*` 函式 | 沒有任何角色可直接呼叫 |

### 8.4 約束

- 所有數量 / 時間 / 工作量欄位為 `bigint`，並以 check 限制在 `0 … 2^53 − 1`；超出、小數、錯型別的值在寫入時被拒絕，整個交易 rollback。
- 遊戲 ID 以 check 清單限制（GBS §24：只能新增；新增 ID 需要新的 migration）。`packages/game-server/test/schema-ids.test.ts` 檢查清單與 `@mining/game-data` 一致。
- 每位玩家最多一份 pending 報告；`action_log` 的 `(player_id, idempotency_key)` 唯一；寶物實例 `(player_id, instance_id)` 唯一。

### 8.5 bigint / JSONB / TypeScript 數值轉換

| 路徑 | 策略 |
|---|---|
| TS → DB | 引擎只產生 safe integer（`validateState`）；RPC 以 `(jsonb ->> 'x')::bigint` 轉換，小數或超過 bigint 會直接錯誤，超過 `2^53 − 1` 會被 check 拒絕 |
| DB → TS | RPC 以 `jsonb_build_object` 組出 `PlayerGameState`；`bigint` 轉成 JSON number。因為 check 保證 ≤ `2^53 − 1`，`JSON.parse` 一定精確 |
| 時間 | 遊戲時間存毫秒 `bigint`（`*_at_ms`），不經過 `timestamptz` 的微秒換算；`timestamptz` 欄位只作稽核 |
| 直接 SQL（pg driver） | `bigint` 會回傳字串；只有測試與維運腳本使用，遊戲路徑一律經由 RPC 的 JSON |
| 往返測試 | 整合測試：所有操作後「資料庫載入的狀態 = 引擎提交的狀態」；`2^53 − 1` 可往返；`2^53`、小數、負數被拒絕且 rollback |

### 8.6 與 v1.5 草稿的差異

| v1.5 草稿 | 實作 | 原因 |
|---|---|---|
| `mining_state` 獨立資料表 | 併入 `players` | 一對一、每次提交都會改；少一個 join 與一列鎖 |
| `pending_report_id` 欄位 | 由 `offline_reports` 的部分唯一索引決定 | 避免兩個來源不一致 |
| `zone_unlocks` 資料表 | `players.unlocked_zone` | 解鎖必須依序（D10），單一數字即可表示 |
| `inventory_items` / `collection_records` | `player_inventory` / `artifact_discoveries` | 依本階段需求命名 |
| `artifact_instances` 出售即刪除、主鍵 uuid | 保留並標記 `sold`、主鍵 `(player_id, instance_id)` | 防止同一個 ID 被重新建立；實例 ID 由方塊序號決定（§8.1） |
| `load_player_snapshot` / `commit_player_state` | `game_load_snapshot` / `game_commit`（另有 `game_create_player`） | 以 `game_` 前綴區分遊戲 RPC |
| 密鑰由 Edge Function 產生 | 資料庫 `gen_random_bytes(32)` 產生 | 密鑰不經過應用程式 |
| `players.name` / `appearance` | 尚未加入 | 角色名稱規則待確認（C-3），不影響遊戲狀態；UI 階段加入 |
| `timestamptz` 時間 | 毫秒 `bigint` | 與引擎時間完全相同，不需換算 |

---

## 9. 寶物市場實作【v1.14 已實作】

| 項目 | 規則 |
|---|---|
| 市場日 | Asia/Taipei（固定 UTC+8，無日光節約）00:00 換日（GBS §13，提案 P24–P26）。只用資料庫 `now()`，不使用 Client 時間 |
| 產生 | `private.market_ensure(date)`：每件寶物從最後一筆紀錄逐日遞推到指定日（中間缺少的日期全部補齊）；`insert … on conflict do nothing` |
| 延遲生成 | `game_load_snapshot`（每個讀取 / 交易）在同一個交易中呼叫 `private.market_quote(now())`：當日 12 件都在就直接讀取（不取鎖）；缺少時才產生 |
| 排程 | pg_cron `market-daily-prices`：每天 UTC 16:01（台灣 00:01）`select private.market_ensure(private.market_date(now()))`。只是優化，沒跑到也不影響正確性；重跑是冪等的 |
| 並行 | 產生時取 `pg_advisory_xact_lock`，多個 Worker 依序執行；值只取決於密鑰與日期，主鍵 + do nothing 保證不覆蓋 |
| 不可變 | 已產生的價格不能 UPDATE / DELETE（trigger；連 postgres 也不行），同一市場日、同一寶物永遠是同一個倍率 |
| 失敗 | 產生失敗（例如密鑰遺失）只記 warning：其他操作照常，只有出售回 `MARKET_UNAVAILABLE`（503，不保存、可用同一個 key 重試）。**不使用任何備用倍率** |
| 報價 | 每個回應附 `market`：`{ date, nextRefreshAt, multipliersPpm }`；`game-state` 另附最多 6 天 `history`（PR #14 的走勢；沒有資料就沒有） |
| 成交價 | `sell_artifacts` 在伺服器交易時以**當下市場日**的倍率計算 `floor(BaseValue × multiplier)`。Client 只能帶 `marketDate`（看到的報價日期），不能帶價格或倍率；與伺服器市場日不同 → `MARKET_QUOTE_EXPIRED`（409，附新報價，不出售），玩家必須以新報價重新確認 |
| 跨日邊界 | 市場日與 serverNow 來自同一個交易的 `now()`；成交以「載入快照」的時間點為準（之後的 CAS 提交只差毫秒） |

## 10. API

### 10.1 共通規則

- 所有 API 都是 Supabase Edge Function，需要 `Authorization: Bearer <Supabase Auth access token>`（以及 gateway 需要的 `apikey: <anon key>`）。
- 玩家身分**只**來自函式內以 `auth.getUser(jwt)` 驗證後的 user id；body / query 不接受 `playerId`，多出的欄位一律 `400 INVALID_REQUEST`。
- 改變狀態的請求（`game-action`）必須帶 `Idempotency-Key: <uuid>` header；冪等由資料庫 `action_log (player_id, idempotency_key)` 保證，不依賴前端。
- 回應即 `@mining/game-server` 的 `ApiResponse`（成功：`{ ok: true, requestId, command, state: PlayerView, events, settlement, report, ... }`；失敗：`{ ok: false, requestId, command, error: { code, message }, state? }`）。HTTP 狀態由 `httpStatus()` 決定（200 / 201 / 400 / 401 / 404 / 405 / 409 / 422 / 500 / 503）。
- 每個回應都有 `X-Engine-Version`；`game-action` 另有 `Idempotent-Replayed: true|false`。
- **每個動作都先結算到現在**（伺服器時間 = 資料庫 `now()`），再執行動作，並在同一次 `game_commit` 交易中寫入。
- 有待領取的離線報告時，除了 `claim_report`，其他改變狀態的指令都回傳 `REPORT_PENDING`（D24）。
- 錯誤訊息是固定的通用文字；SQL 錯誤、資料表名稱、堆疊、金鑰都只寫入伺服器 log。

### 10.2 端點

| 端點 | 方法 | 請求 | 說明 |
|---|---|---|---|
| `character-create` | `POST` | 空 body 或 `{}` | 建立初始狀態（木製十字鎬 Lv1，D10）與 `rng_secret`；`201`，已存在則 `409 CHARACTER_EXISTS`。角色名稱 / 外觀不在本階段範圍 |
| `game-state` | `GET` | 不接受任何 query | **唯讀**，不結算、不寫入；未建立角色 `404 PLAYER_NOT_FOUND`。要結算請送 `settle` 指令 |
| `game-action` | `POST` | header `Idempotency-Key`；body 必須恰好是 `{ "command": GameCommand }` | 所有改變狀態的操作：`settle`、`claim_report`、`select_mining_mode`、`unlock_zone`、`purchase_pickaxe`、`equip_pickaxe`、`upgrade_pickaxe`、`craft`、`sell_items`、`sell_artifacts`。指令格式由引擎 `parseCommand` 嚴格驗證（不接受價格、深度、時間等欄位） |
| （所有端點） | `OPTIONS` | — | CORS preflight；其他方法 `405` |

原 v1.6 以前「一個動作一個端點」的規劃（`state-get`、`mining-settle`、`report-claim`、`pickaxe-buy`…）改為單一 `game-action` + 指令型別：驗證、冪等、CAS 重試與回應保存只需實作一次，指令集與引擎 `GameCommand` 一一對應。市場報價不另設端點：每個回應附 `market`（v1.14），不需要額外輪詢。

### 10.3 錯誤碼

| 代碼 | 意義 |
|---|---|
| `UNAUTHORIZED` | 未登入 |
| `CHARACTER_NOT_FOUND` / `CHARACTER_EXISTS` | 角色不存在 / 已存在 |
| `REPORT_PENDING` | 有待領取的報告 |
| `REPORT_NOT_FOUND` / `REPORT_ALREADY_CLAIMED` | 報告不存在 / 已領取 |
| `INSUFFICIENT_COINS` / `INSUFFICIENT_ITEMS` | 金幣 / 素材不足 |
| `PREREQUISITE_MISSING` | 未擁有前一階十字鎬、礦區未到達等 |
| `MAX_LEVEL` | 已達 Lv5 |
| `ZONE_LOCKED` | 礦區未解鎖 |
| `MARKET_QUOTE_EXPIRED` | 出售時帶的報價市場日已過（409；回應附新報價） |
| `MARKET_UNAVAILABLE` | 當日市場價格無法取得（503；不保存，可用同一個 key 重試） |
| `INVALID_REQUEST` | 參數錯誤 |
| `IDEMPOTENCY_MISMATCH` | 同一個 key 對應不同內容 |
| `VERSION_CONFLICT` | 重試三次後仍衝突 |
| `RATE_LIMITED` | 每位使用者的請求超過上限（429 + `Retry-After`；未執行、未保存，以同一個 key 重試）【v1.16，取代原「結算間隔 2 秒」的規劃】 |
| `REQUEST_EXPIRED` | 410：這個 key 已處理過但詳細回應已超過保存期限（`expired.processed = true`、`ok` = 當初是否成功），或未確認操作超過有效期限而被確認作廢（`processed = false`）；**絕不重新執行**【v1.16】 |
| `SERVER_BUSY` | 503：資料庫錯誤、逾時、Edge 暫時錯誤；結果可能不確定 → 以同一個 key 重試 / 調和 |
| `INTERNAL_ERROR` | 500：伺服器狀態異常；不保存，結果視為不確定 |

### 10.4 提交流程

協調層：`packages/game-server` 的 `handleGameRequest(db, { playerId, requestId, command })`（Node 與 Deno 共用）。

```mermaid
sequenceDiagram
    participant C as Client
    participant EF as Edge Function
    participant DB as Postgres
    C->>EF: POST（JWT、Idempotency-Key、command）
    EF->>EF: 驗證 JWT → playerId（不採用 body 中的任何 id）
    EF->>DB: rpc game_load_snapshot(player_id, key, request_hash)
    DB-->>EF: replay / mismatch / not_found / ok（state、rngSecret、serverNow、market）
    EF->>EF: executeRequest(state, { requestId, command }, { serverNow, rng, market })
    EF->>DB: rpc game_commit(player_id, expected_version, key, hash, command, state|null, reportCreated, reportClaimed, response)
    alt committed / recorded / replay
        DB-->>EF: 同一交易：鎖定玩家列 → 冪等 → CAS → 寫入所有資料表 → 報告 → action_log
    else version_conflict
        DB-->>EF: 以同一個 key 重新載入最新快照與資料庫時間、重新計算（最多 3 次）
    end
    EF-->>C: ApiResponse（公開狀態；不含密鑰或內部錯誤）
```

- `game_*` RPC 都是 `security definer`、`search_path = ''`，只授權給 `service_role`。
- `serverNow` 取自 Postgres `now()`（毫秒），是唯一時間來源。
- `game_commit` 先 `select … for update` 鎖定玩家列：同一位玩家的提交依序執行，同一個 key 並行送出時，後到的請求會看到先到的紀錄並回傳同一個回應。
- 交易中任何一步失敗（型別、約束、報告不是 pending、狀態與報告表不一致）都會整個 rollback，也不會留下 `action_log`。

### 10.5 離線報告領取流程 【決策 D20】

玩家有待領取的報告時，必須先領取才能進行其他遊戲操作。

**伺服器端**

| 規則 | 實作 |
|---|---|
| 待領取期間 | 挖掘暫停；領取時以 `server_now` 為新的 `lastSettledAt`，等待的時間不補算，所以領取後不會再立刻產生另一份報告（D24） |
| 空報告 | 離線期間沒有完成任何方塊時不建立報告（D23） |
| 阻擋其他操作 | 所有改變狀態的 API（除了 `report-claim`）在 `pending_report_id` 不為空時回傳 `REPORT_PENDING`。`state-get`、`market-get` 等唯讀 API 照常可用 |
| 原子領取 | `commit_player_state` 以 `select … for update` 鎖定報告列；只有 `status = 'pending'` 才寫入獎勵並改為 `claimed`，同一交易清除 `pending_report_id` |
| 重送同一個 key | 回傳 `action_log` 中儲存的回應，不再入帳 |
| 其他分頁 / 裝置用不同 key 領取 | 第二個請求看到 `claimed`，回傳 `REPORT_ALREADY_CLAIMED` 與目前狀態；不會再次入帳 |
| 同時只有一份報告 | 部分唯一索引：每位玩家最多一筆 `pending`（§8.4） |
| 領取不可能因遊戲規則失敗 | 領取只做加法（沒有背包上限或其他檢查）；獎勵在產生報告時就已確定。可能失敗的只有網路或基礎設施 |
| 數值版本變更 | 報告保存具體的物品 ID 與數量；ID 不可刪除（GBS §24），所以任何版本都能領取 |
| 不受頻率限制 | `report-claim` 不套用結算的 2 秒頻率限制 |
| 資料異常 | 若報告內容違反不變式（理論上不會發生），回傳 `REPORT_INVALID` 並記錄錯誤；只有 `service_role` 可用的修復函式能處理，Client 不能自行跳過 |

**Client 端**

| 情況 | 行為 |
|---|---|
| 進入遊戲時有待領取報告 | 顯示探險成果畫面；其他操作停用 |
| 按下「領取」 | 產生一個 Idempotency-Key，**重試時沿用同一個 key** |
| 網路或 API 失敗 | 自動重試（1、2、4、8 秒…最多間隔 30 秒），並顯示「重新嘗試」按鈕與連線狀態；不會永久停在畫面上 |
| 收到 `REPORT_ALREADY_CLAIMED` | 視為成功：重新讀取狀態並關閉畫面（另一個分頁或裝置已領取） |
| 其他分頁在報告產生後送出操作 | 收到 `REPORT_PENDING`，該分頁也顯示探險成果畫面 |
| 重新整理 / 重開瀏覽器 | `state-get` 回傳待領取報告或已領取後的狀態，畫面依此顯示 |

---

### 10.6 冪等與原子提交 【Settlement & Actions Core】

純函式不處理鎖或交易，但回傳的資料足以讓 Supabase Integration 階段實作：

| 項目 | 定義 |
|---|---|
| 請求識別 | 每個改變狀態的請求帶 `requestId`（= `Idempotency-Key`，Client 產生 uuid，重試沿用）。`canonicalCommandJson(command)` 產生 `request_hash`；同一個 key 對應不同內容 → `IDEMPOTENCY_MISMATCH` |
| stateVersion | 載入時的版本 = `expectedStateVersion`；提交時 `update … where version = expected`，成功後為 +1。不符 → `VERSION_CONFLICT`，從載入重新執行 `executeRequest`（最多 3 次） |
| 不需要提交 | `commit = null`（沒有變化或請求無效）：不寫入，但仍寫入 `action_log` 讓重送得到相同回應 |
| 報告識別 | `reportId = "r" + periodStart`；每位玩家唯一（`lastSettledAt` 只會遞增）。部分唯一索引保證最多一份 `pending` |
| 報告建立 | `commit.reportCreated`：同一交易寫入 `offline_reports`（pending）、`pending_report_id`、挖掘狀態、首次保護狀態 |
| 報告領取 | `commit.reportClaimed`：同一交易鎖定報告列，只有 `pending` 才改為 `claimed` 並寫入獎勵、清除 `pending_report_id` |
| 必須原子提交 | 金幣、物品、寶物實例（新增 / 出售刪除）、圖鑑、十字鎬、礦區、挖掘狀態（含 `digCounter`、`lastSettledAt`）、首次保護、報告狀態、`action_log`、`version` |
| 操作失敗 | 操作沒有任何效果；若結算有變化（例如剛產生報告）`commit.actionApplied = false`，結算結果仍提交 |
| 回應保存（實作） | `commit ≠ null`：狀態與回應同一交易提交（`committed = true`）。`commit = null`（無變化、或遊戲規則拒絕且結算沒有變化）：只保存回應（`committed = false`），保存前同樣做 CAS，確保回應根據最新狀態計算。**不保存**：`IDEMPOTENCY_MISMATCH`、`VERSION_CONFLICT`（重試用盡）、資料庫錯誤、伺服器狀態異常，Client 可以用同一個 key 重試 |
| 寶物實例 | 主鍵 `(player_id, instance_id)`；`instance_id = "d" + digCounter`，同一方塊不會產生兩個實例 |


### 10.7 身分驗證與 Service Role 【Supabase Integration 2/2】

```mermaid
sequenceDiagram
    participant C as Client
    participant G as API Gateway
    participant EF as Edge Function
    participant A as Supabase Auth
    participant DB as Postgres (RPC)
    C->>G: POST /functions/v1/game-action (Bearer JWT, Idempotency-Key, {command})
    G->>EF: 轉送
    EF->>A: auth.getUser(jwt)（anon key client）
    A-->>EF: user.id 或 401
    EF->>EF: 驗證 header / body（parseCommand）
    EF->>DB: rpc game_load_snapshot(user.id, key, hash)（service role client）
    DB-->>EF: 快照 + rng_secret，或已保存的回應
    EF->>EF: executeRequest（@mining/game-engine，與 Node 相同原始碼）
    EF->>DB: rpc game_commit(...)（CAS，衝突時最多重試 3 次）
    EF-->>C: ApiResponse（不含 rng_secret）
```

- **Service Role Key** 只在 Edge Function 內以 `SUPABASE_SERVICE_ROLE_KEY`（Supabase 自動注入）建立 client，只用來呼叫三個 `game_*` RPC；不出現在任何回應、`NEXT_PUBLIC_*` 或瀏覽器。一定先完成 `getUser` 才建立。
- **`verify_jwt = false`**（`supabase/config.toml`）：gateway 的 JWT 檢查會擋掉不帶 `Authorization` 的瀏覽器 preflight，因此由函式內 `getUser` 驗證每個請求（`OPTIONS` 除外，它不讀寫任何資料）。`getUser` 會向 Auth 伺服器確認 token，已登出 / 被刪除的使用者也會被拒絕。
- `GAME_API_ALLOWED_ORIGIN`（選填）：CORS 允許清單，逗號分隔；每一項是完整的 origin，或只含一個 `*` 的 Vercel Preview 樣式（`https://<project>-*-<team>.vercel.app`，`*` 只比對 `[a-z0-9-]`，後面必須以 `-` 開頭）。符合時回傳該 origin 與 `Vary: Origin`，不符合時不回傳 `Access-Control-Allow-Origin`。未設定時：本地為 `*`；Cloud（`SUPABASE_URL` 是 https）**拒絕所有瀏覽器 origin**（fail closed，並記錄 `cors_not_configured`）。Cloud 只允許 Vercel 網址（`pnpm cloud secrets` 依 `CLOUD_WEB_URL` 設定）【v1.18】。API 本身靠 Bearer token，不依賴 cookie【v1.17】。
- `EDGE_DIAGNOSTICS=true`（只在本機 `[edge_runtime.secrets]`）：回應加上 `Server-Timing` 與 `X-Diagnostics-Memory`，供 §10.8 測量；正式環境不設定。

### 10.9 Rate Limit【v1.16】

- **位置**：伺服器端、資料庫計數（`private.rate_limits`，每位使用者每個 bucket 一列，固定視窗）。`game-state` / `game-action` 在既有的 `game_load_snapshot` 內計數（不增加資料庫往返）；`character-create` 呼叫 `game_rate_limit`（低頻 API）。
- **身分**：只用已驗證 JWT 的 user id；**不使用任何 IP header**（不信任可偽造的 header）。
- **預設**（`DEFAULT_RATE_LIMITS`，環境變數 `GAME_RATE_LIMIT_ACTION` / `_STATE` / `_CREATE` 可覆寫，格式 `次數/毫秒`）：`game-action` 30 / 10 秒、`game-state` 20 / 10 秒、`character-create` 5 / 60 秒。正常同步（每 5–20 秒、多分頁各自同步）與玩家連續操作遠低於上限。
- **不計數也不阻擋**：同一個 key 的重送（replay / 已壓縮 → expired）在計數前就回傳；作廢探詢（`Idempotency-Expire`）屬於調和；CAS 衝突的伺服器內重試只計一次。
- **超限**：429 `RATE_LIMITED`、`Retry-After`（秒）與 `retryAfterMs`。伺服器沒有執行也沒有保存 → API Client 在 10 秒內的 Retry-After 以**同一個 key** 等待重試；更長的交給 Controller：保留未確認紀錄、Retry-After 之後自動以同一個 key 重試（領取報告、調和不會永久卡住）。
- **限制**：無效 JWT 在呼叫資料庫前就被 `auth.getUser` 拒絕（401），不計入每位使用者的限制；大量建立帳號依賴 Supabase Auth 平台預設的 rate limit（本專案**尚未**在 `supabase/config.toml` 自訂 `[auth.rate_limit]`，Supabase Cloud 部署前需確認並設定）；每位使用者建立角色另有 `character-create` 的限制；IP 層級的 DDoS 防護依賴平台（Supabase gateway / Cloudflare），本專案沒有實作。

### 10.10 action_log 分層保存與 Request ID 有效期限【v1.16】

| 層 | 保存 | 用途 |
|---|---|---|
| 完整回應（`response`） | 30 天（pg_cron `action-log-compact`：每小時 `call private.action_log_drain()`，分批、每批 commit，直到清完或達上限） | 回應遺失後以同一個 key 重送：回傳完全相同的結果 |
| 冪等識別（`player_id`、`idempotency_key`、`request_hash`、`command`、`committed`、`response_ok`） | **永久**（settle 以外） | 之後以同一個 key 重送：`REQUEST_EXPIRED`（附當初成功與否），**不重新執行**；不同內容 → `IDEMPOTENCY_MISMATCH` |
| `settle` | 30 天後整筆刪除 | settle 沒有 Client 指定的效果（只把時間推進到「現在」）：同一個 key 再送只會結算到現在，不會重複發放 |

- trigger `action_log_guard`：冪等識別不可改寫；回應只能被清除（壓縮），不能改成其他內容。
- 清除吞吐量（PR #15 Review P1）：每批 2,000 列 × 2 種（刪 settle、壓縮交易）、每次最多 500 批 → 每小時最多 2,000,000 列；一位持續在線、每 20 秒同步的玩家每小時約 180 筆 settle。部分索引只涵蓋「還要處理的列」，掃描成本與積壓量成正比。監控：`select private.action_log_backlog()`（待處理數與最老時間，應維持在 0 附近）與 `cron.job_run_details`。
- **未確認操作的有效期限（Client）**：超過 7 天（`PENDING_MAX_AGE_MS`）的未確認紀錄改送 `Idempotency-Expire: true`（只調和、不執行）。伺服器：key 已存在 → 回傳原本的結果（或 `REQUEST_EXPIRED` 附當初結果）；不存在 → **不執行**，寫下作廢紀錄（`processed = false`），之後同一個 key 的原始請求即使晚到也只會得到作廢結果（唯一鍵 + 同一交易的 CAS）。
- Client 從不自行判定成功或失敗：`REQUEST_EXPIRED` 依伺服器的 `expired` 欄位顯示，並重新讀取狀態（狀態永遠以伺服器為準）。

### 10.11 錯誤分類與 log【v1.16】

| 類別 | 代碼 | HTTP | 交易是否已執行 | Client 行為 |
|---|---|---|---|---|
| 成功 / 重送 | — | 200 | 是（重送 = 原本的結果） | 套用回應 |
| 規則拒絕 | `INSUFFICIENT_*`、`REPORT_PENDING`、`MARKET_QUOTE_EXPIRED`… | 409 / 422 | 否（保存在 action_log） | 清除未確認紀錄、顯示原因（報價過期 → 以新報價重新確認） |
| 參數錯誤 | `INVALID_REQUEST`、`IDEMPOTENCY_MISMATCH` | 400 / 409 | 否 | 清除、顯示錯誤 |
| 已過期的 key | `REQUEST_EXPIRED` | 410 | 依 `expired`（已處理 / 作廢） | 清除、重新讀取狀態 |
| 未登入 | `UNAUTHORIZED` | 401 | 否 | 更新 token 一次；仍失敗 → 登出（未確認紀錄留在該使用者的 storage） |
| 限流 | `RATE_LIMITED` | 429 | 否（未保存） | 保留未確認紀錄，`Retry-After` 後以同一個 key 重試 |
| 市場無價格 | `MARKET_UNAVAILABLE` | 503 | 否（未保存） | 清除（確定未執行）、停用出售 |
| 暫時錯誤 / 逾時 / 資料庫失敗 | `SERVER_BUSY`、`VERSION_CONFLICT` | 503 / 409 | **不確定** | 保留未確認紀錄，以同一個 key 重試 / 調和 |
| 伺服器異常 | `INTERNAL_ERROR` | 500 | **不確定** | 同上；顯示錯誤 |
| 網路 / 回應損壞 | `NETWORK`、`BAD_RESPONSE`（Client） | — | **不確定** | 同上 |

- **逾時**：每個 RPC 預設 8 秒（`GAME_DB_TIMEOUT_MS`）。逾時的交易可能仍在資料庫中完成 → `SERVER_BUSY`（不確定），由同一個 key 調和。
- **log**（Edge Function `console.error`，結構化 JSON）：錯誤與重送寫入 `request_rejected` / `request_failed`（fn、status、code、requestId、command、userId、attempts、durationMs）；資料庫錯誤 `db_error`、限流 `rate_limited`、作廢 `request_expired`。**不寫入** JWT、Authorization header、Service Role Key、RNG / 市場密鑰或玩家狀態內容；回應只含通用錯誤訊息。

### 10.8 Edge Runtime 實測效能

在 CI 的真實 Supabase Local（Edge Runtime、Deno）上，經由 gateway 以 HTTP 呼叫 `game-action`，最壞情境：回訪 zone1、鑽石十字鎬 Lv5、三套套組（9 件寶物）、前線 3000、離線 18 小時 → 模擬上限 12 小時、3,384 個方塊。數值與測量方式見 PR 說明；CPU 以「函式內總時間 − Auth − DB」的純計算時間近似（計算是同步 CPU 工作，不含 I/O 等待），這是 wall time 的上限估計，不是 runtime 回報的 CPU 計數。

## 11. 安全

| 項目 | 規則 |
|---|---|
| RLS | `public` 所有遊戲資料表：`authenticated` 只能 `select` 自己的資料（`player_id = auth.uid()`）；沒有任何 `insert / update / delete` 權限 |
| 私有資料 | `private` schema 不對 `anon` / `authenticated` 開放 |
| RPC | `load_player_snapshot`、`commit_player_state` 只授權 `service_role` |
| 時間 | 不接受 Client 傳入的任何時間 |
| 數量 | 只接受 Client 指定「要做什麼」，所有數量與結果由伺服器計算 |
| 頻率 | 結算請求每位玩家最少間隔 2 秒 |
| 名稱 | 長度、字元集與過濾規則：待確認 C-3 |
| 密鑰 | service role key 只存在 Edge Function 環境變數；市場密鑰只存在資料庫 `private` schema（v1.14） |

---

## 12. Client 架構

### 12.1 狀態（Zustand）【Playable MVP 已實作】

`apps/web/src/lib/game/store.ts`（vanilla store，Controller 與 React 共用）：

```ts
interface GameUiState {
  phase: "booting" | "signed_out" | "no_character" | "ready" | "error";
  view: PlayerStateView | null;   // 最後一次伺服器回傳的權威狀態（整個覆蓋）
  fresh: boolean;                 // view 是否剛由結算產生（只有這時才能預測進度）
  receivedAt: number;             // 收到時的本機時間（performance.now，僅用於預測）
  busy: BusyOp | null;            // 進行中的狀態操作（同時只有一個）
  lastSettlement, recentLoot;     // 最新挖掘成果、Recent Loot（以 digCounter 去重）
  sync: { ok, lastOkAt, failures, message }; notice; error;
}
```

- 不在 Client 保存任何會入帳的計算結果；金幣、背包、裝備、挖掘進度一律來自伺服器回應。
- 待領取報告就是 `view.state.pendingOfflineReport`（不另外保存）。
- 原規劃的 `eventQueue`（動畫佇列）與 `ui.tab` 留到背包 / 工坊 / 圖鑑 UI 的 PR。

### 12.2 進度預測

- 引擎 `predictBlockProgress(state, elapsedMs)`（`packages/game-engine/src/predict.ts`）：只用 Hardness、目前數值與已累積的工作量，不用亂數；回傳狀態、目前方塊進度、預測完成的方塊數（內容未知）、下一個方塊的剩餘時間。
- 預測最多到 300 秒（在線門檻）；不模擬數值變化（例如掉落湊齊套組）。
- 單元測試確認：數值不變時，預測的方塊數與方塊進度與伺服器在線結算完全一致。
- 進度條依預測顯示；方塊的礦石在伺服器結算前顯示為「?」；預測完成的方塊顯示為「待結算」，不顯示任何資源。
- 伺服器回應一到就以新狀態為基準（校正）。`game-state`（唯讀）與錯誤附帶的狀態不是現在的狀態（`fresh = false`），不預測，並盡快結算。

### 12.3 結算排程【實作值；T9 調整】

| 觸發 | 規則 |
|---|---|
| 進入遊戲 | `game-state` → 沒有待領報告時立即 `settle` |
| 心跳 | 最長 **20 秒**一定同步一次（`HEARTBEAT_MS`；任務要求 15–30 秒；300 秒在線門檻內） |
| 預測方塊完成 | 完成時間 + 300 ms，但距離上次同步至少 **10 秒**（`BLOCK_SYNC_MIN_MS`；原提案 5 秒） |
| 分頁回到前景 / 視窗 focus / `online` 事件 | 立即同步 |
| 背景分頁 | 停止計時器；超過 300 秒才回來時由伺服器產生離線報告（預期行為，Client 不補算） |
| 失敗 | 退避 5 → 10 → 20 → 30 秒；第一次載入失敗時自動重新載入 |
| 待領取報告 | 不排程（D24：暫停） |

- `setTimeout` 鏈，一次只有一個計時器；React Strict Mode 重複掛載時 `bootstrap` 只執行一次。
- 同時觸發的同步合併成一個請求；同時只允許一個會改變狀態的操作。

### 12.4 路由【T10 定案】

- `/`：遊戲主畫面（Mine；底部導覽的 Inventory / Workshop / Collection 為下一個 PR）。未登入一律導向 `/login`。
- `/login`：Email / Password 登入與註冊。登入過期時顯示 `?expired=1` 提示。
- 角色建立不是獨立路由：登入後 `game-state` 回 404 時在 `/` 顯示建立畫面。
- `/dev`（診斷）與 `/dev/preview`（記憶體後端預覽各種畫面狀態）只在 `next dev` 存在；`/dev/preview` 以 `page.dev.tsx` 命名，正式 build 不產生路由與 bundle。

### 12.5 寶物揭曉【v1.13 已實作】

- 稀有度只有 GBS §8.3 的 Epic / Legendary（Common / Rare 是礦物：Recent Loot 以顏色 / 符號區分，GDD §4.2）。
  - Epic：水晶色像素卡片（名稱、圖示、礦區、EPIC、NEW DISCOVERY、首次寶物保護）。
  - Legendary：全螢幕金色演出（緩慢旋轉的光芒 + 呼吸光暈 + 像素粒子；不使用快速閃爍）。
  - `prefers-reduced-motion`：不播放動畫，直接顯示靜態卡片，標記與按鈕不變。
- 佇列在 GameController（共用 runtime），不在頁面元件：換頁不會遺失；React Strict Mode 不會重複入列。畫面只顯示第一筆，「收下」換下一筆，另有「全部略過」「前往圖鑑」；Escape 關閉目前這筆；焦點限制在對話框內並在結束後還原（與 ConfirmDialog / 寶物詳情共用 `useDialogFocus`）。
- 有待領報告時先顯示報告（D20），不顯示揭曉。演出不阻擋同步排程、不改變任何結算。

**資料來源（只用伺服器確認的資料）**

| 來源 | 時機 |
|---|---|
| `block_completed`（`instanceId`、`artifact` / `protection`、`isNewDiscovery`） | 在線結算（含操作前的結算） |
| `report_claimed.artifactInstanceIds` + 領取前報告的 `rewards.artifacts` | `claim_report` 成功後（領取前不入列；報告已不在畫面時改用持有清單的實例資料） |
| `heldArtifacts` 中新出現的實例（相對於第一次收到狀態時的最大 digCounter） | 沒有事件的情況：其他分頁 / 裝置取得、拒絕回應附帶的結算狀態、重新讀取 |

**去重**：鍵是 `instanceId`（`d<digCounter>`，同一位玩家永不重複；同種寶物取得兩次是兩個鍵）。去重只影響 UI，不影響入帳。

**保存（PR #12 Review 修正）**：依使用者、每個實例一個 `localStorage` key（`mining-expedition:reveal:v2:<userId>:q:<id>` 待播放、`…:s:<id>` 已播放、`…:floor`），不對單一 JSON 做 read-modify-write，多分頁同時入列 / 略過不會互相覆蓋。
- 略過：先寫已播放、再刪待播放；讀取時**已播放優先**（晚到的舊入列會被清掉），所以入列與略過交錯時不會重播。
- 待播放**不截斷**：全部保留到看完 / 略過；儲存空間不足的項目只保留在本分頁記憶體（仍會播放；略過後本分頁不重播）。
- 已播放紀錄上限 200：在同帳號 Web Lock 內先提高 floor（只增不減）、再刪較舊的紀錄；仍有待播放項目 ≤ floor 時不清理；不支援 Web Lock 時不清理（保守）。
- 重新整理時第一次收到的狀態只當基準，既有寶物不重播；未看完的佇列繼續播放。舊版 v1 資料會自動遷移。
- NEW DISCOVERY 只在伺服器事件 / 報告明確標示時顯示；以持有清單補上的項目不推斷（中性）。

### 12.6 API Client 與錯誤處理【Playable MVP】

`apps/web/src/lib/game/api.ts`（純 TypeScript，瀏覽器與 Node 整合測試共用）：

- `getState()`、`createCharacter()`、`action(command, requestId)`。只送 `Authorization: Bearer <access token>` 與 `apikey`，不送任何 playerId。
- Idempotency-Key：每個獨立操作 `crypto.randomUUID()`；同一個操作的所有重試沿用同一個 key（包含玩家按「重試」領取同一份報告）。
- 401：`refreshSession()` 一次後以同一個 key 重送；仍失敗 → 本機登出並導向 `/login?expired=1`。
- 網路錯誤、逾時（15 秒）、502 / 503 / 504、`SERVER_BUSY`、`VERSION_CONFLICT`：以同一個 key 退避重試（0.5 / 1.5 / 3.5 秒）。逾時的請求可能已提交，重送會拿到伺服器保存的同一個回應。
- **未確認操作【v1.9，v1.11 改為每筆一個 key】**：玩家操作（領取、模式、解鎖、出售、購買、裝備、強化、製作）送出前先把 `{ requestId, command }` 存到 `localStorage`：`mining-expedition:pending-action:v2:<userId>:<requestId>`（每筆操作一個 key，分頁只新增 / 刪除自己那筆；v1 的單一 key 讀取時自動轉換）。
  - 清除條件：伺服器確定的結果——成功，或已保存在 `action_log` 的遊戲規則拒絕（金幣不足等）。
  - 保留條件：`NETWORK`、逾時、`BAD_RESPONSE`、503 `SERVER_BUSY`、409 `VERSION_CONFLICT`、500、401——這些都不代表伺服器沒有提交。
  - 調和：玩家重按同一個操作、下一次自動同步、或重新整理後的 bootstrap，都以**同一個 requestId** 重送；伺服器回傳原結果（已提交）或第一次執行（未提交）。
  - 未確認期間不接受其他玩家操作（畫面顯示「上一個操作的結果尚未確認」與「重新確認」按鈕）；換帳號不會讀到其他使用者的 key。
  - 自動結算（settle）不保存：重複結算只依伺服器時間推進，不會重複發放。
- **回應驗證【v1.9】**：`lib/game/validate.ts` 在寫入 store 前檢查 `ok`、`stateVersion`（與 `state.state.stateVersion` 一致）、`state`（PlayerStateView 的必要欄位與型別）、`events`、`settlement`、`report`、`error`；HTTP 狀態碼與 `ok` 必須一致。不合法 → `BAD_RESPONSE`（不複製資料；原物件通過檢查後直接寫入）。
- 錯誤對應：`REPORT_PENDING` → 重新讀取並顯示報告；`REPORT_ALREADY_CLAIMED` / `REPORT_NOT_FOUND` → 提示並重新讀取；`CHARACTER_NOT_FOUND` → 建立角色畫面；`INTERNAL_ERROR` → 錯誤訊息（不重試）。
- 沒有使用 TanStack Query：狀態只有一份伺服器快照，由 Controller 統一寫入 Zustand，避免兩套快取。

### 12.8 Runtime 生命週期【v1.9】

- 每位登入使用者一組 `{ API Client, Store, Controller }`，以參考計數管理（`acquireRuntime` / `releaseRuntime`），只在 React effect 中建立與釋放；render 沒有副作用。
- 最後一次 release 後延後到下一個 macrotask 才 dispose：Strict Mode 的 mount → unmount → mount 沿用同一組，不會重複 bootstrap。
- 換帳號：其他使用者的 runtime 立即 dispose；`useGameRuntime` 只回傳 userId 相同、未 dispose 的 runtime。
- `dispose()`：不再寫入 store（進行中的請求回來時直接丟棄）、清除計時器、取消訂閱並關閉 BroadcastChannel。
- 舊 runtime 的 API Client 只會使用屬於同一個 userId 的 token；換帳號後舊請求不會帶著新使用者的身分送出。

### 12.9 背包 / 工坊 / 製作【v1.10】

- 路由：`app/(game)/layout.tsx` 包住 `/`（挖礦）、`/inventory`（背包）、`/workshop`（工坊與製作）。runtime、同步排程、待領報告視窗都在 layout，切換頁面不會重新登入或重建狀態。
- 所有成本、價格、配方都取自 `@mining/game-data`（`PICKAXES`、`MATERIALS`、`MINERALS`），畫面只用來顯示與停用按鈕（`lib/game/economy.ts`）；合法性與扣款由伺服器（引擎 `applyAction`）再次確認。
- 所有交易經 `GameController.perform()`（§12.6 未確認操作 / 冪等）；畫面數值只在伺服器回應後更新，不做 optimistic update。成功 / 失敗 / 未確認以提示列顯示（金額取自伺服器事件）。
- 出售：指定數量或全部；全部出售（10 個以上）或一次 100 個以上需要確認視窗。
- 十字鎬：依序購買（購買後自動裝備，P21）、裝備、強化（Lv5 上限）；不足時列出缺少的項目。換裝後挖掘進度依引擎規則處理（P5：保留累積工作量），UI 不重置。
- 製作：一次 N 份，素材不足則整批失敗（P22）。

### 12.10 出售價格來源【v1.10 確認】

| 對象 | 價格 | 來源 | 本階段 |
|---|---|---|---|
| 礦物 / 寶石 | 固定 `MINERALS[id].sellPrice × 數量` | 引擎 `sell_items` | ✅ 開放 |
| 製作素材 | 不可出售（P16） | 引擎拒絕 | 只顯示 |
| 寶物 | `floor(BaseValue × 當日倍率)`（GBS §13） | 伺服器 `market_prices`（`game_load_snapshot` 載入，必要時延遲生成）；指令必須帶報價的 `marketDate`；缺少倍率時 `MARKET_UNAVAILABLE` | ✅（v1.15，`/market`，§12.14） |

### 12.11 跨分頁交易與失敗模式【v1.11】

同一位使用者的玩家操作在所有分頁之間以 **Web Locks**（`navigator.locks`，鎖名 `mining-expedition:actions:<userId>`）排隊。拿到鎖之後：

1. 重新讀取 storage 的所有未確認操作（可能來自其他分頁）。
2. 先以各自原本的 requestId 調和；仍有任何一筆不確定 → 不開始新的交易（提示「上一個操作（可能在其他分頁）尚未確認」）。
3. 才送出新的交易。

**正確性不依賴鎖或 BroadcastChannel**：唯一的冪等依據仍是伺服器的 `action_log`。

| 情況 | 處理 |
|---|---|
| Web Locks 不支援 / 鎖失效 | 只在分頁內排隊；兩個分頁可能同時以**同一個** requestId 重送 → 伺服器回傳同一個結果，只套用一次；每筆紀錄獨立保存，不會互相覆蓋 |
| 等鎖超過 20 秒（另一個分頁的請求很慢） | 不送出新交易，提示「其他分頁正在進行交易」 |
| 分頁在請求進行中關閉 / 崩潰 | 瀏覽器自動釋放 Web Lock；紀錄留在 storage；其他分頁經 `storage` 事件得知並在 5 秒內調和（或下次開啟時 bootstrap 調和） |
| 兩個分頁同時重新整理 | 兩個 bootstrap 依序取得鎖；第一個確認並刪除紀錄，第二個看到已沒有紀錄。鎖失效時兩個都以同一個 requestId 重送，伺服器只套用一次 |
| 離線 | 紀錄保留，退避排程（5 → 30 秒）與 `online` 事件時調和；期間不接受新的交易 |
| 未確認的 `claim_report` | 「有未確認操作」優先於「待領報告暫停排程」：繼續以退避排程調和；成功後報告消失並恢復正常同步；同一份報告只會入帳一次 |
| storage 無法寫入（私密模式 / 容量） | 退回分頁記憶體；重新整理後無法恢復，但伺服器仍保證不重複 |

拒絕回應（`ok: false`、已保存在 `action_log`）代表**交易本身沒有執行**；但伺服器先結算再執行操作，`stateVersion` 前進時表示挖掘結算已同步（`lastAction.synced = true`），提示文字會說明，不再顯示「沒有任何變更」。

### 12.12 帳號切換與延遲 401【v1.11】

- 每個 runtime 只服務一個 userId。共用的 Supabase client 可能已換成另一位使用者，所以：
  - `getAccessToken`：目前 session 不是這個 userId → 不送出請求。
  - `refreshAccessToken` / `onUnauthorized`：只有目前 session 仍屬於這個 userId（且 runtime 未 dispose）時才更新或 `signOut({ scope: "local" })`。
- 因此 A 帳號的舊請求晚收到 401，不會更新、登出或清除 B 的 session；A 的 Controller 已 dispose，不會寫入任何 store。

### 12.13 圖鑑與套組【v1.12】

資料模型（已存在，沒有新增欄位）：

| 需要 | 來源 |
|---|---|
| 歷史圖鑑 | `PlayerGameState.discoveredArtifacts[id] = { firstDiscoveredAt, firstBand, totalFound }`（`artifact_discoveries`，永不刪除） |
| 目前持有 | `heldArtifacts[]`（`artifact_instances`，出售時刪除） |
| 稀有度 / 礦區 / 基礎估值 / 套組 | `@mining/game-data` `ARTIFACTS`（只有 Epic、Legendary 兩種稀有度，GBS §8.3） |
| 套組成員與加成 | `SETS`（Speed %、Luck ppm）；是否啟動：引擎 `activeSets(heldCounts(state))`（D3：必須實際持有全部成員） |
| 新發現事件 | `block_completed.isNewDiscovery`（在線）、`ReportArtifact.isNewDiscovery`（離線報告） |
| 離線報告中的寶物 | `pendingOfflineReport.rewards.artifacts`（領取前不在 `heldArtifacts`，也不在圖鑑） |

畫面（`lib/game/collection.ts` 為顯示用計算）：
- 圖鑑進度 = 已發現種類 / 12（GBS §9、P19），另顯示三個礦區各 / 4。
- 寶物卡：已發現（名稱、稀有度、礦區、持有數；持有 0 時標示「已發現，未持有」）／未發現（剪影 + `？？？`）。詳細：持有數、歷史發現次數、首次發現時間與深度、所屬套組、基礎估值（註明不是當日成交價）。
- 篩選：狀態（全部 / 已發現 / 未發現）、礦區、稀有度；另有「套組」分頁。
- 套組卡分開顯示三種狀態：**圖鑑已發現全部成員**（`allDiscovered`：每件都曾分別發現，不代表曾同時持有或曾啟動套組；目前沒有歷史啟動紀錄）、目前持有全部成員、加成生效中；以及持有數 / 3、缺少的成員、完成加成（取自 `SETS`）。
- 實際能力值只顯示伺服器回傳的 `PlayerStateView.stats`；UI 不把加成套用到任何狀態。

**未發現寶物的揭露規則（GDD 未定義；PR #11 Review 確認作為 MVP 取捨）**：目前顯示礦區與稀有度（GBS §8.3 的公開資料，也讓「礦區完成率」與稀有度篩選有意義），隱藏名稱、配色與套組歸屬；剪影保留輪廓。若希望連稀有度也隱藏，只需調整 `CollectionPage` 的顯示。

### 12.7 多分頁

- 成功提交後以 `BroadcastChannel("mining-expedition:state")` 廣播 `stateVersion`；其他分頁看到較新的版本時以 `game-state` 重新讀取，2 秒後結算。
- 多分頁同時結算時由伺服器 CAS（§10.6）處理；同一份報告只會入帳一次，晚到的分頁得到 `REPORT_ALREADY_CLAIMED` 後重新讀取。

---


### 12.14 市場與寶物出售（`/market`）【v1.15】

| 項目 | 規則 |
|---|---|
| 資料來源 | 報價只來自伺服器回應的 `market`（store 保存市場日較新的報價）；開啟市場時以唯讀 `game-state` 取得歷史（`controller.refreshMarket()`），本機時間超過 `nextRefreshAt` 時也重新取得。售價用引擎 `artifactSalePrice` 顯示，**不重新實作定價** |
| 歷史讀取【v1.16】 | 頁面以 `controller.watchMarket()` 訂閱：沒有歷史 / 已過更新時間才讀取；bootstrap、結算、交易進行中時排隊，結束後讀取；失敗或伺服器仍是舊報價時退避（2 秒起、最多 60 秒、尊重 Retry-After）；離開頁面即停止，已有歷史時重新進入不送請求 |
| 報價狀態 | `valid` / `refreshing`（本機時間已過更新時間，只是顯示）/ `unavailable`（倍率為空：不顯示價格、不能出售，不使用任何備用倍率）/ `none` |
| 寶物卡 | 圖示、名稱、Epic / Legendary、礦區、基礎價值、今日售價、倍率、持有數、是否屬於生效中的套組。未發現的寶物沿用圖鑑規則：只顯示礦區與稀有度，不顯示名稱、外觀與行情 |
| 走勢 | 伺服器歷史（最多 6 天 + 今天）畫成 SVG 折線，可展開日期 / 倍率 / 價格表；少於 2 天顯示「尚無歷史行情」。漲跌只在歷史中確實有「昨天」時顯示（不與基礎價比較、不補假資料） |
| 選擇 | 每種寶物選件數（− / ＋ / 全部），轉成 `heldArtifacts` 中的 instanceId（先賣較新取得的）；件數永遠不超過目前持有；**多種合計不超過 `MAX_ARTIFACTS_PER_SALE`（100）**：「全部」只補到上限、顯示還可再選的件數【v1.16】；伺服器另外驗證（超過 100 件 → `INVALID_REQUEST`） |
| 成交提示【v1.16】 | 只對應成功的那一個 Request ID（取自該次 `artifacts_sold` 事件）；新交易開始、之後有其他操作結果、換帳號時不再顯示 |
| 確認 | 名稱、實際實例 ID、件數、單價 / 倍率、小計與預估總收入、市場日、出售後剩餘；開啟時固定要出售的實例，持有狀態改變（例如其他分頁已出售）時停用確認並提供「重新選擇」 |
| 套組影響 | 以引擎 `activeSets` 比較出售前後的持有數量：只列出「出售前生效、出售後失效」的套組（例：「出售後將失去老礦工套組效果：Speed ×1.03」），可同時列出多個；有影響時標題、按鈕（「仍要出售」）與警告框都不同。只是預測，結果以伺服器回應為準 |
| 送出 | `{ type: "sell_artifacts", instanceIds, marketDate }`（畫面上報價的市場日），經由既有的 `controller.perform`（未確認操作、Web Lock、冪等）；不送價格 / 倍率；不做 optimistic update，金幣、持有、套組、能力值只來自伺服器回應；成交金額取自 `artifacts_sold` 事件 |
| 報價過期 | `MARKET_QUOTE_EXPIRED`：交易沒有執行，未確認紀錄清除；回應附帶的新報價更新畫面，確認視窗以新價格重新計算並顯示「市場價格已更新，請重新確認」；**不自動重送**，玩家再次確認才送出（指令不同 → 新的 Request ID） |
| 無法取得 | `MARKET_UNAVAILABLE`（不保存 → 確定沒有提交）：顯示「市場價格暫時無法取得」，停用出售；挖礦、同步等其他功能不受影響。網路失敗等「結果未確認」的情況仍走既有的同 Key 調和 |
| 其他入口 | 背包的寶物區塊（同種合併件數、前往市場）；圖鑑詳細資料的「查看市場行情」（`/market#market-<id>`）。圖鑑紀錄出售後仍保留 |
| 阻擋 | 有待領報告或未確認操作時不能出售（`canAct`）；共用同一個 runtime，切換頁面不重建 |

## 13. 存檔與版本

| 項目 | 規則 |
|---|---|
| 存檔 | 每次 API 呼叫都在伺服器寫入，Client 不需要手動存檔 |
| 重新整理 | 重新整理後呼叫 `state-get`，資料不遺失【GDD §13】 |
| Schema 變更 | 使用 `supabase/migrations`，只能新增，不改寫已發布的 migration |
| 遊戲數值變更 | 改 `game-data` 並將 `DATA_VERSION` 加 1；依 GBS §24 記錄並執行模擬；不回溯既有玩家資料（D19） |
| 亂數順序變更 | `RNG_VERSION` 加 1，保留舊快照（§4） |
| 多分頁 / 多裝置 | 由樂觀鎖與伺服器權威處理；任一分頁的結果都以伺服器為準 |

---

## 14. 測試規範

### 14.1 單元測試（Vitest）【GDD】

引擎每個模組都要有單元測試，涵蓋率門檻：`game-engine` lines / statements / functions ≥ 90%、branches ≥ 85%（`packages/game-engine/vitest.config.ts`，CI 執行 `pnpm --filter @mining/game-engine coverage`）。【T11】

必要案例：

| 模組 | 案例 |
|---|---|
| fixed | 所有十字鎬 × 等級的 `power10` 都能整除；鑽石 Lv3 的 power10 = 360 ≥ 360 |
| stats | GBS §10 的數值表全部相符；套組加成相加規則 |
| mining | `blockMs` 與 GBS §5 表格相符；換裝後工作量保留；Power 不足時停止 |
| drop | 每一層的分布總和 = 1,000,000 ppm；Luck 只放大 Rare / Epic / Legendary |
| drop | Luck 0.12 時：zone1 Rare = 28,000 ppm；寶物 Legendary = `Chance × 0.1 × 1.12` |
| drop | 回訪：寶物 Chance ×0.5、金幣金額 ×0.5；礦物表不變 |
| drop | 同一位置只改變強化等級：寶物每小時期望值只隨 Luck 改變（GBS §7.6） |
| drop | 寶物機會上限 500,000 ppm（GBS P37）；最大 Luck 下 `legPpm + epicPpm ≤ 1,000,000` |
| settle | 300 秒以內入帳；超過 300 秒產生報告；12 小時上限；超過部分捨棄 |
| settle | 回訪模式使用該礦區最深深度帶的 Hardness 與 RequiredPower；不改變 `frontierBlockIndex` |
| settle | 前線到礦區底部且未付費解鎖時停止（D10） |
| settle | 遇到門檻停止且保留成果；遇到未解鎖礦區停止 |
| settle | 有待領取報告時拒絕結算 |
| collection | 出售後圖鑑紀錄保留；套組在持有時啟動、出售後失效、重新取得後啟動 |
| rework | 只在前線卡關時可用；深度帶 = 最後挖完方塊所在帶往上第一個 Req ≤ Power 的帶；不改變 `frontierBlockIndex` |
| rework | 金幣 ×0.5、寶物 ×0.5（暫定）；礦物表不變；前線解除卡關後不可再進入 |
| first-treasure | 正常掉落第一件寶物 → `obtained`，之後永不發放 |
| first-treasure | 有效時間達門檻且該方塊無寶物 → 發放固定 Epic、`granted`；不消耗亂數（保護前後的 golden 結果除了該件 Epic 外完全相同） |
| first-treasure | 卡關、超過 12 小時上限、切換模式放棄的未完成方塊都不累積有效時間 |
| first-treasure | 出售保護寶物後不會再次發放 |
| actions | 每個動作的成功與各種失敗條件 |
| market | 倍率永遠在 Min–Max 範圍內 |

### 14.1.1 MVP v1.0 引擎規則與測試對照 【決策 D18、D19、D20】

| 規則 | 測試案例 |
|---|---|
| P2 回訪無限循環 | 回訪 N 個方塊後 `frontierBlockIndex` 不變，`digCounter` 增加 N |
| P3 切換模式進度歸零 | 切換後 `blockWork`、`blockMs` 為 0；`digCounter` 不變，下一個方塊結果與未切換時相同 |
| P5 工作量 | 挖到一半換十字鎬，已累積的工作量保留；`blockMs` 與 GBS §5 計算一致 |
| P6 門檻用 `≥` | `power10 = requiredPower10` 可以挖；少 1 不能挖（含鑽石 Lv3 = 360） |
| P7 結算順序 | 記錄每方塊的亂數消耗序列，與快照一致（§6.2） |
| P8 基礎產出 | 每個完成的方塊恰好產出 1 個 OreType 礦物 |
| P13 稀有度分類 | 寶物定義只有 `epic` / `legendary`；方塊礦物為 Common、寶石為 Rare |
| P21 十字鎬 | 依序購買；購買後自動裝備；切換保留等級；出售十字鎬被拒絕 |
| P22 製作 | 一次 N 份、素材不足全部失敗；購買或強化不會自動製作 |
| P28 在線 / 離線 | 間隔 300,000 ms 直接入帳；300,001 ms 產生報告 |
| P39 固定保護寶物 | 保護發放 `a_z1_lantern` |
| D18 門檻 | 有效時間 14,399,999 ms 不發放；≥ 14,400,000 ms 且該方塊無寶物時發放；該方塊有寶物則改為 `obtained` |
| D20 報告 | 見 §14.5 |

### 14.1.2 Settlement & Actions 測試對照

| 規則 | 測試（`packages/game-engine/test/`） |
|---|---|
| 一次結算 = 分段在線結算（含套組變化、未完成方塊） | `settle.test.ts` |
| P5 換裝備保留工作量 | `settle.test.ts` |
| D5 Power 不足 / D10 未解鎖 / 主線完成：停止且沒有額外掉落 | `settle.test.ts` |
| 回訪 / 重挖不增加最大深度 | `settle.test.ts` |
| D9 12 小時上限、超過部分不再結算 | `settle.test.ts` |
| P28 300,000 ms 在線、300,001 ms 離線 | `settle.test.ts` |
| D17 / D18 首次保護：最多一次、不消耗亂數、離線發放與報告一致、出售後不再發放 | `settle.test.ts` |
| D23 沒有完成方塊時不建立報告；D24 待領取期間暫停、領取時更新基準、不連續產生報告 | `settle.test.ts`、`request.test.ts` |
| 不可信快照（缺欄位、null、錯型別）回傳 INVALID_STATE、不丟例外 | `request.test.ts` |
| D20 報告未領取時背包不可用、一般操作拒絕、重複領取不重複入帳 | `settle.test.ts`、`actions.test.ts`、`request.test.ts` |
| P20 在線入帳後下一方塊套組生效、領取後套組生效、出售後失效（圖鑑保留） | `settle.test.ts`、`actions.test.ts` |
| D10 / P21 / P22 購買、強化、製作、出售、解鎖：足夠 / 不足、不部分扣除、非法數量 | `actions.test.ts` |
| D15 / D16 / P3 模式切換、重挖深度帶、自動回到前線 | `actions.test.ts` |
| 狀態驗證、序列化、不含密鑰、cloneState 不共用物件 | `request.test.ts` |
| stateVersion、提交計畫、操作失敗時的提交 | `request.test.ts` |

### 14.2 確定性測試

- 固定 `rngSecret` + 固定狀態 + 固定時間 → 結果與快照（golden file）完全一致。
  - Engine Core：`test/golden.ts` 產生逐方塊亂數與六種位置 × 2,000 方塊的掉落；`fixtures/golden-v1.json` 由 Vitest 比對，CI 另以 `node` 與 `deno` 執行 `test/golden-cli.ts` 並與同一份 fixture 比對。
  - 結算層的快照（固定狀態 + 時間）在 Settlement 階段加入。
- 同一段時間「一次結算」和「切成多次結算」的結果必須一致（在線模式、沒有套組變化時）。
- 改變亂數消耗順序的修改必須更新快照，並在 PR 中說明。

### 14.3 統計測試

- 每一層抽樣 10^6 次，各結果頻率與理論值誤差在 ±3 個標準差內。密鑰固定，所以測試是確定性的。
- 物品權重表抽樣驗證。

### 14.4 平衡模擬

- `scripts/balance-sim.ts` 是**開發輔助工具**，不是遊戲實作。玩家狀態是正式的 `PlayerGameState`；時間推進用 `settle`（在線每次 ≤ 300 秒、離線在登入時一次結算並領取報告），購買 / 強化 / 製作 / 出售 / 解鎖 / 切換模式 / 領取都用 `applyAction`。腳本只保留參考玩家策略（何時做什麼）、登入排程、Monte Carlo 與報表。
- 執行與參數見檔案開頭說明與 GBS §23（Node 22.18+，先 `pnpm install`）。可切換：首次保護門檻、回訪 / 重挖的金幣與寶物倍率、D13 前後的金幣表、是否啟用重挖、出售策略。非預設方案經由引擎的 `DropRules` 參數與 `firstTreasureStep` 的門檻參數傳入，正式結算一律使用預設值。
- 輸出：玩家類型完成時間（平均、P10、P50、P90、P99）、裝備購買時間點、回訪 / 重挖 vs 前線收益表、Mining Speed 驗證、首次保護 A / B / C、主線後補齊收藏、防卡死壓力測試、D12–D16 前後比較。
- 模擬器與正式引擎的已知差異列在 GBS §23.2。
- 結果必須符合 GBS §18 的標準，納入 CI。

### 14.5 整合測試（本機 Supabase）

| 案例 | 預期 |
|---|---|
| 同一個 Idempotency-Key 送兩次 | 只執行一次，兩次回應相同 |
| 同一個 key、不同內容 | `IDEMPOTENCY_MISMATCH` |
| 同時送出兩個購買請求 | 一個成功，另一個重試後依結果成功或 `INSUFFICIENT_COINS`，金幣不會變負 |
| 同時領取同一份報告兩次 | 只入帳一次 |
| Client 修改本機時間 | 收益不變（伺服器不接受 Client 時間） |
| 離線 11 小時 / 12 小時 / 16 小時 | 收益分別對應 11 / 12 / 12 小時 |
| 每 6 小時領取 vs 每 12 小時領取（總時間相同、沒有卡關） | 期望收益相同（D9） |
| 首次保護：同一份離線報告重送領取 / 重登入 / 同時兩個結算請求 | 保護寶物只發放一次 |
| 報告：兩個分頁同時用不同 key 領取 | 一個成功，另一個 `REPORT_ALREADY_CLAIMED`；只入帳一次 |
| 報告：領取成功但回應遺失，Client 以同一個 key 重送 | 回傳原回應，不重複入帳 |
| 報告：有待領取報告時呼叫購買 / 出售 / 切換模式 | `REPORT_PENDING`，狀態不變 |
| 報告：產生報告後 `DATA_VERSION` 加 1 再領取 | 依報告內容入帳成功 |
| 首次保護：Client 修改本機時間、長時間卡關空等 | 有效時間不增加 |
| 重挖：Client 指定 `reworkBand` | 忽略，由伺服器計算 |
| 防卡死：金幣 0、背包全空的帳號在每個門檻 | 都能透過重挖或回訪恢復（對應 GBS §21） |
| RLS | `authenticated` 無法寫入任何遊戲資料表、無法讀取他人資料、無法讀取 `private` |

時間：**不在 RPC 加入任何時間覆寫參數**（T12 改為下列做法）。測試以 postgres superuser 把玩家的時間基準往前移（`created_at_ms`、`last_settled_at_ms`，等同玩家離開了一段時間），正式程式碼沒有任何可以改時間的路徑。有待領取報告時不倒轉時間（報告內容固定），D24 的等待以實際等待驗證。

實作（PR #5）：`tests/integration/`，在 CI 的 docker job 中於真正啟動的 Supabase Local（PostgREST + PostgreSQL 17 + Auth）上執行；同一組情境也在本機以 PGlite 執行（`packages/game-server/test/`，單一連線、不含並行）。

| 分類 | 測試 |
|---|---|
| Auth / RLS（真實 JWT 經 PostgREST） | anon 讀不到任何玩家資料；A 只讀得到自己、讀不到 B；Client 不能改金幣 / 物品 / 深度 / 裝備 / 報告 / 首次保護 / 市場價格、也不能改別人的資料；讀不到密鑰（service_role 經 PostgREST 也讀不到）與 action_log；anon / authenticated 不能呼叫 `game_*` RPC；回應與 action_log 不含密鑰 |
| 冪等 / CAS | 同 key 同指令只套用一次；同 key 不同指令 `IDEMPOTENCY_MISMATCH`；遊戲規則拒絕也保存回應；`commit = null` 只保存回應；注入競爭提交 → 重試 1 次後成功；持續競爭 → 3 次後 `VERSION_CONFLICT` 且不保存，同一個 key 再試成功 |
| 交易 | 約束違反時整個 rollback（狀態、寶物、action_log 都沒有變化）；已出售實例不能重新出現；圖鑑不能刪除或減少 |
| 並行（多連線） | 同一個 key 同時 8 次只套用一次；兩個裝置同時操作沒有遺失更新；10 個請求同時湧入 + Client 以同一 key 重送 → 每個只套用一次；同時領取同一份報告只入帳一次；逾時重送、回應遺失後重送 |
| 遊戲邏輯 | 初始角色；完整往返（結算、報告、購買、製作、強化、出售、裝備）；safe integer 邊界；與 golden fixture 一致；伺服器結果 = 相同快照的純引擎計算；12 小時離線（30 小時 → 模擬 12 小時）；D23；D24；解鎖與模式切換持久化；重新載入後一致 |

尚未涵蓋（下一個 PR：Edge Functions）：HTTP 層（JWT 驗證、Idempotency-Key header、錯誤碼對應）、Edge Runtime 實測效能、`DATA_VERSION` 升版後領取報告。

### 14.6 效能基準

12 小時離線結算最壞情境（`packages/game-engine/bench/settle-bench.ts`，Node 與 Deno 共用）：窮舉所有合法「位置 × 十字鎬 × 等級 × 套組」後，最多方塊的是「主線完成後回訪 zone1、鑽石 Lv5、三套套組」，12 小時 3,384 個方塊。數值見 PR #4；Edge Function 的實際 CPU / 記憶體在 Supabase Integration 階段量測。

### 14.6.1 目標

- 最壞情況（離線 12 小時、最快方塊）的 `settle` 在 Node 上 < 50ms。
- 部署後在 Edge Function 上量測實際 CPU 時間。

### 14.7 E2E

GDD 只列 Vitest。是否加入 Playwright 做 E2E 測試，待確認。【提案 T13】

---

## 15. 環境與部署

### 15.1 本機開發：Docker-first 【決策 D22】

本機只需要 Docker Desktop、Git 與編輯器。Node.js、pnpm、Supabase CLI 都在開發容器內執行；Supabase 的服務（Postgres、Auth、PostgREST、Edge Runtime、Studio）由容器內的官方 CLI 透過 Docker 啟動。不使用 Supabase Self-hosting。

```mermaid
flowchart LR
    subgraph Host["Docker Desktop"]
        subgraph Compose["compose.yaml"]
            DEV[dev<br/>Node + pnpm + Supabase CLI + Docker CLI]
            WEB[web<br/>next dev :3000]
            FN[functions<br/>supabase functions serve]
        end
        subgraph SB["Supabase CLI 建立的容器"]
            KONG[API gateway :54321]
            PG[(Postgres :54322)]
            ER[Edge Runtime]
            ST[Studio :54323]
        end
    end
    DEV -- docker.sock --> SB
    FN -- docker.sock --> ER
    WEB -- supabase_network（kong:8000） --> KONG
    KONG --> ER
    KONG --> PG
    ER --> PG
    Browser -- 127.0.0.1:3000 --> WEB
    Browser -- 127.0.0.1:54321 --> KONG
```

| 項目 | 設計 |
|---|---|
| 開發容器 | `Dockerfile.dev`：Node 22、pnpm（corepack）、Supabase CLI v2.122.1、Docker CLI |
| Docker 存取 | Docker-outside-of-Docker：掛載 `/var/run/docker.sock`，Supabase CLI 在宿主的 Docker 上建立容器 |
| 路徑 | Repo 以**與宿主相同的絕對路徑**掛載到容器（`${PROJECT_ROOT}:${PROJECT_ROOT}`）。Supabase CLI 傳給 Docker 的 bind mount 路徑因此在宿主上也成立 |
| 容器間網路 | `web` 加入 Supabase CLI 建立的 `supabase_network_<project_id>`，以 `http://supabase_kong_<project_id>:8000` 存取 API gateway；`dev`、`functions` 使用 host network；瀏覽器使用 `127.0.0.1` |
| Hot Reload | `web`：Next.js dev server 監看 bind mount（必要時設 `WATCHPACK_POLLING=true`）；Edge Runtime：`[edge_runtime] policy = "oneshot"`，每個請求重新載入。CLI 把被匯入的 `packages/` 檔案逐一掛載，**新增檔案後需重新 `supabase start`**（見 `docs/PHASE1_ACCEPTANCE.md`） |
| 環境變數 | `.env`（compose 用，由 `.env.example` 複製）；`apps/web/.env.local` 由 `pnpm env:sync` 從 `supabase status` 產生；兩者都不進版控 |
| 資料持久化 | Postgres 資料在 Supabase CLI 建立的 Docker volume；`supabase stop` 保留資料，`supabase stop --no-backup` 才刪除。pnpm store 在 named volume |
| 連線驗證 | `pnpm verify:env`：Web → Edge Function → Postgres、Web → PostgREST → Postgres |
| 指令 | 見 README |

### 15.2 本機安全性

| 風險 | 處理 |
|---|---|
| Docker socket 等同宿主的 root 權限 | 只掛載到需要的服務（`dev`、`functions`）；`web` 不掛載；不在容器內執行來源不明的程式碼 |
| 容器內以 root 執行 | 入口腳本偵測 socket 的群組 ID，把 `node` 使用者加入該群組後以 `node` 執行 |
| 埠暴露到區網 | 全部只綁定 `127.0.0.1`。`web` 由 compose 指定；Supabase CLI 發布埠時不指定 IP（預設 `0.0.0.0`），因此 Supabase 網路由 compose 建立並設定 `com.docker.network.bridge.host_binding_ipv4=127.0.0.1`，CLI 沿用此網路。`pnpm verify:env` 檢查綁定位址並從非 loopback 介面實際連線驗證 |
| 本地金鑰 | Supabase 本地金鑰只用於開發；`.env`、`.env.local` 列在 `.gitignore`；正式金鑰只存在 Vercel / Supabase secrets |
| 版本漂移 | Supabase CLI、pnpm、Docker CLI 版本固定在 `Dockerfile.dev` 的 build args |

### 15.3 部署環境

| 環境 | Next.js | Supabase |
|---|---|---|
| local | 開發容器內 `next dev` | 開發容器內 `supabase start` |
| test（目前）| Vercel Production（`main`，noindex、封閉測試） | 測試用 Supabase 專案（`pnpm cloud` 手動部署；`docs/DEPLOYMENT.md`）【v1.18】 |
| production（未來） | 另行規劃 | 另一個獨立的 Supabase 專案（不與測試共用資料庫或密鑰） |

| 變數 | 位置 |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_ANON_KEY` | Vercel |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase 平台自動提供給 Edge Functions（不需要也不應該手動設定；市場密鑰在資料庫內產生） |
| `GAME_API_ALLOWED_ORIGIN`、`GAME_RATE_LIMIT_*`、`GAME_DB_TIMEOUT_MS` | Supabase Edge Function secrets（`pnpm cloud secrets`） |

---

## 16. 開發順序（更新 ANALYSIS_REPORT 附錄 A5）

| 階段 | 內容 | 完成條件 |
|---|---|---|
| 0 | 規格確認 | 本文件與 GBS 審核完成 |
| 1 | Monorepo 骨架；驗證 Edge Function 能匯入 `packages/game-engine` | 一個 hello 函式能呼叫引擎 |
| 2 | 引擎：fixed、rng、stats、mining、drop | §14.1 對應案例通過 |
| 3 | 引擎：settle、actions、collection、market | §14.1–14.3 全部通過；平衡模擬符合 GBS §18 |
| 4 | Supabase：schema、RLS、RPC、Edge Functions | §14.5 全部通過 |
| 5 | Client：登入、角色建立、主畫面、預測、結算排程 | 可玩到 50m |
| 6 | Client：Inventory、Workshop、Collection、離線報告與動畫 | 完整主線可玩 |
| 7 | 市場、動畫音效、RWD、Beta | GDD §13 驗收條件 |

---

## 17. 待確認的技術項目

| # | 項目 |
|---|---|
| T6–T8 | 定點數、亂數、市場實作細節（依本文件實作，測試時確認） |
| T9 | 結算排程參數（5 秒 / 60 秒 / 300 秒） |
| T10 | 單頁 Tab 路由 |
| T12 | ~~測試環境可注入伺服器時間~~ → 改為測試中倒轉玩家的時間基準，正式程式碼不提供時間覆寫（§14.5，PR #5），待審核 |
| T13 | 是否加入 Playwright E2E |
| T14 | Supabase CLI 是否升級到 v3（目前固定 v2.122.1，§15.1） |
| T15 | Edge Function 匯入 `packages/`：Linux（CI）上 `supabase start` 已確認可行；Docker Desktop 待驗證（`docs/PHASE1_ACCEPTANCE.md`） |
| — | 是否需要訪客模式（C-4）。本規格假設**必須登入**，因為伺服器權威需要身分 |
| — | 首次保護以帳號為單位：每個 `auth.uid()` 只能建立一個角色（`character-create` 只能一次）；多帳號不在 MVP 防範範圍內 |

已定案：T1、T2（D21）、T3 pnpm（D21）、T4 `@noble/hashes` 2.4.0（§3.4，PR #3）、T5 不回溯（D19）、首次保護門檻（D18）、T11 涵蓋率門檻（§14.1，CI 強制）。
