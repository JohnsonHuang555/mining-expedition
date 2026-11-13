#!/usr/bin/env bash
# 開發容器入口（以 root 啟動，處理權限後以 node 使用者執行指令）。
#
# 1. 讓 node 使用者的 UID / GID 對應到 repo 擁有者，避免在宿主上留下 root 擁有的檔案。
# 2. 若有掛載 Docker socket（只有 dev / functions 服務會掛），讓 node 使用者能存取：
#    - socket 屬於非 root 群組（Linux）：把 node 加入該群組。
#    - socket 屬於 root（Docker Desktop 常見）：以 socat 建一個只有 node 可用的代理 socket。
# 3. 以 node 使用者執行指令（gosu，不會留下 root shell）。
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  exec "$@"
fi

workdir="$(pwd)"
target_uid="$(stat -c %u "$workdir")"
target_gid="$(stat -c %g "$workdir")"

# 1. UID / GID 對應（repo 擁有者是 root 時不調整）
if [ "$target_uid" -ne 0 ] && [ "$target_uid" -ne "$(id -u node)" ]; then
  usermod -o -u "$target_uid" node
fi
if [ "$target_gid" -ne 0 ] && [ "$target_gid" -ne "$(id -g node)" ]; then
  groupmod -o -g "$target_gid" node
fi
chown node:node /pnpm-store /pnpm-home 2>/dev/null || true

# 2. Docker socket
socket=/var/run/docker.sock
if [ -S "$socket" ]; then
  sock_gid="$(stat -c %g "$socket")"
  if [ "$sock_gid" -ne 0 ]; then
    if ! getent group "$sock_gid" >/dev/null; then
      groupadd -g "$sock_gid" docker-host
    fi
    usermod -aG "$(getent group "$sock_gid" | cut -d: -f1)" node
  else
    proxy=/var/run/docker-node.sock
    rm -f "$proxy"
    socat "UNIX-LISTEN:${proxy},fork,mode=600,user=node" "UNIX-CONNECT:${socket}" &
    for _ in $(seq 1 50); do [ -S "$proxy" ] && break; sleep 0.1; done
    export DOCKER_HOST="unix://${proxy}"
  fi
fi

export HOME=/home/node
exec gosu node "$@"
