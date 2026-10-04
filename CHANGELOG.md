# Changelog

## 2026-10-05 — Plan 生命周期状态：文案收成一份，并把枚举值从界面上撤下来

### 为什么做

同一个 Plan 状态在界面上能有三四个词，因为它们来自**三份互不相干的表**：

| 状态 | 抽屉标题 | 候选方案卡 | 工作台 | 生命周期条 |
|---|---|---|---|---|
| `DRAFT` | `DRAFT`（**直接渲染枚举值**） | `Candidate` | `Draft` | `Candidate` |
| `READY` | `READY` | `Confirmed` | `Ready` | `Confirmed` |
| `MERGE_READY` | `MERGE_READY` | `Ready for review` | `Needs review` | `Ready for review` |
| `MERGED` | `MERGED` | `Merged` | `Merged` | **`Completed`** |

`PlanDetailContent.vue` 那句 `<el-tag>{{ plan.status }}</el-tag>` 是把**枚举值本身**端给用户看；
`utils/statusVisual.ts` 另有一张自己的文案表，与 `utils/planStatus.ts` 早已漂成两套词。

### Changed

- **Plan 状态文案中文化**（`utils/planStatus.ts`）：草稿 / 已丢弃 / 已设计 / 已规划 / 已确认 / 已入队 /
  已派发 / 排队中 / 启动中 / 执行中 / 验证中 / 待合并 / 已合并 / 已阻塞 / 需要改计划。
  补上此前缺的 `DESIGNED` / `PLANNED` 两项（它们此前回落成原字符串）。
- **`utils/statusVisual.ts` 不再自带 Plan 状态的文案**：它只留 PlanStatus **之外**的派发 / 等待 /
  运行态（`WAITING_*`、`NEEDS_CONFIGURATION`、`DISPATCHING` 等，一并中文化），Plan 状态一律从
  `planStatusLabel` 取——同一个状态一个词。`statusVisual.test.ts` 断言源文件里不许再出现同名条目。
- **抽屉标题不再渲染枚举值**：`{{ plan.status }}` → `planStatusLabel(plan.status)`；它的语气色也改成
  `statusVisualFor(...).tone`，去掉那份自己写的三元判断。
- `planLifecycle.ts` 的 `NEEDS_CONFIGURATION`、以及两处把状态名写进句子的提示文案一并中文化。

### 还没动的（另一套状态机，不在本轮范围）

Run 详情头的 REVIEW 卡（`Not started` / `Verification pending` / `Ready for review` / `Awaiting merge` …）、
Agent Loop 状态（`Running` / `Blocked` / `Completed` …）、Run 级活动标题
（`Run created` / `Hook completed` / `Verification`）。

## 2026-10-04 — 两条对话线共用一份消息词表；一次调用只占一行

### 为什么做

清点探索线程（对话框 A）与执行线程（对话框 B）的类型表时发现三层不一致：

1. **名字**：同一个概念两边不同名——"你发的消息"在 A 叫 `USER_MESSAGE`、在 B 叫 `guidance`；
   同一次工具调用，A 按生命周期拆成 `TOOL_STARTED` / `TOOL_COMPLETED` / `TOOL_DENIED` 三条，B 合成一个 `tool`。
2. **大小写**：A 的类型值全大写（它直接来自领域枚举），B 的 17 个值是手写的小写串。
3. **语言**：同一组状态，A 写 `Running` / `Read only` / `Failed`，B 写 `进行中` / `已完成` / `失败`。

再加上三处具体的呈现缺陷，依据都是本机运行库的实测：

- **一次调用在 A 占两行**：`TOOL_REQUESTED → TOOL_COMPLETED` 是同一件事的两端，B 按 `callId` 合并成一条，
  A 没有。顺带发现 `TOOL_FAILED` / `TOOL_NEEDS_RECONCILIATION` 两个步骤类型在 A **连一行都没有**
  （投影里没有分支，静默掉了）——"工具失败了"在探索时间线上看不见。
- **Provider 回声冒充工具行**：A 只按 `itemType` 里有没有 `mcp` / `reason` 三个子串判类，
  于是 `userMessage`（Provider 把你那句话回显一次）与 `plan`（整篇规划文档）都落进了
  "Tool started / Tool completed"——实测 112 个与 29 个。
- **门禁刷屏**：90 条 `GATE_CHECKED` 里 `complete` 51、`continue` 39、**`blocked` 0**，每轮都写一行"一切正常"。

### Changed

- **共用词表**（新增 `apps/web/src/utils/conversationTypes.ts`）：13 类共用项在两条线上同名、同中文文案，
  两张呈现表都必须为每一项给出一行——`type-parity.test.ts` 编译期拦、`conversationTypes.test.ts` 运行时拦。
  命名一律大写下划线；执行侧只此一份的 5 类（`PLAN` / `MODEL_REPORT` / `TASK_LIFECYCLE` /
  `RUN_ACTIVITY` / `RECOVERY`）与探索侧独有的 4 类逐条登记了理由。
- **一次调用只产出一条条目**（`explorer-activity.ts`）：按身份键（Loop 步骤的 `callId` / Provider 活动的
  `itemId`）合成一条，后到的事件覆盖状态与正文——与执行侧 `projectExecutionJournal` 同一条规则。
  名字留住开始那一条的、原因覆盖成结束那一条的；回合结束后仍没有结束事件的标成 `状态未知`，
  不再一直显示"进行中"。推理与 Provider 回声同样按身份合并。
- **Provider 活动改按中立类别归类**（复用 `model/provider-activity.ts`）：`command` / `file-change` /
  `tool` / `mcp` 各成一类，`message` / `session` 落 `hidden`，`plan` 回声不再产出，
  真正认不出来的仍以「未识别」一行保留（标签直接摆原生 `itemType`）。
- **门禁只在 `blocked` 时成行**；`TOOL_FAILED` / `TOOL_NEEDS_RECONCILIATION` 补上分支。
- **用户消息改成纯文本**：三个界面统一成 Codex 那种「`› + 原文`」，去掉头像、卡片与展开按钮，
  仍然靠右。`messageSummary.ts` 随之删除。
- **状态文案与行首标签中文化**，与执行侧、项目执行线程、需求清单同一套词。
- **修一个会静默丢消息的判据**：`RunDetailView` 的 `visibleItems` 此前写死"属于 `card` 或 `line`"，
  新增的 `text` 会让那类消息**从会话里消失**——改成"除折叠与不渲染之外"。

实测同一条需求的渲染行数 **432 → 229**，本机 27 个需求合计 **1,274 → 653**：少掉的不是信息，
是同一次事实的第二行、每一轮的"一切正常"，以及内容在别处已经有的回声。
`docs/消息类型及事件状态机流程图.md` 按改后的代码逐节核过（含新增的 §4.4「两条线共用的词表」）。

## 2026-10-03 — journal：条目不再按 40ms 一片，也不再每次重写整体快照

### 为什么做

执行会话页看起来像"一行两个字"。查下去发现根因不在渲染：`agent-loop` 的正文刷新是
**160 字符阈值或 40ms 定时器**，低速率输出下定时器主导——实测本机库 3,933 条 `MODEL_OUTPUT`
的文本长度**中位数是 2 个字符**，66% 不超过 3 个（单个 Run 最多 1,536 条正文条目）。
它们还逐条镜像成 `run.executor.event` 领域事件，于是同一份碎片在库里存了两遍（15,458 条）。

顺带查清了两件事：前端的 `projectExecutionJournal` **已经在**按"模型轮次 + provider 条目 id"
把连续正文合并成一条消息（1,647 条 journal → 94 条消息、17 条正文、平均 52 字），
所以页面上并不缺合并逻辑；缺的是**写侧的粒度**。而 `execution_threads.journal_json`
（journal 的整体快照）既贵又错：写侧每次 `saveExecutionThread` 都要序列化整份（实测最大 579 KB），
它却只在那一处更新、`appendExecutionJournal` 不碰它——实测 18 个线程里 **13 个的快照与执行日志表
已经对不上**。

### Changed

- **正文按"连续段"落一条**（`executor-agent.ts`）：攒进内存，遇到下一条非正文条目或 Run 终止时写一条。
  分段依据与前端投影**逐字相同**，所以条目顺序、分组、页面呈现都不变，只是条目数少一两个数量级。
- **`execution_threads.journal_json` 整体快照删除**：启动时先把"只有快照、表里没有行"的历史线程
  搬进 `execution_journal`，再 `DROP COLUMN`。`backfillLegacyVerificationRuns` 一并从快照改读表
  （拿一份已经过期的副本当修复依据，会漏掉最近的条目）。
- **`appendExecutionJournal` 的归属校验**从 `getExecutionThread`（读整条日志并解析）改成一次主键查询。
  它逐条追加调用，此前整体是 O(n²)。

### 随后一并处理

- **`agent_loop_steps` 同一处碎片也收掉了**：模式一样（段内照旧实时派发 `agent.model.text.delta`，
  只在段结束时落一条步骤），封段边界与读取方 `explorer-activity` 合并卡片的边界逐字相同。
  改这里的前提是 `routes/explorers.ts` 里那句"没有等价性测试不要改这里"——
  已补上等价性用例（同一段正文按 3 条 / 1 条两种形态投影，结果逐字段相同）与引擎级用例。
- **历史碎片合并成段**（经确认的一次性历史改写）：启动时把库里已有的连续碎片按同一规则并成段。
  实测本机：`agent_loop_steps` 60,161 → 2,963 行、`execution_journal` 4,547 → 739 行、`domain_events` 133,464 → 90,031 行，
  而同一个 Run 的执行会话投影逐条完全一致（94 条消息、类型直方图、正文长度分布全部与合并前相同）。
- **`domain_events` 里带序号的两簇也合并成段了**：`agent.step.model_text_delta` 40,245 → 221 行、
  `run.executor.event` 的 MODEL_OUTPUT（带 `payload.sequence` 的）3,529 → 120 行。
  这里踩到一个坑值得记下来：**事件流是交错的**——每 40ms 一次刷新会同时写步骤镜像与那条遗留重复
  （`agent.model.text.delta`），两者把对方的序号隔开，所以"事件序号相邻"这个在两张表上成立的判据
  在事件表上**匹配数是 0**（第一版跑了个空）。改成用载荷里的**序号**（步骤号 / journal 号）才对得上。
- **剩下两簇改动为删**：`agent.model.text.delta`（35,961 行）与 `explorer.turn.text.delta`（35,007 行）
  不能合并——合并会把正文挪到别的活动事件之后、打乱时序——只能**确认副本存在后删除**，判据逐个聚合验证、不抽样：
  前者比对该 loop 的步骤行正文总量（50 个 loop 全部满足），后者要求剥掉计划协议块后逐字等于
  `explorer_turns.content`（33 个回合里 **3 个不满足，全部保留**：两个被取消的回合——content 被替换成
  "本轮已取消"，模型原始输出只在这批事件里——与一个 content 被后续覆盖的回合）。
  为此把 `stripPlanProtocol` 挪到 `plan/completion.ts` 共用：删除的唯一判据不能与展示投影各写一份。
- **实测总账**：`domain_events` 133,464 → 19,549 行、19.72 → 3.61 MB；库文件 81.58 MB → 12.20 MB。

## 2026-10-03 — 删掉 V1 扁平合同镜像（Plan 契约只剩一份）

### 为什么做

`ResolvedPlanContract` 之外还并存着一份 V1 扁平合同（`CandidatePlan.contract`）。它不是"另一种契约"，
而是已解析契约的**有损投影**：`dependsOnPlanIds` 恒填 `[]`、`priority` 恒为 0。字段名却更短，
于是界面与调度里到处是"优先读 `resolvedContract`、缺它才回退到 `contract`"的读点——
两份形状迟早对不上，而 `planQueryProjectionFor` 曾是这份镜像最后一个**无条件**读者。

库里的数据支持直接删：本机 3 个库、35 份候选计划，`schemaVersion = 1` 的 **0 份**，
没有 `generatedSpec` 的也是 **0 份**——也就是说这份镜像在库里**完全可推导**，删列不丢事实。
（清点见 `docs/消息类型及事件状态机流程图.md` 的 §6。）

### Changed

**1. 契约只剩 `resolvedContract`（domain）**

- 删 `PlanContract` / `PlanTask` 类型、`executionContractFromResolved`（投影函数）、
  `defaultPlanContract`（兜底合同）、`validatePlanContract`（V1 结构校验），以及三处
  `contract.schemaVersion === 1` 只读闸门——没有可表达的 V1 形状，闸门成了空转。
- `CandidatePlan` / `PlanRevision` / `PlanRevisionDraft` / `ChangeProposal` 的 `contract` 改成
  必填的 `resolvedContract`；`PlanArtifact` 的 `contract` 入口换成 `resolvedContract`。
- `createCandidatePlan` 现在**必须**拿到 `generatedSpec` 或 `resolvedContract`，两者都没有直接拒绝；
  落盘、审计哈希、预检全部改读 `resolvedContract`。

**2. 计划依赖与自然语言先决条件分开（这是删镜像暴露出的真问题）**

`dependsOnPlanIds` 与 `dependencies` 原先共用镜像的同一个字段，而 `resolvePlanContract` 往
`dependencies` 里填的是模型写的**自然语言先决条件**（"需要 Node.js 22"）。镜像一删，两条读点
（`validatePlanDependencies`、`dispatch-coordinator.evaluateWait`）就会把先决条件当成 Plan id，
去等一个不存在的 Plan——表现为 `BLOCKED / depends on unknown plan 需要 Node.js 22`。

处置：`ResolvedPlanContract` 新增 Factory-owned 的 `dependsOnPlanIds`（解析时恒为 `[]`，
只有 `PlanService.setDependencies` 能写），`dependencies` 保持原义。

**3. 存储与 API**

- 四张表的 `contract_json` 列删掉，老库启动时 `DROP COLUMN`；`pruneLegacyV1Plans` 随之删除
  （它靠 `json_extract(contract_json, ...)` 找行，列一没就没有识别依据）。
- 读契约失败**抛错**而不是回落到一个（看着像契约、其实什么都没有的）空形状：
  空任务清单会让执行者开工、空命令集会让验证静默判 `SKIPPED`。
- 老库回填 `resolvedContract.dependsOnPlanIds`：字段是新加的必填项，老行里没有这个键，
  读点虽然都写了 `?? []`，但让数据对得上比要求每个新读点都记得兜底可靠。
- `change_proposals` 补上 `resolved_contract_json` 列。提案的契约此前存在 `contract_json` 里，
  改列时漏了建表——**内存实现不经过 SQL 列，所有用例照样绿**，只有真开一个 SQLite 库才暴露。
  已补一条 SQLite 往返用例。
- API：workbench 投影与 change-proposal 请求体暴露 `resolvedContract`；`Plan.contract` 响应字段消失。
  `PlanIndexRow.priority` 保留但恒为 0（响应形状与 `sort=priority` 还引用它），dispatch 的优先级排序删掉。

**4. Web：从三层回落到两层**

`PlanDetailContent` / `RunDetailView` / `planContract.ts` / `explorerRequirementRows` 里所有
`plan.contract` 的读取与回落都删掉，只剩 `resolvedContract → generatedSpec`。

**5. 测试夹具**

不再有兜底合同之后，造一个 Plan 必须显式给契约。新增跨包夹具 `plan/plan-fixture.ts`
（domain 导出、api 与 web 共用），每个包各写一份必然与领域形状漂移。

### 验证

- `pnpm verify`：986 个用例全绿（domain 366 / api 111 / web 509），typecheck 全过，无新增值级环。
- 真库升级：重启服务后本机运行库 21 份 Plan / 21 个 Revision / 6 份草稿全部读得出契约，
  四列成功丢弃，`dependsOnPlanIds` 回填完成；`/workbench`、`/plans/:id`、Plan Center 查询
  返回的都是 `resolvedContract`，没有 `contract` 字段。

## 2026-10-01（其十五）— Plan 结构对齐 Claude Code：现状、风险、文件变更真正传给 Executor

### 为什么做

对比 Claude Code 的 Plan 后发现，项目当前的 Plan **有目标、有任务标题，但没有"为什么这么做、具体动哪些文件"**。
更严重的是：Executor 的 system prompt 嵌的是 `revision.contract` 的 V1 投影，V2 的 `design` 整节在
`executionContractFromResolvedV2`（`plan/service.ts`）里被丢掉了——`technicalConstraints`、
`dataSecurity`、`failureHandling`，以及 `dependencies` 并入的技术约束，**从未到达执行者**。

这与真实阻塞原因直接对上：`package.json remains missing in expected project directory` 反复出现，
而 Plan 的 dependencies 里明明写着「需要在 code/ 目录使用仓库现有 package.json 和锁文件安装依赖」。
执行者没见过这句话，只能对着一个任务标题重新探索。

### Changed

**1. V2 Plan 增加三个结构字段（不升 schemaVersion）**

- `objective.context`：现状与调查发现（Explorer 在仓库里看到了什么、依据是什么）。
- `design.risks`：风险与回滚。
- `tasks[].changes[]`：这一步要动哪些文件、怎么动；每项包含 `path`、`action`（`create` /
  `modify` / `delete`）、`detail`。

三个字段在底层校验器里**保持可选**，确保历史 V2 spec 能继续被
`reviseConfiguration` / `setVerificationSuites` 重新解析；但新 Explorer 产物在 `assessPlanCompletion`
门禁里必须提供这三类细节，缺失会生成逐字段诊断并自动续探索补齐。这样兼顾了新计划质量与旧数据兼容。

`tasks[].changes[].path` 复用已有 `safePaths`，不另写路径安全规则；非法 action、空 detail、空数组都会
被具体指出。

**2. Executor 拿到完整的 V2 精选视图**

有 `resolvedContract` 的 V2 Revision 现在给 Executor 的 system prompt 包含：
`objective`、`design`、`scope`、`tasks`（含 changes）、`dependencies`、`conflicts`、产物和验证信息。
不再把 `repository` 哈希等无关元数据塞进提示词；历史 V1 Revision 仍原样使用旧 contract。

**3. Plan 文档与 Plan 详情抽屉同步展示**

- 落盘 Markdown 新增「现状与发现」「风险与回滚」，每个实施步骤列出动作、路径和 detail。
- Plan 详情抽屉新增同样的现状、风险、文件变更展示：动作以新建 / 修改 / 删除标签区分，
  不再只有任务标题。
- Explorer requirements manifest 与 web fallback 镜像同步更新，明确三项为新产物必填。

### 验证

- `pnpm verify` 全绿：domain **362** / api **111** / web **497**，无新增 value 级环。
- 向后兼容：历史 V2 spec 没有新字段仍能 parse / resolve；新门禁会明确指出
  `objective.context`、`design.risks`、`tasks[n].changes` 的缺失。
- Executor 测试断言 system prompt 真包含调查上下文、风险、dependencies、changes 路径与 detail，
  防止新字段只停留在页面/数据库而没有真正进入执行。
- Plan archive 与 PlanDetailContent 测试覆盖新字段渲染。

## 2026-10-01（其十四）— 执行会话：消息类型清单化、说人话、修掉漏进正文的标记

### 为什么做

用户报"执行线程的消息我看不懂"，并给了截图。把截图里那几条逐条翻译之后，问题分成三类，
都不是"结构错了"：

- **说的是 Provider 的机械话**：「命令 · 已完成 · **Provider reported success**」——跑的是什么、为什么跑，一个字没说。
- **标题只写角色名**：模型正文的卡片标题是「**Executor**」，那不是内容。
- **同一件事说了两遍**：「任务 开始 · 新增项目级任务创建接口…」与它上方步骤头说的是同一件事。

用户还要求"把大模型的消息类型列个清单，我来决定每种怎么呈现"。清单按真实数据做，
结论落成**一张呈现方式表**（见下）。

### Changed

**1. 消息类型清单 → 一张呈现方式表**（`apps/web/src/utils/executionStream.ts`）

新增 `ExecutionMessageType`（17 类）与 `EXECUTION_DISPLAY_MODES`：每类映射到
`card` / `line` / `folded` / `hidden` 四档。**视图只问 `executionDisplayMode(item)`**，
不再自己判断——此前判断散在三处：按 `kind` 分支、按 `outcome` 猜、按标题字符串相等
（`title === "Executor report"`）。改呈现方式从此只改这张表。

