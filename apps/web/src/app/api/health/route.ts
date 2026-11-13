import { checkHealth } from "@/lib/health";

export const dynamic = "force-dynamic";

/** 正式環境健康檢查：只回傳 {"ok": boolean}（200 / 503） */
export async function GET() {
  const ok = await checkHealth();
  return Response.json({ ok }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
