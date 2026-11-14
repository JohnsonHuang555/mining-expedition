import { ARTIFACTS, type ArtifactId, type ItemId, MATERIALS, MINERALS, PICKAXES, type PickaxeId, ZONES } from "@mining/game-data";
import type { MiningSpot, Stats } from "@mining/game-engine";

export const itemName = (id: ItemId): string => (id in MINERALS ? MINERALS[id as keyof typeof MINERALS].name : MATERIALS[id as keyof typeof MATERIALS]?.name ?? id);
export const itemRarity = (id: ItemId): "common" | "rare" => (id in MINERALS ? MINERALS[id as keyof typeof MINERALS].rarity : "common");
export const artifactName = (id: ArtifactId): string => ARTIFACTS[id]?.name ?? id;
export const artifactRarity = (id: ArtifactId) => ARTIFACTS[id]?.rarity ?? "epic";
export const pickaxeName = (id: PickaxeId): string => PICKAXES.find((p) => p.id === id)?.name ?? id;
export const zoneName = (zone: number): string => ZONES[zone]?.name ?? `礦區 ${zone + 1}`;

export const coins = (n: number): string => n.toLocaleString("zh-TW");
/** blockIndex → 公尺（每公尺 10 個方塊） */
export const meters = (blocks: number): string => `${(blocks / 10).toLocaleString("zh-TW", { maximumFractionDigits: 1 })} m`;
export const bandRange = (band: number): string => `${band * 10}–${band * 10 + 10} m`;

export function formatStats(s: Stats): { power: string; speed: string; luck: string } {
  return {
    power: (s.power10 / 10).toFixed(1),
    speed: `×${(s.speed1000 / 1000).toFixed(2)}`,
    luck: `${(s.luckPpm / 10_000).toFixed(1)}%`,
  };
}

export function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} 小時 ${m} 分`;
  if (m > 0) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}

export function spotLabel(spot: MiningSpot, frontierBlockIndex: number): string {
  const where = spot.mode === "frontier" ? `前線 ${meters(frontierBlockIndex)}` : spot.mode === "revisit" ? `回訪 ${bandRange(spot.band)}` : `重挖 ${bandRange(spot.band)}`;
  return `${zoneName(spot.zone)}・${where}`;
}

export const STATUS_LABEL = {
  mining: "挖掘中",
  blocked_power: "Power 不足",
  blocked_unlock: "礦區未解鎖",
  frontier_complete: "主線完成",
  paused: "暫停中（待領取報告）",
} as const;
