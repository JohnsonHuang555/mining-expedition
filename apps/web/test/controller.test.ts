import { miningPosition, predictBlockProgress } from "@mining/game-engine";
import { describe, expect, it } from "vitest";
import { BLOCK_SYNC_MIN_MS, HEARTBEAT_MS } from "@/lib/game/controller";
import { MemoryBackend } from "@/lib/game/dev/memory-backend";
import { flush, rig, sharedChannel } from "./helpers";

const HOUR = 3_600_000;

async function readyRig(setup?: (b: MemoryBackend, id: string) => void) {
  const r = rig();
  await r.controller.createCharacter(); // 建立角色 → bootstrap（game-state + settle）
  if (setup) {
    setup(r.backend, r.userId);
    await r.controller.retryBootstrap();
  }
  return r;
}

const actions = (r: ReturnType<typeof rig>, fn = "game-action") => r.backend.requests.filter((x) => x.fn === fn);

describe("登入後流程", () => {
  it("沒有角色 → no_character；建立角色 → 讀取狀態並立即結算 → ready", async () => {
    const r = rig();
    r.controller.start();
    await flush();
    expect(r.store.getState().phase).toBe("no_character");
    expect(await r.controller.createCharacter()).toBe(true);
    const s = r.store.getState();
    expect(s.phase).toBe("ready");
    expect(s.view!.state).toMatchObject({ coins: 0, pickaxes: { pick_wood: 1 }, equippedPickaxe: "pick_wood", unlockedZone: 0 });
    expect(s.view!.status).toBe("mining");
    expect(s.fresh).toBe(true);
    expect(r.backend.requests.map((x) => x.fn)).toEqual(["game-state", "character-create", "game-state", "game-action"]);
  });

  it("已有角色（其他分頁先建立）：建立回 409 也直接進入遊戲", async () => {
    const backend = new MemoryBackend();
    const id = crypto.randomUUID();
    const a = rig({ backend, userId: id });
    await a.controller.createCharacter();
    const b = rig({ backend, userId: id });
    expect(await b.controller.createCharacter()).toBe(true);
    expect(b.store.getState().phase).toBe("ready");
  });

  it("React Strict Mode：start / stop / start 只會 bootstrap 一次、只有一個計時器", async () => {
    const r = rig();
    await r.controller.createCharacter();
    const fresh = rig({ backend: r.backend, userId: r.userId });
    fresh.controller.start();
    fresh.controller.stop();
    fresh.controller.start();
    await flush();
    expect(fresh.backend.requests.filter((x) => x.fn === "game-state")).toHaveLength(2); // 第一個 rig 一次 + 這裡一次
    expect(fresh.clock.pending).toHaveLength(1);
  });

  it("登入失效（token 更新失敗）→ signed_out，並通知導向登入頁", async () => {
    const r = await readyRig();
    r.backend.tokens.clear();
    await r.controller.sync();
    expect(r.store.getState().phase).toBe("signed_out");
    expect(r.store.getState().view).toBeNull();
    expect(r.signedOut).toBe(1);
    expect(r.refreshes).toBe(1);
  });

  it("token 過期但可以更新：自動更新後繼續，不需要重新登入", async () => {
    let n = 0;
    const r = rig({ refresh: () => `fresh-${++n}` });
    await r.controller.createCharacter();
    r.backend.tokens.clear();
    r.backend.addUser(r.userId, "fresh-1");
    await r.controller.sync();
    expect(r.store.getState().phase).toBe("ready");
    expect(r.signedOut).toBe(0);
  });
});

