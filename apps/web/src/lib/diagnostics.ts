import { DEV_MARKER, engineInfo, type EngineInfo } from "@mining/game-engine";
import { readSupabaseEnv } from "./env";

/**
 * 本地開發診斷（只在 diagnosticsEnabled() 時使用）：
 * Web → Edge Function → Postgres，以及 Web → PostgREST → Postgres，附上延遲與錯誤細節。
 */

export interface CheckResult {
  ok: boolean;
  status?: number;
  ms?: number;
  detail?: unknown;
  error?: string;
}

export interface DiagnosticsReport {
  ok: boolean;
  checkedAt: string;
  web: { engine: EngineInfo; devMarker: string };
  env: { ok: boolean; missing?: string[]; serverUrl?: string };
  edgeFunction: CheckResult;
  postgrest: CheckResult;
}

const TIMEOUT_MS = 5000;

async function timedFetch(url: string, init: RequestInit): Promise<CheckResult> {
  const started = Date.now();
  try {
    const res = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    let detail: unknown = text;
    try {
      detail = JSON.parse(text);
    } catch {
      // 保留原始文字
    }
    return { ok: res.ok, status: res.status, ms: Date.now() - started, detail };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function runDiagnostics(): Promise<DiagnosticsReport> {
  const env = readSupabaseEnv();
  const web = { engine: engineInfo(), devMarker: DEV_MARKER };
  const checkedAt = new Date().toISOString();

  if ("missing" in env) {
    const skipped: CheckResult = { ok: false, error: "environment variables missing" };
    return { ok: false, checkedAt, web, env: { ok: false, missing: env.missing }, edgeFunction: skipped, postgrest: skipped };
  }

  const headers = { apikey: env.anonKey, Authorization: `Bearer ${env.anonKey}` };
  const [edgeFunction, postgrest] = await Promise.all([
    timedFetch(`${env.serverUrl}/functions/v1/health`, { method: "GET", headers }),
    timedFetch(`${env.serverUrl}/rest/v1/rpc/health_ping`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: "{}",
    }),
  ]);

  return {
    ok: edgeFunction.ok && postgrest.ok,
    checkedAt,
    web,
    env: { ok: true, serverUrl: env.serverUrl },
    edgeFunction,
    postgrest,
  };
}
