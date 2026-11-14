import { ONLINE_GAP_MS } from "@mining/game-data";
import { describe, expect, it } from "vitest";
import { blockWork, miningPosition, predictBlockProgress, settle, type PlayerGameState } from "../src/index.ts";
import { T0, deepFreeze, makeState, rng } from "./support/fixtures.ts";

function settled(s: PlayerGameState, elapsed: number): PlayerGameState {
  const r = settle(s, { serverNow: T0 + elapsed, rng });
  if (!r.ok) throw new Error(r.error.code);
  return r.state;
}

describe("predictBlockProgress（Client 進度預測，不使用亂數）", () => {
  const setups = [
    { name: "木製 Lv1、0m", state: () => makeState() },
    { name: "石製 Lv3、12m", state: () => makeState({ tier: 1, level: 3, frontier: 120 }) },
    { name: "鑽石 Lv5、挖到未解鎖的礦區底部", state: () => makeState({ tier: 4, level: 5, frontier: 995 }) },
    {
      name: "回訪 zone1",
      state: () => {
        const s = makeState({ tier: 2, level: 2, frontier: 1100, unlockedZone: 1 });
        s.mining.mode = "revisit";
        s.mining.revisitZone = 0;
        return s;
      },
    },
  ];
  for (const { name, state } of setups) {
    it(`${name}：預測的完成方塊數與方塊進度，與伺服器在線結算完全一致`, () => {
      const base = deepFreeze(state());
      for (const elapsed of [0, 1, 4_999, 61_234, 180_000, 299_999, ONLINE_GAP_MS]) {
        const p = predictBlockProgress(base, elapsed);
        const s = settled(base, elapsed);
        expect(p.blocksCompleted, `${elapsed}ms blocks`).toBe(s.mining.digCounter - base.mining.digCounter);
        const pos = miningPosition(s);
        expect(p.status).toBe(pos.status);
        if (pos.spot) {
          expect(p.spot).toEqual(pos.spot);
          expect(p.progress).toBeCloseTo(s.mining.blockWork / blockWork(pos.spot.hardness), 9);
          expect(p.msToNextBlock).toBeGreaterThan(0);
        }
        expect(p.beyondOnlineWindow).toBe(false);
      }
    });
  }

  it("超過在線門檻（300 秒）後不再預測：結果等於 300 秒時，並標示 beyondOnlineWindow", () => {
    const base = makeState({ tier: 1, level: 3, frontier: 120 });
    const at = predictBlockProgress(base, ONLINE_GAP_MS);
    const later = predictBlockProgress(base, 6 * 3_600_000);
    expect({ ...later, beyondOnlineWindow: false }).toEqual(at);
    expect(later.beyondOnlineWindow).toBe(true);
  });

  it("有待領取報告時：paused，不預測任何進度（D24）", () => {
    const base = makeState();
    const r = settle(base, { serverNow: T0 + 2 * 3_600_000, rng });
    if (!r.ok) throw new Error("settle");
    expect(r.state.pendingOfflineReport).not.toBeNull();
    const p = predictBlockProgress(r.state, 120_000);
    expect(p).toMatchObject({ status: "paused", blocksCompleted: 0, msToNextBlock: null });
  });

  it("Power 不足、礦區未解鎖、主線完成：不預測進度", () => {
    let f = 0;
    while (miningPosition(makeState({ frontier: f })).status === "mining") f += 10;
    expect(predictBlockProgress(makeState({ frontier: f }), 60_000)).toMatchObject({ status: "blocked_power", blocksCompleted: 0, progress: 0 });
    expect(predictBlockProgress(makeState({ tier: 4, level: 5, frontier: 1000, unlockedZone: 0 }), 60_000)).toMatchObject({ status: "blocked_unlock", blocksCompleted: 0 });
    expect(predictBlockProgress(makeState({ tier: 4, level: 5, frontier: 3000, unlockedZone: 2 }), 60_000)).toMatchObject({ status: "frontier_complete" });
  });

  it("挖到卡關位置時停止：方塊數只算到卡關前", () => {
    let f = 0;
    while (miningPosition(makeState({ frontier: f })).status === "mining") f++;
    const base = makeState({ frontier: f - 1 });
    const p = predictBlockProgress(base, ONLINE_GAP_MS);
    const s = settled(base, ONLINE_GAP_MS);
    expect(p.status).toBe("blocked_power");
    expect(p.blocksCompleted).toBe(1);
    expect(s.mining.frontierBlockIndex).toBe(f);
  });

  it("非有限或負的經過時間視為 0；不修改傳入的狀態", () => {
    const base = deepFreeze(makeState());
    const zero = predictBlockProgress(base, 0);
    expect(predictBlockProgress(base, -5)).toEqual(zero);
    expect(predictBlockProgress(base, Number.NaN)).toEqual(zero);
  });
});
