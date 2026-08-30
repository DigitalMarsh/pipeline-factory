#!/usr/bin/env bash

# 停止 Web 前先校验 PID 对应的命令属于本项目，避免复用旧 PID 时误操作其他 Vite 进程。
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$PROJECT_ROOT/.runtime/web.pid"

if [[ ! -s "$PID_FILE" ]]; then
  echo "Web 未运行（没有 PID 文件）"
  exit 0
fi

pid="$(tr -d '[:space:]' < "$PID_FILE")"
if [[ ! "$pid" =~ ^[0-9]+$ ]]; then
  rm -f "$PID_FILE"
  echo "已清理无效的 Web PID 文件"
  exit 0
fi

if ! kill -0 "$pid" 2>/dev/null; then
  rm -f "$PID_FILE"
  echo "Web 已停止"
  exit 0
fi

command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
case "$command" in
  *@pipeline-factory/web*|*apps/web*|*vite*) ;;
  *)
    rm -f "$PID_FILE"
    echo "Web PID 文件指向了其他进程，未执行停止操作: $pid" >&2
    exit 1
    ;;
esac

stop_tree() {
  # 递归处理 pnpm 与 Vite 的子进程，保证 Web 停止后不会继续持有 5173 端口。
  local parent="$1"
  local child
  for child in $(pgrep -P "$parent" 2>/dev/null || true); do
    stop_tree "$child"
  done
  kill "$parent" 2>/dev/null || true
}

stop_tree "$pid"
# 使用有限等待并在失败时保留 PID，方便后续人工排查而不是静默丢失状态。
for _ in {1..50}; do
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "Web 已停止"
    exit 0
  fi
  sleep 0.1
done

echo "Web 未能在 5 秒内停止，请检查进程: $pid" >&2
exit 1
