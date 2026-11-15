"use client";

import { miningPosition } from "@mining/game-engine";
import { useEffect, useState } from "react";
import { CreateCharacter } from "@/components/game/CreateCharacter";
import { GameFrame, MineContent } from "@/components/game/Dashboard";
import { CollectionPage } from "@/components/game/CollectionPage";
import { InventoryPage } from "@/components/game/InventoryPage";
import { RevealOverlay } from "@/components/game/RevealOverlay";
import { WorkshopPage } from "@/components/game/WorkshopPage";
import { OfflineReportModal } from "@/components/game/OfflineReportModal";
import { RuntimeContext, useGame } from "@/components/game/runtime-context";
import { createGameApi } from "@/lib/game/api";
import { GameController } from "@/lib/game/controller";
import { MemoryBackend } from "@/lib/game/dev/memory-backend";
import type { GameRuntime } from "@/lib/game/runtime";
import { RevealQueue } from "@/lib/game/reveal";
import { createGameStore } from "@/lib/game/store";

const HOUR = 3_600_000;
const SCENES = ["new", "mining", "blocked_power", "blocked_unlock", "report", "economy", "collection", "reveal"] as const;
type Scene = (typeof SCENES)[number];

async function build(scene: Scene): Promise<GameRuntime> {
  const backend = new MemoryBackend(Date.now());
  const userId = crypto.randomUUID();
  const token = backend.addUser(userId);
  const api = createGameApi({ functionsUrl: "http://memory/functions/v1", anonKey: "anon", fetch: backend.fetch, getAccessToken: async () => token, refreshAccessToken: async () => null });
  // 記憶體後端的伺服器時間跟著本機時間走
  setInterval(() => (backend.now = Math.max(backend.now, Date.now())), 250);
  const store = createGameStore();
  const reveals = new RevealQueue();
  const controller = new GameController({ api, store, channel: null, reveals });
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
    if (scene === "collection")
      backend.mutate(userId, (x) => {
        const add = (artifactId: string, i: number, n = 1) => {
          for (let k = 0; k < n; k++) x.heldArtifacts.push({ instanceId: `d${100 + i * 10 + k}`, artifactId: artifactId as never, obtainedAt: x.createdAt, mode: "frontier", band: 3, frontierBlockIndex: 300 + i, digCounter: 100 + i * 10 + k, source: "drop" });
        };
        const found = (artifactId: string, total: number) => ((x.discoveredArtifacts as Record<string, unknown>)[artifactId] = { firstDiscoveredAt: x.createdAt - 86_400_000, firstBand: 3, totalFound: total });
        add("a_z1_lantern", 0, 2);
        add("a_z1_badge", 1);
        add("a_z1_map", 2);
        add("a_z2_orb", 3);
        ["a_z1_lantern", "a_z1_badge", "a_z1_map", "a_z2_orb", "a_z2_crown", "a_z1_heart"].forEach((a, i) => found(a, a === "a_z1_lantern" ? 3 : 1 + (i % 2)));
        x.mining.frontierBlockIndex = 1000;
        x.mining.digCounter = 1200;
        x.unlockedZone = 1;
        x.pickaxes = { pick_wood: 5, pick_stone: 5, pick_iron: 2 };
        x.equippedPickaxe = "pick_iron";
        x.firstTreasure = { status: "obtained", effectiveMiningMs: 0, resolvedAt: x.createdAt, artifactInstanceId: "d100", reportId: null };
      });
    if (scene === "economy")
      backend.mutate(userId, (x) => {
        x.coins = 1_860;
        x.inventory = { stone: 412, coal: 96, copper: 71, iron_ore: 64, silver: 7, gold: 1, amethyst: 9, iron_ingot: 3, reinforce_stone: 1 };
        x.pickaxes = { pick_wood: 3, pick_stone: 2 };
        x.equippedPickaxe = "pick_stone";
        x.mining.frontierBlockIndex = 620;
        x.mining.digCounter = 640;
      });
    await controller.retryBootstrap();
    if (scene === "reveal") {
      const order = new URLSearchParams(window.location.search).get("first") === "epic" ? ["a_z1_lantern", "a_z1_heart"] : ["a_z1_heart", "a_z1_lantern"];
      reveals.enqueue(
        order.map((artifactId, i) => ({
          key: `d${900 + i}`,
          digCounter: 900 + i,
          artifactId: artifactId as never,
          rarity: artifactId === "a_z1_heart" ? ("legendary" as const) : ("epic" as const),
          isNewDiscovery: true,
          protection: artifactId === "a_z1_lantern",
          origin: "offline" as const,
        })),
      );
      store.setState({ reveals: reveals.items() });
    }
  }
  return { userId, api, store, controller };
}

function Tab() {
  const tab = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("tab");
  if (tab === "inventory") return <InventoryPage />;
  if (tab === "workshop") return <WorkshopPage />;
  if (tab === "collection") return <CollectionPage />;
  return <MineContent />;
}

function Screens() {
  const phase = useGame((s) => s.phase);
  const view = useGame((s) => s.view);
  if (phase === "no_character") return <CreateCharacter onSignOut={() => {}} />;
  if (!view) return <p className="p-6">載入中…</p>;
  return (
    <>
      <GameFrame email="preview@example.com" onSignOut={() => {}}>
        <Tab />
      </GameFrame>
      <RevealOverlay />
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
