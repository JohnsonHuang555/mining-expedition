/**
 * API 回應的執行期結構驗證（寫入 Zustand 前）。
 *
 * 只檢查畫面與控制器會讀取的欄位型別，不複製、不轉換資料（回應物件原樣交給 store），
 * 所以不會產生額外的狀態副本。遊戲規則的不變式由伺服器負責；這裡只防止壞掉的 JSON 讓畫面崩潰。
 */

import type { ApiResponse } from "@mining/game-server";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const isNonNegInt = (v: unknown): v is number => isInt(v) && v >= 0;
const isStr = (v: unknown): v is string => typeof v === "string";
const isNumMap = (v: unknown): boolean => isObj(v) && Object.values(v).every(isNonNegInt);

function reportIssue(r: unknown): string | null {
  if (r === null) return null;
  if (!isObj(r)) return "report";
  if (!isStr(r.reportId)) return "report.reportId";
  for (const k of ["periodStart", "periodEnd", "simulatedMs", "discardedMs", "minedMs", "idleMs", "blocksMined", "frontierFrom", "frontierTo"]) {
    if (!isNonNegInt(r[k])) return `report.${k}`;
  }
  if (!isStr(r.stopReason) || !isStr(r.mode)) return "report.stopReason";
  if (typeof r.firstTreasureGranted !== "boolean") return "report.firstTreasureGranted";
  const rw = r.rewards;
  if (!isObj(rw) || !isNonNegInt(rw.coins) || !isNumMap(rw.items) || !Array.isArray(rw.artifacts)) return "report.rewards";
  for (const a of rw.artifacts) {
    if (!isObj(a) || !isStr(a.instanceId) || !isStr(a.artifactId) || !isStr(a.source) || typeof a.isNewDiscovery !== "boolean") return "report.rewards.artifacts";
  }
  return null;
}

/** PlayerStateView：回傳第一個不合法的欄位路徑，合法時回傳 null */
export function viewIssue(v: unknown): string | null {
  if (!isObj(v)) return "state";
  const s = v.state;
  if (!isObj(s)) return "state.state";
  if (!isStr(s.playerId)) return "state.state.playerId";
  for (const k of ["stateVersion", "coins", "lastSettledAt", "createdAt", "unlockedZone"]) if (!isNonNegInt(s[k])) return `state.state.${k}`;
  if (!isStr(s.equippedPickaxe)) return "state.state.equippedPickaxe";
  if (!isNumMap(s.pickaxes)) return "state.state.pickaxes";
  if (!isNumMap(s.inventory)) return "state.state.inventory";
  if (!Array.isArray(s.heldArtifacts)) return "state.state.heldArtifacts";
  if (!isObj(s.discoveredArtifacts)) return "state.state.discoveredArtifacts";
  const m = s.mining;
  if (!isObj(m) || !isStr(m.mode)) return "state.state.mining";
  for (const k of ["frontierBlockIndex", "digCounter", "blockWork", "blockMs"]) if (!isNonNegInt(m[k])) return `state.state.mining.${k}`;
  if (!(m.revisitZone === null || isNonNegInt(m.revisitZone))) return "state.state.mining.revisitZone";
  if (!(m.reworkBand === null || isNonNegInt(m.reworkBand))) return "state.state.mining.reworkBand";
  if (!isObj(s.firstTreasure) || !isStr(s.firstTreasure.status)) return "state.state.firstTreasure";
  const ri = reportIssue(s.pendingOfflineReport);
  if (ri) return `state.state.pendingOfflineReport(${ri})`;
  const st = v.stats;
  if (!isObj(st) || !isNonNegInt(st.power10) || !isNonNegInt(st.speed1000) || !isNonNegInt(st.luckPpm)) return "state.stats";
  if (!isStr(v.status)) return "state.status";
  const spot = v.spot;
  if (spot !== null && (!isObj(spot) || !isNonNegInt(spot.band) || !isNonNegInt(spot.zone) || !isNonNegInt(spot.hardness) || !isStr(spot.mode))) return "state.spot";
  if (!isNonNegInt(v.maxDepthBand)) return "state.maxDepthBand";
  return null;
}

function eventsIssue(events: unknown): string | null {
  if (!Array.isArray(events)) return "events";
  for (const e of events) {
    if (!isObj(e) || !isStr(e.type)) return "events[].type";
    if (e.type === "block_completed") {
      if (!isNonNegInt(e.digCounter) || !isNonNegInt(e.coins) || !isNumMap(e.items) || typeof e.isNewDiscovery !== "boolean") return "events[block_completed]";
      if (!(e.artifact === null || isStr(e.artifact)) || !(e.protection === null || isStr(e.protection))) return "events[block_completed].artifact";
    }
  }
  return null;
}

function settlementIssue(s: unknown): string | null {
  if (s === null) return null;
  if (!isObj(s) || !isStr(s.kind) || !isStr(s.stopReason)) return "settlement";
  for (const k of ["elapsedMs", "simulatedMs", "discardedMs", "minedMs", "idleMs", "blocksMined"]) if (!isNonNegInt(s[k])) return `settlement.${k}`;
  return null;
}

/** 回傳第一個不合法的欄位路徑；合法時回傳 null（此時可以安全地當作 ApiResponse 使用） */
export function apiResponseIssue(x: unknown): string | null {
  if (!isObj(x)) return "body";
  if (typeof x.ok !== "boolean") return "ok";
  if (x.ok) {
    if (!isStr(x.requestId) || !isStr(x.command)) return "requestId/command";
    if (!isNonNegInt(x.stateVersion)) return "stateVersion";
    const vi = viewIssue(x.state);
    if (vi) return vi;
    if ((x.state as { state: { stateVersion: number } }).state.stateVersion !== x.stateVersion) return "stateVersion(mismatch)";
    return eventsIssue(x.events) ?? settlementIssue(x.settlement) ?? reportIssue(x.report);
  }
  const err = x.error;
  if (!isObj(err) || !isStr(err.code) || !isStr(err.message)) return "error";
  if (x.state !== undefined) return viewIssue(x.state);
  return null;
}

export function isApiResponse(x: unknown): x is ApiResponse {
  return apiResponseIssue(x) === null;
}
