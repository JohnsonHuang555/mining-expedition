import { runHealthChecks } from "@/lib/health";

export const dynamic = "force-dynamic";

export async function GET() {
  const report = await runHealthChecks();
  return Response.json(report, { status: report.ok ? 200 : 503 });
}
