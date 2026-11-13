import { engineInfo, type EngineInfo } from "@mining/game-engine";
import { readSupabaseEnv } from "./env";

/**
 * Phase 1 連線檢查：Web → Edge Function → Postgres，以及 Web → PostgREST → Postgres。
 * 不含任何遊戲邏輯。
 */

export interface CheckResult {
  ok: boolean;
  status?: number;
  ms?: number;
  detail?: unknown;
  error?: string;
}

export interface HealthReport {
  ok: boolean;
  checkedAt: string;
  web: { ok: true; engine: EngineInfo };
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

export async function runHealthChecks(): Promise<HealthReport> {
  const env = readSupabaseEnv();
  const web = { ok: true as const, engine: engineInfo() };
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
