/**
 * 玩家操作（TECHNICAL_SPEC §10.2；GBS §2.3、§2.4、§2.6、§8、§10–§13；決策 D3、D10、D15、D16、D20；D19：P3、P5、P16、P21、P22）。
 *
 * 每個操作都是純函式：`applyAction(已結算到現在的狀態, 操作, 情境)`。
 * - 成功：回傳新狀態與事件。
 * - 失敗：只回傳錯誤，不產生任何新狀態（不會部分扣除）。
 * - 所有成本、價格、深度都由伺服器資料計算；請求只帶「要做什麼」，不帶成本或數量以外的數值。
 * - 有待領取報告時，除了領取以外一律拒絕（D20）。
 */

import {
  ARTIFACTS,
  type ArtifactId,
  MARKET_MULTIPLIER_RANGE_PPM,
  MATERIALS,
  type MaterialId,
  MAX_PICKAXE_LEVEL,
  MINERALS,
  type MineralId,
  type MiningMode,
  PICKAXES,
  PICKAXE_IDS,
  type PickaxeId,
  type PickaxeLevel,
  PPM,
  ZONES,
} from "@mining/game-data";
import { type GameError, gameError } from "./errors.ts";
import type { GameEvent } from "./events.ts";
import { mulDivFloor } from "./fixed.ts";
import { type ZoneIndex, revisitSpot, revisitableZones, reworkBand } from "./mining.ts";
import { addItems, addSafe, checkLoadedState, heldCountsOf, pushSetChanges, recordDiscovery } from "./settle.ts";
import { type Inventory, type PlayerGameState, cloneState, currentStats } from "./state.ts";
import { activeSets } from "./stats.ts";

/** 單次製作 / 出售的上限：防止超大數量造成溢位或濫用（一般遊玩遠低於此值） */
export const MAX_ACTION_QUANTITY = 1_000_000;
/** 一次最多出售的寶物件數 */
export const MAX_ARTIFACTS_PER_SALE = 100;

export type GameAction =
  | { type: "purchase_pickaxe"; pickaxeId: PickaxeId }
  | { type: "equip_pickaxe"; pickaxeId: PickaxeId }
  | { type: "upgrade_pickaxe"; pickaxeId: PickaxeId }
  | { type: "craft"; materialId: MaterialId; times: number }
  | { type: "sell_items"; itemId: MineralId; quantity: number }
  | { type: "sell_artifacts"; instanceIds: string[] }
  | { type: "unlock_zone"; zone: ZoneIndex }
  | { type: "select_mining_mode"; mode: MiningMode; zone?: ZoneIndex }
  | { type: "claim_report"; reportId: string };

export interface ActionContext {
  /** 伺服器時間；領取報告時必須提供（D24：領取時間成為新的結算基準） */
  serverNow?: number;
  /** 當日市場倍率（ppm，GBS §13），出售寶物時必須提供；由伺服器的 market_prices 載入 */
  marketMultiplierPpm?: Partial<Record<ArtifactId, number>>;
}

export type ActionResult =
  | { ok: true; state: PlayerGameState; changed: boolean; events: GameEvent[] }
  | { ok: false; error: GameError };

const fail = (code: GameError["code"], message: string): ActionResult => ({ ok: false, error: gameError(code, message) });

const isPositiveInt = (v: unknown, max: number): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= max;

// ---------------------------------------------------------------------------
// 請求驗證：未經信任的輸入 → 型別正確的 GameAction
// ---------------------------------------------------------------------------

const has = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

