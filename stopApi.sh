#!/usr/bin/env bash

# 停止 API 的目标由独立 PID 文件确定，并在发送信号前检查命令行，防止陈旧 PID 误杀其他进程。
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
  # 先递归停止 pnpm/Vite/Node 子进程，避免父进程退出后留下孤儿 API 进程。
  local parent="$1"
  local child
  for child in $(pgrep -P "$parent" 2>/dev/null || true); do
    stop_tree "$child"
  done
  kill "$parent" 2>/dev/null || true
}

stop_tree "$pid"
# 给进程树一个有限的退出窗口；超时保留现场，便于操作者继续诊断。
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
