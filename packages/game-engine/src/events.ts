/**
 * 狀態轉換產生的事件（回傳給 Client 做動畫與提示；不影響狀態本身）。
 */

import type { ArtifactId, ItemId, MaterialId, MineralId, MiningMode, PickaxeId, SetId } from "@mining/game-data";
import type { Layer2Outcome, Layer4Outcome } from "./drop.ts";
import type { ZoneIndex } from "./mining.ts";
import type { ArtifactSource, Inventory, MiningStatus } from "./state.ts";

/** 一個完成的方塊（在線結算一定回傳；離線結算在 recordBlocks 時回傳） */
export interface BlockRecord {
  digCounter: number;
  completedAt: number;
  blockMs: number;
  mode: MiningMode;
  band: number;
  zone: ZoneIndex;
  /** 前線模式挖掉的 blockIndex；回訪 / 重挖為 null */
  frontierBlockIndex: number | null;
  /** 本次結算開始到這個方塊完成為止的挖掘毫秒（含先前未完成的部分） */
  minedMsInSettle: number;
  items: Partial<Record<MineralId, number>>;
  coins: number;
  layer2: Layer2Outcome;
  layer4: Layer4Outcome;
  /** 第四層掉落的寶物 */
  artifact: ArtifactId | null;
  /** 首次寶物保護發放的寶物（與 artifact 不會同時存在） */
  protection: ArtifactId | null;
  instanceId: string | null;
  isNewDiscovery: boolean;
}

export type GameEvent =
  | ({ type: "block_completed" } & BlockRecord)
  | { type: "mining_stopped"; status: Exclude<MiningStatus, "mining"> }
  | { type: "set_changed"; setId: SetId; active: boolean }
  | { type: "first_treasure_resolved"; status: "obtained" | "granted"; instanceId: string; artifactId: ArtifactId; source: ArtifactSource }
  | { type: "report_created"; reportId: string }
  | { type: "report_claimed"; reportId: string; coins: number; items: Inventory; artifactInstanceIds: string[] }
  | { type: "pickaxe_purchased"; pickaxeId: PickaxeId }
  | { type: "pickaxe_equipped"; pickaxeId: PickaxeId }
  | { type: "pickaxe_upgraded"; pickaxeId: PickaxeId; level: number }
  | { type: "crafted"; materialId: MaterialId; times: number }
  | { type: "items_sold"; itemId: ItemId; quantity: number; coins: number }
  | { type: "artifacts_sold"; instanceIds: string[]; coins: number }
  | { type: "zone_unlocked"; zone: ZoneIndex }
  | { type: "mining_mode_changed"; mode: MiningMode; revisitZone: ZoneIndex | null; reworkBand: number | null; reason: "player" | "rework_ended" | "rework_band_changed" };
