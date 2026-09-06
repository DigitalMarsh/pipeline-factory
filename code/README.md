# AI Software Pipeline Factory v4

这是 v4 设计对应的 TypeScript/Vue 最小可运行实现，代码范围限定在本目录。v4 是唯一的 HTTP API、Web 客户端调用方式和测试协议，并通过 Codex App Server 支持异步 Plan Mode 结构化提问。

## 目录

代码注释规范见仓库根目录的 [`docs/COMMENTING.md`](../docs/COMMENTING.md)。

- `packages/domain`：Plan 状态、ExplorerThread 谱系投影、生命周期 Hook 领域服务。
- `apps/api`：Node.js + Fastify API，提供 ExplorerThread、Plan confirm/enqueue、Plan 查询、Hook 配置和 v4 SSE/结构化输入接口。
- `apps/web`：Vue 3 + Vite + Element Plus 控制台，提供 ExplorerThread 工作区、Full Plan 抽屉、结构化选择弹窗和 Plan Center。

## 本地运行

从项目根目录可以使用独立脚本管理两个服务；停止其中一个不会影响另一个：

```bash
./startApi.sh
./stopApi.sh
./startWeb.sh
./stopWeb.sh
./status.sh
```

脚本会把 PID 和日志保存到项目根目录的 `.runtime/`，其中 API 日志为 `.runtime/api.log`，Web 日志为 `.runtime/web.log`。

也可以继续使用下面的手动启动命令：

```bash
pnpm install
pnpm --filter @pipeline-factory/domain build
pnpm --filter @pipeline-factory/api dev -- --config ./config/pipeline-factory.config.json
pnpm --filter @pipeline-factory/web dev
```

API 默认监听 `http://127.0.0.1:4310`，前端默认监听 `http://127.0.0.1:5173`。API 的运行参数全部来自 `config/pipeline-factory.config.json`，也可以通过 `--config` 指定其他配置文件；不读取环境变量。

`@pipeline-factory/api` 的 `dev` 命令会先自动构建 workspace domain 包，避免 API 加载旧的 `dist` 类型；如果看到 `EADDRINUSE 127.0.0.1:4310`，表示 API 已经在运行，不要重复启动同一实例。

复制 `config/pipeline-factory.config.example.json` 后，按受管项目修改 `project.root`、`storage`、固定命令和 `model` 配置：

```json
{
  "project": {
    "root": "/absolute/path/to/your/project",
    "commands": [
      { "commandId": "project.start", "argv": ["/absolute/path/to/node", "scripts/start.mjs"], "environment": { "PATH": "/absolute/path/to/bin:/usr/bin:/bin" } },
      { "commandId": "project.cleanup", "argv": ["/absolute/path/to/node", "scripts/cleanup.mjs"], "environment": { "PATH": "/absolute/path/to/bin:/usr/bin:/bin" } }
    ]
  }
}
```

默认配置通过 `codex app-server --stdio` 接入本机 Codex App Server。Codex 的登录态和认证由 Codex 自身管理，Factory 不读取或保存 API Key。Explorer 会以 `read-only`/`never approval` 创建线程；Executor 使用独立角色配置和受控工作区策略。

结构化提问使用配置文件中的 `--enable default_mode_request_user_input` 开关（当前 Codex CLI 0.149.0 的 feature 名称；其他 CLI 版本若仍使用 `experimental_request_user_input`，只需在配置文件中替换该参数）：

```json
"args": ["app-server", "--stdio", "--enable", "default_mode_request_user_input"],
"roles": {
  "explorer": { "model": "gpt-5.6-luna", "mode": "plan", "temperature": 0.1 },
  "executor": { "model": "gpt-5.6-luna", "mode": "default", "temperature": 0 }
}
```

v4 的 `POST /api/v4/projects/:projectId/explorer-thread/turns` 会立即返回 `202`，用户消息和 assistant `RUNNING` 占位先进入时间线；随后通过 `/events` SSE 接收文本增量、`turn.input_required`、完成和取消事件。选择答案通过 `/input-requests/:requestId/answer` 回传到同一个 Provider Turn。Explorer 不会把一次 `turn.completed` 直接当作设计完成：模型回合结束后会经过计划完整性门禁，缺少关键项时自动发起内部续探索，只有收到并校验 `pipeline-factory-plan` 完整契约后才自动生成 CandidatePlan。

核心 v4 资源路径保持稳定且唯一：

