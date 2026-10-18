#!/bin/sh
# Pipeline Factory 安装脚本
#
# 用法（在解压后的发布物目录里）：
#   ./install.sh
#   pipeline start
#
# 可选：
#   --dir <目录>    安装目录（默认 $PIPELINE_HOME 或 ~/.pipeline-factory）
#   --bin <目录>    CLI 链接目录（默认 $PIPELINE_BIN 或 ~/.local/bin）
#   --from <路径|URL|tar.gz>  从另一个发布物/压缩包安装或升级
#   --no-start      安装完成后不自动启动
#
# 设计说明：
#   - 沿用发布物的布局（app/web/config/var/bin），config/ 与 var/ 在重复安装/升级时**保留**；
#   - CLI 是单个可执行文件 bin/pipeline（Node），链接到 --bin 目录后即可直接运行；
#   - 不做任何全局 npm 安装，也不要求 sudo。

set -eu

INSTALL_DIR="${PIPELINE_HOME:-$HOME/.pipeline-factory}"
BIN_DIR="${PIPELINE_BIN:-$HOME/.local/bin}"
START=1
FROM=""
TEMP_DIR=""

cleanup() {
  if [ -n "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR"
  fi
  # EXIT trap 的最后一个命令决定退出码；显式成功，避免把"临时目录为空"当成安装失败。
  true
}
trap cleanup EXIT INT TERM

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --bin) BIN_DIR="$2"; shift 2 ;;
    --from) FROM="$2"; shift 2 ;;
    --no-start) START=0; shift ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "未知参数：$1" >&2
      exit 1
      ;;
  esac
done

SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ -n "$FROM" ]; then
  case "$FROM" in
    http://*|https://*)
      TEMP_DIR=$(mktemp -d)
      echo "下载 $FROM ..."
      curl -fsSL "$FROM" -o "$TEMP_DIR/release.tar.gz"
      tar -xzf "$TEMP_DIR/release.tar.gz" -C "$TEMP_DIR"
      SOURCE_DIR=$(find "$TEMP_DIR" -maxdepth 2 -type f -path '*/app/dist/main.js' -print | head -n 1 | sed 's#/app/dist/main.js##')
      ;;
    *.tar.gz|*.tgz)
      TEMP_DIR=$(mktemp -d)
      tar -xzf "$FROM" -C "$TEMP_DIR"
      SOURCE_DIR=$(find "$TEMP_DIR" -maxdepth 2 -type f -path '*/app/dist/main.js' -print | head -n 1 | sed 's#/app/dist/main.js##')
      ;;
    *)
      SOURCE_DIR="$FROM"
      ;;
  esac
fi

if [ ! -f "$SOURCE_DIR/app/dist/main.js" ]; then
  echo "找不到发布物：$SOURCE_DIR/app/dist/main.js" >&2
  echo "请在解压后的 pipeline-factory-<version> 目录内运行，或用 --from 指定 tar.gz/目录。" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "需要 Node.js ≥ 22.5（未找到 node）。" >&2
  exit 1
fi

node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<5)){console.error(`Node.js ${process.versions.node} 太低，需要 ≥ 22.5`);process.exit(1)}' \
  || exit 1

mkdir -p "$INSTALL_DIR" "$INSTALL_DIR/var" "$BIN_DIR"

if [ "$(CDPATH= cd -- "$SOURCE_DIR" && pwd)" != "$(CDPATH= cd -- "$INSTALL_DIR" && pwd)" ]; then
  for entry in app web bin; do
    if [ -e "$SOURCE_DIR/$entry" ]; then
      rm -rf "$INSTALL_DIR/$entry"
      cp -R "$SOURCE_DIR/$entry" "$INSTALL_DIR/$entry"
    fi
  done
  for entry in INSTALL.md RELEASE.md install.sh; do
    if [ -f "$SOURCE_DIR/$entry" ]; then
      cp "$SOURCE_DIR/$entry" "$INSTALL_DIR/$entry"
    fi
  done
  mkdir -p "$INSTALL_DIR/config"
  # **只在缺失时**安装配置：重复安装/升级不能覆盖用户已经改过的配置。
  if [ ! -f "$INSTALL_DIR/config/pipeline-factory.config.json" ] && [ -f "$SOURCE_DIR/config/pipeline-factory.config.json" ]; then
    cp "$SOURCE_DIR/config/pipeline-factory.config.json" "$INSTALL_DIR/config/pipeline-factory.config.json"
  fi
fi

chmod +x "$INSTALL_DIR/bin/pipeline"
ln -sfn "$INSTALL_DIR/bin/pipeline" "$BIN_DIR/pipeline"

echo
echo "安装完成：$INSTALL_DIR"
echo "命令：$BIN_DIR/pipeline"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo
    echo "提示：$BIN_DIR 不在 PATH 中。把下面一行加到 shell 配置里："
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac
echo
echo "下一步："
echo "  1. 编辑配置：$INSTALL_DIR/config/pipeline-factory.config.json"
echo "  2. 启动：pipeline start"
echo "  3. 状态：pipeline status"

if [ "$START" -eq 1 ]; then
  echo
  "$INSTALL_DIR/bin/pipeline" start || true
fi
