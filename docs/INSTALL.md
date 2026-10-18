# 安装与运行

本文面向**拿到 `pipeline-factory-<version>.tar.gz` 发布物**的使用者。发布物是单进程应用：
API 与 Web 同源监听一个端口；安装后用一个 `pipeline` 命令管理启动、停止、日志与升级。

## 1. 前置条件

| 依赖                           | 要求                   | 说明                                                               |
| ------------------------------ | ---------------------- | ------------------------------------------------------------------ |
| Node.js                        | **≥ 22.5**             | 使用 `node:sqlite`；发布物没有打包 Node                            |
| Git                            | ≥ 2.38（推荐）         | 冲突预测需要 `git merge-tree --write-tree`；旧版本只是该功能不可用 |
| Codex CLI                      | 使用 Codex 后端时必须  | `codex` 在 `PATH` 中并已登录                                       |
| Claude Code / Claude Agent SDK | 使用 Claude 后端时必须 | 见第 4 节，**安装包不包含 SDK**                                    |

## 2. 安装

```bash
tar -xzf pipeline-factory-0.1.0.tar.gz
cd pipeline-factory-0.1.0
./install.sh
```

安装脚本会：

- 把发布物安装到 `~/.pipeline-factory`（可用 `--dir` 或 `PIPELINE_HOME` 改）；
- 把 `pipeline` 命令链接到 `~/.local/bin`（可用 `--bin` 或 `PIPELINE_BIN` 改）；
- 保留已有的 `config/` 与 `var/`（重复安装/升级不会覆盖配置和数据）；
- 若 `~/.local/bin` 不在 `PATH`，会打印需要添加的 `export PATH=...`。

可选参数：

```bash
./install.sh --dir ~/apps/pipeline-factory --bin ~/bin --no-start
./install.sh --from ./pipeline-factory-0.1.0.tar.gz   # 从压缩包安装/升级
```

## 3. 配置与启动

编辑配置（首次安装后至少确认这几项）：

```bash
$EDITOR ~/.pipeline-factory/config/pipeline-factory.config.json
```

- `project.root`：Factory 管理的代码仓库根目录；
- `model.codexAppServer.cwd`：Codex 子进程 cwd，通常与 `project.root` 相同；
- `storage.databasePath` / `storage.worktreeRoot`：默认在安装目录的 `var/` 下；
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

推荐把它装进安装目录的 `app/`（不修改全局 Node 环境）：

```bash
cd ~/.pipeline-factory/app
npm install --no-save @anthropic-ai/claude-agent-sdk@0.3.283
cd -
```

或者在配置里指向 SDK 入口文件的绝对路径：

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

```bash
pipeline update                          # 从 GitHub Releases 下载最新 pipeline-factory.tar.gz
pipeline update --file ./pipeline-factory-0.2.0.tar.gz
pipeline update --from https://example.com/pipeline-factory-0.2.0.tar.gz
```

升级流程：停止 → 备份并替换 `app/` `web/` `bin/` → 保留 `config/` 与 `var/` → 重新启动。
任何一步失败会回滚 `app/` `web/` `bin/`。

- 结构版本升级由 SQLite `PRAGMA user_version` 自动对齐；
- **旧程序会拒绝打开新库**（`SCHEMA_TOO_NEW`），请升级发布物而不是降级；
- 发布物与构建机平台绑定，升级包要在同一平台/架构上使用。

## 6. 数据、备份与安全

运行时数据都在安装目录的 `var/` 下：

- `var/pipeline-factory.sqlite`（及 `-wal` / `-shm`）：项目、Plan、Run、事件、附件元数据；
- `var/attachments/<projectId>/`：对话图片；
- `var/worktrees/`：Run 的 Git worktree。

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

| 现象                            | 原因 / 处理                                                  |
| ------------------------------- | ------------------------------------------------------------ |
| `CLAUDE_AGENT_SDK_UNAVAILABLE`  | 目标机器没有可解析的 SDK；按第 4 节安装，或配置 `sdkPath`    |
| `SCHEMA_TOO_NEW`                | 用旧程序打开了新版本创建的库；`pipeline update`              |
| 启动报 Node 版本/`node:sqlite`  | Node < 22.5；切换 Node 版本                                  |
| `pipeline` 找不到               | `~/.local/bin` 不在 PATH；按安装脚本提示添加                 |
| 启动失败                        | `pipeline logs` 查看 `var/pipeline.log`                      |
| 页面是旧界面                    | 单进程托管的是 `web/` 静态产物；升级发布物或清浏览器缓存     |
| `server.authToken is required…` | 把 `server.host` 改成了非回环地址；补 token 并确保客户端携带 |

## 8. 从源码构建发布物

```bash
pnpm install
pnpm pack:release
```

产物在 `release/pipeline-factory-<version>/` 与同名 tar.gz；发布物与构建机平台绑定。