实际落到界面上：推理与门禁 → 折叠（`N 条过程记录`）；Provider 回显、会话重建、
上下文压缩、循环启动 → 不显示；命令 / 文件变更 / 工具 / 步骤 → 一行；正文与结论 → 卡片。
**异常类（阻塞、取消、恢复、你的插话）无论呈现方式怎么调都是卡片。**

**2. 说人话：动作卡片说清"做的是什么"**

- **journal 记下 `summary`**（`executor-agent.ts`）：命令原文、被改动的文件路径都在里面。
  不记它，卡片只能写「命令 · Provider reported success」。这是可读性的关键一条，
  老事件没有这个字段，仍退回类别标签（不编内容）。
- 文案中文化：`Provider reported success` → 「执行成功」、`Provider activity started` → 「执行中」、
  失败原因 `Provider command exited with code 1` → 「命令退出码 1」（**只在显示层翻译**，
  journal 保留原文；认不出来的形状原样显示，不猜意思）。
- 模型正文标题 `Executor` → 「执行说明」；完成报告 `Executor report` → 「执行报告」；
  工具卡片 `Provider tool call` → 「工具调用」。标题里的长命令截断到 80 字。

**3. 修掉漏进正文的任务标记**（实见缺陷）

截图里有一张卡片的正文第一行是 `actory-task-progress>{"taskId":"task-1","state":"started"}`——
任务标记跨了两条事件，上一条的尾巴被"结尾未闭合"规则削掉，剩下的一半落在下一条的**开头**，
而清理只处理结尾。现在按"开头这一截是标记的任意一段后缀"识别并削掉，两种后续形态都覆盖：
后面接标记的 JSON 载荷（连闭合标记一起去掉）、后面直接接正文（只削尾巴）。
正文被清空时**不产生卡片**——只剩标题与时间的空卡片是纯噪音。

### 未做

- **方案结构（第 3 件）另立计划**：参考 Claude Code 的 plan 结构给契约补
  `objective.context` / `tasks[].changes` / `design.risks`，属于契约变更，不混在本轮。

### 验证

- `pnpm verify` 全绿：domain **358** / api **111** / web **496**，无新增值级环。
- 新增/更新用例：`executionStream.test.ts`（呈现方式表抽查、"异常永远是卡片"、"认不出来的活动标成未识别"、
  `summary` 决定标题、老事件退回类别标签、长命令截断、失败原因翻译、**跨事件切断的标记两种形态**、
  空正文不产生卡片、普通正文不被误伤）；`executor-agent.test.ts`（**journal 确实记下 summary**）；
  `RunDetailView.test.ts`（视图只问呈现方式表，`isActivityNoise` 已移除）。
- 浏览器实测同一个 Run：卡片从 16 张降到 10 张，`Provider reported success` 与
  `Provider activity started` 均已消失，正文里不再有标记残留，折叠区显示「9 条过程记录」。
- ⚠️ **`summary` 只对新事件生效**：这次实测里命令卡还没显示命令原文（那些事件写在改动之前）。
  新 Run 才会带上。

## 2026-10-01（其十三）— 「Confirm Plan 慢」：先量化，再收掉两处潜伏阻塞

### 为什么做

报障是"确认 Plan 要等很久"，并明确是**请求本身慢**（点下去要等），不是"确认后等执行开始"。

按"先量不猜"逐段实测（project4 / 本机现状），结果是**复现不出来**：确认→Run 创建 10–20ms
（真实时间戳）、Run 创建→执行循环建好 ~60ms、刷新端点 0.6–55ms、Plan 详情 1.6–32ms、
整页 72ms（21 个请求共 290ms）、预检的 `git status -uall` 0–10ms、`git worktree add` 39ms。
`domain_events` 已 13.7 万行但索引齐备，`candidate_plans` 只 20 行。

**没有证据就不做性能改动**——那只会改坏现在正常的东西。所以这一轮交付的是两件**由构造证明、
不依赖复现**的修复，加一件让下次不再靠猜的工具。

### Changed

**1. `wake()` 不再同步跑**别的** Run 的验证**（`run/dispatch-coordinator.ts`）

`confirmAndDispatch` 末尾 `await this.wake()`，而 `wake()` 对**每一个 Run** 调 `syncRun`——其中
`READY_FOR_VERIFY` 的 Run 会当场执行该项目的验证命令（build/test，**分钟级**），且是 `await` 的。
于是"确认一个 Plan"会一直等到**另一个 Run 的验证跑完**才返回。改成后台跑
（`runVerification`，并发仍由 `verifyingRuns` 保证）：状态在分离前已写成 `VERIFYING` 并由 SSE
推给前端，结果由后台回写。

project4 没登记任何验证命令，所以这条**现在触发不到**——但真实项目里一定会踩到。

**2. 预检从"每个路径一次进程"改成"一次批量查询"**（`plan/preflight.ts`）

原来对每个 include 路径 spawn 一次 `git cat-file -e`（每次 5–10ms，全部卡在事件循环上）；
现在一次 `git cat-file --batch-check` 问完所有路径（产物路径一并问，省掉第二次 spawn）。
顺带补一条安全边界：**批量查询本身失败时不阻断**，只出一句"本次未做路径预检"——
一次失败的 git 调用不该让每个 Plan 都被判成非法。

**3. 慢请求日志**（`apps/api/src/server.ts`）

`onResponse` 钩子：超过 **1 秒**的请求往 `.runtime/api.log` 写一行
`[slow] METHOD URL <ms> <status>`，排除 SSE（天然长命，会刷屏）。
这是本轮**最关键**的产出：既然复现不出，就让真实场景自己留下痕迹——
下次报"慢"时能直接拿到路径与耗时，而不是继续猜。

### 未做（等证据）

- **`performWake()` 的全库线性扫描没有动。** 它 `listDispatchStates()` + `listPlans()`（逐行
  JSON.parse）+ 遍历所有 Run 调 `syncRun` + 遍历所有 `DISPATCHED` 计划，而 `handleEvent` 对每个
  非流式事件都触发一次。**这是整条链上唯一会随使用量变慢的环节**（18 个 Run 无感，几百个 Run 时
  会到秒级），但它落在调度热路径上，且**没有数据证明它就是这次的慢**。列入候补，等日志说话。
- `PlanService.confirm` 里 `projects.snapshot()` 被取两次，可合并——属清理，不是性能关键。
- UI 侧"同一批 15+ 请求连发三遍"未动：单个都是毫秒级，且没有证据说它是原因。

### 验证

- `pnpm verify` 全绿：domain **357** / api **111** / web **485**，无新增值级环。
- 新增/更新用例：`dispatch-coordinator.test.ts` 增一条
  「**不等待**验证跑完就返回」——把 `verify` 挂在 gate 上，断言 `wake()` 仍然返回且状态是
  `VERIFYING`（旧实现下它会一直等，测试超时）。原有那条"自动验证 READY_FOR_VERIFY"改成
  轮询等状态落定，不再靠微任务时序侥幸通过。
- `plan/preflight.test.ts` 的假 git 改成如实模拟 `cat-file --batch-check`（按 stdin 行、
  顺序对应、` missing` 结尾），并新增「多路径只 spawn 一次」「批量失败不阻断」两条。

## 2026-10-01（其十二）— 「结构化计划校验失败」是解析器的误报，不是模型的问题

### 为什么做

用户看到探索时间线上写着 **"结构化计划校验失败，请继续完善。"**，问"模型做了什么事情？"。

查下来**模型没有问题**。那一轮（需求5，`turn-aafb90bb-a42`）它：读了仓库定位到根因
（任务新增表单不传 `project_id`，`POST /api/tasks` 于是报"所属项目不合法"）、两次结构化提问锁定
产物模式与路径、第一次门禁因 `MODE_CONFLICT` 没过、补齐后第二次 `PLAN_READY` 并生成了
`plan-b2734ed8-224`。**方案是完整合法的**——同一屏下方紧跟着 PLAN_CREATED 卡片，页面自相矛盾。

问题在解析器：它判的是 **V1 的字段形状**。

| | 模型给的（V2） | 解析器找的（V1） |
|---|---|---|
| 目标 | `objective.goal` | 顶层 `goal` ← 不存在 |
| 范围 | `scope.includePaths` | 顶层 `include` |
| 验收 | `objective.acceptanceCriteria` | 顶层 `acceptanceCriteria` |
| 验证命令 | `verification.commandIds` | 顶层 `verificationCommandIds` |

顶层没有 `goal` → 直接落到"校验失败"。**从 Plan V2 落地起，每一份新方案都会这样显示。**

### Changed

**1. 两份实现都要改——这是本次最值得记的一点**

解析 Plan 协议的逻辑有**两份必要的镜像**，而**两份都只认 V1**：

- `packages/domain/src/explorer/explorer-activity.ts` 的 `parsePlanArtifact`（活动摘要落库用）；
- `apps/web/src/utils/planProtocolDisplay.ts`（流式期间 web 必须自己解析一遍，因为活动摘要要等回合
  结束才落库；而 web 不能运行时依赖领域层，那会把整个领域打进浏览器包）。

镜像的存在是必要的，但**两边的测试夹具当时也全是 V1**——所以两边同时错、谁也没暴露谁。
两份都改成同时认 V1 与 V2（V1 只用于读历史消息），并在两处都补了 **V2 夹具**，
字段直接取自那次真实输出。

**2. 新增跨实现一致性测试**

`apps/web/src/utils/planProtocolDisplay.parity.test.ts`：同一批夹具同时喂给领域层与 web 两份实现，
断言 READY / INVALID / GENERATING / plain 四种结论与全部摘要字段一致。任何一边改了判定都会红。
（与 `executionStream.parity.test.ts` 同一手法，理由也相同。）

**3. 消除歧义的两条边界**

- 用 `undefined` 判空而不是真值判断：空字符串在旧实现里算合法，不改那条语义。
- `verificationCount` 为 0 是**正确值**：模型只声明 `verification.mode`，命令 ID 由 Factory 解析。

### 验证

- `pnpm verify` 全绿：domain **354** / api **111** / web **485**，无新增值级环。
- **活动摘要是读时投影**，所以修复对历史线程同样生效。已用真实数据核对：
  `GET /explorers/explorer-36c7fd77-f5f/activity?explorerPlanId=explorer-plan-ba2db4ca-5ac`
  里两条原本 `status: INVALID` 的助手活动，现在返回 `status: READY` 与
  「完整执行方案已生成：需求5：修复现有项目添加任务时所属项目不合法」；
  浏览器打开同一线程，"校验失败"已消失、两处都显示方案标题。

## 2026-10-01（其十一）— 执行会话的阶段感与降噪

### 为什么做

执行线程页反复打补丁，但"不好理解"一直在。这一轮把根因拆成三条，都是**看得见的具体现象**：

1. **没有阶段感。** 页面只有一条平铺的消息流 + 顶部六个状态卡，回答不了"现在在干什么、下一步是什么"。
2. **噪音淹没正文。** `reasoning` / Provider 消息 / 会话重建这类**没有成败概念**的活动各占一张卡：
   全库 343 条 `PROVIDER_ACTIVITY` 里有 210 条属于这一类。它们和"命令失败""任务完成"长得一样大。
3. **空执行步骤各占一张卡。** 5 个还没轮到的步骤就是 5 张"尚无结构化进度事件表明此任务已开始"。

### Changed

**1. 三阶段条**（`execution-phase-strip`）

执行 / 验证 / 合并 三步，当前步高亮、已完成打勾，各带一句人话（`0/6 步骤`、`已跳过`、`等待人工合并`）。
当前步由 Run 状态推出：`MERGE_READY` 或已建 Merge request → 合并；有验证结果或处于
`VERIFYING` / `READY_FOR_VERIFY` → 验证；否则执行。**BLOCKED / CANCELLED 停在它当时所在那一步**，
不往前推——否则"卡住了"会被显示成"正在进行下一步"。

**偏差说明**：计划里写的是**四**阶段（准备 / 执行 / 验证 / 合并），实际交付**三**条。原因：
"准备"的事实（工作树、基线、生命周期钩子、Run 级活动）上一轮刚收进顶部 RUN CONTEXT 卡片，
再在会话区放一条"准备"会变成两处讲同一件事。阶段条因此只覆盖会话区能回答的那三步。

**2. 活动噪音折叠**

`outcome === "not-applicable"` 的条目不再各渲染一张卡，收进该执行步骤下的一个
`<details>`（默认一行：「N 条活动记录（推理 / 消息）」），展开是紧凑的一行一条。
**没有丢数据**：它们仍可回溯，只是默认不占视线。步骤头的计数也随之分成两段
（`10 条` + `6 条活动`），一眼能看出"这一步真正发生了什么"有多少。

**3. 连续的空执行步骤并成一行**

`collapsePendingTaskGroups` 把**连续的**空步骤合成一行「N 个执行步骤尚未开始」并列出标题。
只在连续时合并：中间夹着有内容的步骤时分开显示，"跳过第 2 步先做第 3 步"这种事实才看得出来。

### 未做

- **时间线仍是"按执行步骤分组"，没有整体重排成阶段分区。** 阶段条是**导航**，不是容器：
  它告诉你现在在哪一步，但下面的消息流依然按执行步骤组织。把整个会话重排成四个分区是更大的改动，
  且会把"某一步跨了验证阶段"这类真实的交叉情况压平，本轮不做。
- 执行步骤之间仍按方案顺序而非时间顺序排列（既有性质）。

### 验证

- `pnpm verify` 全绿：domain **353** / api **111** / web **475**，无新增值级环。
- 新增用例（`RunDetailView.test.ts`）：阶段条存在且 `.execution-phase.current` 有样式、
  噪音判据是 `outcome === "not-applicable"`、卡片循环改用 `visibleItems`、噪音进 `<details>`、
  空步骤折叠只在**连续**时合并。
- 浏览器实测（dev 5174）：
  - `run-88084cfe-12d`（IN_PROGRESS）：阶段条显示「① 执行 0/6 步骤 ←当前 / ② 验证 未开始 /
    ③ 合并 未开始」；5 张空步骤卡变成一行「5 个执行步骤尚未开始」；task-1 组从 16 张卡变成
    10 张卡 + 一行「6 条活动记录（推理 / 消息）」。
  - `run-a1aa1eae-f43`（MERGE_READY）：阶段条正确推进为「执行 1/1 ✓ / 验证 已跳过 ✓ /
    合并 等待人工合并 ←当前」。
  - **同时确认了上一轮改造在界面上的效果**：同一条命令活动现在显示「命令 · 已完成 ·
    Provider reported success」，改造前它是「状态未知 · Provider 已结束调用，但成败状态未记录」。

## 2026-10-01（其十）— agent 词表中立化、工作区干净闸门、路径预检、Plan 落盘

### 为什么做

三件事都由使用中的事实推动，不是重构偏好：

**1）执行成功率低，且原因高度集中。** 全库 Run 结局 `MERGE_READY` 10 / `CANCELLED` 3 / `BLOCKED` 3，
阻塞原因里 `PROVIDER_COMMAND_TIMEOUT` 6 次、`package.json remains missing in expected project directory`
4 次、各种"目标文件缺失 / 工作树为空"8 次以上。**没有一条是"模型不会写代码"**——全是计划假设的
前置条件与现实不符。而 Explorer 是只读的、读得到仓库，这些事实在生成 Plan 时就能查出来。
仓库里的 `docs/execution-preflight-and-recovery.md` 正是上次同类事故的人工复盘，但**它只是文档**。

**2）同一个动作换个 agent 就换个名字，成败基本读不出来。** 两个 Provider 的原生词表完全不通用
（Codex：`reasoning`/`commandExecution`/`fileChange`/`userMessage`/`mcpToolCall` + `completed`/`failed`；
Claude：`tool_use`/`tool_result`/`providerSession` + `started`/`succeeded`/`failed`），而消费方此前
各自正则猜标签、各自维护成败白名单。后果：全库 `PROVIDER_ACTIVITY` **343 条"状态未知"、11 条失败、
0 条成功**——Codex 的成功词 `completed` 不在成功白名单里，成功从未被识别过；其中 210 条是 `reasoning`
与 `userMessage`，它们**本来就没有成败概念**。

**3）Plan 只存在于页面里。** 落不到盘上，就无法随工程被审阅、被 diff、被版本化。

### Changed

**1. Provider 活动语义中立化**（`model/provider-activity.ts` 新增）

- 中立词表：`activityKind`（command / file-change / tool / mcp / reasoning / message / session / other）
  与 `outcome`（running / succeeded / failed / unknown / **not-applicable**）。
- **`not-applicable` 与 `unknown` 分开是这次的关键**：前者是"这类活动没有成败概念"（推理流、用户消息、
  会话重建，UI 不再给它们挂状态标签），后者是"应该有成败但 Provider 没给"。两者此前混成同一个
  "状态未知"，是 210/343 条噪音的来源。
- 两个 Provider 的映射表**集中在一处、并排写**，"同一逻辑活动 → 同一类别 + 同一成败"因此可读可测；
  `ModelEvent.provider.activity` 的两个新字段**必填**，编译器会指到所有需要更新的夹具。
- 顺带修掉两处**只认 Codex 词表**的判定：`agent-loop.ts` 的单条命令超时此前判
  `itemType === "commandExecution"`，于是**执行器跑在 Claude 上时 Bash 命令根本没有单条超时**，
  只能等整个 Loop 超时（`PROVIDER_COMMAND_TIMEOUT` 那一类阻塞有一半来自这个盲区）；
  `executor-agent.ts` 的 TOOL_CALL 账本现在与 UI 共用同一个 outcome。
- Claude 侧顺带修掉一个显示缺陷：`tool_result` 不带工具名，合并后标题会退化成 `toolUseId`——
  现在由 gateway 记住本轮的工具名，标题与类别都与它的 `tool_use` 一致。
- **向后兼容**：旧 journal 事件没有这两个字段，web 投影保留回退路径（同样修掉 `completed → 成功`），
  `executionStream.parity.test.ts` 用同一批样例断言"镜像与领域实现给出相同结论"。

**2. 派发前的工作区干净闸门**（`git/working-tree.ts` 新增）

- 判据：`git status --porcelain -uall -- . ':(exclude)<planDirectory>'` 为空。白名单用 **git pathspec
  magic** 而不是自己解析 porcelain——后者要处理 rename 的 `old -> new` 与引号转义，漏一个就会把
  Factory 自己写的计划文件算成脏。
- 闸门在建 worktree 时**硬阻断**（`LocalGitWorktreeAdapter.create`，位置在 `worktree add` **之前**：
  顺序颠倒会白建一个工作树再回滚），由 `Scheduler` 落成 Run 的 BLOCKED 原因；确认 Plan 时只**提示**
  不阻断（确认计划与工作区干净是两件事）。
- **基线因此恒等于 `baseCommit`**：`snapshotProjectWorkingTree` 的"把未提交改动铺进工作树"随之删除
  （模块一并移除），`git/worktree.ts` 的维护提示第 2、3 条与它相反的事实一起改掉。
  理由：那会让"你本地看到的树"与"Agent 改的树"成为两棵不同的树，"我本地明明是好的"这类纠纷
  无法收敛。未提交改动被挡在门外是**有意**的。

**3. 派发前的路径预检**（`plan/preflight.ts` 新增，`PlanService.confirm` / `confirmRevisionDraft` 落闸门）

- 只查 **include 里带扩展名的具体文件**：`artifact.path` 与通配范围都不查——产物天然可能是要新建的
  文件（"添加甘特图"就要新建组件），通配描述的是"在哪个范围里干活"。具体的**输入文件**不存在，
  才是"计划建立在幻觉上"。
- 判定用 `git cat-file -e <baseCommit>:<path>`（一条命令同时覆盖文件与目录），**同步实现**——
  它跑在 `confirm` 这条同步短路径上，与 `git/merge-inspector.ts` 同样的理由。
- 闸门放在 **service 而不是 route**：`routes/plans.ts` 有 `confirmAndDispatch` 与 `plans.confirm`
  两条路径，service 是唯一必经点。`PLAN_PREFLIGHT_FAILED` 由路由拆成 `code` + `error` 返回 409。