/** 解析並驗證 Client 傳來的 JSON（不信任任何欄位；多餘的欄位一律拒絕） */
export function parseAction(raw: unknown): { ok: true; action: GameAction } | { ok: false; error: GameError } {
  const bad = (msg: string) => ({ ok: false as const, error: gameError("INVALID_REQUEST", msg) });
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad("action must be an object");
  const r = raw as Record<string, unknown>;
  const keys = Object.keys(r).sort().join(",");
  const expectKeys = (...k: string[]) => keys === ["type", ...k].sort().join(",");
  switch (r.type) {
    case "purchase_pickaxe":
    case "equip_pickaxe":
    case "upgrade_pickaxe":
      if (!expectKeys("pickaxeId") || !has(PICKAXE_IDS, r.pickaxeId)) return bad("invalid pickaxeId");
      return { ok: true, action: { type: r.type, pickaxeId: r.pickaxeId } };
    case "craft":
      if (!expectKeys("materialId", "times") || !has(Object.keys(MATERIALS) as MaterialId[], r.materialId)) return bad("invalid materialId");
      if (!isPositiveInt(r.times, MAX_ACTION_QUANTITY)) return bad(`times must be an integer in 1–${MAX_ACTION_QUANTITY}`);
      return { ok: true, action: { type: "craft", materialId: r.materialId, times: r.times } };
    case "sell_items":
      // 製作素材不可出售（P16）：只接受礦物 / 寶石
      if (!expectKeys("itemId", "quantity") || !has(Object.keys(MINERALS) as MineralId[], r.itemId)) return bad("invalid itemId (only minerals can be sold)");
      if (!isPositiveInt(r.quantity, MAX_ACTION_QUANTITY)) return bad(`quantity must be an integer in 1–${MAX_ACTION_QUANTITY}`);
      return { ok: true, action: { type: "sell_items", itemId: r.itemId, quantity: r.quantity } };
    case "sell_artifacts": {
      const ids = r.instanceIds;
      if (!expectKeys("instanceIds") || !Array.isArray(ids) || ids.length === 0 || ids.length > MAX_ARTIFACTS_PER_SALE) {
        return bad(`instanceIds must be a non-empty array of at most ${MAX_ARTIFACTS_PER_SALE}`);
      }
      if (!ids.every((x) => typeof x === "string" && x.length > 0 && x.length <= 64)) return bad("instanceIds must be strings");
      if (new Set(ids).size !== ids.length) return bad("instanceIds must be unique");
      return { ok: true, action: { type: "sell_artifacts", instanceIds: [...(ids as string[])] } };
    }
    case "unlock_zone":
      if (!expectKeys("zone") || (r.zone !== 1 && r.zone !== 2)) return bad("zone must be 1 or 2");
      return { ok: true, action: { type: "unlock_zone", zone: r.zone } };
    case "select_mining_mode": {
      if (r.mode === "revisit") {
        if (!expectKeys("mode", "zone") || (r.zone !== 0 && r.zone !== 1 && r.zone !== 2)) return bad("revisit requires zone 0, 1 or 2");
        return { ok: true, action: { type: "select_mining_mode", mode: "revisit", zone: r.zone } };
      }
      // 前線與重挖不接受位置：重挖深度帶只由伺服器計算（D16）
      if ((r.mode === "frontier" || r.mode === "rework") && expectKeys("mode")) return { ok: true, action: { type: "select_mining_mode", mode: r.mode } };
      return bad("mode must be frontier, revisit (with zone) or rework");
    }
    case "claim_report":
      if (!expectKeys("reportId") || typeof r.reportId !== "string" || r.reportId.length === 0 || r.reportId.length > 64) return bad("invalid reportId");
      return { ok: true, action: { type: "claim_report", reportId: r.reportId } };
    default:
      return bad("unknown action type");
  }
}

// ---------------------------------------------------------------------------
// 共用工具
// ---------------------------------------------------------------------------

function hasItems(inv: Inventory, need: Partial<Record<string, number>>, times = 1): boolean {
  for (const [id, n] of Object.entries(need)) {
    const required = mulDivFloor([n ?? 0, times], 1);
    if ((inv[id as keyof Inventory] ?? 0) < required) return false;
  }
  return true;
}

function removeItems(inv: Inventory, need: Partial<Record<string, number>>, times = 1): void {
  for (const [id, n] of Object.entries(need)) {
    const key = id as keyof Inventory;
    const left = (inv[key] ?? 0) - mulDivFloor([n ?? 0, times], 1);
    if (left < 0) throw new RangeError(`removeItems would go negative for ${id}`);
    if (left === 0) delete inv[key];
    else inv[key] = left;
  }
}

