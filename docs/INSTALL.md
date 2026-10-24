# 安装与运行

Pipeline Factory 是单进程应用：API 与 Web 同源监听一个端口；安装后用 `pipeline` 命令管理启动、
停止、日志与升级。推荐 npm 全局安装（不需要下载发布物）。

## 1. 前置条件

| 依赖                           | 要求                   | 说明                                                             |
| ------------------------------ | ---------------------- | ---------------------------------------------------------------- |
| Node.js                        | **≥ 22.5**             | 使用 `node:sqlite`                                               |
| npm                            | 随 Node 提供           | 用于安装/升级；离线环境可用发布物                                |
| Git                            | ≥ 2.38（推荐）         | 冲突预测需要 `git merge-tree --write-tree`；旧版本仅该功能不可用 |
| Codex CLI                      | 使用 Codex 后端时必须  | `codex` 在 `PATH` 中并已登录                                     |
| Claude Code / Claude Agent SDK | 使用 Claude 后端时必须 | 见第 4 节，**安装包不包含 SDK**                                  |

## 2. 安装

### npm（推荐）

```bash
npm install -g pipeline-factory
pipeline start
```

- 包本身只提供运行时（`dist/` + `web/` + `bin/pipeline.mjs`），不携带 Claude SDK；
- 用户数据在 `~/.pipeline-factory`（`PIPELINE_HOME` 可改），首次启动自动生成配置并把 Web 产物同步过去；
- `pipeline update` 会执行 `npm install -g --prefix <当前前缀> pipeline-factory@latest`。

如果全局 npm 目录没有写权限，请先配置一个用户级 prefix，或使用下面的离线发布物。

### 离线发布物

```bash
tar -xzf pipeline-factory-<version>.tar.gz
cd pipeline-factory-<version>
./install.sh
```

安装脚本会安装到 `~/.pipeline-factory`（`--dir` / `PIPELINE_HOME` 可改），把 `pipeline`
链接到 `~/.local/bin`（`--bin` / `PIPELINE_BIN` 可改），并保留已有的 `config/` 与 `var/`。

```bash
./install.sh --dir ~/apps/pipeline-factory --bin ~/bin --no-start
./install.sh --from ./pipeline-factory-<version>.tar.gz
```

## 3. 配置与启动

首次 `pipeline start` 会生成 `~/.pipeline-factory/config/pipeline-factory.config.json`，
其中 `project.root` 暂定为执行命令时的当前目录。至少确认：

```bash
$EDITOR ~/.pipeline-factory/config/pipeline-factory.config.json
```

- `project.root`：Factory 管理的代码仓库根目录；
- `model.codexAppServer.cwd`：Codex 子进程 cwd，通常与 `project.root` 相同；
- `storage.databasePath` / `storage.worktreeRoot`：默认在 `~/.pipeline-factory/var/` 下；
- `model.backend` 与 `model.roles.*.model`：实际使用的后端与模型；
- `server.host`：默认 `127.0.0.1`，**不要改成 `0.0.0.0`**，除非同时配置 `server.authToken`（见第 6 节）。

启动与日常命令：

```bash
pipeline start      # 后台启动，PID/日志在 ~/.pipeline-factory/var/
pipeline status     # 版本、PID、健康检查
pipeline logs -f    # 跟随日志
pipeline stop       # 停止
pipeline restart
pipeline update     # 升级（见第 5 节）
```

默认地址：<http://127.0.0.1:4310/>。

## 4. 配置模型后端

### Codex（默认）

安装并登录 Codex CLI，确保 `codex` 在 `PATH` 中。配置示例：

```json
{
  "model": {
    "backend": "codex-app-server",
    "codexAppServer": {
      "command": "codex",
      "args": [
        "app-server",
        "--stdio",
        "--enable",
        "default_mode_request_user_input"
      ],
      "cwd": "../../"
    }
  }
}
```

### Claude Agent SDK

**安装包不包含 Claude Agent SDK**（体积主要来自平台二进制）。目标机器需要同时具备：

1. Claude Code（`~/.claude/settings.json` 或官方登录态）；
2. 一个 Node 能解析到的 `@anthropic-ai/claude-agent-sdk`。

npm 全局安装时，把 SDK 装成**同一个全局前缀下的兄弟包**即可。本程序从
`<prefix>/lib/node_modules/pipeline-factory/dist/main.mjs` 加载模块，Node 会沿
`dist/ → pipeline-factory/ → node_modules/` 解析，所以 `<prefix>/lib/node_modules/@anthropic-ai/claude-agent-sdk`
正好能被找到（与包内带一个依赖等价）：

```bash
npm install -g @anthropic-ai/claude-agent-sdk@0.3.283
```

如果安装 pipeline-factory 时用了自定义 `--prefix`，给上面这条命令加同一个 `--prefix`。

离线发布物（`./install.sh`）的布局是 `~/.pipeline-factory/app/`，装进那里：

```bash
cd ~/.pipeline-factory/app && npm install --no-save @anthropic-ai/claude-agent-sdk@0.3.283
```

两种布局都可以不用全局安装，而是在配置里指向 SDK 入口文件的绝对路径：

