#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$PROJECT_ROOT/.runtime/api.pid"

if [[ ! -s "$PID_FILE" ]]; then
  echo "API 未运行（没有 PID 文件）"
  exit 0
fi

pid="$(tr -d '[:space:]' < "$PID_FILE")"
if [[ ! "$pid" =~ ^[0-9]+$ ]]; then
  rm -f "$PID_FILE"
  echo "已清理无效的 API PID 文件"
  exit 0
fi

if ! kill -0 "$pid" 2>/dev/null; then
  rm -f "$PID_FILE"
  echo "API 已停止"
  exit 0
fi

command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
case "$command" in
  *@pipeline-factory/api*|*apps/api*|*src/main.ts*) ;;
  *)
    rm -f "$PID_FILE"
    echo "API PID 文件指向了其他进程，未执行停止操作: $pid" >&2
    exit 1
    ;;
esac

stop_tree() {
  local parent="$1"
  local child
  for child in $(pgrep -P "$parent" 2>/dev/null || true); do
    stop_tree "$child"
  done
  kill "$parent" 2>/dev/null || true
}

stop_tree "$pid"
for _ in {1..50}; do
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "API 已停止"
    exit 0
  fi
  sleep 0.1
done

echo "API 未能在 5 秒内停止，请检查进程: $pid" >&2
exit 1
