/**
 * `pnpm supabase:start` 的前置檢查（在 dev 容器內執行）。
 *
 * Supabase CLI 發布埠時不指定 IP；若由 CLI 自己建立網路，埠會綁定 0.0.0.0（區網可連）。
 * 因此網路必須事先由 compose 建立（compose.yaml 的 networks.supabase，含 host_binding_ipv4=127.0.0.1），
 * CLI 才會沿用它。這裡確認網路存在且選項正確，否則拒絕啟動。
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const projectId =
  /^project_id\s*=\s*"([^"]+)"/m.exec(readFileSync(resolve(import.meta.dirname, "../supabase/config.toml"), "utf8"))?.[1] ?? "";
const network = `supabase_network_${projectId}`;

let bind: string;
try {
  bind = execFileSync(
    "docker",
    ["network", "inspect", network, "--format", '{{index .Options "com.docker.network.bridge.host_binding_ipv4"}}'],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
} catch {
  console.error(
    `❌ 找不到 Docker 網路 ${network}。\n` +
      "   先在宿主執行 `docker compose up --no-start web` 建立網路（只綁定 127.0.0.1），再執行 supabase:start。\n" +
      "   不要讓 Supabase CLI 自己建立網路：那樣發布的埠會綁定 0.0.0.0，區網可連。",
  );
  process.exit(1);
}

if (bind !== "127.0.0.1") {
  console.error(
    `❌ Docker 網路 ${network} 沒有設定 host_binding_ipv4=127.0.0.1（目前：${bind || "未設定"}），Supabase 的埠會對區網開放。\n` +
      "   重建網路：見 README「從舊版設定升級」。",
  );
  process.exit(1);
}

console.log(`✅ ${network}：發布的埠只綁定 127.0.0.1`);
