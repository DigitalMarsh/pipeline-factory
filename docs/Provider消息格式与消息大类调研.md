# Provider 消息格式与消息大类调研

> 调研对象：本仓接入的两个模型后端（Codex App Server、Claude Agent SDK），以及它们返回的消息
> 在业务层与界面上的归宿。
>
> 结论**以代码与真实数据为准**：Provider 侧取自本机安装的 `codex app-server generate-json-schema`
> （codex-cli 0.149.0）与 `@anthropic-ai/claude-agent-sdk@0.3.283` 自带的 `sdk.d.ts`；
> Factory 侧取自 `packages/domain/src/model/`、`packages/domain/src/agent/`、
> `apps/web/src/utils/{explorerPresentation,executionStream}.ts`；
> 「实际到达了什么」取自本机运行库 `code/pipeline-factory.sqlite`。
>
> 本文只做调研与建议，**不含任何实现改动**。

---

## 0. 结论速览

| 问题 | 一句话回答 |
|---|---|
| 两个 Provider 的消息格式 | **完全不是一回事**：Codex 是 75 条 JSON-RPC 通知 + 18 种 ThreadItem；Claude 是 39 种 SDKMessage + 一套 content block。两者只有"文本增量、工具调用、用量、回合结束"四处对得上。 |
| 消息大类怎么分 | 三分法（用户 / 模型 / 运行时）**不够用**：它把"模型说的正文"和"模型做的动作"混成一类（这两类在 OpenClaw 与 Hermes 里是**两种排版**），也把"Provider 的运行事实"和"Factory 自己的生命周期"混成一类（这两类的**归属层**不同）。建议 **5 类**，见 §2。 |
| 有没有接入网关 | **有，而且形状是对的**：`RoutingModelGateway`（路由）+ `ModelGateway`/`ModelEvent`（端口）+ `provider-activity.ts`（词表翻译）+ 各 Provider 适配器。缺的不是架构，是**中立词表的粒度太粗**——Provider 有 18/39 种消息，中立类别只有 8 个，于是 12 种 Codex item 一律落进 `other` → 界面显示成「未识别」。 |
| 呈现参考 | OpenClaw 与 Hermes 在**同一件事上完全一致**：正文之外的一切（工具行、推理、压缩、运行事实）都要么折成一行、要么折进一个可展开的容器、要么移出会话。**没有一家把模型的动作画成卡片。** |

---

## 1. 两个 Provider 到底返回什么

### 1.0 先说清两边的接入方式根本不同

| 维度 | Codex App Server | Claude Agent SDK |
|---|---|---|
| 接入形态 | 自己 spawn 子进程，走 **JSON-RPC over stdio** | 走官方 SDK 的 `query()` async iterable |
| 谁维护协议 | **我们**（`codex-app-server.ts` 634 行里大半是协议客户端、通知订阅、重启与超时） | SDK（`claude-agent-sdk.ts` 只需映射消息） |
| 协议规模 | server→client **通知 75 条**、**请求 10 条**；另有 18 种 ThreadItem | **39 种 `SDKMessage`**；`assistant` 消息内的 content block 另有一套 |
| 适配器现在读了几条 | **5 条**：`item/agentMessage/delta`、`item/started`、`item/completed`、`item/tool/requestUserInput`、`turn/completed`（+ 三类 tokenUsage 别名） | **5 种**：`system/init`、`stream_event`、`assistant`、`user`、`result` |
| 状态词表 | `inProgress` / `completed` / `failed` / `declined` | `started` / `succeeded` / `failed` + `is_error` |

> 读 5 条不是问题——协议大不等于每条都有用。问题在 §1.5：**没读的那些里有界面真正需要的**。

### 1.1 Codex App Server 的消息清单

#### (a) 通知（`ServerNotification`，75 条）

按用途分七组：

| 组 | 条数 | 代表 |
|---|---|---|
| **会话与线程生命周期** | 19 | `thread/started`、`thread/status/changed`、`thread/name/updated`、`thread/queue/changed`、`thread/goal/updated`、`thread/environment/connected`、`thread/settings/updated`、`thread/reverted`、`thread/compacted` |
| **回合与流式增量** | 9 | `turn/started`、`turn/completed`、`item/started`、`item/completed`、`item/agentMessage/delta`、`item/plan/delta`、`item/reasoning/summaryTextDelta`、`item/reasoning/textDelta`、`item/reasoning/summaryPartAdded` |
| **动作的输出流** | 8 | `item/commandExecution/outputDelta`、`item/commandExecution/terminalInteraction`、`item/fileChange/outputDelta`、`item/fileChange/patchUpdated`、`item/mcpToolCall/progress`、`command/exec/outputDelta`、`process/outputDelta`、`process/exited` |
| **审批与安全** | 6 | `item/autoApprovalReview/started`、`item/autoApprovalReview/completed`、`autoApprovalReview/strictReviewRequired`、`serverRequest/resolved`、`turn/moderationMetadata`、`model/safetyBuffering/updated` |
| **账号与额度** | 4 | `account/updated`、`account/rateLimits/updated`、`account/login/completed`、`model/rerouted` |
| **告警与提示** | 6 | `warning`、`guardianWarning`、`configWarning`、`deprecationNotice`、`model/verification`、`windows/worldWritableWarning` |
| **实时语音 / 其他** | 剩余 | `thread/realtime/*`（8 条）、`fs/changed`、`fuzzyFileSearch/*`、`remoteControl/status/changed`、`externalAgentConfig/import/*` |

#### (b) 线程条目（`ThreadItem`，18 种）

这才是"对话里到底有什么"的完整词表：

