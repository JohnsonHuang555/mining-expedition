import type { Metadata } from "next";
import { MarketPage } from "@/components/game/MarketPage";

export const metadata: Metadata = { title: "市場｜挖礦探險隊" };

export default function Page() {
  return <MarketPage />;
}