- **Explorer 侧闭环**（不做的话用户会"生成 → 阻断 → 再生成"空转）：`EXPLORER_PLAN_INSTRUCTIONS`
  补一条——声明方案前必须自行核对具体文件是否存在；要新建文件就写目录范围。闸门是兜底，不是主交互。

**4. Plan 落盘**（`plan/plan-archive.ts` 新增，`project.planDirectory` 新增配置）

- **只在确认时写**，每版一个文件 `<planId>-v<revision>.md`，**不覆盖旧版**；目录不存在自动创建。
- 内容是人读的 Markdown：目标、验收标准、范围、实施步骤与依赖、验证命令、产物路径、基线、
  契约哈希、确认人与时间。
- **写盘先于冻结 Revision**：写失败就阻断确认（可重试、无副作用）；反过来先冻结再写，会留下
  "确认成功了但文件没写成"的中间态。
- 落盘路径**持久化**进 Revision（`plan_document_path`，按仓库既有 `ALTER TABLE` 迁移惯例加列）
  而不是运行时推算——推算值会随配置漂移，"文件在哪"就成了一条会变的事实。
- 这些文件会出现在受管仓库的 `git status` 里（这正是"随工程版本化"的用意），且**不会**阻断派发：
  干净检查对该目录放行。两条规则共用 `plan/plan-directory.ts` 的同一处解析，避免"确认时不脏、
  建 worktree 时脏"。

### 未做

- **执行线程页面重做（四阶段 + 降噪）尚未开始**：本条目只交付了它依赖的数据层与闸门。
  页面改版是下一轮。
- 命令 / manifest 缺失**不做硬阻断**（可能由 Agent 自行创建），只作信息级提示。
- `docs/execution-preflight-and-recovery.md` 的人工流程未改（其第 6、7 条在"工作区必须干净"之后
  语义已变），本轮只更新了代码注释。

### 验证

- `pnpm verify` 全绿：domain **353** / api **111** / web **474**，无新增值级环。
- 新增用例：`model/provider-activity.test.ts`（跨 Provider 等价：同一条命令 / 失败 / 文件修改
  两个 Provider 给出同一类别与同一成败；Codex 的 `completed` 就是成功；没有成败概念的类别返回
  not-applicable）、`git/working-tree.test.ts`（判据、白名单路径、**先检查再建树**的顺序、
  基线恒等于 baseCommit、porcelain 解析含 rename 与引号路径）、`plan/plan-directory.test.ts`
  （缺省位置、仓库外返回 null、前缀相似的兄弟目录不算"之内"）、`plan/preflight.test.ts`
  （通配不查 / 产物缺失只警告 / 绝对路径与 `..` 不查 / 仓库读不到时不做判断 / 阻断时**没有冻结
  Revision**）、`plan/plan-archive.test.ts`（渲染内容、目录自动创建、**每版一个文件不覆盖**、
  同一版幂等、路径记进 Revision）。
- `m3-run.test.ts` 的 git 调用序列守卫随之更新（那条断言钉的是旧的三步序列，属**有意的行为变更**，
  不是回归，故改测试而非登记基线）。

## 2026-10-01（其九）— 把「Run 级活动」移出执行会话，并给归因缺口正名

### 为什么做

起因是一句提问："`未关联执行步骤` 是什么意思？"——**用户看不懂自己界面上的一个标题**，这本身就是结论。
查真实数据（`execution_journal` 表）之后发现两件事：

- 那个桶的日常内容是 `RUN_CREATED`(15) / `HOOK_SKIPPED`(17) / `VERIFICATION`(9) / `USER_GUIDANCE`(2)，
  它们**结构上永远没有 `taskId`**——讲的是整个 Run，本来就不属于任何一步。这是**常态**。
- 文案「未关联执行步骤 ← 此处保留旧 Run 或未提供执行步骤标识的事件」却在描述**异常**，
  而且先说了少数派（老数据）。真正的老数据只有 404 条无 `modelStep` 的 `MODEL_OUTPUT`，
  **全部集中在 2026-09-18 ~ 09-25，之后再没出现过**。

还有一个更根本的展示问题：桶永远排在时间线最后，但里面的 `Run created` 永远**最早**发生。
截图里的视线路径是：5 张「尚无结构化进度事件表明此任务已开始」的空卡片 → 才看到实际发生的两件事。

### Changed

**1. 判据改为一行：`kind === "activity" && !taskId`**

- 即「没有归属于任何执行步骤的 Run 级事件」。原先按事件类型列举（RUN_CREATED / HOOK_* / VERIFICATION）
  的写法每加一种 Run 级事件都要回来补一次，且同样无归属的 `Executor started` / `Execution gate`
  会被漏在会话里名不副实。
- 投影层（`utils/executionStream.ts`）**没有改动**——判据只用既有字段。

**2. 时间线不再有 Run 级活动组，改由顶部 RUN CONTEXT 卡片承载**

- `ExecutionHeaderStatus` 新增 `runActivity` prop，在 RUN CONTEXT 弹层（原本只有
  WORKSPACE / BASE COMMIT / THREAD / STARTED）下方加一节 **RUN ACTIVITY · Run 级活动**：
  说明改成「Run 的创建、生命周期钩子与验证等事件，属于整个 Run，不归属于任何单个执行步骤。」，
  下面按时间列出事件。它讲的是「这个 Run 怎么起来的」，与那一格的既有字段同性质。
- **有 Run 级活动失败时卡片本身变红**（如 `HOOK_FAILED`）——否则失败只藏在弹层里，不点开看不见。
- 时间线由此收敛为：冻结方案 → 执行步骤 → 你说的话（＋老数据的归因缺口）。

**3. 归因缺口组正名：`unassigned` → `unattributed`**

- 标题「未关联执行步骤」→「**未归属事件**」，说明改成「这些事件没有记录所属的执行步骤，
  只出现在早期 Run 的数据里。」
- **说明文案不再需要判断"要不要显示"**：该组现在只在真有归因缺口时才存在，条件显示自然成立。
- 模板与 CSS 一起改名（`.execution-unassigned-heading` → `.execution-unattributed-heading`），不留死样式。

**4. guidance 独立成组（无组头）**

- 无 `taskId` 的 guidance 自成一格 `.execution-conversation-group-guidance`，**不渲染组头**——
  条目标题已经是「你补充了要求」，再加一层组头是重复。

### 一处计划外的发现（纠正本轮计划里的假设）

计划里写的是「你自己发的消息现在也被标成"未关联执行步骤"」。**实测不成立**：
`run-8d0b9489-06d` 第 86 条的 guidance 带上了 `taskId`——投影用「当前模型轮次」给它归了因，
所以它一直显示在对应的执行步骤组内，时序也是对的。只有**早于任何步骤归因**的 guidance
（`run-5fd6449b-c0d` 第 5 条，前面只有 RUN_CREATED / HOOK_SKIPPED）才会落进那个桶，
第 4 条改的正是这一种。规则本身以数据为准，不是以假设为准。

### 未做

- **分组模型仍按「方案 → 步骤顺序」排列，不按时间穿插。** 无 `taskId` 的 guidance 因此仍是
  独立一组排在末尾，而不是插在它真正发生的位置。修它等于重做分组模型（任务组之间也不是严格时序），
  属于另一件事；本次只保证它不再被错标。

### 验证

- `pnpm verify` 全绿：domain **309** / api **111** / web **460**，无新增值级环。
- 新增用例：`ExecutionHeaderStatus.test.ts`（列出 Run 级活动、没有时不渲染这一节、失败时卡片变红）、
  `RunDetailView.test.ts`（判据是 activity+无 taskId、旧标题与旧说明不再出现、模板与样式两侧同步改名、
  guidance 独立成组）。
- 浏览器实测四个 Run（dev 5174）：
  - `run-88084cfe-12d`（现代 Run）：时间线**不再有** RUN ACTIVITY 组；RUN CONTEXT 弹层出现
    「Run 级活动 2 条」，列出 `Run created 10:55:40` 与 `Hook skipped start`。
  - `run-5fd6449b-c0d`：第 5 条的 guidance 渲染为独立一格、无组头，不再挂在旧桶下。
  - `run-8d0b9489-06d`：带归因的 guidance 仍在任务组内、时序不变（确认第 4 条没有误伤）。
  - `run-bbf57894-513`（老数据）：`UNATTRIBUTED 未归属事件 1 条` + 新说明正常渲染，
    另有 7 条 Run 级活动被移到了顶部。
- **本条补完的改动有一半先随 `bb5a6ce` 落库**（分组类型与判据两处 hunk 被那次提交一起 `git add` 了），
  当时仓库处于"新判据已生效、模板仍判断旧 kind"的半成品状态；本条把模板、样式、测试一并补齐。

## 2026-10-01（其八）— 执行对话按步骤折叠；用横线分段取代左侧竖线

### 为什么做

两条反馈都关于"按 task 分组"这件事做得不够：

1. **步骤的存在感弱、也不能收**。分组本身是对的，但从这一步切到那一步时，只能一路滚——想"逐个
   看每个 task 执行得怎么样"就会乱。
2. **每个步骤左边那根竖线占地方**。它把整组内容往右推 53px（`margin-left: 39px` + `padding-left: 14px`），
   而它想表达的"这是一组"其实已经有分组头在说了。

### Changed

- **步骤头变成折叠开关**（`<header>` → `<button>`，带 `aria-expanded` / `aria-controls`）：
  整条可点，右侧有箭头，收起的是**这一组的消息**——步骤头始终留着，它就是"这里还有一个 task"的那一行。
  头部同时补强了可读性：`PLAN TASK` 变成小圆角标签、标题加大、状态变成带色标签
  （完成绿 / 进行中蓝 / 阻塞红）、右侧显示条数（`19 条`），阻塞原因照旧在最下面一行。
- **去掉左侧竖线**，改成**组与组之间一条 2px 横线**：省下横向空间，任务边界反而更醒目。
  "从状态卡选中某一步"的高亮也从"竖线变蓝"改成整条头部高亮。
- **从状态卡跳到被收起的步骤时先自动展开**（`focusExecutionTask` → `expandTaskGroup`）——
  否则"跳过去"看起来像没反应，而这正是这个折叠功能最容易踩的坑。

### 验证

- `pnpm verify` 全绿：domain 309 / api 111 / web **456**。新增断言：步骤头是带 `aria-expanded`
  的按钮、`toggleTaskGroup` 有没有接上、条目容器存在、聚焦时先展开，以及**样式表里不再出现
  `.execution-conversation-group-task { … border-left … }`**、且组间是 `border-top: 2px solid`
  （竖线不许悄悄回来）。
- 浏览器实测（真实 Run `run-14f0417a-5cb`）：
  - 计算样式：组 `border-left: 0px none`、`border-top: 2px solid rgb(215,224,236)`、`margin-left: 0`。
  - 头部为 `BUTTON`，`aria-expanded=true`、`aria-controls=execution-task-stream-task-task-1`，
    文案 "PLAN TASK | … | Completed | 19 条"。
  - 点一下：`aria-expanded=false`、组多出 `.collapsed`、条目容器从 DOM 移除、可见消息 0 条；
    再点恢复。

## 2026-10-01（其七）— 设置页改执行模型不再被"有 Run 在跑"挡住

### 为什么做

报障："project4 我把执行模型换成 claude 了，执行线程底部还是 codex 与 gpt-5.6-luna。"

查下来是两件事叠在一起：

1. **那次保存根本没成功**。`ProjectService.update` 把**任何** settings 变更都算作"高风险"，
   而高风险变更要求没有活动 Run（`hasActiveRun`，含 `STARTING / IN_PROGRESS / VERIFYING`）。
   project4 当时有两个 `IN_PROGRESS` 的 Run，于是返回 409 `PROJECT_HAS_ACTIVE_RUNS`——
   而用户看到的只是一句英文 "has active runs"，很容易当成无关提示划过去。
2. 即便存成功，**已确认的 Plan 与它派生的 Run 用的是确认时冻结的那份配置**
   （`executor-agent` 从 `revision.projectConfigSnapshot.settings.models.executor` 取模型），
   所以那份 Run 仍会显示 codex。这一条是设计不是 bug，但页面上没写清楚，用户第二次困惑就在这。

数据库侧的佐证：project4 的 `config_version` 一直是 **1**、`project_config_revisions` 只有建项目那一条、
`domain_events` 里今天**没有任何** `project.config.updated`——那次修改从未落库。

### Changed

- **`ProjectService.update`：把"高风险"收窄到真正会动到运行中 Run 脚下那块地的改动** ——
  仓库 / Worktree 路径、默认分支，加上 hooks。模型、并发、命令、工具白名单不再被活动 Run 挡住：
  它们在 Plan Confirm 时就冻结进 Revision 快照，运行中的 Run 只读自己那份。
  设置页三处提示本来也是这么承诺的（General 栏"仓库目录、Worktree 和分支修改需要没有运行中的 Run"
  vs 执行/模型栏"这些设置会在下一次 Plan Confirm 时冻结"），**是实现比文案更严**。
  hooks 保留在守卫内：`PATCH /hooks` 那条路由本来就有同一道守卫，不能从这里开后门。
  拒绝信息补了中文说明（哪些被挡、哪些可以随时改），不再只有一句 "has active runs"。
- **Models & Tools 栏文案**（弹框与独立设置页各一处）：补上"已确认的 Plan 与正在跑的 Run 继续用
  它们冻结的那份，改动从下一次 Plan Confirm 起生效"。
- **执行线程底部的来源说明**：当项目当前配置与这份 Run 用的模型不一致时，写成
  `本次执行记录 · 项目当前配置 claude-opus-5（改在下一个 Plan Revision 生效）`——
  把"为什么还是旧的"直接写在页面上（`utils/executionTelemetry.ts` 的 `executionModelSourceNote`，纯函数 + 单测）。

### 验证

- `pnpm verify` 全绿：domain **309** / api **111** / web **455**。新增用例：
  `project.test.ts`（活动 Run 下改模型可以存、路径/分支/hooks 仍被挡）、
  `server.test.ts`（同一条经 HTTP 走通，`configVersion` 1→2）、
  `executionTelemetry.test.ts`（来源说明 + 配置漂移提示）。
- 先写了一条会失败的用例复现报障（`→ Project project-1 has active runs`），再改实现——它现在留在
  测试里当回归守卫。
- **没有在你的 project4 上实测保存**：那会真的改你的项目配置，我没动。修好后在设置里再存一次即可。

## 2026-10-01（其六）— 执行线程改成对话观感；底部回答"现在用的是什么模型"

### 为什么做

两条反馈，都在执行页签（抽屉里的 Run）里：

1. **"内容结构混乱"**：一屏都是卡片墙，`Turn #1`、`Call …`、`Provider item msg_…`、
   `Provider session linked` 全挤在每条消息的标题行上，像日志不像对话。期望"我和大模型沟通"的观感：
   我的消息在右、执行者的在左。
2. **"底部不知道当前用的是什么模型"**：底部那条 `AGENT / MODEL / CONTEXT` 三格都是"未记录"。

### Changed

**执行对话：左右分栏 + 降噪（只改渲染与样式，不动 journal 投影）**

- 我的消息（`role === 'user'`，即 guidance）靠右、执行者的靠左。原来 `flex-basis: 92%` 几乎占满整行，
  右对齐等于没做——现在收到 `min(620px, 78%)`。
- 诊断字段收进"详情"：常驻只留 **标题 · 状态 · 时间**；`Turn #`/`Call`/`Provider item`/`Provider session`
  移到 hover（`title`）与"详情"折叠里。规则抽成 `utils/executionMessageDetails.ts` 并单测——
  它同时是安全边界的外沿：**只排版已有字段，不新增暴露面**（`executionStream.ts` 定过：不出工具参数、
  成功结果与思维链）。
- `状态未知` 不再整卡染黄（截图里三张黄卡很扎眼），改成中性卡片 + 状态标签。

**探索线程：同一套读法（靠右 + 右侧身份标识）**

- `.user-message` 从"整块左对齐卡片"改成靠右：`display: flex; flex-direction: row-reverse; margin-left: auto`，
  并补上右侧的 `LS` 头像（`title="我"`）。左边 assistant 有头像、右边什么都没有的话，
  一眼看不出那句是谁说的。右上角收一点圆角作为"这是我说的"记号，与执行线程一致。
- 记账：**"探索线程本来就是我的消息在右"这个印象与代码不符**。早先那套 `row-reverse` 右对齐规则还在
  文件里，但被后面那次"Codex Desktop 风格"改造的 `.user-message { display: block; max-width: 760px }`
  压在下面，早已失效——两条规则同时存在、只有一条生效，是本轮最容易误判的地方。

**底部：模型与 agent 必须有答案**
- **修一个真缺陷**：`projectRunThreadTelemetry` 重建 telemetry 对象时漏搬 `backend`，于是库里记着
  `codex-app-server`、界面上 AGENT 一栏**永远是"未记录"**。现在 `existing` 有的字段逐个带过去，
  缺失时才回退 Revision 快照。
- **运行中也要有答案**：遥测是**每一轮结束时**才落库的，所以"正在跑"时三格必然空白——而这正是
  想问"现在用什么模型"的时刻。新增 `resolveRunExecutorConfig`（Revision 快照优先、否则当前项目设置），
  `GET /api/v4/runs/:runId` 把它作为 `executorConfig` 单独返回，前端在"本次没有记录"时用它，
  并标注来源（`本次执行记录` / `按本 Run 冻结的项目配置`）。项目没覆盖 backend 时再回退该角色生效的
  全局后端（`/model-backends` 的 roles），否则 AGENT 一栏仍会空着。
- `context-note` 从 `provider exact` 改成 `仅结束时由 provider 上报`：运行中拿不到就是拿不到，
  说清楚比让人以为坏了强。
- **本次记录整份优先、不与配置混搭**：model 与 backend 是同一次写入的一对事实，
  混搭会造出一个从未存在过的组合。所以 09-26 那类"遥测里还没有 backend 字段"的老 Run 仍显示
  `未记录` —— 那是诚实的，不是漏修。

### 验证

- `pnpm verify` 全绿：domain 308 / api **110** / web **453**。新增/更新用例：
  `projections/run-telemetry.test.ts`（新文件：existing 优先、backend 被保留、快照兜底、都没有时为 null）、
  `server.test.ts`（`executorConfig` 与 telemetry.backend 的 HTTP 断言）、
  `utils/executionTelemetry.test.ts`（记录优先 / 配置兜底 / 都没有）、
  `utils/executionMessageDetails.test.ts`（新文件）、`components/ProviderUsageFooter.test.ts`（新文件，
  挂真实组件）、`RunDetailView.test.ts`（源码级断言跟着新模板走）。
- 浏览器实测（用**数据库副本**在 4313 起独立实例，不动正在跑的 4310）：
  - 用户给的 Run `run-62e320ce-d60` 底部从"三格未记录"变成
    `AGENT Codex App Server · MODEL gpt-5.6-luna · CONTEXT 191,197 tokens · 本次执行记录`。
  - `GET /api/v4/runs/run-62e320ce-d60` 的 telemetry 里 `backend` 回来了（修前被投影丢掉）。
  - 另一条带 guidance 的 Run：我的消息在右侧、矮而窄（body 左 1803/右 2382，其余消息左 1731/右 2408），
    每条活动只剩"标题 · 状态 · 时间 · 详情"，点"详情"展开 `Turn #1` 且 `aria-expanded=true`，
    hover 有 `Turn #1` 提示。
  - 探索线程：用户消息从"左 224 起、852 宽"变成"右贴边、760 宽"（左 316 → 右 1076），
    右侧 `LS` 头像落在 951→976，与左侧 assistant 头像（124→149）对称；抽屉里的探索对话同一套 class，同样生效。
- **未实测**：`executorConfig` 那条"运行中"回退路径只跑过单测——真实数据库里所有 Run 都已有遥测，
  我改副本数据库后又想重起实例时被权限拦下了。要用真实数据看这一条，把某个 Run 的
  `execution_threads.telemetry_json` 置空再打开页面即可。

## 2026-10-01（其五）— 新建 Project 时用系统对话框选目录

### 为什么做

反馈很直接："Git repository root 能不能改成选择文件夹？我不想输入路径，容易输错。"

