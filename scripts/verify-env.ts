/**
 * 本地環境驗收（在 dev 容器內執行，需要 `supabase start` 與 `docker compose up -d web`）：
 *
 *   pnpm verify:env
 *
 * 檢查項目：
 * 1. Edge Function（本地診斷模式）→ 共用引擎（packages/game-engine、packages/game-data）+ Postgres
 * 2. PostgREST → Postgres
 * 3. Web /api/dev/diagnostics：Web → Edge Function / PostgREST（真實 Supabase Local）
 * 4. Web /api/health：正式環境格式只回傳 {"ok": true}
 * 5. 埠只綁定 loopback：Supabase 與 web 容器發布的埠都是 127.0.0.1 / ::1（docker inspect）
 * 6. 非 loopback 介面連不到：對宿主（dev 容器在 host network）每個非 loopback IPv4 實際連線，必須失敗
 *
 * 任一項失敗時以非 0 結束。
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";

function loadEnvFile(path: string): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && m[1]) out[m[1]] = m[2] ?? "";
    }
    return out;
  } catch {
    return {};
  }
}

const fileEnv = loadEnvFile(resolve(import.meta.dirname, "../apps/web/.env.local"));
const env = (k: string) => process.env[k] ?? fileEnv[k] ?? "";

// dev 容器在 host network：直接用宿主上的埠
const webUrl = env("WEB_URL") || "http://127.0.0.1:3000";
const supabaseUrl = env("VERIFY_SUPABASE_URL") || env("NEXT_PUBLIC_SUPABASE_URL");
const anonKey = env("NEXT_PUBLIC_SUPABASE_ANON_KEY");

async function getJson(url: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // 非 JSON
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body)}`);
  return body;
}

const headers = { apikey: anonKey, Authorization: `Bearer ${anonKey}` };

const projectId =
  /^project_id\s*=\s*"([^"]+)"/m.exec(readFileSync(resolve(import.meta.dirname, "../supabase/config.toml"), "utf8"))?.[1] ?? "";

type Binding = { container: string; hostIp: string; hostPort: number };

/** Supabase（CLI 標籤）與 web（compose 標籤）容器發布到宿主的埠 */
function publishedBindings(): Binding[] {
  const docker = (args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 30_000 }).trim();
  const ids = [
    ...docker(["ps", "-q", "--filter", `label=com.supabase.cli.project=${projectId}`]).split("\n"),
    ...docker(["ps", "-q", "--filter", "label=com.docker.compose.project=mining-expedition", "--filter", "label=com.docker.compose.service=web"]).split("\n"),
  ].filter(Boolean);
  if (ids.length === 0) throw new Error("找不到 Supabase / web 容器");
  const containers: any[] = JSON.parse(docker(["inspect", ...ids]));
  return containers.flatMap((c) =>
    Object.values<any[] | null>(c.NetworkSettings?.Ports ?? {}).flatMap((list) =>
      (list ?? []).map((b) => ({ container: String(c.Name).replace(/^\//, ""), hostIp: b.HostIp, hostPort: Number(b.HostPort) })),
    ),
  );
}

function tcpReachable(host: string, port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host, port, timeout: 1500 });
    socket.once("connect", () => (socket.destroy(), done(true)));
    socket.once("timeout", () => (socket.destroy(), done(false)));
    socket.once("error", () => done(false));
  });
}

const LOOPBACK = new Set(["127.0.0.1", "::1"]);
const NETWORK_HINT =
  "Supabase 網路不是由 compose.yaml 建立（缺少 host_binding_ipv4 選項）。重建：`pnpm supabase:stop`、`docker compose rm -sf web`、" +
  "`docker network rm supabase_network_mining-expedition`，再依 README 重新啟動";