/**
 * 操作後重新確認挖掘位置（GBS §2.4）：
 * - 重挖時前線不再卡關 → 回到前線（「前線解除卡關後不能再進入重挖」）
 * - 重挖時 Power 改變 → 重挖深度帶依「目前 Power」重新計算；位置改變時進度歸零（P3）
 */
function normalizeMining(state: PlayerGameState, events: GameEvent[]): void {
  const m = state.mining;
  if (m.mode !== "rework") return;
  const band = reworkBand(m.frontierBlockIndex, state.unlockedZone, currentStats(state).power10);
  if (band === null) {
    Object.assign(m, { mode: "frontier", revisitZone: null, reworkBand: null, blockWork: 0, blockMs: 0 });
    events.push({ type: "mining_mode_changed", mode: "frontier", revisitZone: null, reworkBand: null, reason: "rework_ended" });
  } else if (band !== m.reworkBand) {
    Object.assign(m, { reworkBand: band, blockWork: 0, blockMs: 0 });
    events.push({ type: "mining_mode_changed", mode: "rework", revisitZone: null, reworkBand: band, reason: "rework_band_changed" });
  }
}

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

/**
 * 套用一個操作。`state` 必須已經結算到現在（request.ts 的 executeRequest 會先結算）。
 * 傳入的 state 不會被修改。
 */