**浏览器给不了这个能力，不是没做而是故意不做**：`showDirectoryPicker()` 只返回目录句柄（拿不到
`/Users/...` 这种绝对路径，且 Firefox 没有这个接口）；`<input webkitdirectory>` 只给
`webkitRelativePath`（相对路径）；拖拽文件夹的 `webkitGetAsEntry()` 同样只有相对 `fullPath`。
规范刻意不暴露路径，否则任意网页都能刺探本地目录结构。而 `repoRoot` 必须是本机绝对路径
（服务端要拿它跑 git、建 Worktree），所以**只能由跑在同一台机器上的本地 API 去问操作系统**。

### Changed

**后端：一处系统对话框，三种结果都当正常响应**

- 新增 `runtime/directory-dialog.ts`：macOS 用 `osascript` 的 `choose folder`，Windows 用
  PowerShell 的 WinForms `FolderBrowserDialog`，Linux 用 `zenity` / `kdialog`（zenity 没装才轮到
  kdialog——只有 ENOENT 才算"没装"，装了的那个报错就如实上报，不静默换一个再弹）。
- 新增 `POST /api/v4/dialogs/select-directory`。**它是 POST 不是 GET**：会在服务端弹 GUI，
  不是可以缓存或预取的读。**只接受回环地址**的调用（否则 403）——服务将来若被配成监听
  `0.0.0.0`，不该由远端决定什么时候在你屏幕上弹东西。
- 结果语义分开且都可断言：`{ cancelled: true }`（用户点了取消，**200，不是错误**）、
  `{ cancelled: false, path }`、501（平台不支持，提示手输）、504（等超时）、502（命令失败）。
- 平台命令都缺时抛 `DIALOG_UNSUPPORTED` 而不是静默返回空——"点了没反应"在这一轮里已经反复
  被判定为缺陷，不该在新按钮上重演。

**前端：两个新建入口共用一段交互**

- `api.selectDirectory()` + `composables/useDirectoryPicker.ts`（点按钮 → 弹框 → 回填；
  取消什么都不做，失败把后端那句话原样显示在弹框里）。
- `ProjectCreateDialog` 与 `ProjectManagementDialog` 的创建态各加一个 `选择文件夹…` 按钮，
  输入框保留（手输与粘贴照旧）。

### 验证

- `pnpm verify` 全绿：domain 308 / api **104** / web **444**。新增用例：三个平台各自的"取消长什么样"
  （含**中文系统**的 AppleScript 文案）、成功的路径取用、真失败与"被信号打断"的区分、
  路由的 200 取消 / 200 选到 / 501。
- 浏览器 + 系统实测（独立测试实例 4312，不碰正在跑的 4310）：点按钮后请求**一直挂起**，
  在 `ps` 里能看到 API 进程下的 `osascript -e POSIX path of (choose folder …)` 子进程
  —— 对话框确实弹出来了；杀掉该子进程后，页面显示
  `打开文件夹选择框失败：osascript 未能返回目录：进程被信号中断（SIGTERM）`（502 / `DIALOG_FAILED`）；
  从局域网地址（`192.168.2.107`）请求得到 **403 `DIALOG_LOCAL_ONLY`**，且不弹窗。
- **实测中修掉一个错误**：第一版把"子进程被外部杀掉"和"等超时"都算成 504 `DIALOG_TIMEOUT`，
  于是页面会写"等待选择超时（300 秒）"——当时只过了 16 秒。现在只有 Node 自己按 timeout 杀的
  （`error.killed`）才算超时，别的信号如实报 `DIALOG_FAILED` 并带上信号名。
- **未验证**：Windows / Linux 的命令是照各自文档写的，本机（macOS）无法实测；"用户真的选中一个
  目录 → 路径回填"这一步需要真人点对话框，由使用者验收（取消/失败两条路已实测）。

## 2026-10-01（其四）— dev 下 API 热重载，改 domain 不再需要重建

### 为什么做

dev 模式下 API 跑的是 `src/main.ts`（tsx），但 `@pipeline-factory/domain` 是通过包的
`exports` 解析到 `packages/domain/dist/index.js` 的。于是"改 domain"实际上要走三步：
`tsc` 重新构建 domain → 停掉 API → 再启动，中间任何一步漏掉，跑的就是旧代码，而且**没有任何
提示**——进程活着、健康检查通过、行为却是上一版。这正好是本地调试最费时间的那类假象。

### Changed

**1. dev 下 domain 走源码，不再经过 dist**

- `packages/domain/package.json` 的 `exports["."]` 增加最高优先级条件
  `"pipeline-dev": "./src/index.ts"`；`apps/api` 的 `dev` 脚本加 `--conditions=pipeline-dev`，
  于是运行时命中该条件，直接加载 `packages/domain/src/index.ts`，由 tsx 现场编译。
- 条件名取 `pipeline-dev` 而不是通用的 `development`：后者可能被依赖树里别的包或工具默认打开，
  污染面不可控；自定义名只有显式传 `--conditions` 才会命中。
- **没有用 tsconfig `paths` 指向源码**：那样 `apps/api` 的 `tsc --outDir dist` 会把
  `packages/domain/src/**` 拉进 program，而它不在 `rootDir`（`apps/api/src`）之内，
  构建会以 TS6059 失败。exports 条件只作用于运行时解析，`tsc` 看不见，构建链路零改动。
- `predev` 仍然构建 domain——那是给 `tsc` 与编辑器解析 `types` 用的，已经不是运行时依赖。

**2. API 以 `node --watch` 启动**

- `dev` 脚本由 `node --import tsx/esm src/main.ts` 改为
  `node --watch --conditions=pipeline-dev --import tsx/esm src/main.ts`。
  `--watch` 监听**已加载的源码模块**，因此改 `apps/api/src` 与 `packages/domain/src` 都会自动重启；
  它默认跳过 `node_modules`，而 domain 源码解析出的是真实路径 `packages/domain/src/`，
  不在 `node_modules` 下，不会被漏掉。
- 用 `node --watch` 而不是 `tsx watch`：条件解析要的是 Node 自己的 `--conditions`（否则得退化成
  `NODE_OPTIONS` 环境变量），而 `--watch` 与 `--import tsx/esm` 本就配套。
- 代价写进了 `code/README.md`：重启会切断 SSE 连接、重置调度器内存状态，数据库与事件流本身是持久的。

**3. `apps/web` 不动**

- web 只在 `*.test.ts` 里引用 domain（`type-parity.test.ts`、`explorerPlanRequirements.test.ts`），
  运行时不依赖它，所以 vite 侧不需要任何 alias 或条件。

### 未做

- **prod 不受影响，也没有改动**：`pnpm build && pnpm start` 不传 `--conditions`，仍加载 `dist/`。
  两条路径（源码 / 产物）按设计并存，不是"临时绕过"。
- 没给 web 加 HMR 相关配置：vite 本来就带，问题只在 API 这一侧。

### 验证

- **源码 vs 产物的直接证据**：临时在 `packages/domain/src/index.ts` 顶部插入
  `throw new Error("WATCH-PROBE: domain src 被加载")`，API 自动重启后崩溃，栈顶为
  `at <anonymous> (/Users/Bill/Downloads/pipeline-factory/code/packages/domain/src/index.ts:62:7)`
  ——加载的确实是源码，且**改动是被自动发现的**。随后删除探针，日志出现
  `Restarting 'src/main.ts ...'`，`GET /health` 恢复 `{"status":"ok",...}`。
- `touch apps/api/src/server.ts` 同样触发重启（PID 换新），确认 api 侧源码也在监听范围内。
- `pnpm build` 与 `pnpm typecheck` 全绿（domain / api / web 三包），确认新增 exports 条件没有
  影响 `tsc` 的 `types` 解析与产物构建。
- 服务以 `node scripts/service.mjs start --mode dev` 正常起停，`stop` 的进程树清理未受影响。

## 2026-10-01（其三）— 对话产物的确认边界、Explorer 指令与一处死代码清理

### 为什么做

从一次用户报障开始："需求7 确认了 V2 之后，执行页签点不动。"查下去是三件独立的事叠在一起，
最后顺手清掉一处死代码。三件事都绕着同一条边界：**对话产物（CONVERSATION）可以被确认，但不能被执行。**

### Changed

**1. 抽屉里的 "Confirm V2" 点了没反应**

- 根因不在按钮，而在"确认哪一版"。工作区投影**只把 DRAFT 的 Plan 当候选**：已确认 Plan 上挂着修订草稿时
  `candidate` 是 `null`，而 `confirmPlan` 第一行就固定读它——于是直接早退，没有请求、没有报错、没有提示。
  抽屉却照常渲染出草稿投影的 "Confirm V2"（它走的是 `detailPlan`），**两边认的不是同一份 Plan**。
- 改法：`confirmPlan` / `discardPlan` 的**目标由调用方给**（抽屉传 `detailPlan`，时间线内联卡传卡片自己那份），
  缺省才回落到 `candidate`——与 `enqueuePlan(plan)` 一直以来的写法一致。
- 顺带修掉一处同类缺陷：内联卡的 `@click="enqueuePlan"` 会把 MouseEvent 当 Plan 传进去，
  `plan.status !== "READY"` 直接早退——**那个 "Enqueue plan" 按钮此前同样是死的**。
- 一并发现："Discard plan" 在同样的状态下也点不动（同一个读 `candidate` 的守卫）。

**2. Explorer 不再把 CONVERSATION 标成"推荐"**

- `EXPLORER_PLAN_INSTRUCTIONS` 补一条：不得把 CONVERSATION 标成推荐、默认项或首选；需求要改仓库里的文件时
  只有 REPOSITORY_FILE 能被执行；只有"只要一份对话内的结论、不落盘"的需求才适合 CONVERSATION。
  起因是需求7 那次提问把 CONVERSATION 标成"（推荐）"，而同一组回答里用户选的目标与范围
  （补充/修改作品集 + 仅 `code/personal-site/**`）明明是仓库改动——**模型推荐错了模式，系统也没提示这个矛盾**。
- **生效范围**：这段指令只在 `role === "explorer" && mode === "plan"` 且**新建 provider thread** 时注入
  （`codex-app-server.ts`），所以**已存在的探索线程拿不到新提示词**，要新建线程/需求才会用上。

**3. 确认前给警告（只警告、不拦截）**

- Plan 详情抽屉：确认按钮上方说明"确认后仍不能入队或启动 Run"以及出路（改成 REPOSITORY_FILE 并确认新版本）。
- 时间线内联卡（PLAN CREATED 卡与 assistant 活动卡各一处）：同一句话的紧凑版。
- 之所以只警告不拦截：对话产物是**合法契约**（设计文档 §14：两种模式都可 Confirm，只是禁止 Enqueue/Dispatch/Start Run），
  确认入口不该被拿掉；要拦的是"不知道自己正在确认什么"。

**4. 删除死代码 `PlanCenterPanel`**

- 它在 ac4d794（consolidate explorer requirement workspace）之后就没有任何地方渲染了：全仓库只剩它自己、
  它自己的测试，以及 `ExplorerView.test.ts` 里一个从未被使用的 `planCenterSource` 声明。
  它做过的事已由 Explorer 的需求工作区承接（配置项目命令、创建更新版本都在任务面板里）。
- 同时删掉它的测试与那个未使用的声明；保留 `not.toContain("<PlanCenterPanel")` 守卫并注明新含义——
  **不要再长出第二套 Plan 中心**（与它并列的两条旧上下文面板守卫同理）。
- 两条账要记：
  - `utils/runPrerequisites.ts` 的 `parseMissingRunCommands` 现在只剩测试在调它（面板是唯一生产调用方）。
    **本轮没动它**——删不删取决于还要不要那个提示文案。
  - 面板里的 **"Retry dispatch"（自动派发失败后重试）目前界面上没有入口**：它只存在于这个面板，
    随 ac4d794 一起失去可达性。删死代码不会让它更差，但这是真实的能力缺口，需要时得在需求工作区补一个。

### 验证

- `pnpm verify` 全绿：domain **308** / api **96** / web **441**（比上一轮少 4 条 = 随面板删掉的用例）。
- 新增/更新用例：`usePlanLifecycleActions.test.ts`（候选为 null 时确认与丢弃仍走草稿端点）、
  `ExplorerView.test.ts`（抽屉 `@confirm` 传 `detailPlan`、两张内联卡的警告句）、
  `PlanDetailContent.test.ts`（**挂真实组件**：对话产物有警告且仍可确认、可执行方案没有警告）、
  `plan-requirements.test.ts`（锁住"不得标成推荐"那句，并与 `artifactModes` 交叉校验）。
- 浏览器实测（dev server 5173，代理到同一个 4310 API）：需求7 的 V2 草稿点 "Confirm V2" 会发出
  `POST /api/v4/plans/plan-f8801424-f30/revision-drafts/revision-draft-c535f61f-0b1/confirm`
  （用 fetch 拦截器拦下记录，**未真的落库**，草稿确认是用户自己点的）；对话产物草稿上抽屉与内联卡都出现警告、
  按钮仍在；REPOSITORY_FILE 的方案没有警告。

## 2026-10-01（其二）— 冲突判定范围可选、验证子集可人工重挑

### 为什么做

补齐上一轮记账的最后两项。两处都不是"加功能"，而是把已经存在但只能靠模型/只能看不能改的东西
交回人手里：

- 冲突判定此前**只认模型声明的 `conflicts` 语义键**——探索产出的键不可靠时，两道并行 Run 就可能改到
  同一片代码。派生策略的方向是有的，但"该不该保守"取决于项目，所以做**可选策略**而不是改默认。
- `verification.suites` 只能由 Explorer 产出，想调整就得让模型重出一版方案。上一轮以为需要"浏览器端
  方案草稿编辑能力"，实际与前置 Plan 是同一条路子（Factory-owned 字段 + 人来设 + Confirm 时冻结）。

### Changed

**冲突判定范围（`concurrency.conflictScope`）**

- 新增 Project 设置 `concurrency.conflictScope: "declared" | "overlap"`，**默认 `declared`**——
  与引入本字段之前逐字相同，升级不会让同目录下不相关的 Plan 突然互相排队。
- `overlap` 时**另外**比较两个 Plan 的 `scope.includePaths`：相等或一个是另一个的父路径即视为冲突
  （按路径段比较，不是字符串前缀；`code/apps/web/**` 与 `code/apps/web` 经 `scopeRoot` 归一后同义）。
- **只在同一 Project 内比较**：include 是项目相对路径，跨项目同名的 `src/index.ts` 不代表碰同一份文件。
  **这条是写测试时才发现的**——第一版没加项目过滤，测试里两个项目用了相同路径字符串，直接串到一起。
- 等待原因带上具体是哪一片范围重叠（`Waiting for conflicting Run … (overlapping scope code/apps/web/src)`），
  排障不用再去比对两个 Plan 的 scope。
- 字段**可选**：本字段之前落库的 Project 没有它，读路径一律按 `declared` 处理，不为一个新开关改写用户配置行。
- 控制台：两个设置入口的 Execution policy 各加一个 `Conflict scope` 选择器（带说明，避免误以为越保守越好）。

**验证子集的人工重挑**

- `PlanService.setVerificationSuites()` + `PUT /api/v4/plans/:planId/verification-suites`：
  候选态可改，**只有 tag 可选**（词表来自项目登记的 tags），命令 ID 依旧由 Factory 用同一套规则解析。
  空数组 = 回到项目默认全集（不是"什么都不跑"）。会**重新解析** resolvedContract 与 V1 投影
  （用当前 Project 快照 + 原有 Git 基线），既让 commandIds 跟着 tag 变，也让候选与当前配置版本对齐。
- 项目没有任何默认验证命令时明确拒绝，而不是把请求当成功。
- 控制台：Plan 详情新增 `03D Verification subset`（勾选项来自项目 tag 词表；空词表时如实说明
  "还没有登记任何验证 tag"）。顺带修正该文件里一处段落编号笔误（Merge detection 复用了 03B）。

### 验证

- domain **306** / api **96** / web **438** 全通过；三个 typecheck 无错误。
- 新增用例：`dispatch-coordinator.test.ts`（overlap 生效、declared 不生效、范围不重叠不冲突）、
  `plan-v2.test.ts`（人工改子集 → commandIds 跟着变、V1 投影同步、空数组回全集、未登记 tag 被拒、
  Confirm 后锁定）、`server.test.ts`（HTTP 路由 200/409/404）、
  `PlanDetailContent.test.ts`（**挂真实组件**验证两个编辑器：勾选 → 保存 → 抛事件、脏值前禁用保存、
  只读态只展示、空词表的说明文案）。
- 浏览器实测：Project 设置的 Execution policy 出现 `Conflict scope` 选择器与两项选项。
- `pnpm verify` 全绿（含循环依赖检查）。

## 2026-10-01 — 线程按天分组、术语统一、任务中心四分区、按 tag 选验证子集

### 为什么做

上一轮记了四项"未做"，本轮补齐。过程中发现两件事值得单独说明：

1. **`explorerTimestampTitle` 是多余的**（同日回退）。加它之前我以为"以创建时间命名"没实现，
   实际上 `placeholderExplorerTitle` / `composeExplorerTitle` **本来就是"项目简称-日期-时间"**，
   首条消息后还会升级成"时间-内容摘要"。我的改动反而把内容摘要那一半关掉了，所以整个回退，
   只在 `ExplorerService.create` 里保留原样。**需求本来就满足，且比我的实现更好。**
2. **Project 设置页保存会丢命令字段**：`ProjectSettingsView.settingsPayload` 只回传
   `commandId/argv/environment`，于是 `category`/`enabled`/`description`/`timeoutMs` 在保存时被抹掉，
   而 `defaultVerificationCommandIds` 仍指向那些命令 → domain 校验直接 409
   （"must be an enabled verification command"）。顺带修掉，否则新加的 tags 也会被同样抹掉。

### Changed

**任务中心四分区（共享一份定义）**
- 新增 `utils/taskBuckets.ts`：`taskBucketFor` / `countTaskBuckets` / `filterTasksByBucket` +
  `TASK_BUCKETS`（待执行 / 执行中 / 已完成 / 待处理）。判定**同时看 Plan 状态与 dispatch 状态**
  （排队等容量时 Plan 仍是 DISPATCHED，只看 `status` 会错报成"待执行"）。
- `PlanCenterPanel`：原来是**藏在下拉里**的状态筛选，现在是四个**看得见的**分区按钮（带数量），
  与 `全部` 并列。
- `WorkbenchView`：左侧列表加同一组分区按钮（此前没有任何分区），列表与计数一起按档过滤；
  空状态文案区分"这一档为空"与"还没有任务"。

**ThreadRail 按天分组**

- `utils/explorerGroups.ts`：按**创建日**分组（今天 / 昨天 / 具体日期；缺失或坏时间戳归"创建时间未知"），
  摊平成"日期头 + 行"供模板一次渲染。按本地日期算日键（不用 UTC 的 `toISOString().slice(0,10)`，
  东八区晚上会把"今天"算成"昨天"）。
- **组按日期倒序、组内保持原顺序**：线程列表按最近活动倒序、组名却是创建日，不排组会出现
  "9-26、9-25、9-27" 这种看着像坏了的顺序。**这条是浏览器实测发现的**（DOM 断言拿到的组序不对），
  单测当时只覆盖了"组内顺序"，没有覆盖"组间顺序"——已补用例。

**术语统一（web 文案与注释，不动 API / 领域命名）**

- 三层命名固化在 `utils/taskTree.ts` 的文件头：**需求**（ExplorerPlan）/ **方案**（Plan、Revision）/
  **任务**（已确认并进入调度的方案）/ **执行步骤**（契约里的 `contract.tasks`）。
- 逐处改掉的混用：`Tasks & dependencies` → 执行步骤与依赖、`暂无执行任务`/`Plan task` →
  执行步骤、`任务关联未记录` → 未关联执行步骤、需求清单表头 `Plan 状态`/`结构化 Plan` →
  方案状态/方案契约、候选卡的 `Tasks` 计数 → 执行步骤、项目执行会话标题不再叫"项目任务"。

**`verification.suites`：按 tag 选验证子集**

- `RegisteredCommandDefinition.tags` 新增（只对 verification 命令有意义）；Project 设置与
  `config.project.commands` 都能声明；domain 校验拒绝重复、带空白和空字符串的 tag。