| # | `type` | 关键字段 | 是什么 |
|---|---|---|---|
| 1 | `userMessage` | `content`, `clientId` | **你说的**（Provider 回声） |
| 2 | `agentMessage` | `text`, **`phase`**(`commentary`\|`final_answer`), `memoryCitation`, `delivery` | **模型说的**（且自带"过程叙述 / 最终回答"的区分） |
| 3 | `plan` | `text` | 模型写的整篇计划 |
| 4 | `reasoning` | `content[]`, `summary[]` | 模型的推理（原文与摘要分开给） |
| 5 | `commandExecution` | `command`, `commandActions`, `cwd`, `exitCode`, `aggregatedOutput`, `durationMs`, `status`, `processId` | 跑了一条命令 |
| 6 | `fileChange` | `changes`, `status` | 改了文件（带 patch） |
| 7 | `mcpToolCall` | `server`, `tool`, `arguments`, `result`, `error`, `durationMs`, `status` | MCP 调用 |
| 8 | `dynamicToolCall` | `namespace`, `tool`, `arguments`, `contentItems`, `success` | 动态工具调用 |
| 9 | `collabAgentToolCall` | `agentsStates`, `receiverThreadIds`, `senderThreadId`, `prompt`, `model` | 子代理调用 |
| 10 | `subAgentActivity` | `agentPath`, `agentThreadId`, `kind` | 子代理的活动 |
| 11 | `webSearch` | `action`, `query`, `results` | 联网搜索 |
| 12 | `imageView` | `path` | 看了张图 |
| 13 | `imageGeneration` | `savedPath`, `revisedPrompt`, `transparentBackground`, `status` | 生成了图 |
| 14 | `sleep` | `durationMs` | 等待 |
| 15 | `hookPrompt` | `fragments` | 钩子往对话里插的提示 |
| 16 | `enteredReviewMode` / `exitedReviewMode` | `review` | 进入/退出评审模式 |
| 17 | `contextCompaction` | — | 上下文压缩发生在此处 |

（表里 18 种，`entered/exitedReviewMode` 算两种。）

### 1.2 Claude Agent SDK 的消息清单

#### (a) `SDKMessage` 联合（39 种）

| 分组 | 条数 | 成员 |
|---|---|---|
| **模型内容** | 5 | `SDKAssistantMessage`(type `assistant`)、`SDKUserMessage`、`SDKUserMessageReplay`、`SDKPartialAssistantMessage`(type `stream_event`)、`SDKResultMessage` |
| **system 的一般事件** | 26 | 全部 `type: "system"`，靠 `subtype` 区分：`init`、`compact_boundary`、`status`、`api_retry`、`hook_started`、`hook_progress`、`hook_response`、`task_started`、`task_progress`、`task_updated`、`task_notification`、`background_tasks_changed`、`thinking_tokens`、`session_state_changed`、`worker_shutting_down`、`commands_changed`、`notification`、`files_persisted`、`memory_recall`、`elicitation_complete`、`permission_denied`、`mirror_error`、`informational`、`model_refusal_fallback`、`model_refusal_no_fallback`、`local_command_output`、`control_request_progress`、`plugin_install` |
| **独立 type** | 8 | `tool_progress`、`tool_use_summary`、`auth_status`、`rate_limit_event`、`prompt_suggestion`、`conversation_reset`、`files_persisted`、`notification` |

#### (b) 内容块

`SDKAssistantMessage.message` 是一个 Anthropic Messages API 的 `BetaMessage`，`content` 是块数组：
`text`、**`thinking`**、`redacted_thinking`、`tool_use`、`server_tool_use`、`web_search_tool_result` 等。
`SDKUserMessage.message.content` 里则是 `tool_result` 块。

> **本次调研最硬的一条发现**：`claude-agent-sdk.ts` 对 `assistant` 消息**只读 `tool_use` 块**
> （`block.type !== "tool_use" → continue`），`stream_event` 只读 `content_block_delta`
> 里的 `text_delta`。全仓 `grep -rn thinking packages/domain/src apps/web/src` → **0 行**。
> 也就是说 **Claude 侧的推理在界面上从来不存在**，而 Codex 侧的推理是有的（本机库 868 条
> `reasoning` 活动）——这就是"换个 agent 推理行就不见了"的原因。

### 1.3 对照表：同一个事实，两个 Provider 各叫什么