export function applyAction(input: PlayerGameState, action: GameAction, ctx: ActionContext = {}): ActionResult {
  const loadErr = checkLoadedState(input);
  if (loadErr) return { ok: false, error: loadErr };
  const parsed = parseAction(action);
  if (!parsed.ok) return parsed;
  const a = parsed.action;

  if (a.type === "claim_report") return claimReport(input, a.reportId, ctx.serverNow);
  if (input.pendingOfflineReport) return fail("REPORT_PENDING", "claim the pending offline report first");

  const state = cloneState(input);
  const events: GameEvent[] = [];
  const setsBefore = activeSets(heldCountsOf(state.heldArtifacts));

  switch (a.type) {
    case "purchase_pickaxe": {
      const tier = PICKAXE_IDS.indexOf(a.pickaxeId);
      const ownedCount = PICKAXE_IDS.filter((id) => state.pickaxes[id] !== undefined).length;
      if (tier < ownedCount) return fail("PREREQUISITE_MISSING", `${a.pickaxeId} is already owned`);
      if (tier > ownedCount) return fail("PREREQUISITE_MISSING", "pickaxes must be bought in order (D10)");
      const cost = PICKAXES[tier as 0 | 1 | 2 | 3 | 4].purchase!;
      if (state.coins < cost.coins) return fail("INSUFFICIENT_COINS", `need ${cost.coins} coins`);
      if (!hasItems(state.inventory, cost.items)) return fail("INSUFFICIENT_ITEMS", "missing materials (crafting is never automatic, P22)");
      state.coins -= cost.coins;
      removeItems(state.inventory, cost.items);
      state.pickaxes[a.pickaxeId] = 1;
      state.equippedPickaxe = a.pickaxeId; // 購買後自動裝備（P21）；未完成方塊的工作量保留（P5）
      events.push({ type: "pickaxe_purchased", pickaxeId: a.pickaxeId }, { type: "pickaxe_equipped", pickaxeId: a.pickaxeId });
      break;
    }
    case "equip_pickaxe": {
      if (state.pickaxes[a.pickaxeId] === undefined) return fail("PREREQUISITE_MISSING", `${a.pickaxeId} is not owned`);
      if (state.equippedPickaxe === a.pickaxeId) return { ok: true, state, changed: false, events };
      state.equippedPickaxe = a.pickaxeId;
      events.push({ type: "pickaxe_equipped", pickaxeId: a.pickaxeId });
      break;
    }
    case "upgrade_pickaxe": {
      const level = state.pickaxes[a.pickaxeId];
      if (level === undefined) return fail("PREREQUISITE_MISSING", `${a.pickaxeId} is not owned`);
      if (level >= MAX_PICKAXE_LEVEL) return fail("MAX_LEVEL", `${a.pickaxeId} is already Lv${MAX_PICKAXE_LEVEL}`);
      const cost = PICKAXES[PICKAXE_IDS.indexOf(a.pickaxeId) as 0 | 1 | 2 | 3 | 4].upgrades[level - 1]!;
      if (state.coins < cost.coins) return fail("INSUFFICIENT_COINS", `need ${cost.coins} coins`);
      if (!hasItems(state.inventory, cost.items)) return fail("INSUFFICIENT_ITEMS", "missing reinforce stones");
      state.coins -= cost.coins;
      removeItems(state.inventory, cost.items);
      state.pickaxes[a.pickaxeId] = (level + 1) as PickaxeLevel;
      events.push({ type: "pickaxe_upgraded", pickaxeId: a.pickaxeId, level: level + 1 });
      break;
    }
    case "craft": {
      // P22：一次 N 份；素材不足則全部失敗
      const recipe = MATERIALS[a.materialId].recipe;
      if (!hasItems(state.inventory, recipe, a.times)) return fail("INSUFFICIENT_ITEMS", `not enough materials for ${a.times} × ${a.materialId}`);
      removeItems(state.inventory, recipe, a.times);
      addItems(state.inventory, { [a.materialId]: a.times });
      events.push({ type: "crafted", materialId: a.materialId, times: a.times });
      break;
    }
    case "sell_items": {
      const have = state.inventory[a.itemId] ?? 0;
      if (have < a.quantity) return fail("INSUFFICIENT_ITEMS", `have ${have} ${a.itemId}`);
      const coins = mulDivFloor([MINERALS[a.itemId].sellPrice, a.quantity], 1);
      removeItems(state.inventory, { [a.itemId]: a.quantity });
      state.coins = addSafe(state.coins, coins);
      events.push({ type: "items_sold", itemId: a.itemId, quantity: a.quantity, coins });
      break;
    }
    case "sell_artifacts": {
      const byId = new Map(state.heldArtifacts.map((x) => [x.instanceId, x]));
      let coins = 0;
      for (const id of a.instanceIds) {
        const inst = byId.get(id);
        if (!inst) return fail("INSUFFICIENT_ITEMS", `artifact instance ${id} is not held`);
        const def = ARTIFACTS[inst.artifactId];
        const mult = ctx.marketMultiplierPpm?.[inst.artifactId];
        const range = MARKET_MULTIPLIER_RANGE_PPM[def.rarity];
        if (mult === undefined || !Number.isSafeInteger(mult) || mult < range.min || mult > range.max) {
          return fail("INVALID_REQUEST", `market price for ${inst.artifactId} is missing or out of range (GBS §13)`);
        }
        coins = addSafe(coins, mulDivFloor([def.baseValue, mult], PPM)); // CurrentValue = floor(BaseValue × multiplier)
      }
      const sold = new Set(a.instanceIds);
      state.heldArtifacts = state.heldArtifacts.filter((x) => !sold.has(x.instanceId)); // 圖鑑保留（GBS §9）
      state.coins = addSafe(state.coins, coins);
      events.push({ type: "artifacts_sold", instanceIds: [...a.instanceIds], coins });
      break;
    }
    case "unlock_zone": {
      // D10、GBS §12：依序；前線挖完上一區最後一個方塊；付費
      if (a.zone !== state.unlockedZone + 1) return fail("PREREQUISITE_MISSING", "zones must be unlocked in order");
      if (state.mining.frontierBlockIndex < a.zone * 1000) return fail("PREREQUISITE_MISSING", "the frontier has not reached this zone yet");
      const fee = ZONES[a.zone].unlockFee;
      if (state.coins < fee) return fail("INSUFFICIENT_COINS", `need ${fee} coins`);
      state.coins -= fee;
      state.unlockedZone = a.zone;
      events.push({ type: "zone_unlocked", zone: a.zone });
      break;
    }
    case "select_mining_mode": {
      const m = state.mining;
      const power10 = currentStats(state).power10;
      let next: { mode: MiningMode; revisitZone: ZoneIndex | null; reworkBand: number | null };
      if (a.mode === "frontier") {
        next = { mode: "frontier", revisitZone: null, reworkBand: null };
      } else if (a.mode === "revisit") {
        const zone = a.zone!;
        if (zone > state.unlockedZone) return fail("ZONE_LOCKED", `zone ${zone} is locked`);
        if (!revisitableZones(m.frontierBlockIndex, state.unlockedZone).includes(zone)) {
          return fail("PREREQUISITE_MISSING", "only zones shallower than the frontier zone can be revisited (D15, GBS §2.3.1)");
        }
        if (power10 < revisitSpot(zone).requiredPower10) return fail("PREREQUISITE_MISSING", "not enough Power for this zone's bottom band");
        next = { mode: "revisit", revisitZone: zone, reworkBand: null };
      } else {
        const band = reworkBand(m.frontierBlockIndex, state.unlockedZone, power10);
        if (band === null) return fail("PREREQUISITE_MISSING", "rework is only available while the frontier is blocked (D16)");
        next = { mode: "rework", revisitZone: null, reworkBand: band };
      }
      if (next.mode === m.mode && next.revisitZone === m.revisitZone && next.reworkBand === m.reworkBand) {
        return { ok: true, state, changed: false, events }; // 沒有切換：不重置進度
      }
      Object.assign(m, next, { blockWork: 0, blockMs: 0 }); // P3：切換模式時目前方塊進度歸零；digCounter 不變
      events.push({ type: "mining_mode_changed", ...next, reason: "player" });
      break;
    }
  }

  normalizeMining(state, events);
  pushSetChanges(events, setsBefore, activeSets(heldCountsOf(state.heldArtifacts)));
  return { ok: true, state, changed: true, events };
}