- `GeneratedPlanSpecV2.verification.suites?: string[]` 新增：**模型只能声明 tag 词表**，
  仍然不能指定命令 ID。与 `mode: "NONE"` 互斥（MODE_CONFLICT），空数组也是无效写法。
- Factory 解析规则（`selectVerificationCommands`）三条都是"宁可失败也不静默改语义"：
  没声明 → 项目默认全集；声明了未登记的 tag → 抛错并列出已登记词表；命中为空 → 抛错，
  而不是退化成一个空的验证集。**解析后的 `commandIds` 才是执行事实**，请求过的 suites
  留在 `generatedSpec` 里可审计。
- tag 词表通过**仓库上下文**注入 Explorer 回合（`RepositoryContextCache` 新增
  `Verification tags: …` 一行，只给 tag、不给命令 ID），缓存键含 configHash，改配置即失效。
- 控制台：两个设置入口的命令编辑器都加 `Verification tags`（逗号分隔）；Plan 详情在
  VERIFICATION 一格上标出"按 tag 选子集"。

### 未做

- 「Explore 的 Plan 详情里直接编辑 suites」没做：那需要浏览器端的 Plan 草稿编辑能力（当前只有
  Confirm 前的 RevisionDraft 流程），超出本轮范围。要改 suites 目前是让 Explorer 重新产出方案。

### 验证

- `vitest run packages/domain` **303 通过**；`vitest run apps/api` **95 通过**；
  `apps/web` 下 `vitest run` **433 通过**；三个 typecheck（domain / api / vue-tsc）无错误。
- **浏览器实测**（`apps/web/dist` + 验收库 / Project3 的真实数据）：Workbench 任务中心四档计数
  `全部 8 / 待执行 0 / 执行中 0 / 已完成 0 / 待处理 8`，点"已完成"后列表清空并显示新文案；
  Explorer 线程列表按 `2026-09-27 (2) / 2026-09-26 (1) / 2026-09-25 (1)` 分组；需求清单表头为
  需求名称 / 方案状态 / 方案契约 / 任务状态；375px 窄屏下分区按钮不溢出。
- 新增用例：`utils/taskBuckets.test.ts`（4）、`utils/explorerGroups.test.ts`（6）、
  线程按天分组的组件用例、任务中心四分区的组件用例（数量 + 点筛选）、
  `plan-v2.test.ts` 的 suites 解析（子集/顺序/未知 tag/命中为空/空数组/NONE 冲突）、
  `project.test.ts` 的 tag 校验、`repository-context-cache.test.ts` 的词表注入（且不含命令 ID）。
- `pnpm verify` 全绿（domain 303 / api 95 / web 434）。**本轮抓到并修正一处被 stale dist 掩盖的回归**：上一轮改了 `ExplorerService.create` 的标题规则，
  但 API 测试跑的是未重建的 domain `dist`，所以当时"47 通过"是假象；重建后才暴露。
  该改动已随本轮回退，API 用例恢复原断言。

## 2026-09-29 — 容量闸门接回活路径、今日活动、合并后回收 Worktree、探索线程按时间命名

### 为什么做

调度里有两类"死状态"和两处"只增不减"：

- `WAITING_PROJECT_CAPACITY` / `WAITING_GLOBAL_CAPACITY` 在联合类型里声明、在前端有文案与测试
  （`statusVisual.ts`），但 `PlanDispatchCoordinator.evaluateWait` **从来没有容量判定**，
  也没有任何代码抛 `concurrency limit reached`；`Scheduler.globalConcurrency()` 恒返回 `undefined`
  且被标 deprecated，`maxParallelRuns` 也标了 deprecated。选项 `globalConcurrency` 声明了却没人读。
- 合并后不回收 Worktree：`Scheduler.finish()` 只在取消/显式退出时被调用，而 `confirmMerged`
  只翻 Plan 状态——`storage.worktreeRoot` 因此只增不减。
- Workbench 只能回答"现在有什么"，回答不了"今天做了什么"（原始需求里那条"今日已完成任务清单"）。

### Changed

**容量闸门（行为变化，请留意）**

- `evaluateWait` 新增两段判定：全局活跃 Run ≥ `runtime.globalConcurrency` → `WAITING_GLOBAL_CAPACITY`；
  同 Project 活跃 Run ≥ 冻结快照的 `settings.concurrency.maxParallelRuns` → `WAITING_PROJECT_CAPACITY`。
- 判定顺序（即优先级）固定为：依赖 → 缺命令 → 全局容量 → 项目容量 → 冲突，写进了文件头维护提示。
- **只算占槽位的状态**（`EXECUTION_SLOT_RUN_STATUSES`）：`READY_FOR_VERIFY` / `MERGE_READY` 已经在等人，
  不算在容量内，否则"验证完等合并"的 Run 会堵住后面的 Plan。
- **同一 Plan 同一 Revision 的既有 Run 不与自己抢名额**：那条路径是重试/续跑，算进去会让重试永远排队。
- 缺省的语义是"不限制"：`globalConcurrency` 未传即不限，`revision.projectConfigSnapshot` 缺失
  （旧 Revision）时不做 Project 级判定——**不给缺省编一个数字**，否则升级会悄悄改变历史行为的可重跑性。
- 删掉 `Scheduler.globalConcurrency()` 与 `SchedulerOptions.globalConcurrency`（声明了却没人用），
  以及 `dispatchOne` 里匹配 `concurrency limit reached` 的死分支；`maxParallelRuns` 的
  `@deprecated` 注释改回真实语义。
- **行为变化**：原本"确认即并发跑"，现在会按配置排队。两个用例因此**翻转**——原来断言
  "不设上限"，现在断言"等待并让位"（`dispatch-coordinator.test.ts`）。

**今日活动（新增）**

- `projections/activity.ts` + `GET /api/v4/projects/:projectId/activity?date=`：四组事实 ——
  **今日执行完成**（当天首次进入 MERGE_READY）、**今日已合并**（当天进入 MERGED）、
  **今日失败或阻塞**、**跨日仍在运行**。只读事件与 Run，**不新增表**。
- 执行完成与人工合并是两个时点，界面上分开显示——只统计"今日已合并"会把"跑了但没合"整个漏掉。
- 按**本地时区**切天；`2026-02-31` 这类会被 `Date` 静默滚动的输入被拒绝，而不是汇报一个别的一天。
- Workbench 顶部加「今日」条（四格 + 前 5 条可点进对应 Plan）；取不到时降级为一行提示，不阻塞整页。

**合并后回收 Worktree（新增）**

- `Scheduler.releaseWorkspace(runId, hooks)`：删 Worktree（**分支保留**）+ 跑一次 cleanup hook，
  **不改任何状态**；失败只写 `attentionReason` 与 journal。
- `confirmMerged` 成功后由 Merge 路由调用它，回收结果随响应返回。
- 幂等：成功后清空 `run.workspacePath`；目录本就不存在时算作已回收（`finish()` 可能先删过），
  不会把"已经没了"报成失败。

**探索线程按时间命名（已回退，见 2026-10-01 条目）**

- `explorerTimestampTitle()` + `ExplorerService.create` 的默认标题改为**创建时刻**
  （本地 `YYYY-MM-DD HH:mm`），并按 `MANUAL` 落库——时间就是它的名字，不再被自动起标题覆盖。
  显式传入的标题仍然优先。
- **同日回退**：既有机制本来就是「项目简称-日期-时间」，首条消息后升级成「时间-内容摘要」；
  这次改动把内容摘要那一半关掉了，属于把已满足的需求改坏。现已还原为原样，只在
  `ExplorerService.create` 里保留不变。ThreadRail 的按天分组（下一轮）与它无关，保留。

### 未做（明确记账）

- 3.4 的界面部分（ThreadRail 按"今天 / 昨天 / 更早"分组）与 3.5 术语统一、3.6 任务中心四分区：
  均为纯界面改动，本轮未做。
- 2.4 冲突键派生策略、2.5 `verification.suites` 按 tag 选验证子集：见上一条 CHANGELOG 的记账。

### 验证

- 定向用例全绿：`dispatch-coordinator.test.ts`（15，含 3 条新容量用例）、`m3-run.test.ts`（13，
  含 `releaseWorkspace` 的回收/幂等/分支保留）、`projections/activity.test.ts`（4）、
  `explorer-service.test.ts`（6，含时间命名）、`apps/api/src/server.test.ts`（47）。
- 当时 `pnpm verify` 被权限分类器拦截，改为逐项跑（三个 typecheck + 三个测试包）；**后经用户授权
  重跑聚合命令，同一份代码全绿**：domain 303 / api 95 / web 434，无新增值级环。

## 2026-09-29 — Plan 契约去掉"会说谎的字段"，依赖闸门变成可达

### 为什么做

`GeneratedPlanSpecV2` 是「模型能声明什么」的契约，但其中几个字段**填了也没有消费方**：

- `execution.executorModelRole` / `toolPolicy`：执行侧读的是 Project 快照里的 executor 配置
  （`ExecutorAgent.executorModelConfig`），从不读它们；界面却把它们当 "Execution policy" 展示。
- `tasks[].status`：从来没有任何代码推进过它，Workbench 却按实时状态显示恒定的 `READY`。
- `dependsOnPlanIds`（V1 契约字段）：V2 的投影**恒填 `[]`**，于是 `dispatch-coordinator` 里那两道
  真实的闸门（`WAITING_DEPENDENCY` 要求前置 Plan 已 MERGED、`WAITING_CONFLICT` 取冲突键交集）
  **有一半从 Explorer 侧不可达**——模型不知道 plan id，V2 契约里也没有对应字段。

### Changed

- `GeneratedPlanSpecV2.execution` 只保留 `maxRepairAttempts`；执行角色与工具策略由
  `resolvePlanContractV2` 以常量 `EXECUTOR_ROLE` / `EXECUTOR_TOOL_POLICY` 固定填进
  `ResolvedPlanContractV2`（下游 `PlanContract` 投影与审计视图不受影响）。
  校验器对这两个键**接受但忽略**（不报 FORBIDDEN）：库里已有的 CandidatePlan 带着它们，
  报错会让旧数据连 confirm 都过不去。prompt、`EXPLORER_PLAN_REQUIREMENTS.optionalFields`
  与 web 侧 fallback 副本三处同步更新。
- `PlanTaskShape` 新增并注明 `status` 是**计划态**；prompt 不再示范、Workbench 的
  "Execution tasks" 改为 "Approved plan steps" 并说明每步实际进度在 Run 日志里
  （`Open Run` 查看），不再把一个恒为 READY 的字段显示成实时状态。
- **跨 plan 依赖改为 Factory-owned 且可达**：新增 `PlanService.setDependencies()` 与
  `PUT /api/v4/plans/:planId/dependencies`，只允许在 Confirm 前设置，合法性复用 Confirm 的
  那套规则（未知 id / 自环 / 环）。界面在 Plan 详情抽屉里加 "Prerequisite plans" 选择器
  （候选来自本项目其他 Plan），候选态且非历史版本时才可编辑。
- **删掉 `confirm()` 里那段"净化"启发式**：它把「恰好出现在自然语言先决条件里的 id」从
  `dependsOnPlanIds` 中剔除——那既会删掉用户显式设置的依赖，也让依赖语义取决于文本巧合。
  现在只校验不动数据：引用未知 Plan 会在 confirm 时明确失败。**这是一处行为变化**：
  若历史数据里 `dependsOnPlanIds` 被自然语言污染过，confirm 会报 `unknown plan`，
  在 Plan 详情的依赖编辑器里清掉即可。
- 新增 `utils/planContract.ts`（web）：界面读 Plan 契约的唯一入口，固定
  `resolvedContract → generatedSpec → contract` 的取值顺序。Workbench inspector 改用
  `planContractView()`，不再优先读那份**有损投影** `contract`（它的 `dependsOnPlanIds` 恒为 []）。

### 未做（明确记账，不是遗漏）

- `verification.suites`（按 tag 选验证子集）：需要 Project 命令加 `tags`、spec 加字段、
  并把可用 suites 注入 Explorer 回合（现有 prompt 是静态常量，得走仓库上下文那条通道）。
  半成品比没有更糟——留待下一轮。
- `conflicts`（冲突键）由 includePaths 派生的策略：模型声明的语义键已经可用且可审计，
  派生规则会改变串行度（保守方向），值得单独设计 + 可配置，不与本轮混在一起。

### 验证

- `pnpm verify` 全绿（domain 294 / api 90 / web 422）。
- 新增 domain 用例：自然语言先决条件仍进 `design.technicalConstraints` 且**不再被静默删除**；
  `setDependencies` 的正常路径、Confirm 后拒绝修改、未知 id 与自环被拒绝。
- 新增 HTTP 用例：`PUT /plans/:planId/dependencies` 保存成功、未知依赖映射 409、未知 Plan 映射 404。

## 2026-09-29 — 多后端：探索与执行各用一个 agent（按角色路由）

### 为什么做

「探索用强模型、执行用便宜模型」这件事此前**只能表达一半**：`model.backend` 是进程级单选，
一个 `ModelGateway` 实例被 Explorer、Scheduler/Executor、ProjectExecutionThread 和分支名生成器
共用（`server.ts` 一处构造、四处消费）。想「探索走 Codex、执行走 Claude（DeepSeek 兼容端点）」，
在旧结构里没有第二种写法。Project 级的 `settings.models.<role>` 也只能改模型名与推理强度，
改不了 agent。

### Changed

配置层（`apps/api/src/config.ts`）：

- `model.roles.<role>.backend` 新增：**这是"探索用 Codex、执行用 Claude"的唯一开关**，取值是
  后端 id（字符串，不是 enum）。缺省跟随 `model.backend`。
- `model.backends` 新增具名后端注册表；`backendEntrySchema` 与 `codexAppServer` / `claudeAgent` /
  `openai` 共用同一份字段定义，避免"注册表里少一个字段"这类分叉。**整块缺省是合法且常见的用法**：
  四个 kind 名本身就能当 id 用，端点由那三块兼容配置提供。注册表只在需要「同类两个不同端点」时才用。
- `resolveModelBackends()` / `roleBackendId()` 新增：把配置解析成"id → 后端定义"，并校验
  **每个角色引用的 id 都能解析**，不可解析则启动期抛错并列出可用 id。
- **迁移改成按角色各自判定**（`migrateForeignFamilyModels` 的 `familyForRole`）：旧实现用单一家族
  判定，在 explorer=codex + executor=claude 下会把其中一个角色**正确**的 slug 改坏。另外，
  **Project 显式写了 `backend` 的角色一律不迁移**——那是用户有意的选择，该由 Provider 侧报错暴露。
- server 的 `bootstrapLegacy` **不再把 `backend` 抄进种子 Project**：抄进去等于让该项目从此脱离
  "跟随全局"，连家族迁移都会跳过它。

领域层（`packages/domain`）：

- `ModelRoleConfig.backend` 新增。**这是让"项目级覆盖 agent"零管道生效的支点**：explorer 侧已经
  `modelConfigForProject` 整块传入项目设置、executor 侧已经 `{...configFor("executor"), ...snapshot.settings.models.executor}`
  合并，所以覆盖不需要新的传递路径。
- `ModelGateway.capabilities(role, config?)` 与 `describeEndpoint(role?)` 加可选参数。**不修的后果很具体**：
  全局 executor=codex（支持两种 Loop 模式）、某 Project 覆盖为 claude（只支持 provider-controlled）时，
  按角色默认判定会放过 factory-controlled 配置，失败被推迟到第一次模型调用。
- `ProjectSettings.models.<role>.backend` 与 `ModelBackendCatalog` 新增；有目录时校验后端 id 与
  该后端的推理强度。**`backend: null` 表示"清除覆盖、跟随全局"**——不区分它的话，控制台第一次保存
  就会把当前全局后端固化进 Project。
- `ExecutionTelemetry.backend` 新增（可选，旧行为 null）：这次 Run 由哪个 agent 执行，取自
  `agent.loop.started` 的端点指纹。与 `model` 是两件事——同一个模型名可能来自不同后端。
- `ProjectExecutionThreadSnapshot.backend` 新增（只读展示）与其模型/推理强度目录改为**按该项目 executor
  后端**提供（`modelCatalogForProject`）；`updatePreferences` 的校验与给出的选项**同源**，
  消掉"下拉里有、选了却被拒"的死路。

组合根（`apps/api`）：

- `RoutingModelGateway` 新增：按"请求覆盖 → 角色默认 → 全局默认"解析后端并委派。
  `answerUserInput` 按 Provider 发出的 requestId 反查归属，**查不到就抛错**（静默丢弃会让模型一直等输入）；
  `cancel` 查不到归属则**广播**给已实例化的后端（漏掉一次取消会留下还在跑的 Provider turn）。
  `describeEndpoint()` 不传角色且两角色指不同后端时返回 `backend: "mixed"`——**如实回答，不假装成某一个**。
- **角色默认后端在启动期构造**（`warmUp`），注册表里没被引用的后端保持懒构造。这条是启动验证时
  现场发现的回归：懒构造单独用会把"缺 `codexAppServer` 块"从启动期失败推迟成第一次 `/health` 500。
- `apps/api/src/runtime/model-catalog.ts` 新增：`GET /api/v4/model-backends` 的投影与
  `ModelBackendCatalog` 的数据源。模型清单只驱动控制台下拉（Factory 不知道 provider 支持什么），
  推理强度**由后端决定、不是建议**（Claude 侧只透传 5 个取值）。`/health` 增加 `modelBackends`，`modelBackend`
  保留为 explorer 生效后端的兼容键。

控制台（`apps/web`）：

- Project 设置页与设置弹窗各加一个 **Agent 选择器**（`Explorer agent` / `Executor agent`），
  模型与推理强度的候选项跟着所选后端变；空值显示为"跟随全局（<生效后端>）"，保存为 `backend: null`。
- `utils/modelOptions.ts`（一份写死的 Codex 模型清单）删除，换成 `utils/modelCatalog.ts`
  + `composables/useModelBackends.ts`（模块级缓存一次目录）。未知的已配置模型**永远保持可选**。
- 用量栏新增 **AGENT** 一格（`ProviderUsageFooter` 的可选 `backend` prop）：Explorer 侧取
  Project 覆盖后的探索后端，Run 侧取遥测里的 `backend`。"这一轮到底是谁跑的"在页面上第一次有了答案。

### 验证

- `pnpm verify` 全绿（domain 293 / api 85 / web 421，无新增失败，无新增值级环）。
- 新增 `RoutingModelGateway` 单测 12 条（分派、请求覆盖、输入/取消归属、mixed 指纹、懒构造与释放、
  启动期失败与"未被引用的后端不拖垮启动"）。
- 新增 `apps/api/src/server.test.ts` 的 HTTP 集成用例：双后端配置下 `/health` 返回
  `modelBackends: { explorer: codex-app-server, executor: deepseek }`、`/api/v4/model-backends`
  给出注册表后端的模型与推理强度。
- 真机启动验证：用 `/tmp/pf-routing/config.json`（explorer=codex、executor=deepseek）启动，
  `/api/v4/model-backends` 输出符合预期；把 `codexAppServer` 块去掉后**启动即失败**（与改动前一致）。
- **未做真机模型调用**：本机 Codex 刷新令牌已过期、DeepSeek 端点也没有可用凭据，因此
  "一次探索回合真的打到 Codex、一次 Run 真的打到 DeepSeek"这条链路没有实测，只有分派逻辑的单测。

## 2026-09-29 — 移除 5 小时 / 7 天额度（页面与后端服务两侧一起）

### 为什么删

那两格的唯一数据源是 Codex App Server 的**账号级**额度接口（`account/rateLimits/read` 与
`account/rateLimits/updated` 两条 JSON-RPC）。它与用量栏要回答的问题不是一类事实：一个是
**账号级、跨会话**，一个是**本次调用**用了哪个模型、上下文占了多少。

更要紧的是另一侧：Claude Agent SDK **根本没有**这个接口（SDK 只在会话内提示限流）。原实现
让不具备该接口的后端返回 `available: false` + reason ——"宁可显式报取不到也不编一个数字"
这个立场是对的，但代价是每个后端都要为一个与自己无关的窗口维护一份"不可用"。
`ModelGateway` 描述的是"一次模型调用"，账号额度不属于它。

