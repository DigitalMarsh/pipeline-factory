# AI Software Pipeline Factory v4

这是 v4 设计对应的 TypeScript/Vue 最小可运行实现，代码范围限定在本目录。v4 是唯一的 HTTP API、Web 客户端调用方式和测试协议，并通过 Codex App Server 或 Claude Agent SDK 支持异步 Plan Mode 结构化提问。

## 目录

代码注释规范见仓库根目录的 [`docs/COMMENTING.md`](../docs/COMMENTING.md)。

- `packages/domain`：Plan 状态、ExplorerThread 谱系推导、生命周期 Hook 领域服务。
- `apps/api`：Node.js + Fastify API，提供 ExplorerThread、Plan confirm/enqueue、Plan 查询、Hook 配置和 v4 SSE/结构化输入接口。
- `apps/web`：Vue 3 + Vite + Element Plus 控制台，提供 ExplorerThread 工作区、Full Plan 抽屉、结构化选择弹窗和 Plan Center。

## 本地运行

所有命令都从 `code/` 目录执行。安装依赖后，开发模式用一条命令并行启动 API 与 Vite：

```bash
pnpm install
pnpm dev
```

开发模式仍是两个进程：API 默认监听 `http://127.0.0.1:4310`，Web/Vite 默认监听
`http://127.0.0.1:5173`，Vite proxy 负责把 API 与 SSE 请求转发到 4310。API 带热重载：
它以 `node --watch` 运行，监听**已加载的源码模块**，改 `apps/api/src` 或 `packages/domain/src`
都会自动重启，不需要手动重启、也不需要重新构建。代价是重启会切断进程内的 SSE 连接并重置
调度器内存状态（数据库与事件流本身是持久的），正在执行的 Run 期间改代码请自己权衡时机。

也可以只启动或停止其中一个进程：

```bash
node scripts/service.mjs start --mode dev --only api
node scripts/service.mjs start --mode dev --only web
node scripts/service.mjs stop --only api
node scripts/service.mjs stop --only web
node scripts/service.mjs status
```

> **改动前端代码后要重新构建**：单进程模式（API 在 4310 同时托管页面）服务的是
> `apps/web/dist` 这份**静态构建产物**，不会热更新；`pnpm build` 之后还要**硬刷新浏览器**。
> 想要热更新就用开发模式（Vite 5173）。

生产/单进程模式先构建，再由 API 在同一端口托管 Web 构建产物：

```bash
pnpm build
pnpm start
pnpm status
pnpm stop
```

生产模式只启动 API 进程；当 `server.serveWeb` 为 `true` 时，`apps/api` 同时提供
`apps/web/dist`，因此根路径、SPA 深链、`/api/v4/*` 与所有相对路径 SSE 都使用
`http://127.0.0.1:4310`。`pnpm start` 会在构建产物缺失时提前失败，不会启动一个看似成功但
打开页面为 404 的服务。停止与状态检查由 `scripts/service.mjs` 管理，PID 与日志保存在
Git 根目录的 `.runtime/`（API 为 `.runtime/api.pid` / `.runtime/api.log`；开发 Web 为
`.runtime/web.pid` / `.runtime/web.log`）。旧的根目录 `startApi.sh`、`startWeb.sh`、
`stopApi.sh`、`stopWeb.sh`、`status.sh` 已删除，不能再作为运行入口。

单进程托管的两个配置字段：

- `server.serveWeb`：显式开关，示例配置默认为 `false`，生产配置通常设为 `true`；
  不通过 `NODE_ENV` 或其他环境变量推断。
- `server.webDistPath`：相对于配置文件目录解析，默认示例为 `../apps/web/dist`。
  SPA 使用 `createWebHistory()`，所以将来如果修改 Vite 的 `base`，必须同步修改 API
  静态托管的路径前缀；两者不一致会让资源 URL 与 MIME fallback 出错。

复制 `config/pipeline-factory.config.example.json` 后，按受管项目修改 `project.root`、
`storage`、固定命令和 `model` 配置。示例里的 `storage.databasePath` 是相对于
`config/pipeline-factory.config.example.json` 的 `../var/pipeline-factory.sqlite`；当前活跃
配置使用 `../pipeline-factory.sqlite`，即 `code/pipeline-factory.sqlite`。数据库与 WAL 文件
已被 Git 忽略。不要为了整理目录直接移动正在运行的 SQLite 文件；如需改到 `var/`，先停服、
备份数据库及 `-wal`，再修改配置并让 SQLite 重新打开目标路径。

```json
{
  "project": {
    "root": "/absolute/path/to/your/project",
    "planDirectory": "docs/pipeline/plans",
    "commands": [
      {
        "commandId": "project.start",
        "argv": ["/absolute/path/to/node", "scripts/start.mjs"],
        "environment": { "PATH": "/absolute/path/to/bin:/usr/bin:/bin" }
      },
      {
        "commandId": "project.cleanup",
        "argv": ["/absolute/path/to/node", "scripts/cleanup.mjs"],
        "environment": { "PATH": "/absolute/path/to/bin:/usr/bin:/bin" }
      }
    ]
  }
}
```

`project.planDirectory` 决定**确认 Plan 时落盘副本写到哪里**：相对受管工程根目录解析（缺省
`docs/pipeline/plans`），也接受绝对路径；目录不存在会自动创建。每个 Revision 一个文件
（`<planId>-v<revision>.md`），**不覆盖旧版本**。这些文件会出现在受管仓库的 `git status` 里——
这正是"让方案与代码在同一个仓库里被审阅、被 diff"的用意。它们**不会**阻塞派发：工作区干净检查
对该目录放行（见下一条）。