/**
 * 領取離線報告（TECHNICAL_SPEC §10.5）：一次入帳；不可能因遊戲規則失敗。
 * 提交時必須與「報告狀態改為 claimed」在同一個交易中（TECHNICAL_SPEC §10.6）。
 *
 * D24：待領取期間挖掘暫停。領取時 lastSettledAt = serverNow，等待的時間不產出、不累積有效挖掘時間，
 * 也不會在下一次請求變成另一份離線報告。未完成方塊的工作量保留。
 */
function claimReport(input: PlayerGameState, reportId: string, serverNow: number | undefined): ActionResult {
  const r = input.pendingOfflineReport;
  if (!r) {
    if (input.lastClaimedReportId === reportId) return fail("REPORT_ALREADY_CLAIMED", `report ${reportId} was already claimed`);
    return fail("REPORT_NOT_FOUND", `no pending report ${reportId}`);
  }
  if (r.reportId !== reportId) return fail("REPORT_NOT_FOUND", `pending report is ${r.reportId}, not ${reportId}`);
  if (typeof serverNow !== "number" || !Number.isSafeInteger(serverNow) || serverNow < input.lastSettledAt) {
    return fail("INVALID_TIME", "claim requires serverNow >= lastSettledAt");
  }

  const state = cloneState(input);
  const pausedMs = serverNow - input.lastSettledAt;
  state.lastSettledAt = serverNow; // D24：等待領取的時間不補算
  const events: GameEvent[] = [];
  const setsBefore = activeSets(heldCountsOf(state.heldArtifacts));
  state.coins = addSafe(state.coins, r.rewards.coins);
  addItems(state.inventory, r.rewards.items);
  for (const a of r.rewards.artifacts) {
    const { isNewDiscovery: _flag, ...instance } = a;
    state.heldArtifacts.push(instance);
    recordDiscovery(state, instance);
  }
  state.pendingOfflineReport = null;
  state.lastClaimedReportId = r.reportId;
  if (state.firstTreasure.reportId === r.reportId) state.firstTreasure.reportId = null; // 第一件寶物已入背包
  events.push({
    type: "report_claimed",
    reportId: r.reportId,
    coins: r.rewards.coins,
    items: { ...r.rewards.items },
    artifactInstanceIds: r.rewards.artifacts.map((a) => a.instanceId),
    pausedMs,
  });
  pushSetChanges(events, setsBefore, activeSets(heldCountsOf(state.heldArtifacts))); // 領取後套組才生效（P20）
  return { ok: true, state, changed: true, events };
}
