"use client";

import { miningPosition } from "@mining/game-engine";
import { useEffect, useState } from "react";
import { CreateCharacter } from "@/components/game/CreateCharacter";
import { Dashboard } from "@/components/game/Dashboard";
import { OfflineReportModal } from "@/components/game/OfflineReportModal";
import { RuntimeContext, useGame } from "@/components/game/runtime-context";
import { createGameApi } from "@/lib/game/api";
import { GameController } from "@/lib/game/controller";
import { MemoryBackend } from "@/lib/game/dev/memory-backend";
import type { GameRuntime } from "@/lib/game/runtime";
import { createGameStore } from "@/lib/game/store";

const HOUR = 3_600_000;
const SCENES = ["new", "mining", "blocked_power", "blocked_unlock", "report"] as const;
type Scene = (typeof SCENES)[number];

async function build(scene: Scene): Promise<GameRuntime> {
  const backend = new MemoryBackend(Date.now());
  const userId = crypto.randomUUID();
  const token = backend.addUser(userId);
  const api = createGameApi({ functionsUrl: "http://memory/functions/v1", anonKey: "anon", fetch: backend.fetch, getAccessToken: async () => token, refreshAccessToken: async () => null });
  // 記憶體後端的伺服器時間跟著本機時間走
  setInterval(() => (backend.now = Math.max(backend.now, Date.now())), 250);
  const store = createGameStore();
  const controller = new GameController({ api, store, channel: null });
  if (scene !== "new") {
    await controller.createCharacter();
    if (scene === "mining") backend.rewind(userId, 240_000);
    if (scene === "blocked_power") {
      const s = backend.state(userId)!;
      let f = 0;
      while (miningPosition({ ...s, mining: { ...s.mining, frontierBlockIndex: f, digCounter: f } }).status === "mining") f += 10;
      backend.mutate(userId, (x) => {
        x.mining.frontierBlockIndex = f;
        x.mining.digCounter = f;
        x.coins = 1_234;
        x.inventory = { stone: 320, coal: 41, copper: 22, iron_ore: 18, silver: 2 };
      });
    }
    if (scene === "blocked_unlock")
      backend.mutate(userId, (x) => {
        x.pickaxes = { pick_wood: 5, pick_stone: 5, pick_iron: 5, pick_gold: 3, pick_diamond: 1 };
        x.equippedPickaxe = "pick_diamond";
        x.mining.frontierBlockIndex = 1000;
        x.mining.digCounter = 1000;
        x.coins = 7_420;
      });
    if (scene === "report") backend.rewind(userId, 5 * HOUR + 17 * 60_000);
    await controller.retryBootstrap();
  }
  return { userId, api, store, controller };
}

function Screens() {
  const phase = useGame((s) => s.phase);
  const view = useGame((s) => s.view);
  if (phase === "no_character") return <CreateCharacter onSignOut={() => {}} />;
  if (!view) return <p className="p-6">載入中…</p>;
  return (
    <>
      <Dashboard email="preview@example.com" onSignOut={() => {}} />
      {view.state.pendingOfflineReport && <OfflineReportModal report={view.state.pendingOfflineReport} />}
    </>
  );
}

export function Preview() {
  const [runtime, setRuntime] = useState<GameRuntime | null>(null);
  useEffect(() => {
    const scene = (new URLSearchParams(window.location.search).get("scene") ?? "mining") as Scene;
    let cancelled = false;
    let rt: GameRuntime | null = null;
    void build(SCENES.includes(scene) ? scene : "mining").then((r) => {
      if (cancelled) return r.controller.dispose();
      rt = r;
      r.controller.start();
      setRuntime(r);
    });
    return () => {
      cancelled = true;
      rt?.controller.dispose();
    };
  }, []);
  if (!runtime) return <p className="p-6">建立預覽…</p>;
  return (
    <RuntimeContext.Provider value={runtime}>
      <Screens />
    </RuntimeContext.Provider>
  );
}