| 事实 | Codex App Server | Claude Agent SDK | 本仓中立词表 |
|---|---|---|---|
| 会话开始 | `thread/started` / `system` 里的 init 响应 | `system/init`（`session_id`、`claude_code_version`、`apiKeySource`、`model`） | `thread.started` ✅ |
| 你说的话（回声） | `userMessage` item | `SDKUserMessage` / `SDKUserMessageReplay` | Provider 回声，两边都渲染成 `PROVIDER_MESSAGE` / `hidden` ✅ |
| 模型正文（流式） | `item/agentMessage/delta` | `stream_event` → `content_block_delta`/`text_delta` | `text.delta` ✅ |
| 模型正文（整条） | `item/completed` 的 `agentMessage` | `SDKAssistantMessage` | **丢弃**（只用 delta）⚠️ |
| 正文的性质 | `agentMessage.phase`：`commentary` / `final_answer` | 无对应字段 | **丢弃** ⚠️ |
| 推理 | `reasoning` item（`summary[]` + `content[]`） | `thinking` 内容块 + `stream_event` 的 thinking delta | Codex ✅ / **Claude 丢弃** ❌ |
| 跑命令 | `commandExecution` item | `tool_use`(`Bash`) → `tool_result` | 都要经过 `claudeToolKind`/`codexActivityKind` 归到 `command` ⚠️ |
| 改文件 | `fileChange` item | `tool_use`(`Write`/`Edit`/`MultiEdit`/`NotebookEdit`) | `file-change` ⚠️ |
| MCP | `mcpToolCall` item | `tool_use`(`mcp__*`) | `mcp` ⚠️ |
| 子代理 | `collabAgentToolCall` / `subAgentActivity` | `Task` 工具 + `parent_tool_use_id` | `tool`（**两者混进普通工具，分不出来**）❌ |
| 联网搜索 | `webSearch` item | `WebSearch` 工具 + `server_tool_use` | `tool` ❌ |
| 生成图片 | `imageGeneration` item | — | **`other` → 未识别** ❌ |
| 上下文压缩 | `thread/compacted` / `contextCompaction` item | `system/compact_boundary` | `other` → 未识别 ❌（Factory 自己那条 `CONTEXT_COMPACTED` 是另一回事） |
| 用量 | `thread/tokenUsage/updated`、`turn/completed` | `SDKResultMessage.usage` | `model.usage` ✅ |
| 回合结束 | `turn/completed`（`interrupted`/`failed`/成功） | `SDKResultMessage.subtype` + `is_error` | `turn.completed`/`failed`/`cancelled` ✅ |
| 鉴权失败 | `turn/completed` 的 `status: failed` | `assistant.error`（13 种）或 `result.is_error` | `turn.failed` ✅ |
| 额度 | `account/rateLimits/updated` | `rate_limit_event` | **丢弃** ❌ |
| 重试 | （无独立通知） | `system/api_retry` | **丢弃** ❌ |
| 子任务 | （无独立通知） | `task_started` / `task_progress` / `task_updated` / `task_notification` | **丢弃** ❌ |
| 钩子 | `hook/started` / `hook/completed` | `system/hook_started｜hook_progress｜hook_response` | 只有 Factory 自己的 `HOOK_*` ✅（Provider 的丢弃） |
| 权限被拒 | `commandExecution.status: declined` | `system/permission_denied`（带 `tool_name`/`message`） | ⚠️ 见 §1.5 |
| 提问 | `item/tool/requestUserInput`（server→client **请求**） | `AskUserQuestion` 走 `canUseTool` 权限回调 | `turn.input_required` ✅（两条完全不同的机制） |

### 1.4 本机实测：实际到达了什么

```sql
SELECT json_extract(payload_json,'$.itemType'), json_extract(payload_json,'$.activityKind'), COUNT(*)
FROM agent_loop_steps WHERE step_type='PROVIDER_ACTIVITY' GROUP BY 1,2;
```

| itemType | activityKind | 条数 | 落到哪个中立类别 |
|---|---|---|---|
| `reasoning` | （老行无此字段） | 806 | `reasoning`（兜底词表猜出） |
| `commandExecution` | — | 452 | `command` |
| `userMessage` | — | 214 | `message` |
| `mcpToolCall` | — | 72 | `mcp` |
| **`plan`** | — | 50 | **`other` → 未识别** |
| `fileChange` | — | 45 | `file-change` |
| `reasoning` | `reasoning` | 62 | `reasoning` |
| `commandExecution` | `command` | 45 | `command`（running/succeeded/failed 三态齐全） |
| `userMessage` | `message` | 12 | `message` |
| **`plan`** | `other` | 8 | **未识别** |
| **`contextCompaction`** | — | 3 | **`other` → 未识别** |
| `fileChange` | `file-change` | 3 | `file-change` |

三条结论：

1. **实际上只来了 7 种 item**（reasoning / commandExecution / userMessage / mcpToolCall / plan /
   fileChange / contextCompaction），18 种里有 11 种本机从未出现——但**不代表不会出现**
   （`webSearch`、`imageGeneration`、`collabAgentToolCall` 只要模型用了就会来）。
2. **`plan` 与 `contextCompaction` 明确落进了 `other`**：整篇规划文档与"上下文压缩发生在此处"
   这两件事，在数据上被标成了「未识别」。`plan` 后来在**探索侧**被打了一个特判
   （`explorer-activity.ts:120` 的 `PLAN_ECHO_ITEM_TYPES = new Set(["plan"])`）从时间线上藏掉，
   理由是它的正文已在助手消息里；但**中立词表本身没修**，所以执行侧照样显示，
   `contextCompaction` 则**两侧都显示成「未识别」**。
3. **本机 19 条执行线程的 backend 全是 `codex-app-server`（6 条记了 backend，13 条早于该字段），
   零条 Claude**——`tool_use` / `tool_result` 一条都没有。**Claude 那条路在真实数据上基本没被跑过**，
   它的呈现问题只能靠读代码发现。

### 1.5 差额清单：现在被丢掉 / 被误标的东西

按"值得修"排序：