describe("在線挖掘", () => {
  it("同步成功後以伺服器狀態更新畫面；預估進度不會產生任何資源", async () => {
    const r = await readyRig();
    r.controller.start();
    const before = r.store.getState().view!.state;
    r.clock.t += 60_000; // 本機經過 60 秒，但還沒同步
    const p = predictBlockProgress(before, r.clock.now() - r.store.getState().receivedAt);
    expect(p.blocksCompleted).toBeGreaterThan(0);
    expect(r.store.getState().view!.state).toEqual(before); // 預估不改變任何狀態
    expect(r.store.getState().recentLoot).toHaveLength(0);
    r.backend.advance(60_000);
    await r.controller.sync();
    const after = r.store.getState().view!.state;
    expect(after.mining.digCounter - before.mining.digCounter).toBe(p.blocksCompleted);
    expect(r.store.getState().recentLoot.length).toBe(Math.min(12, p.blocksCompleted));
    expect(r.store.getState().lastSettlement?.summary).toMatchObject({ kind: "online", blocksMined: p.blocksCompleted });
  });

  it("排程：預估方塊完成後同步（至少間隔 BLOCK_SYNC_MIN_MS），最長 HEARTBEAT_MS；同時只有一個計時器", async () => {
    const r = await readyRig();
    r.controller.start();
    await flush();
    const [delay] = r.clock.pending;
    expect(r.clock.pending).toHaveLength(1);
    expect(delay).toBeGreaterThanOrEqual(BLOCK_SYNC_MIN_MS);
    expect(delay).toBeLessThanOrEqual(HEARTBEAT_MS);
    const n = actions(r).length;
    r.backend.advance(delay!);
    await r.clock.tick(delay!);
    expect(actions(r).length).toBe(n + 1);
    expect(r.clock.pending).toHaveLength(1);
    // 長時間執行：請求數有上限（不會無限重複發送）
    for (let i = 0; i < 30; i++) {
      r.backend.advance(HEARTBEAT_MS);
      await r.clock.tick(HEARTBEAT_MS);
    }
    const sent = actions(r).length - n - 1;
    expect(sent).toBeGreaterThanOrEqual(30);
    expect(sent).toBeLessThanOrEqual(Math.ceil((30 * HEARTBEAT_MS) / BLOCK_SYNC_MIN_MS) + 1);
  });

  it("同時觸發多次同步：合併成一個請求", async () => {
    const r = await readyRig();
    const n = actions(r).length;
    await Promise.all([r.controller.sync(), r.controller.sync(), r.controller.sync()]);
    expect(actions(r).length).toBe(n + 1);
  });

  it("同時只允許一個會改變狀態的操作：進行中的操作期間，其他操作不送出", async () => {
    const r = await readyRig();
    r.backend.latencyMs = 5;
    const n = actions(r).length;
    const a = r.controller.selectMode("rework");
    const b = r.controller.selectMode("frontier");
    expect(await b).toBe(false);
    await a;
    expect(actions(r).length).toBe(n + 1);
  });

  it("Power 不足時顯示卡關；礦區未解鎖時顯示解鎖狀態", async () => {
    let f = 0;
    const r = await readyRig();
    const s = r.backend.state(r.userId)!;
    while (miningPosition({ ...s, mining: { ...s.mining, frontierBlockIndex: f, digCounter: f } }).status === "mining") f += 10;
    const blocked = await readyRig((b, id) => b.mutate(id, (x) => void ((x.mining.frontierBlockIndex = f), (x.mining.digCounter = f))));
    expect(blocked.store.getState().view!.status).toBe("blocked_power");
    const locked = await readyRig((b, id) =>
      b.mutate(id, (x) => {
        x.pickaxes = { pick_wood: 1, pick_stone: 1, pick_iron: 1, pick_gold: 1, pick_diamond: 5 };
        x.equippedPickaxe = "pick_diamond";
        x.mining.frontierBlockIndex = 1000;
        x.mining.digCounter = 1000;
      }),
    );
    expect(locked.store.getState().view!.status).toBe("blocked_unlock");
  });

  it("重複的回應不會重複顯示獎勵（Recent Loot 以方塊序號去重）", async () => {
    const r = await readyRig();
    r.backend.advance(120_000);
    r.backend.faults.push("drop_response"); // 伺服器已提交，回應遺失 → Client 以同一個 key 重送，拿到相同的回應
    await r.controller.sync();
    const loot = r.store.getState().recentLoot;
    expect(new Set(loot.map((l) => l.key)).size).toBe(loot.length);
    const view = r.store.getState().view!.state;
    expect(view).toEqual(r.backend.state(r.userId));
  });
});

describe("網路", () => {
  it("API 失敗（重試用完）→ 顯示連線中斷並退避；網路恢復後同步成功", async () => {
    const r = await readyRig();
    r.controller.start();
    await flush();
    r.backend.faults.push("network", "network", "network", "network");
    await r.controller.sync();
    const s = r.store.getState();
    expect(s.sync).toMatchObject({ ok: false, failures: 1, message: "連線中斷，正在重試…" });
    expect(r.clock.pending).toEqual([5_000]);
    r.backend.advance(5_000);
    await r.clock.tick(5_000);
    expect(r.store.getState().sync).toMatchObject({ ok: true, failures: 0 });
  });

  it("第一次載入就斷線 → 錯誤畫面並自動重試；恢復後進入遊戲", async () => {
    const backend = new MemoryBackend();
    const id = crypto.randomUUID();
    await rig({ backend, userId: id }).controller.createCharacter();
    const r = rig({ backend, userId: id });
    backend.faults.push("network", "network", "network", "network");
    r.controller.start();
    await flush();
    expect(r.store.getState().phase).toBe("error");
    expect(r.clock.pending).toEqual([5_000]);
    await r.clock.tick(5_000);
    expect(r.store.getState().phase).toBe("ready");
  });

  it("多分頁：一個分頁提交後，另一個分頁重新讀取伺服器狀態", async () => {
    const channel = sharedChannel();
    const backend = new MemoryBackend();
    const id = crypto.randomUUID();
    const a = rig({ backend, userId: id, channel: channel() });
    const b = rig({ backend, userId: id, channel: channel() });
    await a.controller.createCharacter();
    a.controller.start();
    b.controller.start();
    await flush();
    const vB = b.store.getState().view!.state.stateVersion;
    backend.advance(30_000);
    await a.controller.selectMode("frontier").then(() => a.controller.sync());
    await flush();
    expect(b.store.getState().view!.state.stateVersion).toBeGreaterThan(vB);
    expect(b.store.getState().view!.state).toEqual(backend.state(id));
    expect(b.store.getState().fresh).toBe(false); // 唯讀狀態：等下一次結算才預估
  });
});