于是按"数据源在哪、消费者有几个"处理：这条链路的消费者只有页面用量栏一个，两侧一起删，
而不是留一条**恒为"不可用"**的路由。

### Changed

后端服务侧：

- 删 `GET /api/v4/codex/rate-limits`（[platform.ts](code/apps/api/src/routes/platform.ts)）。
  模块头的路由计数从 5 条改为 4 条，那条"它怎么吞异常退化成 `available:false`"的维护提示
  换成"这里为什么不再有额度路由、加回来之前先回答什么"——旧注释留着会让下一个人照着加回去。
- `ModelGateway` 删 `readRateLimits()`，以及只为它存在的 `ProviderUsageSnapshot` /
  `ProviderUsageWindow`（[types.ts](code/packages/domain/src/model/types.ts)）。
  **`ProviderEndpoint` 保留**：端点指纹是另一件事，`agent.loop.started` 的 `provider` 字段在用。
- 各实现同步删：[stub-gateway.ts](code/packages/domain/src/model/stub-gateway.ts)、
  [claude-agent-sdk.ts](code/packages/domain/src/model/claude-agent-sdk.ts)，
  以及 Codex 侧的**整条**链路——客户端的 `readRateLimits` / `onRateLimitsUpdated` /
  `rateLimitListeners` / `account/rateLimits/updated` 通知分支，网关的 `rateLimitUnsubscribers` /
  `cachedRateLimits` / `readRateLimits`，以及会话端口上的两个可选方法。
- 删 [model/codex-rate-limits.ts](code/packages/domain/src/model/codex-rate-limits.ts)（Codex
  响应形状与 `mapCodexRateLimits`）及其单测，`index.ts` 上的三个类型导出一并去掉。

页面侧：

- [ProviderUsageFooter.vue](code/apps/web/src/components/ProviderUsageFooter.vue) 只留
  MODEL / CONTEXT 两格：删掉账号额度那一块、它的取数（`api.codexRateLimits()`）与
  加载/错误态。**`props` 形状没变**，ExplorerView 与 RunDetailView 的调用点一行没改。
- [api.ts](code/apps/web/src/api.ts) 删 `codexRateLimits()`、[types.ts](code/apps/web/src/types.ts)
  删 `CodexRateLimitValue` / `CodexRateLimitsStatus`、
  [explorerStatus.ts](code/apps/web/src/utils/explorerStatus.ts) 删 `formatRateLimit`
  （`formatContextUsage` 保留——上下文占用是 provider 无关的指标）、
  [styles.css](code/apps/web/src/styles.css) 删 `.provider-usage-limits` / `.provider-usage-limit`
  两条已成无主的规则（含 720px 断点里那三条）。

### 留下的不是删除动作，而是理由

- 五处维护提示写的是"**再要加回来，先回答什么**"，不是"这里曾经有什么"：
  `ProviderUsageFooter.vue`、`explorerStatus.ts`、`model/types.ts`、`model/stub-gateway.ts`、
  `platform.ts`。README 的用量栏说明同步改写，`待办事项.md` 里那条已勾选的额度修复下补一行
  "该链路已整体删除"（那条记录本身不动——它是当时的决策）。
- "宁可显式报取不到也不编一个数字"这条立场**没有随代码消失**：它写进了
  `model/types.ts` 的维护提示 8 与 README，成为下次有人要加任何用量面时的判据。

### 防回归断言（两条原先的**正向**断言翻成了负向）

- `ProviderUsageFooter.test.ts` 新增一条"不渲染任何账号级额度"：`.provider-usage-limits` 为
  `null`、`.provider-usage-limit` 长度为 0、正文不含"限额"与"剩余"。
- `ExplorerView.test.ts` 原有的两条 `toContain("5 小时限额")` / `toContain("7 天限额")` 翻成
  `not.toContain`。**翻的时候踩了一次**：直接断言"源码不含『限额』"会撞上组件里那段"为什么删"
  的注释（注释里正写着"5 小时限额 / 7 天限额"），于是先剥掉注释再断言，并把"剥的是注释、
  不是放宽断言"写进注释本身。

### Changed files

- 后端：`code/apps/api/src/routes/platform.ts`、`code/apps/api/src/server.test.ts`。
- 域：`code/packages/domain/src/model/types.ts`、`model/stub-gateway.ts`、
  `model/claude-agent-sdk.ts`、`model/codex-app-server.ts`、`model/codex-app-server.test.ts`、
  `codex-app-server-client.test.ts`、`index.ts`；
  **删除** `model/codex-rate-limits.ts`、`model/codex-rate-limits.test.ts`。
- 页面：`code/apps/web/src/components/ProviderUsageFooter.vue`、`ProviderUsageFooter.test.ts`、
  `api.ts`、`types.ts`、`utils/explorerStatus.ts`、`utils/explorerStatus.test.ts`、
  `views/ExplorerView.test.ts`、`styles.css`。
- 文档：`code/README.md`、`待办事项.md`。

### Verification

- `pnpm --dir code verify` 通过：domain 289/289、API 73/73、Web 421/421，无新增值级循环依赖。
- **路由真的没了**（重建 `apps/api/dist` 后，在隔离实例上验证）：`curl /api/v4/codex/rate-limits`
  → **404** `{"code":"NOT_FOUND"}`；同文件的另外三条平台路由 `/health`、`/api/v4/mcp/tools`、
  `/api/v4/plugins/tools`、`/api/v4/explorer-plan-requirements` 仍全部 200 —— 删的是那一条，
  不是把 `platform.ts` 删塌了。
- **浏览器实测**（隔离实例，指向快照库，不碰正在跑的服务）：重建 `apps/web/dist` 后打开 Explorer
  需求页，用量栏渲染为 `MODEL gpt-5.6-luna` + `CONTEXT ~0 tokens` 两格；
  `.provider-usage-limits` / `.provider-usage-limit` 命中 0 个；页面正文不含"限额"；
  **控制台无任何报错**；`performance.getEntriesByType("resource")` 里匹配 `rate|limit` 的请求
  **0 条**——面板没了，取数也真的没了，不是渲染时被藏起来。
  （截图见过一次 `gpt-5.6-luna`：那是隔离实例的配置，模型名随 E4 收敛，与本次无关。）
- 全仓 grep `ratelimit|限额|fiveHour|sevenDay|额度`：除 CHANGELOG、`docs/` 下的历史设计文档与
  `pnpm-lock.yaml` 里的 `express-rate-limit`（无关依赖）外，剩余命中**全部是上面那批"说明它
  已删除"的注释与文档**。`待办事项.md` 与历史设计文档按惯例只做记账，不改写。
- **未重启线上服务**：`pnpm start` 跑的那个进程仍持有旧 `dist`，`/api/v4/codex/rate-limits` 在
  它上面还会 200 到下次重启为止。本次只重建了 `dist`，重启留到后端收敛那一轮一起做（那轮还要
  把 `backend` 换成 `claude-agent-sdk`，重启一次就够）。

## 2026-09-28 — 开启事件回收：14 天 / 每聚合保底 200 条

### Changed

- 本地 [pipeline-factory.config.json](code/config/pipeline-factory.config.json) 的 `storage` 段加上 `eventRetentionDays: 14` 与 `eventRetentionMinPerAggregate: 200`。保底条数本来就有同样的默认值，这里**显式写出来**：它决定"每个聚合至少留多少条"，是这套策略的一半，读 config 的人应该在一个文件里看全，而不必去翻 `config.ts` 才知道会删到什么程度。

### 开启前的实测（真实库，只读，未动一行数据）

| | |
| --- | --- |
| 全库事件 | 159,543 行 / 22.8 MB 载荷 |
| 事件时间范围 | 2026-09-12 → 2026-09-28（16 天） |
| **14 天 + 保底 200 会删** | **30,238 行 / 3.9 MB（19.0%）** |

- 删的全是那两个**逐字重复**的逐 token 增量类型：`agent.step.model_text_delta` 15,119 行 + `agent.model.text.delta` 15,119 行。两者各有 15,625 行早于 cutoff，其中 506 行被"每聚合保底 200 条"留下。
- `explorer.turn.text.delta`（32,984 行）与 `project.execution.turn.text.delta`（299 行）**一行都不删**：它们最早分别是 09-17 与 09-26，全在 14 天以内。这不是白名单没生效，是这个库只比 14 天大两天。
- `run.executor.event` 有 10,961 行早于 cutoff，**一行都不删**——按下面「A2 白名单收紧」已移出白名单。
- 30,238 行逐行核实过"最终态另有副本"（方法与其结果见下面「A2 白名单收紧」一节）。

### Verification

- 配置能过 API 的加载器：`loadFactoryConfig()` 解析出 `eventRetentionDays: 14` / `eventRetentionMinPerAggregate: 200`。（`apps/api/dist` 在此之前是**旧的**——回收那几项是 A2 才加进 schema 的，旧 dist 会把它们静默丢掉。这一点是靠这次真的去解析配置、而不是只看文件内容才发现的。）
- `pnpm --dir code verify` 通过：domain 276/276、API 72/72、Web 424/424。

### 首次开启的实测结果（重启前后各取一次全量快照比对）

| | 重启前 | 重启后 |
| --- | --- | --- |
| `domain_events` 行数 | 159,556 | 129,320 |
| 载荷 | 22.81 MB | 18.93 MB |
| `MAX(sequence)` | 220,322 | 220,324 |
| 序号高水位表 | 不存在（旧 dist 建的库） | `last_sequence = 220322` |

**实际删除 30,238 行 / 3.88 MB，与开启前算出的预测逐行一致**，且只动了两个类型：

- `agent.model.text.delta` −15,119 行（−2.65 MB）
- `agent.step.model_text_delta` −15,119 行（−1.23 MB）

其余类型一行未动——包括 `run.executor.event`（它另有 10,961 行早于 cutoff，按上一节移出白名单后不删）。

顺带核实到的两件事：

- 重启后仍存在的最大序号行（220322）就是回收前的 `MAX(sequence)`——**这次没有考到序号回退那条守卫**。回收只摘旧行，被摘的行本来就在序号低位，所以存活行的 MAX 没变，有没有高水位都会得到 220,323。高水位表写对了值，但"它救了谁"要等回收真的摘掉序号最大的那批行才能验到（例如某个聚合整体变旧后）。这一点记在这里，别把它当成"守卫已验证"。
- 重启打断了一个在途的 Explorer 回合（`thread-demo` / `turn-ff9f792d-852`，15:30:55 发起）。没有丢数据：回合被标为 `FAILED` 且 `error = EXPLORER_TURN_RECOVERY_REQUIRED`，`agent_loop_steps` 里留下 `LOOP_RESUMED / MODEL_STARTED / PROVIDER_ACTIVITY×2 / LOOP_FAILED` 共 5 步——这正是启动期"未结束的回合标记为待恢复"那条路径该有的样子。**重启前的在途检查只看了 runs / dispatch states，漏了 Explorer 回合**：那个回合是重启前 40 秒才发起的，检查时还不存在。要重启一个正在被使用的实例，这一条得算进去。

## 2026-09-28 — A2 白名单收紧：run.executor.event 移出

### 结论：那一条的依据在真实数据上不成立

A2 把 `run.executor.event` 中 `payload.type === 'MODEL_OUTPUT'` 的部分列进了可回收白名单，依据是
"它是 `execution_journal` 那一行的镜像"。白名单的**判据只有一条**——*最终态另有持久化副本*——
所以在真的按下开关之前，把这个类型**待删的每一行**拿去和 `execution_journal` 逐行关联（不是抽样）。
结果是一条都关联不上，原因是两处：

1. **历史行的载荷里根本没有 `sequence` 字段**（当前代码才写它）。载荷长这样：
   `{"executionThreadId":"execution-thread-b56cb883-72e","type":"MODEL_OUTPUT","text":"I"}`。
   没有 `sequence` 就无法定位 journal 里的对应行，副本"可能存在"但**无法证明存在**。
2. 更要紧的是：这些行绝大多数属于**已经被删除的 run**。run 删掉时 journal 与 execution_thread 一起
   没了，**这些事件是那段模型输出的唯一记录**。实测单个已删除的 `run-1491d6e7-70e` 就有 9,408 条，
   它的 journal 行数、runs 行数、execution_threads 行数全是 0。

它们是垃圾——这一点没错。但白名单的判据是"**另有**副本"，不是"看起来没用"。收据不成立就不能删，
于是把这个类型整个移出白名单（`isPrunableEvent` 退回成一句纯白名单查询，SQLite 侧那条 `prunable`
也去掉了 `json_extract`）。

另一条被引用的依据也一并纠正：A2 原文引 `run/dispatch-coordinator.ts` 的 `isStreamingEvent`
"只影响展示进度，不需要逐条 reconcile"。那是说**不需要逐条对账**，与"数据有副本"是两件事，
不能拿来当回收依据。

### Changed

- [event-retention.ts](code/packages/domain/src/store/event-retention.ts)：`PRUNABLE_EVENT_TYPES` 现在是全部规则，`isPrunableEvent` 只剩一句 `includes`。模块头记下了这次的证据，并新增一条维护提示：**往白名单里加类型之前，在真实库上按聚合逐行验证副本确实存在，而不是只读代码**——上面第 2 条就是这个动作抓出来的，光读代码看不出来。
- [sqlite-store.ts](code/packages/domain/src/store/sqlite-store.ts)：`pruneEvents` 的 `prunable` / `scope` 简化，注释同步。
- [store-contract.test.ts](code/packages/domain/src/store-contract.test.ts)：那条 `prunes only MODEL_OUTPUT among run.executor.event payloads` **反向重写**为 `never prunes run.executor.event, not even its MODEL_OUTPUT payloads`。断言是翻过来的，不是被删掉的——它现在是"判据是副本、不是观感"这条规则在两个实现上的守卫。

### Changed files

- Domain：`code/packages/domain/src/store/event-retention.ts`、`store/sqlite-store.ts`、`store-contract.test.ts`。

### Verification

- `pnpm --dir code verify` 通过：domain 276/276、API 72/72、Web 424/424，无新增值级循环依赖。
- 收紧后重跑逐行核实（本次 14 天配置下**实际会删的两个类型**）：`agent.step.model_text_delta` 15,119 行待删、0 行找不到副本（按 `(loop_id, sequence)` 与 `agent_loop_steps` 关联）；`agent.model.text.delta` 15,119 行待删、0 行找不到副本（它的载荷带的是 `providerTurnId` 而非 `sequence`，按"同 loop 同文本"关联，且与上一个类型条数逐字相等、A1a 已停止写入）。`run.executor.event` 现在是 0 行待删。

## 2026-09-28 — D3 结论：只做 D3-1，另两簇记账不做

D3 原计划把 ExplorerView.vue 的 script 块按三簇拆成 `usePlanDetailDrawer` / `useProjectDialogs` /
`useExplorerComposer`。**D3-1 做了，另两簇经核实不该按原样做**——计划里那三簇是照符号名前缀猜的，
不是照实际内聚度划的，和后端 B1 是同一种偏差。

### D3-2 `useProjectDialogs`：前提不成立，且真实规模不值得抽

计划把 `renameDialogOpen` / `renameSaving` / `renameError` 归进"项目与对话框编排"，但它们
**属于线程重命名**：唯一写它们的是 `openRenameDialog` / `renameThread`，而 `renameThread` 与
`isCurrentProjectScope`、`thread`、导航耦合在一起，是一个独立功能，不是项目对话框的一部分。
去掉这三者之后，"项目对话框"只剩 `projectCreateOpen` / `projectSettingsOpen` /
`projectSettingsProjectId` 三个 ref 与两个开关函数，**约 20 行**——为它新增一个文件、一个测试与
一条 `readFileSync` 常量，收益抵不上成本。记在这里，不硬拆。

### D3-3 `useExplorerComposer`：安全网不足，不做

这一簇（`draft` / `requirementDrafts` / `pendingSendPlanIds` / `failedExplorerSends`）确实内聚，
但它的主体是 `sendTurn`——**全应用最热的路径**（回合的抢先显示、SSE 重试、失败重发、按需求暂存草稿）。
抽它等于把这条路径整体搬家，而当前**没有任何行为测试兜底**：

- `ExplorerView.vue` 只有一个测试文件，且 `mount(` 出现 **0 次**——它全部是读源码文本做断言
  （`expect(explorerViewSource).toContain(...)`）。搬家之后这些断言照旧全绿，**什么也没验证**。
- 本仓没有组件级测试设施的先例，也没有可用的浏览器验收（见下面 A1b/D3 的说明）。

在这种条件下搬最热的代码，风险与收益完全不成比例。它要实现的话应当**先补行为测试**（把
ExplorerView 的发送路径挂到组件测试上），再动结构——那是另一件事，不在本次范围。

### 一份需要单独安排的债

`ExplorerView.test.ts` 的源码文本断言是 P7 抽取时建立的模式，它抓得住"某段代码跑到别的文件去了"
（本次 D3-1 就是靠它发现的），但抓不住任何行为。P7 抽出的 7 个 composable 各自都有独立的行为
测试文件；`ExplorerView.vue` 自身则一次都没有被 mount 过。这条债值得单独排期，不该塞进 D3——
本次新增的 `usePlanDetailDrawer` 同样还没有测试文件，理由与 D3-3 相同：给它写"源码文本断言"
只会复制这个模式，写真正的行为测试才是该做的事，而那是独立的一件事。

## 2026-09-28 — D3-1 抽出 usePlanDetailDrawer（共享抽屉的 Plan 详情）

### Changed

- 共享右侧抽屉的 Plan 详情状态从 [ExplorerView.vue](code/apps/web/src/views/ExplorerView.vue) 抽到新的 composable [usePlanDetailDrawer.ts](code/apps/web/src/composables/usePlanDetailDrawer.ts)：抽屉开关与页签、当前展示的 Plan 版本、可切换的版本列表，以及 `openPlanDetail` / `selectPlanRevision` 两个加载流程。视图的 script 块少 110 行，且"抽屉里到底显示什么"现在能在一个文件里读完（此前 ref 声明与函数分处两段，中间隔着近 400 行别的逻辑）。
- 抽出的顺序有约束：它必须建在 `usePlanLifecycleActions` **之前**——后者要拿这里的 `drawerOpen` / `drawerTab` / `detailPlan` 去在确认、入队之后刷新并切页签。这条写进了调用点的注释。
- 路由跳转（把 `requirementTab=plan` 写进 query）**没有下沉**：composable 只通过 `onOpened` 回调通知"打开了"，路由形状仍由视图决定。与 `usePlanLifecycleActions` 处理 `openRunView` 的方式一致。
- `SharedDrawerTab` 类型随 `drawerTab` 这个 ref 一起搬进 composable 并导出，视图改为 import——避免两处各写一份联合类型。

### Fixed

- **顺手消掉一处重复**：`resetThreadState` 里把同一组抽屉重置（`drawerOpen` / `detailPlan` / `detailRevisions` / `detailConfirmedRevisions` / `detailLatestRevision` / `detailVersionSource`）**写了两遍**，第二遍还漏了 `detailLoadError`。现在只有 `resetDetailState()` 一处。这不是行数问题：两处要保持同步的写法，下一处新增抽屉状态时必然漏一边。

### Changed files

- Web：`code/apps/web/src/composables/usePlanDetailDrawer.ts`（新增）、`code/apps/web/src/views/ExplorerView.vue`、`code/apps/web/src/views/ExplorerView.test.ts`。

### Verification

- `pnpm --dir code verify` 通过：domain 276/276、API 72/72、Web 424/424，无新增值级循环依赖。typecheck 与 build 均通过。
- 逻辑逐字搬移，除 `planFromRevisionDraft` 改为 `deps.planFromRevisionDraft` 外无改动。
- `ExplorerView.test.ts` 里两条用例失败过，原因值得记下来：本仓 P7 抽取时建立的模式是**读源码文本做断言**（每个 composable 都有一个 `readFileSync` 常量）。断言不是被放宽，而是**跟着搬到新文件并保持同一批性质**——包括"先把已知 Plan 落进抽屉再等接口"的顺序断言。切线程那条改为**两半都断言**（视图的 `resetThreadState` 委托 + composable 的 `resetDetailState` 执行），只测一半会让另一半能悄悄漏掉。
- **未做浏览器验收**：抽屉是可见行为，虽然逻辑逐字未改，仍应在下一轮浏览器验收中确认详情打开、版本切换与线程切换三条路径。