| # | 现象 | 证据 | 影响 |
|---|---|---|---|
| 1 | **Claude 的推理完全不显示** | `mapMessage` 只认 `tool_use` 块；全仓 `thinking` 0 命中 | 换个 Agent，推理行整片消失 |
| 2 | **`plan` / `contextCompaction` 落进 `other`** | 实测 58 条；`codexActivityKind` 的 7 个 needle 里没有它们 | 界面上是「未识别」或（探索侧）被特判藏掉 |
| 3 | **`declined` 不在失败词表里** | `activityOutcome` 只查 `failed/error/denied/cancelled/canceled`（`provider-activity.ts:77`），Codex 的 `CommandExecutionStatus` 是 `inProgress/completed/failed/**declined**` | 被拒的命令显示成**「状态未知」**，而不是「被拒」——这正是文档里承诺要能看出来的那一类 |
| 4 | **`commentary` / `final_answer` 没读** | `agentMessage.phase` 是官方字段（描述见 schema） | 分不出"过程叙述"与"最终回答"——这正是 OpenClaw 折叠组的判据 |
| 5 | **子代理 / 联网搜索 / 生图 混进普通工具** | 全部走 `tool` 类别 | 界面上一行长命令与"派了个子代理"长得一样 |
| 6 | **额度 / 重试 / 子任务 事件丢弃** | Claude 侧 `rate_limit_event`、`api_retry`、`task_*` 无人读 | 卡住时用户看不到"正在重试" |
| 7 | **工具的 `arguments` / `result` 不进业务层** | Claude 侧 `summarizeToolInput` 只取一个键 + 截 200 字；Codex 侧 `summary` 取 `command`/`text` | 想展示"这次调用到底做了什么"时没有原料（Hermes 是能展开 `result` 的） |
| 8 | **`aggregatedOutput` / `exitCode` / `durationMs` 丢弃** | Codex `commandExecution` 有这三个字段 | 命令失败时只有一句话，看不到输出与退出码 |

### 1.6 小结：格式差异的**形状**

两个 Provider 的差异可以归成四类，而不是"到处都是差异"：

1. **同一件事，两个名字**（会话开始、正文、工具、用量、回合结束）——**已经收敛好了**。
2. **一边有、一边没有**（Codex 的 `plan`/`imageGeneration`/`hookPrompt`；Claude 的 `task_*`/`api_retry`/`rate_limit_event`）——
   **中立词表要能表达"这一类我这边没有"**，不能靠"某一类永远不来"。
3. **一边是"条目"、一边是"增量"**（Codex 用 `item/started`+`item/completed` 给完整对象；
   Claude 靠 SDK 组合流式事件）——**适配器的职责就是把这条缝抹平**，现在抹平了一半
   （正文只取 delta，不取最终整条）。
4. **两边的"元信息"丰富程度差一个量级**（Codex 的 item 带 status/exitCode/durationMs/phase；
   Claude 的工具结果才带 `is_error` + 内容）——**中立结构要看齐信息量大的那一侧**，
   否则"换个 Agent 就少一半信息"会成为长期现象。

---

## 2. 消息大类：比三分法更合适的分法

### 2.1 三分法的问题

你说的三类是：**用户发送的消息 / 大模型返回的消息 / agent 运行时事件**。这个分法抓住了
"谁发起的"，但有两个地方会咬到：

**问题一：它把"模型说的"和"模型做的"合成了一类。**
而这两者在**呈现上必须是两种排版**——正文要铺开读，动作要折成一行。OpenClaw 与 Hermes 都这么做
（见 §4）。更要紧的是，它们的**生命周期形状不同**：正文有"流式 → 完成"，动作有
"开始 → 结束（成功/失败/被拒）"，而且动作**可以没有结束**（悬空调用）。合成一类之后，
要么正文被套上状态标签，要么动作被当成正文铺开——本仓两边都发生过。

**问题二：它把"Provider 的运行事实"和"Factory 自己的生命周期"合成了一类。**
这两类长得像（都是"系统说的"），但**归属层不同**：

- "会话重建了"、"上下文压缩了"、"正在重试"、"额度快没了"——这是 **Provider 说的**，
  只有适配器能翻译，丢了就永远拿不回来（Provider 不会重发）。
- "门禁拦下了这一步"、"这个 Run 被阻塞了"——这是 **Factory 自己判定的**，
  与 Provider 无关，换后端也照常发生。

把它们混在"运行时事件"里，结果是**没人负责**：适配器觉得那是业务的事，业务觉得那是适配器透传的。

### 2.2 建议的五类

按 **「谁说的」×「要不要进正文」** 两个轴切，得到 5 类：

| 类 | 名字 | 谁产生的 | 进不进正文 | 呈现档位 |
|---|---|---|---|---|
| **①** | **你说的** | 你（本地） | ✅ 正文 | `text` 纯文本一行，靠右 |
| **②** | **模型说的** | 模型（正文 + 推理） | ✅ 正文 | `prose` 铺开（推理可折叠、更淡） |
| **③** | **模型做的** | 模型发起的动作与产物 | ⚠️ 摘要进正文，详情折叠 | `line` 一行 + 可展开结果 |
| **④** | **Provider 说的** | 会话设施（CLI / 网关 / 宿主） | ❌ 不进正文 | 状态条 / 分隔线 / 侧栏 |
| **⑤** | **Factory 说的** | Factory 自己的判定与生命周期 | ⚠️ 只有"需要你决策"的进 | 卡片 / 折叠组 |

判据一句话：**① 是"我说的"，② 是"模型对我说的"，③ 是"模型对世界做的"，④ 是"机器在说话"，
⑤ 是"工厂在记账"。**

为什么是这两个轴：它们分别决定了两件必须分开决定的事——

- 「谁说的」决定 **归属层**（谁负责归一、谁负责持久化、换 Provider 会不会丢）。
- 「要不要进正文」决定 **排版重量**（铺开读 / 折成一行 / 移出会话）。

### 2.3 两个清单逐条归类

#### 探索线程（15 类）

