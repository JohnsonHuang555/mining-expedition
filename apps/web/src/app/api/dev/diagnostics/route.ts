import { runDiagnostics } from "@/lib/diagnostics";
import { diagnosticsEnabled } from "@/lib/diagnostics-flag";

export const dynamic = "force-dynamic";

/** 本地開發診斷。production 模式（含 Vercel Preview）一律 404 */
export async function GET() {
  if (!diagnosticsEnabled()) return new Response("Not Found", { status: 404 });
  const report = await runDiagnostics();
  return Response.json(report, { status: report.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
