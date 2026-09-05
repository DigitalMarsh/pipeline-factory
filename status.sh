#!/usr/bin/env bash

# 检查 API 和 Web 的进程及服务就绪状态；只读运行时信息，不修改 PID 文件。
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_ROOT="$PROJECT_ROOT/.runtime"
overall_status=0

check_service() {
  local service="$1"
  local pid_file="$2"
  local url="$3"

  if [[ ! -e "$pid_file" ]]; then
    printf '%s: 已停止（没有 PID 文件）\n' "$service"
    overall_status=1
    return
  fi

  if [[ ! -s "$pid_file" ]]; then
    printf '%s: PID 无效（PID 文件为空）\n' "$service"
    overall_status=1
    return
  fi

  local pid
  pid="$(tr -d '[:space:]' < "$pid_file")"
  if [[ ! "$pid" =~ ^[0-9]+$ ]]; then
    printf '%s: PID 无效（PID 文件内容不是数字）\n' "$service"
    overall_status=1
    return
  fi

  if ! kill -0 "$pid" 2>/dev/null; then
    printf '%s: 已停止（PID %s 不存在）\n' "$service" "$pid"
    overall_status=1
    return
  fi

  if curl -fsS --max-time 1 "$url" >/dev/null 2>&1; then
    printf '%s: 正常（PID: %s，地址: %s）\n' "$service" "$pid" "$url"
  else
    printf '%s: 进程运行但未就绪（PID: %s，健康检查失败）\n' "$service" "$pid"
    overall_status=1
  fi
}

check_service "API" "$RUNTIME_ROOT/api.pid" "http://127.0.0.1:4310/health"
check_service "Web" "$RUNTIME_ROOT/web.pid" "http://127.0.0.1:5173/"

exit "$overall_status"
