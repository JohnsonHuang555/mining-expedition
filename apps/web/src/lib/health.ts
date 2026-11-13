import { readSupabaseEnv } from "./env";

/**
 * 正式環境可用的健康檢查：以 anon key 經 PostgREST 呼叫 health_ping。
 *
 * 只回傳是否正常，不回傳版本、錯誤訊息、延遲或內部位址；失敗原因只寫到伺服器日誌。
 */

const TIMEOUT_MS = 5000;

export async function checkHealth(): Promise<boolean> {
  const env = readSupabaseEnv();
  if ("missing" in env) {
    console.error("health: missing environment variables", env.missing);
    return false;
  }
  try {
    const res = await fetch(`${env.serverUrl}/rest/v1/rpc/health_ping`, {
      method: "POST",
      headers: { apikey: env.anonKey, Authorization: `Bearer ${env.anonKey}`, "Content-Type": "application/json" },
      body: "{}",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error("health: health_ping returned", res.status);
      return false;
    }
    const body = (await res.json()) as { pong?: boolean };
    return body.pong === true;
  } catch (err) {
    console.error("health: health_ping failed", err);
    return false;
  }
}
