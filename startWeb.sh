#!/usr/bin/env bash

# 启动独立的 Web 开发服务器。Web 使用自己的 PID 和日志文件，生命周期不依赖 API 脚本。
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODE_ROOT="$PROJECT_ROOT/code"
RUNTIME_ROOT="$PROJECT_ROOT/.runtime"
PID_FILE="$RUNTIME_ROOT/web.pid"
LOG_FILE="$RUNTIME_ROOT/web.log"

mkdir -p "$RUNTIME_ROOT"

# 启动脚本可幂等执行：已有存活进程时只报告地址和日志，不重复占用端口。
if [[ -s "$PID_FILE" ]]; then
  pid="$(tr -d '[:space:]' < "$PID_FILE")"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    echo "Web 已在运行，PID: $pid"
    echo "日志: $LOG_FILE"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

# 使用项目代码目录作为 Vite 工作目录，并把后台输出集中到 Web 专属日志。
(
  cd "$CODE_ROOT"
  exec nohup pnpm --filter @pipeline-factory/web dev
) >>"$LOG_FILE" 2>&1 &
pid=$!
echo "$pid" > "$PID_FILE"

# 访问根页面确认 Vite 已真正就绪，而不是仅确认 Node 进程仍然存在。
for _ in {1..60}; do
  if curl -fsS --max-time 1 http://127.0.0.1:5173/ >/dev/null 2>&1; then
    echo "Web 已启动，PID: $pid"
    echo "地址: http://127.0.0.1:5173"
    echo "日志: $LOG_FILE"
    exit 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

rm -f "$PID_FILE"
echo "Web 启动失败或未在 30 秒内就绪，请查看日志: $LOG_FILE" >&2
tail -n 30 "$LOG_FILE" >&2 || true
exit 1