| # | 类型 | 类 | 理由 |
|---|---|---|---|
| 1 | `USER_MESSAGE` | **①** | 你说的 |
| 2 | `ASSISTANT_MESSAGE` | **②** | 模型正文（含内嵌的 `CANDIDATE_PLAN`） |
| 3 | `REASONING` | **②** | 模型说的，但不是对你说——同族、更淡一档 |
| 4 | `CANDIDATE_PLAN` | **③** | 模型产出的**产物**（内嵌在 ② 里），按协议解析后才成卡 |
| 5 | `INPUT_REQUEST` | **③** | 模型发起、需你回话的**动作**（有 OPEN→ANSWERED 生命周期） |
| 6 | `COMMAND` | **③** | 动作 |
| 7 | `FILE_CHANGE` | **③** | 动作 |
| 8 | `TOOL_CALL` | **③** | 动作 |
| 9 | `MCP_CALL` | **③** | 动作 |
| 10 | `UNCLASSIFIED` | **④** | 它**就是**"Provider 给了我不认识的东西"的兜底位 |
| 11 | `PROVIDER_MESSAGE` | **④** | Provider 回声，与你说的那条重复 |
| 12 | `SESSION` | **④** | 会话重建 |
| 13 | `CONTEXT` | **⑤** | Factory 记的"这里压缩过一轮" |
| 14 | `GATE` | **⑤** | Factory 的终止门禁判定 |
| 15 | `TURN_STATUS` | **⑤** | Factory 的轮次占位 |

#### 执行线程（18 类）

| # | 类型 | 类 | 理由 |
|---|---|---|---|
| 1 | `USER_MESSAGE` | **①** | 你说的 |
| 2 | `ASSISTANT_MESSAGE` | **②** | 模型正文 |
| 3 | `MODEL_REPORT` | **②** | 同一段正文的另一种形态（协议解析后） |
| 4 | `REASONING` | **②** | 推理 |
| 5 | `COMMAND` / `FILE_CHANGE` / `TOOL_CALL` / `MCP_CALL` | **③** | 动作四类 |
| 6 | `PLAN` | **⑤** | 冻结方案的**快照**是 Factory 写的（源文本来自模型） |
| 7 | `TASK_LIFECYCLE` | **⑤** | Plan 任务这一层是 Factory 的账（源文本来自模型的任务协议） |
| 8 | `GATE` / `CONTEXT` / `TURN_STATUS` | **⑤** | 同探索侧 |
| 9 | `RUN_ACTIVITY` | **⑤** | Run 级事件（创建 / 钩子 / 验证） |
| 10 | `RECOVERY` | **⑤** | 阻塞、取消、需要恢复 |
| 11 | `PROVIDER_MESSAGE` / `SESSION` | **④** | 同探索侧 |
| 12 | `UNCLASSIFIED` | **④** | 兜底位 |

#### 归类结果一览

```
① 你说的        USER_MESSAGE                                    1 类 ×2 侧
② 模型说的      ASSISTANT_MESSAGE · REASONING · MODEL_REPORT      3 类
③ 模型做的      COMMAND · FILE_CHANGE · TOOL_CALL · MCP_CALL
                · CANDIDATE_PLAN · INPUT_REQUEST                  6 类
④ Provider 说的 PROVIDER_MESSAGE · SESSION · UNCLASSIFIED         3 类
⑤ Factory 说的  GATE · CONTEXT · TURN_STATUS · PLAN
                · TASK_LIFECYCLE · RUN_ACTIVITY · RECOVERY        7 类
```

> **注意 ④ 只有 3 类，而且是三类"兜底/回声"。这本身是个信号**：Provider 有 18/39 种消息，
> 我们只给它留了 3 个位置，其中 2 个还是 hidden。§1.5 里被丢掉的东西（推理、额度、重试、
> 子任务、压缩边界、评审模式、生图）**都属于 ④ 且现在无处安放**。
> 这一类的空缺，是"消息结构要重设计"最实际的那部分。

### 2.4 这套分类能直接回答的三个设计问题

1. **换 Provider 时什么会丢？** → ④：适配器不翻译就永久丢失（Provider 不重发）。
   ①②③ 是语义层，换后端不该变；⑤ 与后端无关。
2. **哪些该进会话正文？** → 只有 ①②③。④⑤ 默认不进；⑤ 里"需要你决策"的
   （门禁拦截、输入卡、恢复）才升级成卡片浮到会话里。
3. **哪些该有生命周期（开始/结束/悬空）？** → ③⑤。② 只有"流式/完成"。

---

## 3. 现在有没有「接入网关」

**有。**而且形状正是你描述的那种：路由 → 各自的解析模块 → 进业务层。四层，边界清楚：

```
     配置：model.backends（具名后端） + 每个角色的 backend
                        │
   ┌────────────────────▼─────────────────────────────────┐
   │ ① 路由层  apps/api/src/runtime/model-gateway.ts      │
   │   RoutingModelGateway：按「请求覆盖 → 角色默认 →     │
   │   全局默认」解析出后端 id，委派给对应实现。           │
   │   全仓**唯一**读 apiKey / authToken 的地方。          │
   └────────┬───────────────┬───────────────┬─────────────┘
            ▼               ▼               ▼
   ┌────────────────┐ ┌──────────────┐ ┌──────────────┐
   │ ② 适配层（每个 Provider 一个）                     │
   │  CodexAppServerGateway  ClaudeAgentSdkGateway      │
   │  原生消息 ──► ModelEvent（9 种）                    │
   └────────┬────────────────────────────────────────────┘
            ▼
   ┌─────────────────────────────────────────────────────┐
   │ ③ 词表翻译  packages/domain/src/model/               │
   │   provider-activity.ts：类别 8 种 + 成败 5 种        │
   │   （**中立词表就是这一层**）                          │
   └────────┬────────────────────────────────────────────┘
            ▼
   ┌─────────────────────────────────────────────────────┐
   │ ④ 业务层  AgentLoop → agent_loop_steps / execution_  │
   │   journal / domain_events → SSE →                   │
   │   web：explorerPresentation.ts / executionStream.ts  │
   └─────────────────────────────────────────────────────┘
```