## 2026-09-28 — 事件回收（A2）：机制、白名单与序号高水位

### Added

- `PipelineStore.pruneEvents({ cutoff, minPerAggregate })`：回收高频事件，返回删除条数。规则与白名单的**唯一**定义在新增的叶子模块 `store/event-retention.ts`，两个实现都按它来——SQLite 那条带窗口函数的 DELETE 是它的规格翻译。`cutoff` 由调用方算好传进来（而不是让存储层取 `now()`），这样"删哪些"完全由入参决定，两种实现才对得齐，测试也不必去伪造历史时间戳（`appendEvent` 的 `occurredAt` 由存储层生成，调用方给不了过去的时间）。
- 配置项 `storage.eventRetentionDays` 与 `storage.eventRetentionMinPerAggregate`，并接进 `createApp` 的 store 构造。
- **可回收白名单**（判定标准只有一条：*这一条事件是不是某段事实的中间态，而那段事实的最终态另有持久化副本*）：`explorer.turn.text.delta`（最终正文在 `explorer_turns.content`）、`agent.step.model_text_delta`（`agent_loop_steps` 那行的事件镜像）、`agent.model.text.delta`（与上一条逐字重复，A1a 已停止写入）、`project.execution.turn.text.delta`（最终正文在 `project_execution_messages.content`）。**任何参与业务判定的事件都不能进白名单**——`plan.*`、`run.paused`、`verification.completed` 删掉不是"少了几条历史"，是状态机少了输入。
- 本条原文把 `run.executor.event` 中 `payload.type === 'MODEL_OUTPUT'` 的那部分也列进了白名单，依据是"它是 `execution_journal` 的镜像"。**那条依据是错的，已在开启回收前移除**，见上面「A2 白名单收紧」一节。
- `store/event-retention.ts` 里另有 `prunableEventIds`（内存实现的判定）与 `isPrunableEvent`，两者与 SQLite 的 SQL 是同一套规则的两种表达。

### Fixed

- **修复回收会引入的序号回退**（由本次新增的契约用例当场抓到）：SQLite 的 `appendEvent` 用 `SELECT MAX(sequence) + 1` 取号，回收删掉尾部若干行之后这个号会**退回去**，于是新事件复用了一个已经被客户端当作游标用过的号——已连接的客户端拿它去过滤（`sequence > cursor`）会把那批新事件整段静默跳过。新增单行表 `event_sequence_watermark` 记高水位，`pruneEvents` 在删行**之前**先写它（顺序不能反：崩在中间时"记了没删"只是下次重删一遍，而"删了没记"才会退号）。内存实现本来就不会退（它用独立的 `eventSequence` 计数器），这条修的是 SQLite。

### Changed

- 回收**默认关闭**（`eventRetentionDays: 0`），这是有意的：回收是不可逆地删除用户数据，不该在升级后第一次启动时悄悄开始。要看效果就把它设成正数，然后重启一次。启动期的回收放在**所有修复与回填之后**——那几步要读历史事件，先删再修会让它们看到一份被削过的历史。
- 启动期回收失败不会挡住启动：它只是清理，库本身仍然可用，下次启动再试。（domain 层没有日志通道，所以明确吞掉，并在源码里写明这是有意的。）
- 不做 `VACUUM`：它会重写整个数据库文件，对几十兆的库是秒级阻塞。回收后只做一次 `PRAGMA wal_checkpoint(TRUNCATE)`，真正的体积回收留给运维在停机窗口执行。

### Changed files

- Domain：`code/packages/domain/src/store/event-retention.ts`（新增）、`store/pipeline-store.ts`、`store/in-memory-store.ts`、`store/sqlite-store.ts`、`index.ts`、`store-contract.test.ts`、`store-startup-repair.test.ts`。
- API：`code/apps/api/src/config.ts`、`code/apps/api/src/server.ts`。
- 配置：`code/config/pipeline-factory.config.example.json`。

### Verification

- `pnpm --dir code verify` 通过：domain 276/276、API 72/72、Web 424/424，无新增值级循环依赖。
- 契约套件新增 5 条用例，在两个实现上各跑一遍：cutoff 在过去时一条不删；白名单外的类型永不删；保底条数**按聚合**生效（3 条保 2 条只删最旧一条，2 条的聚合一条不删）；`run.executor.event` 无论载荷是什么都不删（本条当时断言的是"只有 `MODEL_OUTPUT` 被删"，规则收紧后已改为反向断言）；回收后追加的事件序号仍大于历史。
- 最后一条**当场抓到上文的序号回退缺陷**——SQLite 实现当时还没写高水位，用例失败。这不是"补一条测试让它通过"，是守卫先红后绿。
- 启动期这套逻辑新增 1 条用例（`store-startup-repair.test.ts`）：不配置回收时一条不删、配置后只删白名单内那条、且删完追加的事件序号仍大于历史。用独立连接直接写库造"2020 年的事件"，因为 `appendEvent` 给不出过去的时间戳。
- `store-startup-repair.test.ts` 的 `corrupt()` 改名 `runRawSql()`：它在本文件里多数时候确实在制造损坏，但回收那组用例只是用它塞一条旧事件，用 `corrupt` 会让那句读起来像在"制造损坏"。

## 2026-09-28 — Explorer 活动取数去重，并把"产出依赖逐条增量"这个事实钉住（B1 的结论）

### 结论：B1 作为"等价优化"不成立，改为记账 + 加守卫

原计划是"正文改取 `explorer_turns.content`，只取每个 loop 最后一条增量步骤"，理由是
`content` 已经是增量的逐字拼接、投影真正还需要的是 `providerItemId`/`occurredAt`/排序序号。
**这个前提是错的。** `projectExplorerActivity` 的产出确实依赖逐条 `MODEL_TEXT_DELTA`，两处：

- **卡片数量**取决于增量步与非增量步的先后。相邻增量合并进同一条 `ASSISTANT_MESSAGE`，但中间只要夹了任何其它步骤（工具、门禁、Provider 活动）就会另起一条。一个回合有几张助手卡片，拿拼好的 `content` 分不出来。
- **合并后那张卡片的 `occurredAt` 与排序序号取的是第一条增量**（它参与最终按 `occurredAt` 的排序，换成最后一条会改变该卡片与其它活动的相对顺序），而挂在那张卡片上的 `providerItemId` 取的是最后一条非空增量。两个值 `content` 里都没有。

所以"只取最后一条增量"与"改读 `content`"都会改变可见产出，不是等价优化。真要收敛，得让**写侧**按"文本段"落一条事实（见 `agent/agent-loop.ts` 的 `flushTextDelta`），而不是在读侧猜。本次不硬做。

### Changed

- `routes/explorers.ts` 的两处活动取数（workspace 快照与 activity 时间线）原本是逐字重复的四行查表，抽成 `planActivityInput`。抽出来的主要目的是**给上面的结论一个落点**——两处各写一遍注释必然会漂移，而且这段代码正是下一个想"优化掉步骤读取"的人会盯上的地方，提示必须写在他看得见的位置。

### Added

- `explorer-activity.test.ts` 新增两条用例，把上面两个事实钉住：增量之间夹了非增量步骤会另起一张卡片（且用例把 `turn.content` 设成两段增量的完整拼接，正是为了说明"有 content 也分不出来"）；合并后卡片的时间取第一条增量、`providerItemId` 取最后一条非空增量。**这两条不是描述理想行为，而是守卫**——谁想按原计划那样优化，先让它们变绿。

### Changed files

- API：`code/apps/api/src/routes/explorers.ts`。
- Domain：`code/packages/domain/src/explorer/explorer-activity.test.ts`。

### Verification

- `pnpm --dir code verify` 通过：domain 270/270、API 72/72、Web 424/424，无新增值级循环依赖。
- 抽取是纯搬移：两处调用点的查表顺序、过滤条件、传参逐字未变，产出不变。
- 新用例未做反向验证：它们断言的是**当前**行为（而非新引入的行为），构造上不存在"守卫空转"——把 `explorer-activity.ts` 改成读 `content` 就会直接失败。
- **未做浏览器验收**：本次不含可见行为变化（抽取前后产出相同）。

## 2026-09-28 — SQLite 语句缓存（A3）

### Changed

- `SqlitePipelineStore` 的 127 处方法体内联 `this.database.prepare(sql)` 全部改为 `this.statement(sql)`：按 SQL 文本记忆化已编译语句。此前每执行一次就重新编译一次 SQL 文本，而本类绝大多数调用点是"同一条 SQL 反复执行"——`appendEvent` 在流式期间每秒被调几十次，`getProject` 在每次 `savePlan`/`saveRun` 的收尾都被调一次。
- **构造函数里的迁移区刻意不缓存**（仍是 `this.database.prepare(...)`，共 5 处）：那里每条语句只执行一次，缓存没有收益，却会让语句句柄跨越紧随其后的 `ALTER TABLE` 存活，平白引入"schema 已变但语句早已编译"的疑问。这条例外写进了模块头的维护提示 7，与"新增列必须补迁移分支"并列——两者都容易在改动时被忽略。
- 缓存设了条目上限（512），超出即整体清空重建。**这是有意为之的粗暴做法**：带 `IN (?, ?, …)` 的语句文本随参数个数变化（`sqlIn` 的返回值、`listEvents` 的 `aggregateIds`/`types`、`deleteExplorerCascade` 按被删 ID 个数生成的十几条 DELETE），参数个数有多少种就占多少条；`deleteExplorerCascade` 是唯一可能让它显著增长的调用方。清空只让下一轮调用重新编译一次，不影响正确性；不做 LRU 是因为触发场景本身罕见，为它维护访问序会让这个纯加速层比它加速的东西更复杂。
- `close()` 先清空语句表再关连接：`node:sqlite` 的 `StatementSync` 没有显式 finalize，持引用即在连接存活期内有效，主动释放比交给 GC 去和连接关闭赛跑更可控。

### Added

- 新增 `packages/domain/src/store-statement-cache.test.ts`：对 `DatabaseSync.prototype.prepare` 计数，把"编译次数"这条功能上不可见的性质变成可断言的。四个用例分别覆盖：同一 SQL 反复执行只编译一次、SQL 文本不同才各编译一次、命中缓存不改变结果（写入后读到的仍是最新值，即缓存的是语句不是结果）、带 `IN` 列表的语句按元数分桶。

### Changed files

- Domain：`code/packages/domain/src/store/sqlite-store.ts`、`code/packages/domain/src/store-statement-cache.test.ts`（新增）。

### Verification

- `pnpm --dir code verify` 通过：domain 268/268、API 72/72、Web 424/424，无新增值级循环依赖。
- 守卫经**反向验证**：把 `getProject` 改回 `this.database.prepare(...)`，前两个用例按预期失败（`expected 50 to be 1`、`expected 8 to be 7`），恢复后 4/4 通过。确认它抓的是编译次数而非别的性质。
- **没有断言缓存上限**：观测它要么把 `STATEMENT_CACHE_LIMIT` 导出成公开面，要么把清空时机编码进用例，两者都会让这个纯加速层更难改。上限作为防御性措施记录在本条与源码注释里，不作为契约。
- 未测性能数字：本仓没有基准设施，本次不新增；收益的定性依据是"消除重复编译"这一机制本身。
- 未做浏览器验收：纯存储层改动，无前端可见行为变化。

## 2026-09-28 — 验证命令判定规则收敛（修复基线里挂着的那个真实缺陷）+ Plan 列表读取复杂度

### Fixed

- **修复 `scripts/test-baseline.json` 中长期豁免的那条真实缺陷**（原用例名 `PlanDispatchCoordinator does not treat V2 natural-language prerequisites as Plan dependencies during dispatch`，期望 `RUNNING` 实得 `WAITING/NEEDS_CONFIGURATION`）。根因不是 V2 的自然语言前置条件，而是**验证命令的判定规则被写成两套**：
  - `run/scheduler.ts` 的 `assertVerificationCommands` 与 `PlanService.reviseConfiguration` 只读 V1 的 `contract.verificationCommandIds`，并把 `settings.commands` 里**任何**命令都算作已注册；
  - `PlanDispatchCoordinator.evaluateWait` 在 revision 带 `resolvedContract` 时改读 V2 的 `resolvedContract.verification.commandIds`，且只把 `category === "verification"` 且 `enabled !== false` 的命令算作已注册。

  两套规则让"同一个 Plan 该不该被拦"取决于**谁先问**：派发前的 `evaluateWait` 放行，`Scheduler.start` 里的同名校验却抛 `RUN_PREREQUISITES_UNSATISFIED`。典型触发是 V2 的 `verification.mode: "NONE"`——解析后 `commandIds` 为空、按 README 应当被 `SKIPPED` 而非被拦，但只要它身上带着一份陈旧的 V1 镜像 id 就会被卡住。规则已收敛到 `plan/contract.ts` 的 `missingVerificationCommands` 一处，三处调用点改用它；统一到 coordinator 的那套（已解析的 V2 契约是权威来源）。
- 判定规则两侧语义都被测试钉住（`plan/contract.test.ts`）：V2 分支保持严格（未启用或非 verification 类别的命令不算已注册），V1 回落分支保持历史行为（不收紧，否则旧库里的历史合同会突然无法确认）。

### Changed

- Plan 生命周期投影改为"按请求建一次索引、沿调用链下传"（`buildPlanLifecycleIndex`）。`planEventAggregateIds` 原先**每个 Plan** 都读一遍 `listRuns()` 与 `listMergeRequests()`（各是全表 `SELECT *`），内层再对每个匹配 Run 调 `listChangeProposals`；而 `decoratePlanRows` 对查询返回的**每一行**调一次 `planProjection` —— Plan Center 的 limit 上限是 100，于是单次列表请求等于 200 次全表读。`planProjection` / `decoratePlanRows` 的 `index` 参数可省略（单 Plan 调用自建一次与原行为等价），列表路径由 `decoratePlanRows` 与 `workbenchSnapshot` 各建一次。
- `scripts/test-baseline.json` 的 `knownFailures` 清空 —— 仓库现在没有已知失败用例。文件里保留了 `_历史` 字段记录这条缺陷的原委，因为"空清单"与"漏填"从文件本身看不出来。

### Added

- 新增 `apps/api/src/projections/plan-lifecycle.test.ts`：用调用计数把读取复杂度钉死（表读次数必须与行数无关），并断言"共享索引"与"逐 Plan 自建"产出**完全相同**的 lifecycle —— 否则"优化"就变成了行为变更。
- 新增 `packages/domain/src/plan/contract.test.ts`：判定规则的纯函数级覆盖。

### Changed files

- Domain：`code/packages/domain/src/plan/contract.ts`、`code/packages/domain/src/plan/contract.test.ts`（新增）、`code/packages/domain/src/plan/service.ts`、`code/packages/domain/src/run/scheduler.ts`、`code/packages/domain/src/run/dispatch-coordinator.ts`。
- API：`code/apps/api/src/projections/plan-lifecycle.ts`、`code/apps/api/src/projections/workbench.ts`、`code/apps/api/src/projections/plan-lifecycle.test.ts`（新增）。
- 脚本：`code/scripts/test-baseline.json`。

### Verification

- `pnpm --dir code verify` 通过，**三包零失败**：domain 264/264、API 72/72、Web 424/424，无新增值级循环依赖。这是 `test-baseline.json` 清空后的第一次全绿。
- 原豁免用例现在真正通过（`dispatch-coordinator.test.ts` 14/14），不是被从清单里删掉。
- 复杂度守卫经构造验证：`decoratePlanRows` 处理 5 行时三张表各只被读 1 次；改回逐 Plan 读取会让这三个计数变成 5。
- 未做浏览器验收：C3 改变了派发判定，属于后端行为；受影响的场景（V2 mode NONE 的 Plan 从"卡在 NEEDS_CONFIGURATION"变为"可派发并在验证阶段 SKIPPED"）应在下一轮端到端验收中确认。

## 2026-09-28 — 事件读取加界与 Plan 投影漂移可见化

### Added

- `PipelineStore.listEvents` 新增 `limitFrom: "head" | "tail"`（缺省 `"tail"`，与引入前行为一致）。缺省的 tail 语义是"最新的 N 条"，而轮询式增量读取需要的是"游标之后最早的 N 条"——两者混用会在游标落后时反复读到最新那一批，而游标又推进到本批末尾，中间事件被**永久跳过且不报错**。新增 `EventQuery` 类型承载过滤与截断参数，两个实现同步。
- `SqlitePipelineStore` 新增构造期修复 `repairOrphanedPlans`：把"已确认之后、来源 ExplorerThread 已不存在"的 Plan 标成 `BLOCKED` + `attentionReason`，复用既有前端"需要关注"展示链路。此前这类 Plan 会被投影守卫跳过而**无声消失**，状态却停留在 `READY`/`QUEUED` 之类看起来可执行的值上。
- 新增 `store-startup-repair.test.ts`：覆盖 `repairUnconfirmedProgressedPlans` 与 `repairOrphanedPlans` 的生效与**幂等**（重开库不重复处理、不重复写 `plan.status.changed`）。两条修复的输入都只能用独立连接直接改库来构造——走领域 API 产生不出这些行，那正是它们只对历史数据生效的原因。

### Fixed

- `PlanService.query` 遇到"投影行没有源 Plan"时不再抛错，改为跳过该行。此前一行坏数据会让整个 Plan Center 变成 500。该分支在正常流程不可达（写侧有守卫、`deleteExplorerCascade` 会级联删投影），属防御性修复。

### Changed

- Workbench 事件路由的每一次 `listEvents` 都带 limit：首次连接取尾部窗口（与 `workbenchSnapshot` 的 `WORKBENCH_EVENT_TAIL_LIMIT` 同一常量），之后从游标向前读、单轮上限 500。此前该路由缺 limit，`afterSequence=0` 会把整张事件表读进内存并逐条 `JSON.parse`，而生产库已有十几万条事件、绝大多数与本 Project 无关。
- Agent Loop 事件路由同上：首次回放窗口 2000、单轮上限 500。此前 web 端 `agentLoopEventsUrl` 不传游标，建连即 from 0 全量回放。
- 在 `savePlan` / `backfillPlanQueryProjection` / 内存实现三处注明：投影守卫是**外键驱动**的，不是业务规则——`plan_query_projection` 对 `project_id` 与 `source_explorer_thread_id` 建了外键，而它所索引的 `candidate_plans` 自己没有。**不要把它改成无条件写入**：那会把 `savePlan` 从不抛错的 UPSERT 变成 project/thread 缺失时抛错的方法，而内存实现没有外键会静默成功，等于制造新的双实现分歧。
- `repairOrphanedPlans` **只查来源线程，不查 Project**：领域层允许"有 Plan 却没有 Project 行"（`PlanService.registerThread` + `createCandidatePlan` 不需要先建 Project，多个领域测试正是这么用），把"项目不存在"当孤儿会把正常数据误判成 BLOCKED。这条是在 `pnpm verify` 抓到 `m0-m1.test.ts` 的真实回归后收窄的。

### Changed files

- Domain：`code/packages/domain/src/store/pipeline-store.ts`、`code/packages/domain/src/store/sqlite-store.ts`、`code/packages/domain/src/store/in-memory-store.ts`、`code/packages/domain/src/plan/service.ts`、`code/packages/domain/src/store-startup-repair.test.ts`（新增）、`code/packages/domain/src/store-event-query.test.ts`、`code/packages/domain/src/plan-query.test.ts`。
- API：`code/apps/api/src/routes/workbench.ts`、`code/apps/api/src/routes/agent-loops.ts`、`code/apps/api/src/projections/workbench.ts`、`code/apps/api/src/server-sse.test.ts`。

### Verification