```json
{
  "model": {
    "backend": "claude-agent-sdk",
    "claudeAgent": {
      "sdkPath": "/absolute/path/to/@anthropic-ai/claude-agent-sdk/sdk.mjs"
    }
  }
}
```

缺少 SDK 时**只有使用 Claude 后端时**才会报 `CLAUDE_AGENT_SDK_UNAVAILABLE`，Codex 后端不受影响。

## 5. 升级

npm 安装：

```bash
pipeline update                    # npm install -g --prefix <当前前缀> pipeline-factory@latest
pipeline update --file ./pipeline-factory-0.2.2.tgz   # 升级到本地指定包
pipeline update --no-start         # 只更新，不自动重启
```

npm 升级会停服务 → 安装新包 → 用新版本重启；`config/` 与 `var/` 不动。Web 产物在启动时
按包内版本号同步到 `~/.pipeline-factory/web`。

离线发布物安装：

```bash
pipeline update                          # 读取 GitHub Releases 最新发布的 pipeline-factory-<version>.tar.gz
pipeline update --file ./pipeline-factory-0.2.2.tar.gz
pipeline update --from https://example.com/pipeline-factory-0.2.2.tar.gz
```

默认通过 GitHub API 找最新 release 资产（按 `pipeline-factory-*.tar.gz` 匹配）；私有仓库可设置
`GITHUB_TOKEN`，固定下载地址可设置 `PIPELINE_UPDATE_URL`，换仓库可设置 `PIPELINE_UPDATE_REPO`。

升级流程：停止 → 备份并替换 `app/` `web/` `bin/` → 保留 `config/` 与 `var/` → 重新启动。
任何一步失败会回滚 `app/` `web/` `bin/`。

- 结构版本升级由 SQLite `PRAGMA user_version` 自动对齐；
- **旧程序会拒绝打开新库**（`SCHEMA_TOO_NEW`），请升级而不是降级；
- 离线发布物与构建机平台绑定，升级包要在同一平台/架构上使用。

## 6. 数据、备份与安全

运行时数据都在数据目录 `~/.pipeline-factory` 下（`PIPELINE_HOME` 可改；离线安装若用 `--dir`
则是该目录）：

- `config/pipeline-factory.config.json`：配置；
- `var/pipeline-factory.sqlite`（及 `-wal` / `-shm`）：项目、Plan、Run、事件、附件元数据；
- `var/attachments/<projectId>/`：对话图片；
- `var/worktrees/`：Run 的 Git worktree；
- `web/`：从包内同步的 Web 静态产物（npm 安装）。

**备份**：`pipeline stop` 后复制 `config/` 与整个 `var/`。

**安全边界**：API 的能力等同于"本机 shell + 文件系统 + Git"。因此：

- 默认只监听回环地址；
- 浏览器来源只允许回环（任意本地端口）与 `server.allowedOrigins`；
- Host 头必须是回环主机名（防 DNS rebinding）；
- **监听非回环地址时必须有 `server.authToken`**，否则拒绝启动。远程访问需带：

```bash
curl -H "Authorization: Bearer <token>" http://<host>:4310/health
```

- `/health` 不校验 token（给启动探针用）；其余接口在非回环监听下都要校验。

## 7. 常见问题

| 现象                            | 原因 / 处理                                                       |
| ------------------------------- | ----------------------------------------------------------------- |
| `CLAUDE_AGENT_SDK_UNAVAILABLE`  | 目标机器没有可解析的 SDK；按第 4 节安装，或配置 `sdkPath`         |
| `SCHEMA_TOO_NEW`                | 用旧程序打开了新版本创建的库；`pipeline update`                   |
| 启动报 Node 版本/`node:sqlite`  | Node < 22.5；切换 Node 版本                                       |
| `pipeline` 找不到               | npm 全局 bin 或 `~/.local/bin` 不在 PATH；按安装提示添加          |
| 启动失败                        | `pipeline logs` 查看 `~/.pipeline-factory/var/pipeline.log`       |
| 页面是旧界面                    | 升级后重新 `pipeline start`（Web 产物按版本同步）；再清浏览器缓存 |
| `server.authToken is required…` | 把 `server.host` 改成了非回环地址；补 token 并确保客户端携带      |
| 升级后仍是旧版本                | 检查是否有另一个实例占着端口：`pipeline status` 的 PID/版本       |

## 8. 从源码构建

发布物与 npm 包都从源码构建（在 `code/` 下执行）：

```bash
pnpm install
pnpm pack:release   # 离线发布物 → release/pipeline-factory-<version>/ 与同名 tar.gz
pnpm pack:npm       # npm 包 → release/pipeline-factory-<version>.tgz
```

npm 包是单包（core/contracts 由 esbuild 内联），发布前可用本地前缀验证：

```bash
npm install -g --prefix /tmp/pf-prefix release/pipeline-factory-<version>.tgz
PIPELINE_HOME=/tmp/pf-data /tmp/pf-prefix/bin/pipeline start
```

发布到 npm：`npm publish release/pipeline-factory-<version>.tgz`（需要已登录且包名可用）。