**派发 Run 要求受管工程的工作区是干净的**（`git status` 全空，含未跟踪文件）。Run 的 worktree 基线
恒等于 `baseCommit`——工作区里未提交的改动**不会**被搬进工作树，否则"你本地看到的代码"与"Agent
改的代码"就是两棵不同的树。不干净时：确认 Plan 会给出提示（不阻断），派发则被硬阻断并列出具体
文件，处置办法是先提交或 stash。计划目录（`project.planDirectory`）是唯一被放行的例外。

API 的运行参数全部来自 `config/pipeline-factory.config.json`，也可以通过 `--config` 指定
其他配置文件；不读取环境变量。dev 下的 API 通过 `--conditions=pipeline-dev` 解析
`@pipeline-factory/domain`，命中 `packages/domain/package.json` 的 exports 条件
`"pipeline-dev": "./src/index.ts"`，因此运行时加载的是 domain 的**源码**而不是 `dist`——
热重载没有"忘了重新构建"这一环。这个条件只在 `apps/api` 的 `dev` 脚本里打开，`tsc` 与
`pnpm build && pnpm start` 走的仍是 `types`/`import`（`dist/`），两条路径互不影响。
`dev` 前置的 `predev` 仍会构建一次 domain，那是给 `tsc` 和编辑器解析类型用的，不是运行时依赖。
如果看到 `EADDRINUSE 127.0.0.1:4310`，表示 API 已经在运行，不要重复启动同一实例。

默认配置通过 `codex app-server --stdio` 接入本机 Codex App Server。Codex 的登录态和认证由 Codex 自身管理，Factory 不读取或保存 API Key。Explorer 会以 `read-only`/`never approval` 创建线程；Executor 使用独立角色配置和受控工作区策略。

结构化提问使用配置文件中的 `--enable default_mode_request_user_input` 开关（当前 Codex CLI 0.149.0 的 feature 名称；其他 CLI 版本若仍使用 `experimental_request_user_input`，只需在配置文件中替换该参数）：

```json
"args": ["app-server", "--stdio", "--enable", "default_mode_request_user_input"],
"roles": {
  "explorer": { "model": "gpt-5.6-luna", "mode": "plan", "temperature": 0.1 },
  "executor": { "model": "gpt-5.6-luna", "mode": "default", "temperature": 0 }
}
```

`roles.*.model` 必须匹配所配 provider 支持的模型名称：默认示例使用本机 Codex CLI 的 `gpt-5.6-luna`。传入 provider 不认识的模型名时，回合会在 Provider 侧直接失败。

## 接入 Claude Agent（`model.backend = "claude-agent-sdk"`）

`model.backend` 除 `codex-app-server` / `openai-responses` / `stub` 外还有 `claude-agent-sdk`：由官方 `@anthropic-ai/claude-agent-sdk` 的 `query()` 驱动 Claude Code。它与 Codex 后端**同构** —— 同一个 `ModelGateway` 端口、同一套 `ModelEvent`、同一套 Agent Loop 与门禁，两个后端可并存并按 Project 切换。

最小切换（端点与凭据交给 CLI 自己解析）：

```json
{
  "model": {
    "backend": "claude-agent-sdk",
    "roles": { "explorer": { "model": "claude-opus-5", "mode": "plan" }, "executor": { "model": "claude-opus-5", "mode": "default" } }
  }
}
```

需要把端点写死在配置里时（例如 cc-switch 的本地代理、或 DeepSeek 的 Anthropic 兼容端点 `https://api.deepseek.com/anthropic`）：

```json
{
  "model": {
    "backend": "claude-agent-sdk",
    "claudeAgent": { "baseUrl": "http://127.0.0.1:15721", "authToken": "…", "settingsPath": "./claude-settings.json", "maxTurns": 40 }
  }
}
```

