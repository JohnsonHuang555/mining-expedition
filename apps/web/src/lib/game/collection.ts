/**
 * 圖鑑與套組的「顯示用」計算。
 *
 * - 寶物定義、稀有度、礦區、套組成員與加成全部取自 @mining/game-data；套組是否啟動使用引擎的 activeSets
 *   （與伺服器結算相同的函式，D3：必須實際持有全部成員）。
 * - 實際生效的 Power / Speed / Luck 只來自伺服器回傳的 PlayerStateView.stats；這裡不套用任何加成到遊戲狀態。
 * - 歷史發現（discoveredArtifacts，永不刪除）與目前持有（heldArtifacts）分開計算（GDD §4.3、GBS §9）。
 */

import { ARTIFACTS, ARTIFACT_IDS, type ArtifactId, type ArtifactRarity, SETS, SET_IDS, type SetId } from "@mining/game-data";
import { type DiscoveryRecord, type PlayerGameState, activeSets, heldCounts } from "@mining/game-engine";

export interface CollectionEntry {
  id: ArtifactId;
  name: string;
  rarity: ArtifactRarity;
  zone: 0 | 1 | 2;
  set: SetId | null;
  baseValue: number;
  /** 歷史紀錄（曾經發現過；出售後仍保留） */
  discovery: DiscoveryRecord | null;
  /** 目前持有的件數 */
  held: number;
}

export function collectionEntries(state: PlayerGameState): CollectionEntry[] {
  const held = heldCounts(state);
  return ARTIFACT_IDS.map((id) => {
    const def = ARTIFACTS[id];
    return { id, name: def.name, rarity: def.rarity, zone: def.zone, set: def.set, baseValue: def.baseValue, discovery: state.discoveredArtifacts[id] ?? null, held: held[id] ?? 0 };
  });
}

export interface Progress {
  found: number;
  total: number;
  ratio: number;
}
const progress = (found: number, total: number): Progress => ({ found, total, ratio: total === 0 ? 0 : found / total });

/** GBS §9 / P19：圖鑑進度 = 已發現種類 / 全部種類（12） */
export function collectionProgress(entries: CollectionEntry[]): { overall: Progress; byZone: Progress[] } {
  const found = (list: CollectionEntry[]) => list.filter((e) => e.discovery !== null).length;
  return {
    overall: progress(found(entries), entries.length),
    byZone: ([0, 1, 2] as const).map((z) => {
      const list = entries.filter((e) => e.zone === z);
      return progress(found(list), list.length);
    }),
  };
}

export type StatusFilter = "all" | "discovered" | "undiscovered";
export interface CollectionFilter {
  status: StatusFilter;
  zone: 0 | 1 | 2 | "all";
  rarity: ArtifactRarity | "all";
}

export function filterEntries(entries: CollectionEntry[], f: CollectionFilter): CollectionEntry[] {
  return entries.filter(
    (e) =>
      (f.status === "all" || (f.status === "discovered") === (e.discovery !== null)) &&
      (f.zone === "all" || e.zone === f.zone) &&
      (f.rarity === "all" || e.rarity === f.rarity),
  );
}

export interface SetMember {
  id: ArtifactId;
  discovered: boolean;
  held: number;
}

export interface SetRow {
  id: SetId;
  name: string;
  members: SetMember[];
  /** 目前持有的成員種類數（每種至少 1 件才算） */
  heldMembers: number;
  total: number;
  /**
   * 1. 圖鑑已發現全部成員（每一件都曾經發現過）。
   * 注意：只代表「分別發現過」，不代表曾經同時持有、或曾經啟動過套組（目前沒有這種歷史紀錄）。
   */
  allDiscovered: boolean;
  /** 2. 目前持有足夠的寶物 */
  ownedNow: boolean;
  /** 3. 目前實際生效（引擎 activeSets，與伺服器結算相同的規則） */
  active: boolean;
  speedPct: number;
  luckPpm: number;
  /** 缺少的成員：已發現但未持有 / 尚未發現 */
  missing: { id: ArtifactId; discovered: boolean }[];
}

export function setRows(state: PlayerGameState): SetRow[] {
  const held = heldCounts(state);
  const active = new Set(activeSets(held));
  return SET_IDS.map((id) => {
    const def = SETS[id];
    const members = def.members.map((m) => ({ id: m, discovered: state.discoveredArtifacts[m] !== undefined, held: held[m] ?? 0 }));
    const heldMembers = members.filter((m) => m.held > 0).length;
    return {
      id,
      name: def.name,
      members,
      heldMembers,
      total: members.length,
      allDiscovered: members.every((m) => m.discovered),
      ownedNow: heldMembers === members.length,
      active: active.has(id),
      speedPct: def.speedPct,
      luckPpm: def.luckPpm,
      missing: members.filter((m) => m.held === 0).map((m) => ({ id: m.id, discovered: m.discovered })),
    };
  });
}

/** 套組加成的文字（數值取自 game-data） */
export function setBonusText(s: Pick<SetRow, "speedPct" | "luckPpm">): string {
  const parts: string[] = [];
  if (s.speedPct) parts.push(`Speed ×${(1 + s.speedPct / 100).toFixed(2)}`);
  if (s.luckPpm) parts.push(`Luck +${(s.luckPpm / 10_000).toFixed(0)}%`);
  return parts.join("、") || "—";
}
