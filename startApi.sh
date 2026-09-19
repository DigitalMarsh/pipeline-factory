#!/usr/bin/env bash

# 启动独立的 API 开发进程，并通过 PID 文件和健康检查把“已创建进程”与“服务已就绪”区分开。
# API 和 Web 使用不同的 PID、日志和停止脚本，因此停止 API 不会影响 Web。
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODE_ROOT="$PROJECT_ROOT/code"
RUNTIME_ROOT="$PROJECT_ROOT/.runtime"
PID_FILE="$RUNTIME_ROOT/api.pid"
LOG_FILE="$RUNTIME_ROOT/api.log"
PORT=4310

mkdir -p "$RUNTIME_ROOT"

listening_pid() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -n 1 || true
  fi
}

wait_for_health() {
  for _ in {1..60}; do
    if curl -fsS --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

# 端口上的健康 API 优先于 PID 文件；这样外部启动的进程不会被误报为停止。
if curl -fsS --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  detected_pid="$(listening_pid)"
  if [[ "$detected_pid" =~ ^[0-9]+$ ]]; then echo "$detected_pid" > "$PID_FILE"; fi
  echo "API 已在运行，PID: ${detected_pid:-未知}"
  echo "地址: http://127.0.0.1:$PORT"
  echo "日志: $LOG_FILE"
  exit 0
fi

# 重复执行启动脚本时等待已有进程就绪，避免同一端口产生多个开发进程。
if [[ -s "$PID_FILE" ]]; then
  pid="$(tr -d '[:space:]' < "$PID_FILE")"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    if wait_for_health; then
      echo "API 已启动，PID: $pid"
      echo "地址: http://127.0.0.1:$PORT"
      echo "日志: $LOG_FILE"
      exit 0
    fi
    echo "API 进程仍在运行但未就绪，未重复启动（PID: $pid）" >&2
    exit 1
  fi
  rm -f "$PID_FILE"
fi

occupied_pid="$(listening_pid)"
if [[ "$occupied_pid" =~ ^[0-9]+$ ]]; then
  echo "API 启动失败：端口 $PORT 已被 PID $occupied_pid 占用，但健康检查未通过" >&2
  exit 1
fi

# 在子 shell 中切换到代码目录；nohup 只托管 API 进程，日志不与 Web 共用。
(
  cd "$CODE_ROOT"
  exec nohup pnpm --filter @pipeline-factory/api dev -- --config "$CODE_ROOT/config/pipeline-factory.config.json"
) >>"$LOG_FILE" 2>&1 &
pid=$!
echo "$pid" > "$PID_FILE"

# 只有健康端点可访问才报告启动成功；进程提前退出时立即转入失败分支。
for _ in {1..60}; do
  if curl -fsS --max-time 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "API 已启动，PID: $pid"
    echo "地址: http://127.0.0.1:$PORT"
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
