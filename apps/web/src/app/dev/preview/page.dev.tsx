import { notFound } from "next/navigation";
import { diagnosticsEnabled } from "@/lib/diagnostics-flag";
import { Preview } from "./preview";

/** 只在 next dev 提供：以記憶體後端預覽各種畫面狀態（正式環境 404） */
export default function PreviewPage() {
  if (!diagnosticsEnabled()) notFound();
  return <Preview />;
}
