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
  local port="$4"
  local pid=""
  local port_pid=""

  if [[ -s "$pid_file" ]]; then
    pid="$(tr -d '[:space:]' < "$pid_file")"
    if [[ ! "$pid" =~ ^[0-9]+$ ]]; then
      pid=""
    fi
  fi

  # 健康端点是服务状态的主来源；PID 文件可能来自之前的启动脚本实例。
  if curl -fsS --max-time 1 "$url" >/dev/null 2>&1; then
    if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
      if command -v lsof >/dev/null 2>&1; then
        port_pid="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
      fi
      if [[ "$port_pid" =~ ^[0-9]+$ ]]; then
        printf '%s: 正常（端口进程 PID: %s，地址: %s；PID 文件已过期）\n' "$service" "$port_pid" "$url"
      else
        printf '%s: 正常（地址: %s；PID 文件不可用）\n' "$service" "$url"
      fi
    else
      printf '%s: 正常（PID: %s，地址: %s）\n' "$service" "$pid" "$url"
    fi
    return
  fi

  if command -v lsof >/dev/null 2>&1; then
    port_pid="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
  fi

  if [[ ! -e "$pid_file" ]]; then
    if [[ "$port_pid" =~ ^[0-9]+$ ]]; then
      printf '%s: 端口已被 PID %s 占用但健康检查失败（地址: %s）\n' "$service" "$port_pid" "$url"
      overall_status=1
      return
    fi
    printf '%s: 已停止（没有 PID 文件）\n' "$service"
    overall_status=1
    return
  fi

  if [[ ! -s "$pid_file" ]]; then
    printf '%s: PID 无效（PID 文件为空）\n' "$service"
    overall_status=1
    return
  fi

  pid="$(tr -d '[:space:]' < "$pid_file")"
  if [[ ! "$pid" =~ ^[0-9]+$ ]]; then
    printf '%s: PID 无效（PID 文件内容不是数字）\n' "$service"
    overall_status=1
    return
  fi

  if ! kill -0 "$pid" 2>/dev/null; then
    if [[ "$port_pid" =~ ^[0-9]+$ ]]; then
      printf '%s: PID 文件已过期，端口仍由 PID %s 占用但健康检查失败\n' "$service" "$port_pid"
      overall_status=1
      return
    fi
    printf '%s: 已停止（PID %s 不存在）\n' "$service" "$pid"
    overall_status=1
    return
  fi

  printf '%s: 进程运行但未就绪（PID: %s，健康检查失败）\n' "$service" "$pid"
  overall_status=1
}

check_service "API" "$RUNTIME_ROOT/api.pid" "http://127.0.0.1:4310/health" 4310
check_service "Web" "$RUNTIME_ROOT/web.pid" "http://127.0.0.1:5173/" 5173

exit "$overall_status"
