/** SQL 的 ID 清單（check 約束）必須與 @mining/game-data 一致（GBS §24：ID 只能新增，新增 ID 需要新的 migration） */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { ARTIFACT_IDS, MATERIAL_IDS, MINERAL_IDS, PICKAXE_IDS } from "@mining/game-data";
import { describe, expect, it } from "vitest";

const dir = resolve(import.meta.dirname, "../../../supabase/migrations");
const sql = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(resolve(dir, f), "utf8")).join("\n");

function lists(column: string): string[][] {
  const re = new RegExp(`${column}\\s+in\\s*\\(([^)]*)\\)`, "g");
  return [...sql.matchAll(re)].map((m) => [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!));
}

describe("migration 的 ID 清單與 game-data 一致", () => {
  it("物品", () => {
    for (const l of lists("item_id")) expect(l).toEqual([...MINERAL_IDS, ...MATERIAL_IDS]);
  });
  it("寶物", () => {
    const ls = lists("artifact_id");
    expect(ls.length).toBe(3); // artifact_instances、artifact_discoveries、market_prices
    for (const l of ls) expect(l).toEqual([...ARTIFACT_IDS]);
  });
  it("十字鎬", () => {
    for (const l of lists("pickaxe_id")) expect(l).toEqual([...PICKAXE_IDS]);
  });
});
