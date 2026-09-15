#!/bin/sh
# 启动 20059 服务（后台常驻）。
# 只负责「启动」，不处理旧进程——端口被占用时请先自行停止旧实例。
# 完整环境变量清单（缺一不可，漏 GS_WEB_STATIC_DIR 会导致 /admin/ 显示"Web UI 未配置"）：
#   BIND_IP / PORT / CONFIG_PATH / GS_ADMIN_PASSWORD / GS_APP_STATIC_DIR / GS_WEB_STATIC_DIR
#
# 用法：sh tools/start-20059.sh <管理后台密码>
set -e
ADMIN_PASS="${1:-$GS_ADMIN_PASSWORD}"
if [ -z "$ADMIN_PASS" ]; then
  echo "用法: sh tools/start-20059.sh <管理后台密码>" >&2
  exit 1
fi

ROOT=$(cd "$(dirname "$0")/.." && pwd)
LOG="$ROOT/logs/server-20059.log"
mkdir -p "$ROOT/logs"
cd "$ROOT/server"

BIND_IP=:: PORT=20059   CONFIG_PATH="$ROOT/server/config.json"   GS_ADMIN_PASSWORD="$ADMIN_PASS"   GS_APP_STATIC_DIR="$ROOT/ui/app"   GS_WEB_STATIC_DIR="$ROOT/ui/dist"   setsid node ./index.js >> "$LOG" 2>&1 < /dev/null &

sleep 4
echo "日志: $LOG"
curl -s -o /dev/null -w "GET  /            -> %{http_code}\n" http://localhost:20059/
curl -s -o /dev/null -w "GET  /admin/      -> %{http_code}\n" http://localhost:20059/admin/
curl -s -o /dev/null -w "POST /admin/login -> %{http_code}\n" -X POST http://localhost:20059/admin/login   -H 'Content-Type: application/json' -d "{\"password\":\"$ADMIN_PASS\"}"