- **不写 `claudeAgent` 是常规用法**：与 Codex 后端一样，Factory 不读环境变量、不存密钥，端点与凭据由 CLI 读自己的设置（`~/.claude/settings.json`；cc-switch 正是把 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN` 和模型映射写在这里）。`baseUrl`/`authToken` 是唯一显式覆盖点，集中在组合根读一次。
- **子进程环境是净化过的**：启动 Claude 时会剥掉全部 `ANTHROPIC_*`，以及"父进程本身是一个 Claude Code 会话"的标记（`CLAUDECODE`、`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`、`CLAUDE_CODE_HOST_AUTH_ENV_VAR` 等）。后者的实际影响很具体：带着这些标记启动的子会话会认为自己由宿主注入凭据，于是不去读 settings，直接以 `Not logged in` 收场。
- **配了 `baseUrl` 就在启动期探活**：探不通不起服务，错误里给出 URL 与"检查代理是否在跑"的提示，而不是等第一个探索回合跑到一半才失败。
- **每个 Loop 记一条端点指纹**：`agent.loop.started` 事件的 `provider` 字段记下 backend、端点 host（不含路径与令牌）、端点来源（`config` / `provider-settings`）、CLI 自报的版本、凭据来源标识与实际模型名（`agent.provider.thread.started` 会再补一次初始化后的完整指纹）。`endpoint: null` + `source: "provider-settings"` 是一个有用的事实而不是缺失：它明确表示**端点由 CLI 的设置（cc-switch）解析，Factory 不为这次 Run 担保端点**。注意由此带来的边界 —— 走 cc-switch 时真实上游（DeepSeek / Codex / 官方）对 Factory 不可见，指纹能证明"用的是哪个 CLI、哪个模型名、凭据从哪来"，但证明不了"上游是谁"。
- **模型名要换成 Anthropic 一侧的**（如 `claude-opus-5`）。启动时会自动迁移上一个 provider 家族留下的 slug：Claude 后端下的 `gpt-*` 与 Codex/OpenAI 后端下的 `claude-*`，只替换 `model` 字段、保留 mode 等设置；本地别名这类无法判定的名字不动（让 Provider 侧报错，而不是静默替换）。有活动 Run 的 Project 跳过迁移，下次启动重试。
- **能力差异**：结构化提问只有 Explorer 可用（Claude 侧走 `AskUserQuestion` → `canUseTool` 权限回调，答案经 `updatedInput` 回传，Web 侧的弹窗与答案流程完全复用），Executor 的工具集里不含它 —— Executor 没有答案回传通道，模型提问会卡到截止时间。Loop 模式仍只支持 `provider-controlled`。
- **用量栏只有 MODEL / CONTEXT 两格，没有账号额度**：这不是漏做。5 小时 / 7 天额度那两格与其接口（`GET /api/v4/codex/rate-limits`）已从页面与后端两侧一并删除 —— 它唯一的数据源是 Codex App Server 的**账号级**额度接口，与"这一回合用了什么模型、上下文占了多少"不是一类事实；Claude 侧根本没有这个接口（SDK 只在会话内提示限流）。要按回合看用量，读 `model.usage` 事件（`usage.ts` 归一化后的 token 数）。要把账号额度加回来，先回答"没有该接口的后端显示什么、额度按谁归属"，别退回到静默的"取不到"。
- **沙箱边界是会话 cwd**：Explorer 恒为 plan（只读）并把 `EXPLORER_PLAN_INSTRUCTIONS` 作为 plan 模式正文，Executor 为 `acceptEdits` 且 cwd 是 Run Worktree；任何要越出会话目录的请求由权限回调直接拒绝，也不申请 `additionalDirectories`。
- **会话记录落在 `~/.claude/projects/` 下**，这是多轮 Explorer 能续接的前提。换供应商、清目录、换机器后记录会消失，此时 Factory 用已持久化的 turns 重建一条新会话并回放对话（时间线上出现 `Provider session rebuilt`），而不是把一次可恢复的丢失判成回合失败。
- **cc-switch 这类"全局切换供应商"的工具会同时影响所有在跑的 Run**（它改的是 `~/.claude/settings.json`，而这是所有会话共享的端点来源）。切换前请停服，或确认没有活动 Run。

## 多后端：探索与执行各用一个 agent（`model.backends` + `roles.*.backend`）

Codex 与 Claude 可以**同时**跑在同一个进程里，并按角色各用一个：

```json
{
  "model": {
    "backend": "codex-app-server",
    "backends": {
      "deepseek": { "kind": "claude-agent-sdk", "models": ["deepseek-chat", "deepseek-reasoner"] }
    },
    "roles": {
      "explorer": { "backend": "codex-app-server", "model": "gpt-5.6-sol", "mode": "plan", "reasoningEffort": "high" },
      "executor": { "backend": "deepseek", "model": "deepseek-chat", "mode": "default", "reasoningEffort": "medium" }
    }
  }
}
```

- **四个 kind 名本身就是后端 id**：`codex-app-server` / `claude-agent-sdk` / `openai-responses` / `stub`。上例里 explorer 的 `backend` 完全可以省略不写（缺省跟随 `model.backend`），端点由 `model.codexAppServer` / `model.claudeAgent` / `model.openai` 三块提供。**注册表只在需要"同类两个不同端点"时才用**——例如探索走官方 Claude、执行走 DeepSeek 的 Anthropic 兼容端点。注册表项与 kind 同名时**覆盖**隐式后端。
- **解析顺序**：请求级配置（Project 的 `settings.models.<role>.backend`）→ 角色默认（`roles.<role>.backend`）→ 全局默认（`model.backend`）。因此每个 Project 可以覆盖，见 README 下文「Project 设置」与 `GET /api/v4/model-backends`。
- **`GET /api/v4/model-backends` 是"这个进程里能用哪些 agent"的唯一答案**：每条给出 `kind`、候选模型（注册表 `models` 或按 kind 的内置清单）、该后端**真正接受**的推理档位，以及端点指纹。控制台的 agent/模型/推理强度三个下拉全部读它。
- **档位是接线事实而不是建议**：Claude 侧只透传 `low/medium/high/xhigh/max`，配 `minimal`/`ultra` 等于没配且没有任何提示。所以 Project 设置保存时会拒绝该后端不接受的档位（`models.<role>.reasoningEffort is not supported by backend ...`），而不是等运行期静默丢弃。
- **`/health` 的 `modelBackend` 现在指 explorer 生效的后端**（兼容键），完整答案在 `modelBackends: { explorer, executor }`。
- **端点指纹按角色记**：`agent.loop.started` 的 `provider.backend` 是**这一次**真正执行的后端；不传角色且两个角色指向不同后端时，`describeEndpoint()` 如实回答 `backend: "mixed"`，而不是假装成某一个。Run 详情页的 AGENT 一格读的就是这条事实（旧 Run 的遥测里没有它，显示"未记录"）。
- **配置错误仍然在启动期失败**：角色默认后端在启动时构造，缺 `codexAppServer` 之类的必需字段会直接起不来；注册表里**没有角色引用**的后端保持懒构造，只有某个 Project 真指向它时才实例化（因此它的配置错误在第一次用到时暴露，而不是拖垮整个服务）。
- **两个已知耦合**：1) 分支名生成借的是 **explorer 角色**（`run/run-branch.ts`），所以**派发 Run 需要 explorer 后端在线**——explorer 后端故障会连带 Run 无法启动。2) 换 `roles.*.backend` 会触发**按角色**的模型 slug 迁移：只迁移"该角色 slug 的家族 ≠ 该角色后端家族"的项；**Project 显式写了 `backend` 的角色一律不迁移**（那是用户有意的选择，该由 Provider 侧报错暴露）。

v4 的 `POST /api/v4/projects/:projectId/explorer-thread/turns` 会立即返回 `202`，用户消息和 assistant `RUNNING` 占位先进入时间线；随后通过 `/events` SSE 接收文本增量、`turn.input_required`、完成和取消事件。选择答案通过 `/input-requests/:requestId/answer` 回传到同一个 Provider Turn。Explorer 不会把一次 `turn.completed` 直接当作设计完成：模型回合结束后会经过计划完整性门禁，缺少关键项时自动发起内部续探索，只有收到并校验 `pipeline-factory-plan` 完整契约后才自动生成 CandidatePlan。

核心 v4 资源路径保持稳定且唯一：

```text
GET      /api/v4/plans/:planId                 # 详情
POST     /api/v4/plans/:planId/{confirm,discard,enqueue,run}
PUT      /api/v4/plans/:planId/dependencies     # 前置 Plan（Factory-owned：模型不能填，只能由人挑）
PUT      /api/v4/plans/:planId/verification-suites # 按 tag 重挑验证子集（同样只让人挑 tag）
GET      /api/v4/runs/:runId                  # 详情
POST     /api/v4/runs/:runId/{cancel,pause,resume,guidance,verify}
GET      /api/v4/merge-requests/:mergeRequestId # 查询
POST     /api/v4/merge-requests/:mergeRequestId/confirm-merged
GET      /api/v4/projects/:projectId/runs
GET      /api/v4/projects/:projectId/activity   # 今日活动：执行完成 / 已合并 / 失败阻塞 / 跨日运行
GET      /api/v4/model-backends                 # 可用 agent 目录（见上文「多后端」）
GET/PUT  /api/v4/projects/:projectId/settings/hooks
GET      /api/v4/execution-threads/:threadId
```

### 调度闸门与并发

派发**之前**由 `PlanDispatchCoordinator.evaluateWait` 按固定顺序判定，命中的哪一条就是界面上显示的
等待原因：**依赖 → 缺命令 → 全局容量 → 项目容量 → 冲突**。

- **依赖**：前置 Plan 未达到 `MERGED` 时停在 `WAITING_DEPENDENCY`。依赖只能由人在 Plan 详情里设置
  （`PUT /plans/:planId/dependencies`），因为模型不知道 plan id，而这是调度用的真实 id 引用。
- **容量**：全局上限是 `runtime.globalConcurrency`，Project 上限是冻结快照里的
  `concurrency.maxParallelRuns`。**只算占槽位的状态**（`STARTING` / `IN_PROGRESS` / `VERIFYING`）——
  `READY_FOR_VERIFY` 与 `MERGE_READY` 已经在等人，不算在容量里；同一个 Plan 同一 Revision 的既有 Run
  是重试/续跑，也不与自己抢名额。**这是 2026-09-29 恢复的行为**：在此之前这两级上限声明了却从不判定，
  确认即并发跑；现在会按配置排队，Plan Center 显示等待原因。
- **冲突**：`conflicts`（模型声明的语义键）与在跑 Run 取交集，命中则停在 `WAITING_CONFLICT`。
  Project 可以选择 `concurrency.conflictScope: "overlap"`（默认 `"declared"`）：开启后**另外**比较两个
  Plan 的 `scope.includePaths` 是否重叠（相等或一个是另一个的父路径），且**只在同一 Project 内比较**
  ——include 是项目相对路径，两个项目里同名的 `src/index.ts` 不代表碰同一份文件。更保守（同目录下不相关的
  改动也会串行），所以默认关闭；`include: ["."]` 这类笼统范围在 overlap 下会与一切冲突，那是它该有的语义。
  等待原因里会写明是哪一片范围重叠（`overlapping scope code/apps/web/src`），排障不用猜。

Run 终态会触发协调器重新评估，排队的 Plan 因此自动让位。**合并不会自动发生**：`MERGE_READY` 之后
由人 review，然后二选一 —— 在 Git 侧合并后调 `confirm-merged`，或在项目的「Worktree 管理」面板里
预览并执行合并（那条路成功后会自动调 `confirm-merged`）。两条路都会顺带回收该 Run 的 Worktree
（**分支保留**）并跑一次 cleanup hook。

## Worktree 管理（项目视角）

每个项目的左栏都有「Worktree 管理」（地址 `?workspace=worktrees`，与「项目执行线程」同一套外壳）。
它盘点该仓库的本地分支与 worktree（含 detached），按 `no_updates` / `dirty_uncommitted` /
`committed_unmerged` / `merged_clean` / `merged_dirty` / `detached_*` 分类，提供合并预览、真实合并、
冲突续做/中止、三种清理、提交历史与 worktree 内的服务启停。这一能力迁自独立的 worktree-manage 工程：
**只搬业务能力**，不包含它的 Rust/Tauri 客户端、菜单栏、托盘与"打开终端 / SourceTree"这类桌面动作。

```text
GET  /api/v4/projects/:projectId/worktrees                    ?includeFiltered=1
POST /api/v4/projects/:projectId/worktrees/preview            { itemId }
POST /api/v4/projects/:projectId/worktrees/merge              { itemId, expectedBranchHead, expectedBaseHead }
POST /api/v4/projects/:projectId/worktrees/merge/continue
POST /api/v4/projects/:projectId/worktrees/merge/abort
POST /api/v4/projects/:projectId/worktrees/cleanup            { itemId, expectedBranchHead }
GET  /api/v4/projects/:projectId/worktrees/log                ?ref=&limit=
GET  /api/v4/projects/:projectId/worktrees/commits/:commit
GET  /api/v4/projects/:projectId/worktrees/commits/:commit/diff ?path=&previousPath=
GET  /api/v4/projects/:projectId/worktrees/services           ?itemId=
POST /api/v4/projects/:projectId/worktrees/services/start|stop { itemId, serviceId }
GET  /api/v4/projects/:projectId/worktrees/services/logs      ?itemId=&serviceId=
GET  /api/v4/projects/:projectId/worktrees/events             ?afterSequence=   (SSE)
```

### 合并

- **这是唯一真的执行合并的入口**。它做 `git switch <defaultBranch>` + `git merge --no-ff <branch>`，
  工作目录是受管仓库根目录。只有预览通过、且带回的两个 SHA 与当前状态一致时才执行；不一致返回
  `409 WORKTREE_STATE_CHANGED`（"我审核的那一版"与"实际合并的那一版"必须是同一版）。
- **阻断项**（任何一条成立都不能合并）：分支不存在 / 是主分支 / detached / 没有领先提交 / 已经合并 /
  worktree 有未提交改动 / 仓库根目录有未提交改动（Plan 留档目录与工具元数据目录放行）/ 项目有活动 Run /
  仓库里有进行中的合并、rebase、cherry-pick、revert 或 bisect / 主分支被另一个 worktree 占用 /
  MergeRequest 的目标分支与项目默认分支不一致。
- **冲突后停在合并中**：不自动 `merge --abort`（那是用户的工作），也不自动 `--continue`。
  面板顶部常驻横幅并列出冲突文件；其它进行中的 Git 操作只提示、不提供继续/中止（那些要在 Git 里收尾）。
- **合并成功后追回 Factory**：若该分支属于某条 Run 且有 `OPEN` 的 MergeRequest，就用合并后的 HEAD
  调 `MergeService.confirmMerged`（Plan → `MERGED`），并回收 Worktree、唤醒调度协调器。这一步失败
  只作为提醒返回，**不回滚已经发生的合并**；`SUPERSEDED` 的请求不会因为这次合并被承认。

### 清理（三种对象，共用一条命令）

| kind                          | 前提                                                           |
| ----------------------------- | -------------------------------------------------------------- |
| `branch_worktree`             | 分支已合并 + 工作区干净 + 不是活动 Run 的 workspace            |
| `local_branch`（无 worktree） | 分支已合并 + **不是仓库当前检出的分支**                        |
| `detached_worktree`           | 工作区干净 + **HEAD 已被某个本地分支包含**（否则删掉就丢提交） |

三者都要求项目没有活动 Run、仓库没有进行中的 Git 操作。**清理前会先停掉该 worktree 上由本应用启动的服务**
——目录删掉之后进程就成了没有归属的孤儿。删目录用 `git worktree remove --force`
（干净性由我们自己的判据负责：工具元数据目录不算脏，不带 force 时 git 会因为它拒绝删除），
删分支先用 `git branch -d`；被拒时**再用 `merge-base --is-ancestor` 复核一次"已合并进主分支"**，成立才降到
`-D`（`git -d` 只与 HEAD 比较，repoRoot 停在别的分支时会误拒）。属于 Run 的 worktree 会走 `Scheduler.releaseWorkspace`，
所以 cleanup 钩子照常执行；钩子失败不阻止删除，但会作为 `cleanupHookNeedsAttention` 返回。

### 项目范围

配置入口在**「项目设置 → Worktree」页签**（面板上的「在项目设置中配置」直接跳到那一页）：
`filterMode`（`all` / `patterns`）、`branchPatterns`（`*`、`prefix*`、精确名）、
`ignoredBranches`（按分支勾选，显式隐藏）、`includeDetachedWorktrees`。
面板本身只留两个**动作**：「显示被过滤的 N 项」与每条分支的「忽略 / 取消忽略」——范围是项目属性，
编辑器只有设置页这一处。主分支永远显示；被过滤的项可以通过 `?includeFiltered=1`（界面上是
「显示被过滤的 N 项」）看回来，**写操作始终按全量清单解析目标**，隐藏不会让合并变成"不存在"。
「曾经合并过」（`was_merged_before`）来自 Factory 自己记的合并事件，只覆盖从这个面板执行过的合并。

**这些字段不属于执行配置**：它们不参与 `configHash`，改动也不推进 `configVersion`。所以"忽略一条分支"
不会让正在走的 Plan 被判成"配置已变化，请重新生成"（`PlanService.confirm` 正是拿这两个值判过期的）。

### 其它

- **自动刷新**：面板挂载时订阅 `worktrees/events`（SSE），事件里只有 `type + sequence`，
  收到后防抖 400ms 重拉清单；清单内容仍以重拉结果为准，不做本地增量推断。断线重连成功后补一次刷新
  （断线期间的事件不会补推）。
- **服务启停**：读取 worktree 根目录下的 `.pipeline-factory/services.json`（原生，`argv` 直接执行），
  兼容 `.worktree-manage/services.json`（`start_command` 走 `sh -lc`）。`workdir` 解析后必须仍在
  worktree 内；**只停止本进程启动的子进程**（先 SIGTERM 进程组、3 秒后 SIGKILL），不按端口杀。
  这两个目录被排除在"工作区脏"判据之外，也排除在 Run 的自动提交之外（`git add -A` 不提交它们）
  ——本机运行配置不该让 worktree 变成不可合并，更不该随合并进主干。
- **依赖文件夹软链**：「项目设置 → Worktree」里的 `linkedFolders`（`node_modules`、`.next`、
  `target`…，相对仓库根目录）。**新建 Run 的 worktree 时自动建链**，已有 worktree 可在面板里点
  「补齐依赖软链」。规则：只在该目录**存在于主仓库、且目标位置不存在**时建链；**不覆盖**已有内容、
  **不改 Git 索引**（被跟踪的依赖目录应当由仓库自己 gitignore）；失败只报告、不影响 Run；
  这些目录也会被排除在 Run 的自动提交之外（否则会把"指向本机主仓库的符号链接"发到主干上）。
  它**属于执行配置**：改它会推进 `configVersion`，未确认的候选方案需要重新生成。
- **项目级兜底服务配置**：worktree 里没有配置文件时，用「项目设置 → Worktree」里的
  `settings.worktreeServices`（JSON 数组，字段与 `services.json` 的 `services` 相同）。
  **文件整份优先，两份不合并**；文件存在但解析失败时也不回落——那会把"文件写坏了"伪装成
  "用了另一份配置"。响应里的 `configSource` 会说明这次用的是 `worktree-file` 还是 `project-fallback`。
- **提交历史**：`log` / `commits` / `diff` 三条只读接口，界面上的「提交历史」对话框用它们；
  只读，不 checkout、不 reset。
- **git 版本**：冲突预测依赖 `git merge-tree --write-tree`（≥ 2.38），`git switch` 需要 ≥ 2.23。
  版本更旧时冲突预测显示"不可用"，但**不影响合并本身**。
- **性能**：清单按项目范围先过滤再跑 git；每条分支的 ahead/behind 用有界并发（8）执行；
  worktree 的脏/冲突判定合并为一次 `status --porcelain -z`；分支数超过 300 条时截断并标记。

## 执行目录（合并前验证）

合并前想亲手点一遍"这个改动到底对不对"，但每个 worktree 的路径都不一样——端口与配置文件往往按路径写，
验证一次就要来回对照。执行目录给每个项目一个**固定路径**：

```text
<project.worktreeRoot>/.runtime/
  ├── repo -> /abs/path/worktrees/<branch>   ← 切换只改这一条（原子替换）
  └── services.json                          ← 可选：跨分支固定的服务/端口配置
