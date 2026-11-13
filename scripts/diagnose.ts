/**
 * 收集本地 Docker / Supabase 的診斷資訊（在 dev 容器內執行）：
 *
 *   pnpm diagnose
 *
 * 只讀取狀態，不修改任何東西。輸出可以直接貼到 Issue / PR 回報。
 * 會遮蔽金鑰（JWT、sb_ 開頭的 key）。
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const projectId = /^project_id\s*=\s*"([^"]+)"/m.exec(readFileSync(resolve(root, "supabase/config.toml"), "utf8"))?.[1] ?? "?";

function redact(text: string): string {
  return text
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<jwt>")
    .replace(/sb_(publishable|secret)_[A-Za-z0-9_-]+/g, "sb_$1_<redacted>");
}

function run(title: string, cmd: string, args: string[]): void {
  console.log(`\n## ${title}\n$ ${cmd} ${args.join(" ")}`);
  try {
    const out = execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
    console.log(redact(out.trim()) || "（無輸出）");
  } catch (err: any) {
    console.log(`（失敗）${redact(String(err.stderr || err.message).trim())}`);
  }
}

async function probe(title: string, url: string): Promise<void> {
  console.log(`\n## ${title}\nGET ${url}`);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    console.log(`HTTP ${res.status}`);
  } catch (err) {
    console.log(`（連線失敗）${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log(`# Mining Expedition 環境診斷（project_id=${projectId}，${new Date().toISOString()}）`);
console.log(`PROJECT_ROOT=${process.env.PROJECT_ROOT ?? "?"}  cwd=${process.cwd()}  uid=${process.getuid?.()}  DOCKER_HOST=${process.env.DOCKER_HOST ?? "（預設）"}`);

run("工具版本", "sh", ["-c", "node --version; pnpm --version; supabase --version; docker version --format 'docker client {{.Client.Version}} / server {{.Server.Version}} ({{.Server.Os}}/{{.Server.Arch}})'"]);
run("Docker socket 權限", "sh", ["-c", "ls -l /var/run/docker.sock /var/run/docker-node.sock 2>&1; id"]);
run("Supabase 狀態", "supabase", ["status"]);
run("Supabase 容器", "docker", ["ps", "--filter", `name=supabase_`, "--format", "table {{.Names}}\t{{.Status}}\t{{.Ports}}"]);
run("Supabase 網路", "docker", ["network", "inspect", `supabase_network_${projectId}`, "--format", "{{range $k, $v := .Containers}}{{$v.Name}} {{end}}"]);
run("Edge Runtime 掛載（需要包含 packages/ 或整個 repo）", "docker", ["inspect", `supabase_edge_runtime_${projectId}`, "--format", "{{range .Mounts}}{{.Source}} -> {{.Destination}}\n{{end}}"]);
run("Edge Runtime 最近日誌", "docker", ["logs", "--tail", "40", `supabase_edge_runtime_${projectId}`]);
run("web 容器", "docker", ["compose", "ps", "web"]);
run("web 最近日誌", "docker", ["compose", "logs", "--tail", "40", "web"]);

await probe("宿主埠：Supabase API（dev 容器在 host network）", "http://127.0.0.1:54321/rest/v1/");
await probe("宿主埠：Web", `http://127.0.0.1:${process.env.WEB_PORT ?? "3000"}/api/health`);

console.log("\n完成。若要回報問題，請一併附上 `pnpm verify:env` 的輸出。");
