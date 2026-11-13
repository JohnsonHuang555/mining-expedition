import { runDiagnostics, type CheckResult } from "@/lib/diagnostics";
import { diagnosticsEnabled } from "@/lib/diagnostics-flag";

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
  if (!diagnosticsEnabled()) {
    return (
      <main>
        <h1>挖礦探險隊</h1>
        <p>開發中。</p>
      </main>
    );
  }

  const report = await runDiagnostics();
  return (
    <main>
      <h1>挖礦探險隊 — 本地環境診斷</h1>
      <p>
        引擎 v{report.web.engine.engineVersion}・DATA_VERSION {report.web.engine.dataVersion}・RNG_VERSION{" "}
        {report.web.engine.rngVersion}・DEV_MARKER {report.web.devMarker}
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
      <p>檢查時間：{report.checkedAt}（只在 next dev 顯示；正式環境不提供此頁內容）</p>
    </main>
  );
}
