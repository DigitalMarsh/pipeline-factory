# 安装与运行

本文面向**拿到 `pipeline-factory-<version>.tar.gz` 发布物**的使用者。发布物是单进程应用：
API 与 Web 同源监听一个端口，数据默认落在发布物自己的 `var/`。

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
```

目录结构：

```text
pipeline-factory-0.1.0/
├── app/                 # API 运行时代码与生产依赖
├── web/                 # Web 静态产物（由 API 同源托管）
├── bin/pipeline-factory # 启动器
├── config/              # 配置（生成自示例）
├── var/                 # 数据库、worktree、附件（运行时生成）
├── RELEASE.md
└── INSTALL.md
```

编辑 `config/pipeline-factory.config.json`，**至少确认**：

- `project.root`：Factory 管理的代码仓库根目录（相对 `config/` 或绝对路径）。
- `model.codexAppServer.cwd`：Codex 子进程 cwd，通常与 `project.root` 相同。
- `storage.databasePath` / `storage.worktreeRoot`：默认 `../var/...`，相对 `config/`。
- `model.backend` 与 `model.roles.*.model`：实际使用的后端与模型。
- `server.host`：默认 `127.0.0.1`，**不要改成 `0.0.0.0`**，除非同时配置 `server.authToken`（见第 6 节）。

## 3. 启动与停止

前台：

```bash
bin/pipeline-factory --config config/pipeline-factory.config.json
```

后台（简单方式）：

```bash
nohup bin/pipeline-factory --config config/pipeline-factory.config.json \
  > var/pipeline-factory.log 2>&1 &
echo $! > var/pipeline-factory.pid
```

停止：

```bash
kill "$(cat var/pipeline-factory.pid)"
```

启动后浏览器打开 `http://127.0.0.1:4310/`。健康检查：

```bash
curl http://127.0.0.1:4310/health
```

返回里的 `appVersion` 是发布物版本，`schemaVersion` 是 SQLite 结构版本。

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

推荐把它装进发布物自己的 `app/`（不修改全局 Node 环境）：

```bash
cd app
npm install --no-save @anthropic-ai/claude-agent-sdk@0.3.283
cd ..
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

如果缺少 SDK，**只有使用 Claude 后端时**才会报
`CLAUDE_AGENT_SDK_UNAVAILABLE`，Codex 后端不受影响。

## 5. 数据、备份与升级

运行时数据全在 `var/` 与同目录的 `attachments/`：

- `var/pipeline-factory.sqlite`（及 `-wal` / `-shm`）：项目、Plan、Run、事件、附件元数据；
- `attachments/<projectId>/`：对话图片；
- `var/worktrees/`：Run 的 Git worktree（可重新创建，但删除前确认没有未提交改动）。

**备份**：停止进程后复制 `config/` 与 `var/`、`attachments/` 即可。

**升级**：

1. 停止旧进程；
2. 备份 `config/`、`var/`、`attachments/`；
3. 解压新版本，把旧 `config/` 与 `var/` 移到新目录（不要把 `var/` 留在旧目录里继续跑）；
4. 启动新版本并检查 `/health` 的 `schemaVersion`；
5. 若新版本要求更高结构版本，旧库会在启动时自动对齐；反过来，**旧程序会拒绝打开新库**
   （`SCHEMA_TOO_NEW`），这是有意的保护。

## 6. 安全边界（务必读）

API 的能力等同于"本机 shell + 文件系统 + Git"：能建项目、派发 Run、执行仓库命令。
因此：

- 默认只监听回环地址；
- 浏览器来源只允许回环（任意本地端口）与配置的 `server.allowedOrigins`；
- Host 头必须是回环主机名（防 DNS rebinding）；
- **监听非回环地址时必须有 `server.authToken`**，否则拒绝启动。远程访问时请求需带：

```bash
curl -H "Authorization: Bearer <token>" http://<host>:4310/health
```

- `/health` 不校验 token（给启动探针用）；其余接口在非回环监听下都要校验。

## 7. 常见问题

| 现象                            | 原因 / 处理                                                  |
| ------------------------------- | ------------------------------------------------------------ |
| `CLAUDE_AGENT_SDK_UNAVAILABLE`  | 目标机器没有可解析的 SDK；按第 4 节安装，或配置 `sdkPath`    |
| `SCHEMA_TOO_NEW`                | 用旧程序打开了新版本创建的库；升级发布物                     |
| 启动报 Node 版本/`node:sqlite`  | Node < 22.5；切换 Node 版本                                  |
| 页面是旧界面                    | 单进程托管的是 `web/` 静态产物；升级发布物或清浏览器缓存     |
| `server.authToken is required…` | 把 `server.host` 改成了非回环地址；补 token 并确保客户端携带 |

## 8. 从源码构建发布物

```bash
pnpm install
pnpm pack:release
```

产物在 `release/pipeline-factory-<version>/` 与同名 tar.gz。**发布物与构建机平台绑定**
（依赖与可选二进制按构建平台安装）；需要在目标平台重新构建。
