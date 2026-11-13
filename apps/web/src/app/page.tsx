import { runHealthChecks, type CheckResult } from "@/lib/health";

export const dynamic = "force-dynamic";

function Row({ name, result }: { name: string; result: CheckResult }) {
  return (
    <tr>
      <td>{name}</td>
      <td>{result.ok ? "✅" : "❌"}</td>
      <td>{result.status ?? "—"}</td>
      <td>{result.ms !== undefined ? `${result.ms} ms` : "—"}</td>
      <td>
        <code style={{ whiteSpace: "pre-wrap" }}>{result.error ?? JSON.stringify(result.detail)}</code>
      </td>
    </tr>
  );
}

export default async function Home() {
  const report = await runHealthChecks();
  return (
    <main>
      <h1>挖礦探險隊 — Phase 1 環境檢查</h1>
      <p>
        引擎 v{report.web.engine.engineVersion}・DATA_VERSION {report.web.engine.dataVersion}・RNG_VERSION{" "}
        {report.web.engine.rngVersion}
      </p>
      {!report.env.ok && <p>缺少環境變數：{report.env.missing?.join("、")}（執行 <code>pnpm env:sync</code>）</p>}
      <table cellPadding={6} style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th align="left">檢查</th>
            <th align="left">結果</th>
            <th align="left">HTTP</th>
            <th align="left">時間</th>
            <th align="left">內容</th>
          </tr>
        </thead>
        <tbody>
          <Row name="Web → Edge Function → Postgres" result={report.edgeFunction} />
          <Row name="Web → PostgREST → Postgres" result={report.postgrest} />
        </tbody>
      </table>
      <p>檢查時間：{report.checkedAt}</p>
    </main>
  );
}