关键端口：`packages/domain/src/model/types.ts` 的 `ModelGateway` + `ModelEvent`：

```ts
export type ModelEvent =
  | { type: "thread.started"; threadId; endpoint? }
  | { type: "text.delta"; text; providerThreadId?; providerTurnId?; providerItemId? }
  | { type: "provider.activity"; phase; itemId; itemType; activityKind; outcome; title; summary; toolName?; ... }
  | { type: "model.usage"; usage; scope; ... }
  | { type: "tool.call"; call }                 // factory-controlled 循环用
  | { type: "turn.input_required"; request }
  | { type: "turn.completed" } | { type: "turn.failed"; error } | { type: "turn.cancelled" };
```

### 3.1 每一层实际做了什么

| 层 | 文件 | 做了什么 | 做对了什么 |
|---|---|---|---|
| 路由 | `apps/api/src/runtime/model-gateway.ts` | 后端注册表、按角色路由、归属记账（`answerUserInput`/`cancel` 反查）、端点指纹 | **凭据读取点收敛成一处**；懒构造；"缺配置宁可起不来" |
| 适配 | `codex-app-server.ts` / `claude-agent-sdk.ts` | 原生 → `ModelEvent`；**在适配器内**完成类别翻译（"只有本文件知道 itemType 的含义"） | 边界极干净：消费方永远看不到 Provider 原生词 |
| 翻译 | `model/provider-activity.ts` | `codexActivityKind` / `claudeActivityKind` / `activityOutcome` | **两个 Provider 共用一张成败词表**；`not-applicable` 与 `unknown` 分开 |
| 业务 | `agent/agent-loop.ts` | 事件 → 步骤/日志/SSE；文本分段；门禁；恢复 | 事件流与状态机耦合处都留了注释 |
| 呈现 | `apps/web/src/utils/*Presentation.ts` `executionStream.ts` | 消息类型 → 呈现方式（两张表） | **呈现方式只有一个落点**，视图不自己判断 |

### 3.2 缺口：不在架构，在粒度

架构上要补的东西**几乎没有**；要补的是**中立词表的分辨率**。

| # | 缺口 | 具体表现 | 该改哪里 |
|---|---|---|---|
| 1 | **类别太少**：8 个类别覆盖 18/39 种 Provider 消息 | `plan` / `contextCompaction` / `webSearch` / `imageGeneration` / 子代理 全落 `other` | `ProviderActivityKind` 扩枚举（或加"子类别"轴） |
| 2 | **正文没有信封**：`text.delta` 只有文本 | 拿不到 `phase`（commentary/final）、拿不到"这是子代理说的"（`parent_tool_use_id`） | `ModelEvent.text.delta` 加可选字段 |
| 3 | **`provider.activity` 缺"这属于谁"** | Claude 的 `parent_tool_use_id`、Codex 的 `senderThreadId` 被丢 | 加 `agentPath` / `parentItemId` |
| 4 | **结果的形状太扁**：`title` + `summary` 两个字符串 | Claude 只取一个键截 200 字；Codex 的 `aggregatedOutput`/`exitCode`/`durationMs` 丢 | 中立结构改成"结构化载荷 + 展示用摘要"两件 |
| 5 | **没有"Provider 运行事实"的位置** | 额度、重试、压缩边界、评审模式、钩子、子任务无处安放 | 新增一类事件（或扩展 `provider.activity` 的类别） |
| 6 | **推理是一等公民还是二等？** | Codex 有（走 activity），Claude 无（thinking 块没读） | Claude 适配器补 thinking 块 |
| 7 | **`declined` 未归入失败** | `provider-activity.ts:77` 的词表缺它 | 一行修复 |

> 这份缺口清单与 §1.5 是同一批，只是换了个视角：**§1.5 说"丢了什么"，这里说"该在哪一层补"。**

---

## 4. 呈现：OpenClaw 与 Hermes 的做法

两个项目都读过一遍（OpenClaw 的 WebChat / Control UI 文档、Hermes UI 的单文件前端源码）。
下面引的都是它们的原文或源码事实。

### 4.1 OpenClaw

**两条数据通路**（这是它整份文档里最重要的一条设计）：

> "WebChat has two separate data paths: The SQLite transcript rows are the durable model/runtime
> transcript. For normal agent runs, the embedded OpenClaw runtime persists model-visible
> `user`, `assistant`, and `toolResult` messages through the session accessor.
> **WebChat does not write arbitrary delivery, status, or helper text into that transcript.**
> Gateway `ReplyPayload` events are the live delivery projection … They are not themselves the
> canonical session log."

翻译过来：**持久化的对话只有三种角色（user / assistant / toolResult）；一切状态、进度、帮助文案
都不写进对话，而是走另一条"实时投影"通路。** 这正是 §2 里 ④⑤ 不进正文的工程做法。

**呈现上的具体决定**（原文摘录）：

1. **折叠组**："Completed dashboard turns collapse their narration and tool activity under
   `Worked for …` above the answer, with durations such as `Worked for 2 minutes, 3 seconds`.
   Expanding it restores the sequence with the existing tool-call groups and shows the total
   tool-call count."
   → **折叠组在答案上方**，标题带时长；展开后恢复顺序并给出总调用数。
2. **失败永远可见**："When no run duration is available, the heading reads `Worked` rather than
   estimating from message timestamps. **Failures and other non-success outcomes remain visible
   even when collapsed**, such as `Worked for 2 minutes, 3 seconds · 2 failed`."