```text
GET      /api/v4/plans/:planId                 # 详情
POST     /api/v4/plans/:planId/{confirm,discard,enqueue,run}
GET      /api/v4/runs/:runId                  # 详情
POST     /api/v4/runs/:runId/{cancel,pause,resume,guidance,verify}
GET      /api/v4/merge-requests/:mergeRequestId # 查询
POST     /api/v4/merge-requests/:mergeRequestId/confirm-merged
GET      /api/v4/projects/:projectId/runs
GET/PUT  /api/v4/projects/:projectId/settings/hooks
GET      /api/v4/execution-threads/:threadId
```

## Plan V2 与项目验证

新 Explorer 只能产出 `GeneratedPlanSpecV2`（`schemaVersion: 2`）。模型可以声明目标、范围、任务、验证模式和合并意图，但不能提供项目 ID、仓库路径、Git branch/commit、配置版本/哈希或任何命令 ID。Factory 在候选生成时用已绑定 Project、真实 Git 基线和冻结的 Project 配置解析为 `ResolvedPlanContractV2`；绝对路径、`..` 路径穿越和概念性 scope 会被拒绝。Project 配置在 Confirm 前变化会使 Candidate 过期，已 Confirm 的 Revision 始终使用冻结快照。

Project Commands 分为 `verification`、`lifecycle` 和 `executor-tool`。每条命令都有受控 argv、说明、enabled、环境与默认超时；`defaultVerificationCommandIds` 是 Project 管理员维护的有序集合，模型不能选择或发明其中任何 ID。集合为空时 V2 解析为 `verification.mode=NONE`：Verifier 持久化 `SKIPPED / NO_PROJECT_VERIFICATION_COMMANDS`，随后进入 `MERGE_READY`，界面会明确显示“未配置自动验证”，不会显示为通过。旧 flat V1 artifact 仅保留为历史记录，不能由 V2 Explorer 流程重新执行。

Plan 列表接口只返回轻量 Summary；`GET /api/v4/plans/:planId` 返回 Plan、冻结 Revision、Project 快照和调度状态。Web 的 Full Plan 抽屉始终按 ID 获取该详情，加载失败会显示错误而不是呈现演示性 scope、命令或 artifact hash。

SSE 使用数据库事件序列和 `Last-Event-ID` 回放。Explorer 首次加载 turns 时取得当前事件游标，再从该游标订阅 SSE，避免重复回放历史消息；断线重连仍按 `Last-Event-ID` 补发遗漏事件。App Server 重启或答案响应不确定时，输入请求进入 `RECOVERY_REQUIRED`，Factory 不自动重复提交。敏感答案只在内存中传给 App Server，持久化的仅是题目状态和答案数量摘要；普通 assistant 文本中的“请选择”不会触发弹窗。

可选后端也在配置文件中声明：`stub`，或 `openai-responses`（需要在配置文件的 `model.openai.apiKey` 提供密钥）。

Explorer 的持续探索参数也来自配置文件：`runtime.maxAutoContinuationTurns` 默认值为 4，表示一次用户消息最多自动续探索 4 次。达到上限仍未形成完整契约时，线程保持 `INCOMPLETE`，页面会显示尚未确认的设计区域，用户可以继续发送下一轮说明；不会生成可确认的 CandidatePlan。

## Agent Loop 运行模型

Pipeline Flow 负责 Plan、Run、Verify 和 Merge 的业务事实；Agent Loop 负责一个 Explorer Turn 或 Executor Run 内的多次模型步骤、工具调用、结构化提问、上下文摘要和终止门禁。两层不能互相替代：模型输出“完成”不会越过 `PlanCompletenessGate` 或 `TaskProgressGate`，Verifier 也不属于模型 Loop。

- `provider-controlled`：Codex App Server 自己拥有工具循环。Factory 只消费流式文本、结构化提问、取消和生命周期事件，不重复执行 Provider 内部工具。
- `factory-controlled`：ModelGateway 必须声明 `supportsToolCalls=true`，工具请求交给 DurableToolRuntime/ToolGateway 执行；能力不足时返回 `MODEL_CAPABILITY_UNAVAILABLE`，不静默降级。
- Explorer 固定为 Provider-controlled + Plan Mode + read-only；Executor 的模式从配置读取，但默认也是 Codex App Server Provider-controlled。两种循环禁止嵌套。

每个 Loop 都持久化 `agent_loops`、连续的 `agent_loop_steps`、checkpoint 和 Domain Event。达到最大步骤/时长、重复工具调用或无进展阈值时停止；暂停、取消会阻止新步骤并中断当前 Provider Turn。未知副作用、服务重启时没有活动 Provider Turn 的 Loop 进入 `RECOVERING` 或 `NEEDS_RECONCILIATION`，不自动重放。

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
