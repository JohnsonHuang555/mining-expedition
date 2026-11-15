import type { Metadata } from "next";
import { InventoryPage } from "@/components/game/InventoryPage";

export const metadata: Metadata = { title: "背包｜挖礦探險隊" };

export default function Page() {
  return <InventoryPage />;
}