3. **连续动作合成一个日志**："Consecutive tool activity shares one expandable log …
   Visible messages, media, and conversation markers keep their place and separate logs;
   **live response text and the working indicator stay outside the log**.
   Grouping changes only the presentation, not the transcript."
4. **过程叙述单独一档**："While an agent works, completed commentary or preambles appear inline
   in the conversation when the model and runtime provide them. Narration keeps its formatting and
   position alongside tool activity; the working indicator remains a separate status for execution,
   startup, or approval. `Keep commentary` in the chat view menu controls whether commentary stays
   visible after the run."
5. **推理不进正文**："WebChat excludes reasoning-flagged reply payloads (`isReasoning: true`) from
   assistant content, transcript replay text, and audio content blocks.
   **Thinking-only payloads therefore do not surface as visible assistant messages**."
6. **压缩是一条分隔线**："**Compaction entries render as a history divider** showing the context
   reduction when token measurements are available."
7. **别的会话的消息不是气泡**："Inter-session messages appear as compact `updates from` activity
   rows **instead of chat bubbles**. Consecutive updates from the same source share one row."
8. **被跳过的调用明说**："When an incoming message causes an unstarted tool call to be skipped,
   its card and work summary show `Skipped`." 以及 "Approval blocks and tool failures keep their
   separate outcomes."
9. **兜底清洗**：显示前会剥掉运行期上下文、信封包装、内联指令标签，以及
   "**plain-text tool-call XML payloads** (`<tool_call>`, `<function_call>`, …)" 和泄漏的控制 token。
10. **历史分页跳过不该看的**："History pages **skip hidden and tool-only transcript entries**
    while filling the requested visible-message window."
11. **侧栏只给图标不给内容**："running sessions show a small, static tool icon beside the progress
    text … the tool name is available only in the icon's tooltip … **Tool progress uses only
    explicitly public progress text from the Gateway, never argument-derived metadata or raw
    command output.**"

### 4.2 Hermes

单文件 React 前端。消息渲染的**实际结构**（`MessageBubble`，源码顺序）：

```
┌ .message.user-msg / .assistant-msg ────────────────────────┐
│ [头像][You / Hermes]                            [时间 HH:MM]│  ← header
│ ┌ .tool-calls-list ─────────────────────────────────────┐  │
│ │ ⚙️ label            ···(运行中三点)  /  ✓(完成)        │  │  ← 一行一个动作
│ │                              [▸ result / ▾ hide]      │  │
│ │   （展开：结果，>2000 字截断）                          │  │
│ └───────────────────────────────────────────────────────┘  │
│ [图片缩略图]                                                │
│ ┌ <details class="reasoning-card"> ─────────────────────┐  │
│ │ <summary>Reasoning notes</summary>  ← 流式时自动展开    │  │
│ │   等宽小字，流式时固定 160px 高、内部滚动、自动跟底      │  │
│ └───────────────────────────────────────────────────────┘  │
│ ┌ .toolless-work-warning ───────────────────────────────┐  │
│ │ ⚠ **No tool ran.** Hermes described local work, but    │  │
│ │   this reply has no tool call attached. Treat it as    │  │
│ │   not done until a tool result appears.       [Retry]  │  │
│ └───────────────────────────────────────────────────────┘  │
│ .message-content  ← markdown（代码高亮、Copy 按钮、mermaid） │
│ <ThinkingBubble/>  ← "Hermes is thinking... (Ns)" + 最新一句  │
│ [Edit] [Retry]                                             │
└────────────────────────────────────────────────────────────┘
```

外加三种**独立的消息角色**（不属于 user/assistant）：

- **`compaction`**：渲染成 `—— 🔄 {文案} ——` 的**分隔线**（`.compaction-marker`，两侧横线 + 胶囊标签）。
- **`aside`**：侧问侧答，`Aside` 头 + 问题 + 回答；未答时显示 "Checking without changing the main
  thread..." ——**明确声明它不打断主线**。
- **子代理**：`delegate_task` 一类的工具不画成工具行，而是 `.subagent-card`：状态点 + 标题
  （`Explorer Subagent` / `3 Subagents`）+ 状态（`Done · 1.2s`）+ 可展开结果；多任务时列出子行。

还有一些**诚实性**设计值得单独记：

- **`toolless-work-warning`**：模型描述了本地工作却没有工具调用 → 直接标"**No tool ran.** …
  Treat it as not done until a tool result appears"，并给 Retry。
- **`Follow-up stopped.`**：模型说自己在轮询/检查，这一轮却结束了 → 提示"重试或让它继续"。
- **推理渲染截断**：`[showing latest reasoning notes; earlier notes were compacted]` —— 只显示最新一段。
- **工具结果脱敏**：`redactSensitiveValue(result)` 后才展示。
- **TodoWrite 之类的工具不渲染**（`isTodoTool` 过滤掉），改由独立的 `SessionTodosPanel` 承载。

### 4.3 两者的共识（可以直接抄的七条）

| # | 共识 | OpenClaw | Hermes |
|---|---|---|---|
| 1 | **正文之外的一切都要"折"**：折成一行、折进 `<details>`、折进折叠组，或移出会话 | `Worked for …` 折叠组 | `.tool-calls-list` 每行 + `▸ result` |
| 2 | **推理不进正文，进可折叠的独立容器** | 从正文与音频里**直接剔除** | `<details>` "Reasoning notes"（流式自动展开） |
| 3 | **压缩是分隔线，不是事件卡片** | compaction divider | `.compaction-marker` |
| 4 | **失败/被拒/被跳过**永远可见，且**不被折叠吃掉** | `· 2 failed` 留在折叠标题上 | 常驻警告 + `is_error` 红态 |
| 5 | **动作要能展开看结果**（且结果要截断 + 脱敏） | `chat.message.get` 按需取全文 | `▸ result`，>2000 字截断，`redactSensitiveValue` |
| 6 | **声明"这一轮到底做了什么"，不靠模型自述** | working indicator 是独立状态 | toolless-work-warning |
| 7 | **持久化的对话只有少数几种角色，其余走旁路** | 两条数据通路 | 三种旁路角色（compaction/aside/subagent） |

