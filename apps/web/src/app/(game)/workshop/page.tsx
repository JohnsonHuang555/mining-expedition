import type { Metadata } from "next";
import { WorkshopPage } from "@/components/game/WorkshopPage";

export const metadata: Metadata = { title: "工坊｜挖礦探險隊" };

export default function Page() {
  return <WorkshopPage />;
}
