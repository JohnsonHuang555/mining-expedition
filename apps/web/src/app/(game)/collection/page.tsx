import type { Metadata } from "next";
import { CollectionPage } from "@/components/game/CollectionPage";

export const metadata: Metadata = { title: "圖鑑｜挖礦探險隊" };

export default function Page() {
  return <CollectionPage />;
}
