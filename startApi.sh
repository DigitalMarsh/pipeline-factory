#!/usr/bin/env bash

# 已迁移：实现全部在 code/scripts/service.mjs，本文件只剩转调。
# 之所以保留一个提交，是因为 IDE 配置与 shell 历史可能还写着这些旧路径；
# 确认没有引用后即可删除（见计划 P9）。
set -euo pipefail

exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/code/scripts/service.mjs" start --mode dev --only api
