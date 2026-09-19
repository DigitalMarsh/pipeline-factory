#!/usr/bin/env bash

# 启动独立的 Web 开发服务器。Web 使用自己的 PID 和日志文件，生命周期不依赖 API 脚本。
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODE_ROOT="$PROJECT_ROOT/code"
RUNTIME_ROOT="$PROJECT_ROOT/.runtime"
PID_FILE="$RUNTIME_ROOT/web.pid"
LOG_FILE="$RUNTIME_ROOT/web.log"
PORT=5173

mkdir -p "$RUNTIME_ROOT"

listening_pid() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -n 1 || true
  fi
}

wait_for_web() {
  for _ in {1..60}; do
    if curl -fsS --max-time 1 "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

# 端口上的健康 Web 优先于 PID 文件；这样外部启动的进程不会被误报为停止。
if curl -fsS --max-time 1 "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
  detected_pid="$(listening_pid)"
  if [[ "$detected_pid" =~ ^[0-9]+$ ]]; then echo "$detected_pid" > "$PID_FILE"; fi
  echo "Web 已在运行，PID: ${detected_pid:-未知}"
  echo "地址: http://127.0.0.1:$PORT"
  echo "日志: $LOG_FILE"
  exit 0
fi

# 启动脚本可幂等执行：已有存活进程时等待它就绪，不重复占用端口。
if [[ -s "$PID_FILE" ]]; then
  pid="$(tr -d '[:space:]' < "$PID_FILE")"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    if wait_for_web; then
      echo "Web 已启动，PID: $pid"
      echo "地址: http://127.0.0.1:$PORT"
      echo "日志: $LOG_FILE"
      exit 0
    fi
    echo "Web 进程仍在运行但未就绪，未重复启动（PID: $pid）" >&2
    exit 1
  fi
  rm -f "$PID_FILE"
fi

occupied_pid="$(listening_pid)"
if [[ "$occupied_pid" =~ ^[0-9]+$ ]]; then
  echo "Web 启动失败：端口 $PORT 已被 PID $occupied_pid 占用，但页面检查未通过" >&2
  exit 1
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
  if curl -fsS --max-time 1 "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
    echo "Web 已启动，PID: $pid"
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
echo "Web 启动失败或未在 30 秒内就绪，请查看日志: $LOG_FILE" >&2
tail -n 30 "$LOG_FILE" >&2 || true
exit 1