- `pnpm --dir code verify` 通过：domain 258 用例（通过 257，失败 1）、API 70 用例全通过、Web 424 用例全通过，无新增值级循环依赖。
- 那 1 个失败仍是 `scripts/test-baseline.json` 中已登记的既有缺陷（`dispatch-coordinator.test.ts:121`），非回归。
- 新增守卫经反向验证：临时把 Workbench 路由的读取改回无界，`server-sse.test.ts` 的新增用例按预期失败（`expected undefined to deeply equal Any<Number>`），确认它抓的是"路由传了什么参数"而非帧数——无界读取的帧数完全正常，代价全在服务端。
- **中途 `pnpm verify` 抓到一次真实回归**：`repairOrphanedPlans` 初版把"Project 不存在"也当孤儿，导致 `m0-m1.test.ts` 的 `restores plans and append-only events after a service restart` 从 `ENQUEUED` 变 `BLOCKED`。收窄后恢复绿灯——这条正说明该门禁有效。
- 未做浏览器验收：本次改动未触及前端可见行为（Workbench/Agent Loop 面板看的是事件尾部，与窗口语义一致），但窗口化改变了首屏回放条数，仍应在下一轮浏览器验收中确认两个面板内容完整。

## 2026-09-28 — Store 跨实现契约与事件写入去重

### Added

- 新增 `store-contract.test.ts`：PipelineStore 的跨实现契约套件，同一批断言在 `InMemoryPipelineStore` 与 `SqlitePipelineStore` 上各跑一遍。端口方法清单由 tsc 保证完整（漏一个方法编译不过），覆盖生产写路径：事件追加与查询、脱敏、步骤序号、Plan 查询投影、Run/合并/工具调用、幂等与事务回滚。

### Fixed

- 修复 `VerificationRun.reason` 在 SQLite 上永远读不出来的缺陷：该字段自类型引入时就存在（并被 Web 的类型 parity 守卫覆盖），但 `verification_runs` 建表语句一直漏了 `reason` 列，`saveVerificationRun` 也不写、`verificationFromRow` 也不读，于是生产上恒为 `undefined`——`NO_PROJECT_VERIFICATION_COMMANDS`（"未配置自动验证"的唯一凭据）被静默丢弃。补建表列 + `ALTER TABLE` 迁移分支 + 读写路径。
- 修复 `saveIdempotency` 在两种存储下语义相反的缺陷：内存实现用 `Map.set`（后写覆盖），SQLite 用 `INSERT OR IGNORE`（首次写入生效）。调用方一律"先查后写"，该过程不原子，并发重放时只有首次写入生效才能保证重放拿到**原来**那条结果，因此按 SQLite 语义对齐内存实现，并在端口注释 6 中写明该契约。

### Changed

- Agent Loop 的单次模型文本增量不再往事件表写第二份：`agent.model.text.delta` 与 `agent.step.model_text_delta` 的 `text` 逐字相同，同一次增量此前落 1 行 `agent_loop_steps` + 2 条领域事件。`emit` 增加 `durable` 开关，`flushTextDelta` 改用它只做进程内派发——**回调与 listener 的派发时序、内容完全不变**（Explorer 的实时正文靠 thread-service 的 callback 累积，读的是 `AgentLoopEvent` 而非事件表）。实测该类型占全部事件 159,523 条中的 53,161 条（33.3%），数据库 81 MB 中 `domain_events` 占 43 MB。
- `PipelineStore` 端口注释补充 `saveIdempotency` 的首次写入生效语义。

### Changed files

- Domain：`code/packages/domain/src/store-contract.test.ts`（新增）、`code/packages/domain/src/agent-loop-engine.test.ts`、`code/packages/domain/src/agent/agent-loop.ts`、`code/packages/domain/src/store/pipeline-store.ts`、`code/packages/domain/src/store/in-memory-store.ts`、`code/packages/domain/src/store/sqlite-store.ts`。

### Verification

- `pnpm --dir code verify` 通过：domain 253 用例（通过 252，失败 1）、API 68 用例全通过、Web 424 用例全通过，无新增值级循环依赖。
- 那 1 个失败是 `scripts/test-baseline.json` 中已登记的既有缺陷（`dispatch-coordinator.test.ts:121` 期望 `RUNNING` 实得 `WAITING/NEEDS_CONFIGURATION`），本次未触碰，非回归。
- 新契约套件的断言经反向验证：临时移除 `durable: false` 后 `agent-loop-engine.test.ts` 的新增用例按预期失败（`to not include 'agent.model.text.delta'`），确认守卫非空转。
- 未做浏览器验收：本次改动不含前端可见行为变化，但 A1a 改变了事件写入，仍应在下一轮浏览器验收中确认 Explorer 流式正文实时可见。

## 2026-09-27 — Explorer 流式交互与事件查询性能

### Changed

- Agent Loop 将高频模型文本增量合并后再写入步骤和事件：达到 160 字符、最长 40ms、Provider 输出项切换、遇到其他事件或步骤结束时刷新，减少逐 token 持久化和 SSE 事件数量，同时保留流式更新。
- Agent Loop 事件序号改为由追加步骤维护，并在首次使用时从 Store 查询最大序号；诊断投影只读取 `PROVIDER_ACTIVITY`、`GATE_CHECKED` 和 `LOOP_FAILED` 步骤。
- Store 的 `listEvents` 增加多聚合、事件类型和最新条数过滤，SQLite 为聚合 ID 与序号增加索引；Plan 生命周期事件在存储查询层过滤。
- Workbench 初始事件快照最多检查全局最近 4,000 条，再保留当前 Project 最近 400 条；实时新事件仍通过 SSE 推送。Project 事件归属改为先建立聚合到 Project 的索引，避免逐事件重复查找。
- Explorer 将流式期间的 activity、Plan 和 Agent Loop 投影刷新合并到 400ms 间隔；门禁、输入和终态事件仍立即刷新，并在线程切换或卸载时清理定时任务。

### Added

- 新增 Store 事件查询测试，覆盖 InMemory 与 SQLite 实现的多聚合筛选、事件类型筛选、空筛选语义、最新条数和冲突参数校验。

### Changed files

- API：`code/apps/api/src/server.ts`。
- Domain：`code/packages/domain/src/agent-loop.ts`、`code/packages/domain/src/index.ts`、`code/packages/domain/src/store-event-query.test.ts`。
- Explorer：`code/apps/web/src/views/ExplorerView.vue`。
- 文档：`CHANGELOG.md`。

### Verification

- `git diff --check` 通过。
- 本次未运行测试、typecheck 或 build；新增 Store 查询测试尚未在本次提交前执行。

## 2026-09-27 — Explorer 需求工作台与交互恢复

### Added

- 新增当前 ExplorerThread 的需求清单投影：按需求序号稳定排序，将需求、有效 Plan 修订和关联 Run 汇总到同一行；点击 Plan 状态、结构化 Plan 或任务状态分别进入探索对话、Plan 详情或 Run。
- 新增需求行组件与共享右侧抽屉页签，支持当前需求的探索对话、Plan 详情、待入队操作和 Run 对话；线程切换会清除旧线程抽屉内容，并保持需求选择与路由状态一致。
- 新增 Explorer 输入回答草稿恢复：在当前浏览器标签页保存需求范围内的非敏感回答和题目位置，刷新后恢复；敏感题答案不写入 sessionStorage，已结束请求会清理草稿。
- 将完整 Plan 正文抽为可复用组件，并读取 `generatedSpec` 的 V2 结构化字段，使完整解析契约尚未生成时也能查看目标、范围、任务、产物和执行策略。

### Changed

- 左侧线程栏仅显示 Project 与 ExplorerThread，移除其下的需求子项；需求新增入口和清单移到主工作区。新增需求后在当前线程创建对应 ExplorerPlan，并将描述作为首条探索消息；发送失败时保留该需求以便重试。
- Plan 已确认但尚未创建 Run 时，Run 页签显示待入队状态；对话型 Plan 会在入队前给出不可执行原因和修订指引，处理 `CONVERSATION_ARTIFACT_NOT_EXECUTABLE`，不改变服务端接口或生命周期顺序。
- 线程和需求切换时同步更新清单范围、路由与抽屉状态，避免旧需求内容残留；响应式布局覆盖窄屏清单和抽屉展示。

### Changed files

- 组件：`code/apps/web/src/components/ExplorerInputDialog.vue`、`code/apps/web/src/components/ExplorerRequirementList.vue`、`code/apps/web/src/components/PlanDetailContent.vue`、`code/apps/web/src/components/PlanDetailDrawer.vue`、`code/apps/web/src/components/ThreadRail.vue`。
- 页面与类型：`code/apps/web/src/views/ExplorerView.vue`、`code/apps/web/src/views/RunDetailView.vue`、`code/apps/web/src/styles.css`、`code/apps/web/src/types.ts`。
- 工具：`code/apps/web/src/utils/explorerInputProgressDraft.ts`、`code/apps/web/src/utils/explorerRequirementRows.ts`。
- 测试：`code/apps/web/src/components/PlanDetailDrawer.test.ts`、`code/apps/web/src/components/ThreadRail.test.ts`、`code/apps/web/src/views/ExplorerView.test.ts`、`code/apps/web/src/views/RunDetailView.test.ts`、`code/apps/web/src/utils/explorerInputProgressDraft.test.ts`、`code/apps/web/src/utils/explorerRequirementRows.test.ts`。
- 文档：`CHANGELOG.md`。

### Verification

- `npm --prefix code/apps/web test`：54 个测试文件、274 个测试通过。
- `npm --prefix code/apps/web run typecheck` 与 `npm --prefix code/apps/web run build` 通过；构建仍提示存在大于 500 kB 的 chunk。
- `git diff --check` 通过。
- 浏览器全流程验收未完成：当时 API 与 Web 健康检查失败（过期 PID 文件且端点不可用），已打开的浏览器标签也未能完成自动化交互；自动化测试和构建不能替代运行中的浏览器验收。

## 2026-09-27 — 执行线程与 Run 可观测性

### Added

- 增加每个 Project 独立的长期执行线程：持久化消息、Provider Thread、模型与推理等级偏好；按顺序处理请求，支持幂等提交、取消、重启后恢复队列，并通过项目级 API 和 SSE 回放进度。该入口可直接在项目仓库目录执行，不会隐式创建 Explorer Plan 或 Run。
- 在 Explorer 左侧加入“项目执行线程”入口和会话面板，展示消息、Provider/工具活动、队列与连接状态，并支持切换模型偏好和发送请求。
- 为 Run 工作树增加项目当前 Git 可见变更的快照基线，使已修改和普通未跟踪项目文件可供新 Run 使用；快照失败时清理新建的工作树和分支。
- 新增执行目录解析与安全检查：从 Plan 的 `artifactPath` 或 `include` 推导命令工作目录，拒绝越界路径及符号链接，并向 Executor 明确传入工作树根目录与命令目录。
- 新增 Run 执行预检与恢复流程文档，记录 Provider 命令超时、错误目录和清理旧工作树前的现场保全步骤。

### Changed

- Provider 代执行的命令现在受项目默认命令超时约束；超时会取消 Provider Turn、阻塞 Agent Loop，并记录活动 ID、工作目录及超时值。
- Run journal 增加模型轮次、任务 ID、Provider 会话/活动及工具调用的关联字段；执行页按 Plan 任务展示模型输出、工具/MCP 活动和错误，明确标出未记录的状态，并将重复且进度未变化的 Executor 报告合并展示。
- Executor 使用结构化任务进度标记更新任务状态；缺少任务事实时保持“未记录”，不根据模型叙述或 Run 状态推测。执行状态卡直接展示 token 用量明细，执行会话承载过程信息。
- RecoveryCoordinator 仅处理 Run 所属 Agent Loop；项目执行线程单独将重启前未完成的轮次标为需要恢复。

### Verification

- `pnpm --dir code typecheck`、`pnpm --dir code build`、Web 277 个测试和 API 51 个测试通过；构建仍有大于 500 kB 的 chunk 提示。
- Domain 测试 225/226 通过；`dispatch-coordinator.test.ts` 的 1 个测试期望 `RUNNING`，实际因 `NEEDS_CONFIGURATION` 停在 `WAITING`。该测试文件未在本次提交中修改。

## [Unreleased] - 2026-09-19

### Added

- ExplorerThread 支持一等 ExplorerPlan 分区：默认 Plan 1、Plan 级消息/活动/候选方案隔离，所有 Plan 复用同一 Provider Thread 与完整会话上下文。
- 增加同一 ExplorerThread 下多个 ExplorerPlan 的持久化 FIFO 后台队列、运行状态、重启恢复和线程级上下文摘要。
- 增加 ExplorerPlan 分组、创建、重命名、激活和 workspace API；turn、activity、input request、Agent Loop、candidate Plan 和 revision draft 均支持按 ExplorerPlan 隔离。
- 将聊天区消息快捷入口改为 Element Plus Tree：Explorer Thread 作为根节点，Task 和 Plan 默认展开，子 Plan 可定位到时间线；Plan 卡片也可反向定位对应 Task。
- 为 Explorer 增加标题栏状态摘要组件，集中展示需求契约、Provider Loop 和探索进度；支持点击查看详情、键盘操作，以及在 Provider Loop 详情中暂停/恢复循环。
- 将计划中心入口加入左侧主导航并显示计划数量；保留右侧上下文面板中的候选、已确认、已入队、已派发、运行中和待处理分区。
- 将用户消息改为可折叠的标题/摘要卡片，展开后查看完整 Markdown；新增消息摘要工具及对应测试。
- 将聊天区消息时间线改为窄型浮动标记轨道，支持 hover、focus、active 状态和消息定位；最新消息按钮改为水平居中。
- 为 Explorer Tree 增加根节点到 Task、Task 到 Plan 的树形连接线，并保留当前 Task 的轻量选中态。
- 增加 `ProviderUsageFooter`，在聊天底部展示当前模型、上下文用量和账户级 5 小时/7 天限额。
- 增加共享 `TaskLifecycleCard`，统一候选、已确认、已入队、已派发、运行中和待处理 Plan 的生命周期展示、异常状态和执行线程入口。
- 增加 ExplorerThread 删除 API 与领域级级联删除能力；删除前阻止仍有活动 Run 或 Explorer Loop 的线程，并在删除最后一个线程时创建替代线程。
- 增加 Explorer Task 归属和 Plan 生命周期工具及测试，明确未归属记录不得猜测挂到 Task 1。

### Changed

- 优化 Explorer、项目上下文卡片和右侧上下文面板布局，减少冗余标题、仓库路径和说明文本，并补充响应式样式与可访问性标记。
- 统一 Explorer 上下文菜单、计划中心标签和线程操作菜单的中文文案。
- `ExplorerPlanRequirements` 支持通过 `initiallyExpanded` 控制初始展开状态，以适配状态详情浮层。
- Explorer、Executor 及 Project 默认模型由 `deepseek-v4-flash` 切换为 `gpt-5.6-luna`；同步更新配置示例、运行配置、项目设置表单和项目领域默认值。
- 历史模型迁移改为只识别并替换精确的 `deepseek-v4-flash`，继续保留活动 Run 跳过、配置版本递增和配置修订记录能力。
- 更新 `code/README.md`，同步新的默认模型说明和本地运行配置示例。
- Explorer UI 将 `ExplorerPlan` 显示为 `Task`，仅调整前端术语；domain、API、数据库仍保留 `ExplorerPlan` 原名。
- 删除聊天区右侧 `PLANS` 导航栏和 `THREAD READY FOR YOUR NEXT TURN` 专用分隔提示；保留候选 Plan 数据、状态和业务流程。
- Agent Loop 从共享 Provider Thread 继承 provider thread ID，并将排队/运行/等待输入/完成/失败状态同步到对应 Task。
- 修复本地开发服务的过期 PID 文件判断；status/start 脚本优先以健康端点和监听端口判断 API/Web 是否可用。
- 修正本地配置中的项目仓库根目录和 Codex App Server cwd，避免从 `code/config` 解析到非 Git 的上级目录。
- Candidate 查询支持显式 `explorerPlanId` 并默认使用活动 Task；Plan、Revision 和执行详情响应统一补充生命周期投影与执行线程摘要。
- Plan 状态变化统一写入 `plan.status.changed` 事件；旧数据中缺少确认记录却已进入后续状态的 Plan 会被修复为 `BLOCKED`，避免无确认执行。
- 执行时间线保留不可变 Plan 快照；Explorer 线程切换时仅刷新当前 Task 的 Candidate、Revision Draft、消息、输入请求和 Plan 绑定。

### Tests and documentation

- 新增 `ExplorerHeaderStatus`、用户消息摘要和相关交互覆盖；同步更新 Explorer、ThreadRail、计划需求和 Project 模型迁移测试。
- 新增 `design-qa.md`，记录 Explorer 聊天区视觉/交互验收结果和现场截图依据。
- 修正 ThreadRail 样式断言，使测试与当前三列 Grid 项目上下文布局一致。
- 新增 `taskTree.ts` 及测试，覆盖 Task 排序、Plan 归属、去重、未归属 Plan 隔离、展示术语和时间线定位目标。
- 扩展 Explorer domain/API 测试，覆盖默认 Plan 1、多 Plan FIFO 与共享 Provider Thread、跨项目 workspace 拒绝和无效 Plan turn 拒绝；同步记录探索流程设计文档和待办事项。
- 新增 Explorer 删除、Task 归属、Plan 生命周期、Provider 用量页脚和共享生命周期卡测试；扩展 API、domain、ExplorerView、ThreadRail、执行流和状态事件测试。
- 更新原始需求合规计划、UI 完整性计划、探索流程说明和 `待办事项.md`，标注当前自动化结果与剩余浏览器矩阵验收项。

### Verification

- `pnpm --dir code test`：88 个测试文件、526 个测试通过（当前工作区）。
- `pnpm --dir code typecheck`：domain、web、API 均通过。
- `pnpm --dir code build`：domain、web、API 均通过；仅有既有的 chunk size warning。
- API 冒烟检查：health、Project、Explorer、ExplorerPlan、workspace 和 Plan 这些接口均返回成功；跨项目访问按预期拒绝。
- `git diff --check`：通过。
- 浏览器已完成 Explorer Tree 基础交互和 API 健康检查；完整的 Explorer、Plan Center、Workbench、Run、Settings 桌面/平板/窄屏矩阵仍待完成。

### Changed files in this working-tree update

- Explorer UI：`code/apps/web/src/components/ThreadRail.vue`、`code/apps/web/src/components/ThreadRail.test.ts`、`code/apps/web/src/views/ExplorerView.vue`、`code/apps/web/src/views/ExplorerView.test.ts`、`code/apps/web/src/styles.css`、`code/apps/web/src/types.ts`。
- Explorer UI utilities：`code/apps/web/src/utils/explorerScope.ts`、`code/apps/web/src/utils/explorerScope.test.ts`、`code/apps/web/src/utils/explorerStatus.ts`、`code/apps/web/src/utils/explorerStatus.test.ts`、`code/apps/web/src/utils/planLifecycle.ts`、`code/apps/web/src/utils/planLifecycle.test.ts`。
- Explorer UI components：`code/apps/web/src/components/ProviderUsageFooter.vue`、`code/apps/web/src/components/ProviderUsageFooter.test.ts`、`code/apps/web/src/components/TaskLifecycleCard.vue`、`code/apps/web/src/components/TaskLifecycleCard.test.ts`、`code/apps/web/src/components/ExecutionHeaderStatus.test.ts`、`code/apps/web/src/components/ProjectSettingsDialog.test.ts`。
- Web API and execution flow：`code/apps/web/src/api.ts`、`code/apps/web/src/api.test.ts`、`code/apps/web/src/utils/executionStream.ts`、`code/apps/web/src/utils/executionStream.test.ts`、`code/apps/web/src/utils/executionTelemetry.ts`、`code/apps/web/src/utils/executionTelemetry.test.ts`。
- API：`code/apps/api/src/server.ts`、`code/apps/api/src/server.test.ts`。
- Domain：`code/packages/domain/src/index.ts`、`code/packages/domain/src/executor-agent.ts`、`code/packages/domain/src/recovery-coordinator.ts`、`code/packages/domain/src/change-proposal.test.ts`、`code/packages/domain/src/m0-m1.test.ts`、`code/packages/domain/src/explorer-delete.test.ts`。
- Runtime and configuration：`startApi.sh`、`startWeb.sh`、`status.sh`、`code/config/pipeline-factory.config.json`、`code/config/pipeline-factory.config.example.json`。
- Documentation and tracking：`CHANGELOG.md`、`待办事项.md`、`docs/superpowers/plans/2026-08-30-ui-completeness.md`、`docs/superpowers/plans/2026-09-01-original-requirement-compliance.md`、`docs/探索的流程/流程优化升级.txt`。
