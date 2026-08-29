#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODE_ROOT="$PROJECT_ROOT/code"
RUNTIME_ROOT="$PROJECT_ROOT/.runtime"
PID_FILE="$RUNTIME_ROOT/api.pid"
LOG_FILE="$RUNTIME_ROOT/api.log"

mkdir -p "$RUNTIME_ROOT"

if [[ -s "$PID_FILE" ]]; then
  pid="$(tr -d '[:space:]' < "$PID_FILE")"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    echo "API 已在运行，PID: $pid"
    echo "日志: $LOG_FILE"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

(
  cd "$CODE_ROOT"
  exec nohup pnpm --filter @pipeline-factory/api dev -- --config "$CODE_ROOT/config/pipeline-factory.config.json"
) >>"$LOG_FILE" 2>&1 &
pid=$!
echo "$pid" > "$PID_FILE"

for _ in {1..60}; do
  if curl -fsS --max-time 1 http://127.0.0.1:4310/health >/dev/null 2>&1; then
    echo "API 已启动，PID: $pid"
    echo "地址: http://127.0.0.1:4310"
    echo "日志: $LOG_FILE"
    exit 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

rm -f "$PID_FILE"
echo "API 启动失败或未在 30 秒内就绪，请查看日志: $LOG_FILE" >&2
tail -n 30 "$LOG_FILE" >&2 || true
exit 1