const checks: { name: string; run: () => Promise<string> }[] = [
  {
    name: "環境變數（apps/web/.env.local）",
    run: async () => {
      if (!supabaseUrl || !anonKey) throw new Error("缺少 Supabase URL 或 anon key，先執行 `pnpm env:sync`");
      return `supabase=${supabaseUrl}, web=${webUrl}`;
    },
  },
  {
    name: "Edge Function → packages/game-engine + Postgres（Edge Runtime）",
    run: async () => {
      const body = await getJson(`${supabaseUrl}/functions/v1/health`, { headers });
      if (!body.diagnostics) throw new Error(`沒有診斷資訊：${JSON.stringify(body)}（EDGE_DIAGNOSTICS 未生效？）`);
      if (!body.engine?.dataVersion) throw new Error("沒有 engine 資訊（packages/ 匯入失敗？）");
      if (!body.database?.ok) throw new Error(`資料庫失敗：${JSON.stringify(body.database)}`);
      return `engine v${body.engine.engineVersion}, DATA_VERSION ${body.engine.dataVersion}, marker=${body.engine.devMarker}, db ${body.database.ms} ms`;
    },
  },
  {
    name: "PostgREST → Postgres",
    run: async () => {
      const body = await getJson(`${supabaseUrl}/rest/v1/rpc/health_ping`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: "{}",
      });
      if (body.pong !== true) throw new Error(`非預期回應：${JSON.stringify(body)}`);
      return "pong";
    },
  },
  {
    name: "Web（next dev）→ Edge Function / PostgREST",
    run: async () => {
      const body = await getJson(`${webUrl}/api/dev/diagnostics`);
      if (!body.ok) throw new Error(JSON.stringify(body));
      return `edge ${body.edgeFunction.ms} ms, postgrest ${body.postgrest.ms} ms, via ${body.env.serverUrl}`;
    },
  },
  {
    name: "Web /api/health 只回傳 ok",
    run: async () => {
      const body = await getJson(`${webUrl}/api/health`);
      const keys = Object.keys(body);
      if (body.ok !== true || keys.length !== 1) throw new Error(`非預期回應：${JSON.stringify(body)}`);
      return JSON.stringify(body);
    },
  },
  {
    name: "埠只綁定 loopback（Supabase / web）",
    run: async () => {
      const bindings = publishedBindings();
      const exposed = bindings.filter((b) => !LOOPBACK.has(b.hostIp));
      if (exposed.length) {
        throw new Error(`${exposed.map((b) => `${b.container} ${b.hostIp || "0.0.0.0"}:${b.hostPort}`).join(", ")}。${NETWORK_HINT}`);
      }
      return [...new Set(bindings.map((b) => `${b.hostIp}:${b.hostPort}`))].sort().join(", ");
    },
  },
  {
    name: "非 loopback 介面連不到已發布的埠",
    run: async () => {
      // dev 容器在 host network：這裡的介面就是宿主（Docker Desktop 則是其 VM）的介面
      const addrs = Object.values(networkInterfaces())
        .flat()
        .filter((i) => i && i.family === "IPv4" && !i.internal)
        .map((i) => i!.address);
      if (addrs.length === 0) throw new Error("找不到非 loopback 的 IPv4 介面，無法驗證");
      const ports = [...new Set(publishedBindings().map((b) => b.hostPort))].sort((a, b) => a - b);
      const reachable: string[] = [];
      for (const host of addrs) for (const port of ports) if (await tcpReachable(host, port)) reachable.push(`${host}:${port}`);
      if (reachable.length) throw new Error(`可從非 loopback 位址連線：${reachable.join(", ")}。${NETWORK_HINT}`);
      return `${addrs.join(", ")} × 埠 ${ports.join(", ")} 全部拒絕連線`;
    },
  },
];

{
  let failed = 0;
  for (const c of checks) {
    try {
      console.log(`✅ ${c.name}：${await c.run()}`);
    } catch (err) {
      failed++;
      console.log(`❌ ${c.name}：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failed) console.log("\n診斷：執行 `pnpm diagnose` 收集 Docker / Supabase 狀態。");
  process.exit(failed ? 1 : 0);
}