```

- **位置由 `worktreeRoot` 派生**，没有新设置项；以 `.` 开头，不会与 Run 的 worktree 目录撞名
  （分支叶子名正则不允许以点开头），也不在 `git worktree list` 里。
- **当前目标只由 `readlink(repo)` 决定**，不另存状态：重启进程、手动改链接都自洽。
  `repo` 若是真实目录/文件，切换与清空一律拒绝——那是用户自己的东西，我们不删。
- **切换语义**：先停掉通过执行目录启动的服务 → 建临时链接再 `rename` 覆盖（不 `unlink`+`symlink`，
  否则中间那一刻服务会拿到 ENOENT）。可选「切换并启动」：依次启动所有 `enabled` 服务，任一失败即停。
- **服务配置优先级**：`<runtime>/services.json` → 目标 worktree 的
  `.pipeline-factory/services.json` / `.worktree-manage/services.json` → 项目设置里的兜底。
  文件存在但解析失败**不向下回落**（坏配置要被看见）。响应里的 `configSource` 会说明用的是
  `runtime` / `worktree-file` / `project-fallback`。
- **与清理的关系**：当前执行目录目标不能被清理（链接会悬空），先切走或清空；合并不受影响。
- **能力边界**：符号链接改变的是"路径"，不是"进程的物理 cwd"——`getcwd()` 仍会解析成 worktree 的
  真实路径。面向"配置与端口按路径写"的验证场景成立；两个分支同时占用同一组端口不可能靠它解决
  （单执行目录本就是串行验证）。Windows 上创建符号链接需要开发者模式。

```text
GET  /api/v4/projects/:projectId/runtime
POST /api/v4/projects/:projectId/runtime/switch   { itemId }
POST /api/v4/projects/:projectId/runtime/clear
GET  /api/v4/projects/:projectId/runtime/services
POST /api/v4/projects/:projectId/runtime/services/start|stop  { serviceId }
GET  /api/v4/projects/:projectId/runtime/services/logs        ?serviceId=
```

> 为什么**不引入 workspace 聚合**（把多个仓库当成一个单元一次建 worktree）：
> 本工程的 `Plan` 契约绑定单一仓库、Run 只认一个 `worktreeRoot`，引入它要同时改契约、预检、派发、
> 合并与权限；而"路径/端口固定"这件事单仓库内部就能解决。需要"前后端一键一起切"时，
> 后续可以加一个轻量「执行组」而不动模型。

## Plan V2 与项目验证

新 Explorer 只能产出 `GeneratedPlanSpec`（`schemaVersion: 2`）。模型可以声明目标、范围、任务、验证模式和合并意图，但不能提供项目 ID、仓库路径、Git branch/commit、配置版本/哈希或任何命令 ID。Factory 在候选生成时用已绑定 Project、真实 Git 基线和冻结的 Project 配置解析为 `ResolvedPlanContract`；绝对路径、`..` 路径穿越和概念性 scope 会被拒绝。Project 配置在 Confirm 前变化会使 Candidate 过期，已 Confirm 的 Revision 始终使用冻结快照。

**契约只有这一份**：Executor、Verifier、Merge 与界面都读它。曾经与它并存的 V1 扁平合同（`contract` 字段）是一份有损副本（`dependsOnPlanIds` 恒为 `[]`、`priority` 归 0），字段名短反而被界面优先读，已经整个删掉——类型、生成那份副本的函数、库里那四列都不在了。

契约里有一对很容易混的字段：`dependencies` 是**模型写的自然语言先决条件**（"需要 Node.js 22"），`dependsOnPlanIds` 是 **Factory-owned 的前置 Plan id**（解析时恒为 `[]`，只能由人经 `PUT /api/v4/plans/:planId/dependencies` 设置，dispatch 拿它做 `WAITING_DEPENDENCY` 判定）。两者不能互相顶替——共用同一个字段的结果就是等一个名叫"需要 Node.js 22"的 Plan。

Project Commands 分为 `verification`、`lifecycle` 和 `executor-tool`。每条命令都有受控 argv、说明、enabled、环境与默认超时；

**按 tag 选验证子集**：verification 命令还可以声明 `tags`（如 `unit` / `types` / `docs`），
Plan 的 `verification.suites` 用这些 tag 挑一个子集——模型声明"要哪一类验证"，
**命令 ID 始终由 Factory 解析**（模型既看不到也不能填 ID）。候选态还可以在 Plan 详情里人工改这个子集
（`PUT /api/v4/plans/:planId/verification-suites`，勾选项只能来自项目登记的 tag；不勾 = 回到项目默认全集），
确认后随 Revision 冻结。解析规则宁可失败也不静默改语义：
声明了项目未登记的 tag、或合法 tag 一条默认命令都没命中，方案都会被拒绝并列出已登记词表。
tag 词表通过仓库上下文注入 Explorer 回合（只有 tag，没有命令 ID）。
`defaultVerificationCommandIds` 是 Project 管理员维护的有序集合，模型不能选择或发明其中任何 ID。集合为空时 V2 解析为 `verification.mode=NONE`：Verifier 持久化 `SKIPPED / NO_PROJECT_VERIFICATION_COMMANDS`，随后进入 `MERGE_READY`，界面会明确显示“未配置自动验证”，不会显示为通过。V1 扁平合同已不再支持：它既读不出来，也没有可表达它的形状，老库启动时会自动丢弃 `contract_json` 列。

Plan 列表接口只返回轻量 Summary；`GET /api/v4/plans/:planId` 返回 Plan、冻结 Revision、Project 快照和调度状态。Web 的 Full Plan 抽屉始终按 ID 获取该详情，加载失败会显示错误而不是呈现演示性 scope、命令或 artifact hash。

SSE 使用数据库事件序列和 `Last-Event-ID` 回放。Explorer 首次加载 turns 时取得当前事件游标，再从该游标订阅 SSE，避免重复回放历史消息；断线重连仍按 `Last-Event-ID` 补发遗漏事件。App Server 重启或答案响应不确定时，输入请求进入 `RECOVERY_REQUIRED`，Factory 不自动重复提交。敏感答案只在内存中传给 App Server，持久化的仅是题目状态和答案数量摘要；普通 assistant 文本中的“请选择”不会触发弹窗。

可选后端也在配置文件中声明：`stub`、`openai-responses`（需要在配置文件的 `model.openai.apiKey` 提供密钥），或 `claude-agent-sdk`（见上文「接入 Claude Agent」）。示例配置只保留可用的 `codex-app-server` 形态：`claudeAgent` 的 `baseUrl`/`settingsPath` 一旦写错就会在启动期失败，不适合作为"复制即用"的默认值放进示例。

Explorer 的持续探索参数也来自配置文件：`runtime.maxAutoContinuationTurns` 默认值为 4，表示一次用户消息最多自动续探索 4 次。达到上限仍未形成完整契约时，线程保持 `INCOMPLETE`，页面会显示尚未确认的设计区域，用户可以继续发送下一轮说明；不会生成可确认的 CandidatePlan。

## Agent Loop 运行模型

Pipeline Flow 负责 Plan、Run、Verify 和 Merge 的业务事实；Agent Loop 负责一个 Explorer Turn 或 Executor Run 内的多次模型步骤、工具调用、结构化提问、上下文摘要和终止门禁。两层不能互相替代：模型输出“完成”不会越过 `PlanCompletenessGate` 或 `TaskProgressGate`，Verifier 也不属于模型 Loop。

- `provider-controlled`：Codex App Server 自己拥有工具循环。Factory 只消费流式文本、结构化提问、取消和生命周期事件，不重复执行 Provider 内部工具。
- `factory-controlled`：ModelGateway 必须声明 `supportsToolCalls=true`，工具请求交给 DurableToolRuntime/ToolGateway 执行；能力不足时返回 `MODEL_CAPABILITY_UNAVAILABLE`，不静默降级。
- Explorer 固定为 Provider-controlled + Plan Mode + read-only；Executor 的模式从配置读取，但默认也是 Codex App Server Provider-controlled。两种循环禁止嵌套。

每个 Loop 都持久化 `agent_loops`、连续的 `agent_loop_steps`、checkpoint 和 Domain Event。**落库的正文按「文本段」一条**：40ms 的刷新定时器只驱动在线可见性（`agent.model.text.delta` 仍逐次派发，Explorer 的回合正文与项目执行线程靠它累积），而步骤表与 Run journal 在段结束时才写一条——段的边界与各自的读取方逐字相同（`explorer-activity` 合并助手气泡、`projectExecutionJournal` 合并执行会话），所以页面上一条都不变。启动时还会把老库里已有的碎片按同一规则并段，并删掉能逐个聚合证明「另有副本」的正文事件（3 个副本不成立的回合会保留，那是唯一记录）；判据、实测数字与 `VACUUM` 的顺序见 `docs/消息类型及事件状态机流程图.md` 的 §7。达到最大步骤/时长、重复工具调用或无进展阈值时停止；暂停、取消会阻止新步骤并中断当前 Provider Turn。未知副作用、服务重启时没有活动 Provider Turn 的 Loop 进入 `RECOVERING` 或 `NEEDS_RECONCILIATION`，不自动重放。

Executor 只有输出结构化执行报告并通过 `TaskProgressGate` 后才会进入 `READY_FOR_VERIFY`。验证命令由 Verifier 脱离模型会话执行，失败可按 PlanRevision 的上限回到同一 ExecutionThread 修复，超过上限进入 `BLOCKED`。范围、依赖或验收不足时创建 ChangeProposal；批准后生成新的不可变 Revision 和新的 Run，旧 Run 保持原始事实。

Loop 管理接口为 `GET/POST /api/v4/agent-loops/:loopId`、`steps`、`events`、`pause`、`resume` 和 `cancel`。`events` 在 `Accept: text/event-stream` 时返回 SSE，并按 `Last-Event-ID` 回放持久化事件；默认 JSON 形式方便管理页和诊断工具读取。Run 详情页展示 Loop、最近步骤、工具调用、验证和门禁结果。

ChangeProposal 的 API 为 `POST /api/v4/runs/:runId/change-proposals`、`GET /api/v4/runs/:runId/change-proposals` 和 `POST /api/v4/change-proposals/:proposalId/approve`。批准接口在 Scheduler 可用时会自动创建新 Run，否则保留 `QUEUED` 事实等待调度。

## 验证

```bash
./node_modules/.bin/vitest run packages/domain/src/index.test.ts apps/api/src/server.test.ts
./node_modules/.bin/tsc -p packages/domain/tsconfig.json
./node_modules/.bin/tsc -p apps/api/tsconfig.json --noEmit
./apps/web/node_modules/.bin/vue-tsc -p apps/web/tsconfig.json --noEmit
./apps/web/node_modules/.bin/vite build
```

测试中可注入内存适配器；运行时默认使用 SQLite WAL。当前还未接入自动 Merge 操作，合并仍必须由人工完成后通过 `confirm_merged` 语义确认。

一条命令跑完全部门禁（domain build → typecheck → lint → format → 三个包的用例 → 循环依赖检查）：

```bash
pnpm --dir code verify
```

## 代码规范与提交钩子

工具链是 ESLint（flat config）+ typescript-eslint + eslint-plugin-vue + Prettier，配置在
`eslint.config.js` 与 `.prettierrc.json`，几个不显然的取舍都写在配置文件的注释里。

```bash
pnpm --dir code lint          # 只判断，不改文件
pnpm --dir code lint:fix
pnpm --dir code format        # Prettier 全量重排
pnpm --dir code format:check
```

`pnpm verify` 里的 lint 与 format 两个阶段用的就是上面这条 `check` 形式——**门禁只判断合不合格，不替你改文件**。

**提交钩子**（`scripts/git-hooks/pre-commit`）只处理这次**暂存**的文件：先 Prettier 排版、再 ESLint
修可自动修的问题，然后把结果重新暂存。

```bash
pnpm --dir code hooks         # 装/重装钩子（写 core.hooksPath）
```

`pnpm install` 会通过 `prepare` 自动装，**新克隆的仓库不需要额外操作**；已经装过依赖的仓库如果发现钩子没生效
（pnpm 在"依赖没变化"时会跳过 `prepare`），手动跑一次上面那条即可。

两点需要知道：

- **不用 husky**：本仓的 git 根在**上一级**（`pipeline-factory/`），而工作区与 `package.json` 在 `code/`。
  husky 要求 `.git` 就在它运行的那个目录里，`pnpm exec husky` 直接报 `.git can't be found`。这里只做它真正
  必要的那一件事：设 `core.hooksPath`。
- **部分暂存的文件会拦下提交**，而不是偷偷替你决定：一个文件若同时有暂存与未暂存的改动，对工作区文件跑
  `--write` 会把你还没打算提交的那部分一起格式化、随后的 `git add` 又会它一并暂存——提交范围被静默放大。
  钩子会列出这些文件并说明三种处理方式。
- 确实想跳过：`git commit --no-verify`。