### 4.4 我们现在的做法 vs 它们

| 维度 | 本仓现在 | OpenClaw / Hermes | 判断 |
|---|---|---|---|
| 工具/命令/文件/MCP | 探索侧 `line` 一行；执行侧 `line` 一行 | 一行（Hermes 还能展开 result） | **档位对了**；缺"展开看结果" |
| 助手正文 | `prose` 铺开 | 铺开 | 一致 |
| 用户消息 | `text` 一行靠右 | 气泡（Hermes）/ 气泡（OpenClaw） | 一致，形态不同 |
| 推理 | 探索侧独立一行；执行侧 `folded` | 可折叠容器，且**默认更淡** | 一致 |
| 上下文压缩 | `divider` 分隔行（探索侧） | 分隔线 | 一致 |
| 执行侧折叠组 | "N 条过程记录"（**在答案下方**） | `Worked for …`（**在答案上方**，带时长与失败数） | 位置与信息量可再想 |
| 动作的结果 | **不展示** | 可展开 | **缺** |
| 子代理 / 搜索 / 生图 | 混进 `tool` / 落 `other` | 独立卡片 / 独立类型 | **缺** |
| Provider 运行事实（额度/重试/压缩边界） | **丢弃** | 有位置承载 | **缺** |
| 悬空调用 | 标 `状态未知` + 「未记录调用的结束状态。」 | — | **比它们细**，保留 |

一句话：**排版档位上我们和它们已经基本一致了；差的是"折起来的东西能展开看"、
"Provider 的运行事实有地方放"、"动作的种类能分辨"。** 这三件正好是 §1.5 与 §3.2 的那批缺口。

---

## 5. 建议（供决策，本次不实现）

按投入产出排序，三件：

### 建议一：把"模型的推理"变成两个 Provider 都有的东西（缺口 #1）

Claude 适配器补读 `assistant` 的 `thinking` 块与 `stream_event` 的 thinking delta，
映射成与 Codex `reasoning` 同一类别。**不补这一条，两条对话线"看起来一样"永远做不到**——
它们在数据源头就少一半。

### 建议二：中立词表按 §2 的五类重排，④ 从 3 个位置扩到能装下 Provider 的运行事实

具体是两处：
1. `ProviderActivityKind` 扩枚举：至少补 `plan`、`compaction`、`search`、`image`、`subagent`、
   `hook`、`rate-limit`、`retry`、`review`（或引入"主类别 + 子类别"两个轴，避免枚举膨胀）。
2. 给 ④ 类一个**不进正文**的归宿：与 OpenClaw 的"第二条数据通路"同形——
   Run 头 / 侧栏 / 状态条，而不是会话条目。

**理由**：④ 现在只有 3 个位置（2 个 hidden），而 Provider 有 18/39 种消息。
这是"消息结构要重设计"里最实的一块。

### 建议三：动作行补"可展开的结果"，并让种类可分辨（缺口 #4/#5/#8）

- 中立事件带上结构化载荷（`arguments` / `result` / `exitCode` / `aggregatedOutput` /
  `durationMs`），展示层用 `title`+`summary` 做摘要，展开时给全文（截断 + 脱敏，
  照 Hermes 的 2000 字与 `redactSensitiveValue`）。
- 子代理、联网搜索、生图各给一个独立类别 → 独立行型或卡片。
- 顺带修 `declined` 未归入失败（`provider-activity.ts:77`）。

### 需要你先定夺的两件事

1. **执行侧的折叠组放上面还是下面？** 我们现在在答案下方（"N 条过程记录"）。
   OpenClaw 放**上方**并带"时长 + N 个失败"。带时长这件事需要新的数据（当前只有单条时间），
   要动就得连事件一起动。
2. **④ 类落哪儿？** 三个选项：(a) 全部收进 Run 头的诊断区；(b) 会话里保留一条极淡的"运行事实"
   行型；(c) 只在异常时浮现（额度不足、重试超限、鉴权失败）。
   我倾向 **(c) + (a)**：常态不打扰，异常必须显眼——与"失败永远可见"那条共识一致。

---

## 附：本次调研用到的命令与出处

```bash
# Codex 协议（权威）
codex app-server generate-json-schema --out /tmp/codex-schema
# → ServerNotification.json(75 条) / ServerRequest.json(10 条) / ThreadItem(18 种)

# Claude SDK 协议（权威）
find . -name sdk.d.ts -path "*claude-agent-sdk*"   # → SDKMessage 联合 39 种

# 本机实际到达了什么
sqlite3 -readonly code/pipeline-factory.sqlite \
  "SELECT json_extract(payload_json,'$.itemType'), json_extract(payload_json,'$.activityKind'), COUNT(*) \
   FROM agent_loop_steps WHERE step_type='PROVIDER_ACTIVITY' GROUP BY 1,2 ORDER BY 3 DESC;"
```

外部参考：[OpenClaw WebChat 文档](https://docs.openclaw.ai/web/webchat)、
[OpenClaw Control UI 文档](https://docs.openclaw.ai/web/control-ui/)、
[Hermes UI（pyrate-llama/hermes-ui）](https://github.com/pyrate-llama/hermes-ui)。