describe("離線報告（D20 / D23 / D24）", () => {
  it("登入後有待領報告：顯示報告、暫停自動同步、阻擋其他操作；領取後更新", async () => {
    const r = await readyRig((b, id) => b.rewind(id, 3 * HOUR));
    r.controller.start();
    await flush();
    const s = r.store.getState();
    const report = s.view!.state.pendingOfflineReport!;
    expect(report.blocksMined).toBeGreaterThan(0);
    expect(r.clock.pending).toHaveLength(0); // D24：暫停，不排程同步
    const n = actions(r).length;
    expect(await r.controller.selectMode("rework")).toBe(false);
    expect(actions(r).length).toBe(n);
    expect(r.store.getState().notice).toBe("請先領取探險報告");
    expect(await r.controller.claimReport()).toBe(true);
    const after = r.store.getState().view!.state;
    expect(after.pendingOfflineReport).toBeNull();
    expect(after.coins).toBe(report.rewards.coins);
    expect(r.clock.pending).toHaveLength(1); // 恢復同步
  });

  it("重複領取（另一個分頁先領）：REPORT_ALREADY_CLAIMED → 重新取得最新狀態", async () => {
    const backend = new MemoryBackend();
    const id = crypto.randomUUID();
    const a = rig({ backend, userId: id });
    await a.controller.createCharacter();
    backend.rewind(id, 2 * HOUR);
    await a.controller.retryBootstrap();
    const b = rig({ backend, userId: id });
    b.controller.start();
    await flush();
    expect(await b.controller.claimReport()).toBe(true);
    expect(await a.controller.claimReport()).toBe(false);
    expect(a.store.getState().notice).toContain("已經領取過了");
    expect(a.store.getState().view!.state.pendingOfflineReport).toBeNull();
    expect(a.store.getState().view!.state.coins).toBe(backend.state(id)!.coins);
  });

  it("領取失敗後重試：沿用同一個 Idempotency-Key，只入帳一次", async () => {
    const r = await readyRig((b, id) => b.rewind(id, 2 * HOUR));
    const reward = r.store.getState().view!.state.pendingOfflineReport!.rewards.coins;
    r.backend.faults.push("drop_response", "network", "network", "network");
    expect(await r.controller.claimReport()).toBe(false); // 已提交但 4 次都沒拿到回應
    expect(r.store.getState().view!.state.pendingOfflineReport).not.toBeNull();
    expect(await r.controller.claimReport()).toBe(true); // 玩家按「重試」
    const keys = actions(r).filter((x) => (x.body as { command: { type: string } }).command.type === "claim_report").map((x) => x.key);
    expect(new Set(keys).size).toBe(1);
    expect(r.backend.state(r.userId)!.coins).toBe(reward);
    expect(r.store.getState().view!.state.coins).toBe(reward);
  });

  it("D23：卡關期間離線（沒有完成方塊）→ 沒有報告，直接進入遊戲", async () => {
    let f = 0;
    const r0 = await readyRig();
    const s = r0.backend.state(r0.userId)!;
    while (miningPosition({ ...s, mining: { ...s.mining, frontierBlockIndex: f, digCounter: f } }).status === "mining") f += 10;
    const r = await readyRig((b, id) => {
      b.mutate(id, (x) => void ((x.mining.frontierBlockIndex = f), (x.mining.digCounter = f)));
      b.rewind(id, 6 * HOUR);
    });
    const st = r.store.getState();
    expect(st.view!.state.pendingOfflineReport).toBeNull();
    expect(st.lastSettlement?.summary).toMatchObject({ kind: "offline", blocksMined: 0 });
    expect(st.view!.status).toBe("blocked_power");
  });

  it("D24：等待領取期間不累積；領取後以伺服器時間重新開始", async () => {
    const r = await readyRig((b, id) => b.rewind(id, 2 * HOUR));
    const pending = r.backend.state(r.userId)!;
    r.backend.advance(10 * 60_000); // 玩家看著報告 10 分鐘才領
    await r.controller.claimReport();
    const s = r.backend.state(r.userId)!;
    expect(s.lastSettledAt).toBe(r.backend.now);
    expect(s.mining).toEqual(pending.mining); // 等待的 10 分鐘沒有挖掘
    expect(r.store.getState().view!.state).toEqual(s);
  });
});
