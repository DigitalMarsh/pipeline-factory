/**
 * 测试职责：校验 Run 详情页执行对话的 Markdown 渲染装配。
 * 设计说明：只做组件源码级断言，运行行为由 MarkdownMessage 单测覆盖。
 * 维护提示：执行对话渲染方式变化时，应同步调整这里的断言。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * **换行与缩进不是这些断言的判据**：Prettier 会把源码重排（一行拆成多行、缩进改变），而断言要证的是
 * "这里接上了某个东西"，不是"它是怎么排版的"。两边都先把连续空白压成单个空格再比——否则每次格式化
 * 都要回来把一批断言重打一遍，而它们本来就没打算测排版。
 */
const flat = (text: string) =>
  text
    .replace(/\s+/g, " ")
    // 断行会在**下一个 token 前面**留下一个空格（`foo(\n  bar,` -> `foo( bar,`）。只吃掉这些
    // "断行带进来的"空格：开括号/花括号之后，闭括号/花括号/方括号/分号/逗号/引号之前。
    // **不要**动别处——尤其别去掉 `(` 前面的空格：正则断言不会被折叠，`@media (max-width:` 那样
    // 一改就再也匹配不上。
    .replace(/([({])\s+/g, "$1")
    .replace(/\s+([)}\]);,"'])/g, "$1")
    .replace(/,([)}\]])/g, "$1")
    .trim();

const runDetailSource = readFileSync(fileURLToPath(new URL("./RunDetailView.vue", import.meta.url)), "utf8");
const runDetailStyles = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");
/**
 * 这四簇已经各自成文件（视图从 1133 行降到 700 出头），所以**它们的断言要跟着搬**——
 * 断言的是"这条判据还在、且只有一处"，不是"它写在哪个文件里"。
 */
const executionConversationSource = readFileSync(fileURLToPath(new URL("../utils/executionConversation.ts", import.meta.url)), "utf8");
const useRunStreamSource = readFileSync(fileURLToPath(new URL("../composables/useRunStream.ts", import.meta.url)), "utf8");
const useRunControlSource = readFileSync(fileURLToPath(new URL("../composables/useRunControl.ts", import.meta.url)), "utf8");
const useRunComposerSource = readFileSync(fileURLToPath(new URL("../composables/useRunComposer.ts", import.meta.url)), "utf8");
const runControlsSource = readFileSync(fileURLToPath(new URL("../utils/runControls.ts", import.meta.url)), "utf8");
// 执行会话的行组件：**按形态分文件**，所以"这一行长什么样"要去各自的组件里看。
const executionPlanCardSource = readFileSync(fileURLToPath(new URL("../components/ExecutionPlanCard.vue", import.meta.url)), "utf8");
const executionModelRowSource = readFileSync(fileURLToPath(new URL("../components/ExecutionModelRow.vue", import.meta.url)), "utf8");
const executionUserRowSource = readFileSync(fileURLToPath(new URL("../components/ExecutionUserRow.vue", import.meta.url)), "utf8");
const executionActivityRowSource = readFileSync(fileURLToPath(new URL("../components/ExecutionActivityRow.vue", import.meta.url)), "utf8");
// 一条消息的 DOM（头像 + meta + 正文）现在住在行组件里：同一条消息要在**两处**渲染（可见的那批、
// 以及折在上方「N 条过程记录」里那批），两处各写一份模板就是"折叠前后长得不一样"的成因。
const executionMessageRowSource = readFileSync(fileURLToPath(new URL("../components/ExecutionMessageRow.vue", import.meta.url)), "utf8");
const executionDividerRowSource = readFileSync(fileURLToPath(new URL("../components/ExecutionDividerRow.vue", import.meta.url)), "utf8");
const executionReasoningRowSource = readFileSync(
  fileURLToPath(new URL("../components/ExecutionReasoningRow.vue", import.meta.url)),
  "utf8",
);

describe("Run detail execution conversation", () => {
  it("正文与用户消息各走自己的行组件，都经同一个 Markdown 组件渲染", () => {
    // **形态**在行组件里选（视图这一层只按分组摆行）；"长什么样"在各自的组件里。
    expect(flat(executionMessageRowSource)).toContain(flat("item.kind === 'model'"));
    expect(flat(executionMessageRowSource)).toContain(flat("item.kind === 'user'"));
    // 你自己说的话不走卡片、也不带头像：Codex 那种「› + 纯文本」，仍然靠右。
    // （助手正文同样不带头像——与探索侧同档同形，见 docs 的共用档位表。）
    expect(flat(executionMessageRowSource)).toContain(flat('props.item.kind !== "user" && props.item.kind !== "model"'));
    expect(flat(executionModelRowSource)).toContain(
      flat('<MarkdownMessage :source="item.content" :streaming="item.status === \'RUNNING\'" />'),
    );
    expect(flat(executionUserRowSource)).toContain(flat('<MarkdownMessage :source="item.content" />'));
    expect(flat(executionUserRowSource)).toContain(flat('class="execution-user-mark"'));
    expect(executionMessageRowSource).not.toContain("{{ item.content }}<span v-if=\"item.status === 'RUNNING'\"");
  });

  it("形态分支是显式的，兜底会当场显示出来", () => {
    // 七种形态各有自己的分支；某种形态掉到兜底说明模板没跟上——显示出来，不静默降级。
    expect(flat(executionMessageRowSource)).toContain(flat("item.kind === 'activity' || item.kind === 'tool'"));
    expect(flat(executionMessageRowSource)).toContain(flat("execution-unknown-row"));
    expect(runDetailStyles).toContain(flat(".execution-unknown-row"));
  });

  it("**权重**的判据不是白名单：新增一种就不会有消息从会话里消失", () => {
    // `text`（你自己说的话）就是这么漏过一次的——`visibleItems` 当时写死"属于 card 或 line"，
    // 于是那类消息在页面上直接不见了，而类型、模板、样式都对着。
    expect(flat(executionConversationSource)).toContain(flat('executionMessageWeight(item) !== "hidden"'));
    expect(executionConversationSource).not.toContain('mode === "card" || mode === "line"');
  });

  it("**过程记录折在结论上方**，展开后是真实的行（照 OpenClaw 的 `Worked for …`）", () => {
    // 位置：折叠区排在可见条目**之前**——先交代这一步花了多久、折了多少条，再让结论说话。
    const foldedIndex = runDetailSource.indexOf("execution-folded-log");
    const visibleIndex = runDetailSource.indexOf('v-for="item in visibleItems(group)"');
    expect(foldedIndex).toBeGreaterThan(-1);
    expect(visibleIndex).toBeGreaterThan(foldedIndex);
    // 内容：展开后是行组件，不是一张只写了标题的清单。
    expect(flat(runDetailSource)).toContain(flat('<ExecutionMessageRow v-for="item in foldedItems(group)"'));
    expect(runDetailSource).not.toContain("execution-noise-title");
    // 标题上要有时长与失败数——失败**永远可见**，即使这一组是收起的。
    expect(flat(runDetailSource)).toContain(flat("stepDuration(group)"));
    expect(flat(runDetailSource)).toContain(flat("failedCount(group)"));
    // 进行中的一步**不折**：live 内容留在日志外面。（判据本身在 util 里，见下一条用例。）
    expect(flat(executionConversationSource)).toContain(flat("foldsIntoProcess(item, { stepRunning:"));
  });

  it("续跑检查点在执行侧也是**分隔线**，与探索侧同形", () => {
    // 它是会话边界不是事件——画成又一条活动行，读的人不会意识到分界在哪。
    expect(flat(executionDividerRowSource)).toContain(flat("timeline-divider"));
    expect(flat(executionDividerRowSource)).toContain(flat("Factory · 续跑检查点"));
  });

  it("推理是**可折叠的推理卡**，与探索侧同形", () => {
    expect(flat(executionReasoningRowSource)).toContain(flat("<details"));
    // 跑着的时候默认展开——那时候它正在说事；跑完收起来，把视线还给正文。
    expect(flat(executionReasoningRowSource)).toContain(flat(':open="streaming"'));
    // **没有正文时不摆这个折叠**：本机库里 13/13 条老推理行都是空的（那时还不记摘要），
    // 一个点开只有空白的展开区比没有更糟。也不补"未记录摘要"这类句子——上面那行 meta
    // 已经写着「推理」，正文留空就是"这一轮没有可说的"。
    expect(flat(executionReasoningRowSource)).toContain(flat('<details v-if="hasBody"'));
    expect(flat(executionReasoningRowSource)).toContain(flat("props.item.content.trim()"));
    // 正文过一遍展示边界的脱敏（与工具结果同一个口）。
    expect(flat(executionReasoningRowSource)).toContain(flat("presentableText"));
  });

  it("动作行的正文保持纯文本，不渲染成 markdown", () => {
    expect(flat(executionActivityRowSource)).toContain(flat('class="execution-activity-detail"'));
    expect(executionActivityRowSource).not.toContain("MarkdownMessage");
  });

  it("把 Run 面板接上共享抽屉：方案交给宿主，改计划交给「探索对话」页签", () => {
    // 宿主（ExplorerView 的「Run」页签）永远把这两个 id 传进来——组件不再有"从路由参数兜底"那一条。
    expect(flat(runDetailSource)).toContain(flat("defineProps<{ projectId: string; runId: string }>()"));
    // 逐个事件断言，不整块比 `defineEmits<{…}>()`：块里现在夹着解释用的注释，整块比就等于在测排版。
    expect(flat(runDetailSource)).toContain(flat('(event: "open-plan", plan: Plan): void;'));
    expect(flat(runDetailSource)).toContain(flat('(event: "open-explorer"): void;'));
    /** 它**自己不渲染**方案面板：取全 Plan 之后交给宿主（共享抽屉里已经有一份方案面板）。 */
    expect(flat(runDetailSource)).toContain(flat('emit("open-plan", planDetail.value)'));
    expect(runDetailSource).not.toContain("PlanDetailDrawer");
  });

  it("**没有「整页形态」了**：不渲染页头那条「返回」，也不再有 embedded 开关", () => {
    /**
     * 此前这个组件有一个 `embedded` 开关分「内嵌 / 独立整页」两种形态。整页那条
     * （`/projects/:projectId/runs/:runId`）**全仓没有任何入口**、内容又是同一份代码，已经退役成
     * 一条重定向（`router.ts` 的 `runDetailRedirect`）。于是这里留下一堆"只有一种取值"的分支：
     * 页头、「查看方案」开不开抽屉、终止之后往哪跳、根元素那个 class 开关——全部收掉。
     */
    // 断言的是**代码里**没有它了（注释里会引用旧名说明改了什么，那不算）。
    expect(flat(runDetailSource)).not.toContain(flat("props.embedded"));
    expect(flat(runDetailSource)).not.toContain(flat("detail-page-embedded"));
    expect(runDetailSource).not.toContain("detail-top");
    expect(runDetailSource).not.toContain("closeView");
    // 不再从路由参数兜底取 id，也就不再需要 route / router——跳转全归宿主。
    expect(runDetailSource).not.toContain("useRoute");
    expect(runDetailSource).not.toContain("useRouter");
    expect(flat(runDetailSource)).toContain(flat('class="detail-page run-detail-page"'));
    // 终止之后就地重载：整页那条"跳 /plans"的支路跟着整页一起没了。
    expect(flat(runDetailSource)).toContain(flat("onTerminated: async () => { await load(); }"));
  });

  it("uses the compact execution header as the details entry point", () => {
    expect(flat(runDetailSource)).toContain(flat('import ExecutionHeaderStatus from "../components/ExecutionHeaderStatus.vue"'));
    expect(flat(runDetailSource)).toContain(flat("<ExecutionHeaderStatus"));
    expect(flat(runDetailSource)).toContain(flat('@focus-task="focusExecutionTask"'));
    expect(flat(runDetailSource)).toContain(flat('@run-action="handleRunAction"'));
    expect(flat(runDetailSource)).toContain(flat('@loop-action="handleLoopAction"'));
    expect(runDetailSource).not.toContain("open-diagnostics");
    expect(runDetailSource).not.toContain('class="run-actions"');
    expect(runDetailSource).not.toContain('class="execution-telemetry-panel"');
    expect(runDetailSource).not.toContain('class="execution-steps-panel"');
    expect(runDetailSource).not.toContain('class="agent-loop-detail"');
    expect(runDetailSource).not.toContain('class="evidence-card"');
    expect(runDetailSource).not.toContain('class="diagnostics-teaser"');
    expect(flat(runDetailSource)).toContain(flat('class="execution-conversation-panel"'));
  });

  it("renders the shared Provider footer with execution telemetry Context", () => {
    expect(flat(runDetailSource)).toContain(flat('import ProviderUsageFooter from "../components/ProviderUsageFooter.vue"'));
    expect(flat(runDetailSource)).toContain(flat("formatProviderContextUsage"));
    expect(flat(runDetailSource)).toContain(
      flat("const executionContextUsage = computed(() => formatProviderContextUsage(executionTelemetry.value?.usage?.inputTokens));"),
    );
    // 模型/agent 由"本次记录优先、否则用这次 Run 冻结的配置"回答——遥测要这一轮跑完才有值，
    // 运行中只读 telemetry 会得到一片"未记录"。
    expect(flat(runDetailSource)).toContain(
      flat("resolveExecutionModelIdentity(executionTelemetry.value, executionExecutorConfig.value, modelCatalog.value)"),
    );
    // 项目没覆盖 backend 时快照里是 null，生效的是该角色的全局后端——不回退这步运行中 AGENT 一栏是空的。
    expect(flat(runDetailSource)).toContain(flat("backend: configured?.backend ?? roleBackend"));
    expect(flat(runDetailSource)).toContain(
      flat(
        '<ProviderUsageFooter :model="executionModelIdentity.model" :backend="executionModelIdentity.backend" :context="executionContextUsage" context-note="仅结束时由 provider 上报" :source-note="executionModelSourceNote" />',
      ),
    );
  });

  it("puts my messages on the right and collapses provider diagnostics", () => {
    // 左右分栏：我的消息（role=user）靠右，执行者的靠左。
    expect(flat(executionMessageRowSource)).toContain(flat("mine: item.role === 'user'"));
    // 诊断字段默认收起（Turn #/Call/Provider item/Provider session），hover 与"详情"里才看得到。
    expect(flat(executionMessageRowSource)).toContain(flat(':title="executionMessageDiagnosticsTitle(item)"'));
    expect(flat(executionMessageRowSource)).toContain(flat('v-if="details.length"'));
    expect(flat(executionMessageRowSource)).toContain(flat('class="execution-message-toggle"'));
    expect(flat(executionMessageRowSource)).toContain(flat('v-if="expanded"'));
    // 常驻元信息里不再直接铺这些字段。
    expect(runDetailSource).not.toContain("Turn #{{ item.modelStep }}");
    expect(runDetailSource).not.toContain("Provider item {{ item.providerItemId }}");
  });

  it("keeps the execution title focused and hands the current Plan revision to the shared drawer", () => {
    expect(flat(runDetailSource)).toContain(flat('class="execution-plan-link"'));
    expect(flat(runDetailSource)).toContain(flat("api.getPlan(currentRun.planId)"));
    expect(flat(runDetailSource)).toContain(flat("api.getPlanRevision(currentRun.planId, currentRun.planRevision)"));
    // 只读这件事现在由**宿主**那份方案面板决定（共享抽屉里那份本来就是只读的），
    // 组件这边不再自带一个 read-only 的抽屉壳。
    expect(flat(runDetailSource)).not.toContain(flat(':read-only="true"'));
    expect(runDetailSource).not.toContain("RUN · {{ run.id }}");
    expect(runDetailSource).not.toContain("EXECUTION THREAD");
    expect(runDetailSource).not.toContain("· <code>{{ run.branch }}</code>");
  });

  it("routes status-card Plan actions and keeps stale Plan drawers isolated", () => {
    expect(flat(runDetailSource)).toContain(flat('@open-plan="openPlanDetail"'));
    expect(flat(runDetailSource)).toContain(flat("function resetPlanDetail()"));
    expect(flat(runDetailSource)).toContain(flat("watch([projectId, runId], () => { resetPlanDetail();"));
    expect(flat(runDetailSource)).toContain(flat("let planDetailRequestToken = 0;"));
  });

  it("keeps the title and Plan in the first column of the two-row header grid", () => {
    expect(flat(runDetailSource)).toContain(flat('class="detail-heading-title"'));
    expect(flat(runDetailSource)).toContain(flat('class="detail-heading-plan"'));
    expect(flat(runDetailSource)).toContain(flat("<h1>执行运行</h1>"));
    expect(flat(runDetailSource)).toContain(flat('class="execution-plan-link"'));
    expect(runDetailSource).not.toContain('class="detail-heading-copy"');
  });

  it("collapses a task group from its heading and separates tasks with a rule instead of a rail", () => {
    // 步骤头本身是折叠开关：整条可点、带 aria-expanded，收起的是这一组的消息。
    expect(flat(runDetailSource)).toContain(flat('<button v-if="group.task" type="button" class="execution-task-stream-heading"'));
    expect(flat(runDetailSource)).toContain(flat(':aria-expanded="!isTaskGroupCollapsed(group.id)"'));
    expect(flat(runDetailSource)).toContain(flat('@click="toggleTaskGroup(group.id)"'));
    expect(flat(runDetailSource)).toContain(flat('class="execution-task-stream-items"'));
    // 从状态卡跳到被收起的步骤时先展开，否则"跳过去"看着像没反应。
    expect(flat(runDetailSource)).toContain(flat("expandTaskGroup(`task-${task.id}`)"));
    // 左边那根竖线不再回来（它把整组往右推 53px）：任务之间用一条横线分段。
    expect(runDetailStyles).not.toMatch(/\.execution-conversation-group-task \{[^}]*border-left/);
    expect(runDetailStyles).toMatch(/\.execution-conversation-group-task[^{]*\{[^}]*border-top: 2px solid/);
  });

  it("projects the frozen Plan Revision as the first conversation message", () => {
    expect(flat(runDetailSource)).toContain(flat("type ExecutionPlanSnapshot"));
    expect(flat(runDetailSource)).toContain(flat("executionPlan.value = executionPlanSnapshot(response.run, revisionResponse.revision)"));
    expect(flat(runDetailSource)).toContain(
      flat(
        'projectExecutionJournal(currentThread?.journal ?? [], currentThread?.state ?? run.value?.status ?? "ACTIVE", executionPlan.value ?? undefined)',
      ),
    );
    expect(flat(executionMessageRowSource)).toContain(flat('<ExecutionPlanCard :item-id="item.id" :plan="item.plan" @view="viewPlan" />'));
    expect(flat(executionPlanCardSource)).toContain(flat('class="execution-plan-message"'));
    expect(flat(executionPlanCardSource)).toContain(flat('class="execution-plan-toggle"'));
    expect(flat(executionPlanCardSource)).toContain(flat("查看方案"));
  });

  it("uses a persistent Explorer-style composer for execution messages", () => {
    expect(flat(useRunComposerSource)).toContain(flat('import { shouldSubmitComposer } from "../utils/composerKeyboard"'));
    expect(flat(useRunComposerSource)).toContain(flat('const executionDraft = ref("")'));
    /**
     * **输入框的可用性判的是 Run 的状态，不是线程的状态。**
     *
     * 这里此前是 `Boolean(thread.value && !["CANCELLED", "COMPLETED"].includes(thread.value.state))`，
     * 而执行一收尾线程就被置成 `COMPLETED`——于是输入框**恰好在最需要它的那一刻**禁用：执行完了、
     * 还没合并、想再让 Agent 补一轮（那次报障就是这个）。线程状态回答的是"上一轮 Loop 还在不在"，
     * Run 状态才回答"这个 Run 还需不需要人说话"。
     */
    expect(flat(useRunComposerSource)).toContain(flat('computed(() => canContinueRun(deps.run.value?.status ?? ""))'));
    expect(useRunComposerSource).not.toContain('!["CANCELLED", "COMPLETED"].includes(thread.value.state)');
    // 一轮还在跑时给「排队 / 引导」两种投递方式；没在跑时两种等价，不由用户选。
    expect(flat(runDetailSource)).toContain(flat("composer-guidance-mode"));
    expect(flat(useRunComposerSource)).toContain(flat('const executionGuidanceMode = ref<"steer" | "queue">("queue")'));
    expect(flat(runDetailSource)).toContain(flat('class="execution-conversation-stage"'));
    expect(flat(runDetailSource)).toContain(flat('class="composer execution-composer"'));
    expect(flat(runDetailSource)).toContain(flat('aria-label="执行会话消息"'));
    // 占位文案随"这一轮在不在跑"变，并且不可用时如实说明原因，而不是只把框灰掉。
    expect(flat(runDetailSource)).toContain(flat("executionComposerDisabledReason"));
    expect(flat(runDetailSource)).toContain(flat('class="composer-mode">Run 模式</span>'));
    expect(flat(runDetailSource)).toContain(flat('@keydown="handleExecutionComposerKeydown"'));
    expect(flat(useRunComposerSource)).toContain(flat("function handleExecutionComposerKeydown(event: KeyboardEvent): void"));
    expect(flat(runDetailSource)).toContain(flat('class="composer-send"'));
    expect(flat(runDetailSource)).toContain(flat('aria-label="发送消息"'));
    expect(flat(runDetailSource)).toContain(flat('context-note="仅结束时由 provider 上报"'));
    expect(runDetailSource).not.toContain("guidanceComposerOpen");
    expect(runDetailSource).not.toContain('class="execution-guidance-shell"');
    expect(runDetailSource).not.toContain("Add guidance");
    expect(runDetailSource).not.toContain("Guidance is read-only");
  });

  describe("Run 不再接受补充要求时，composer 位置上给的是**带入口的提示**", () => {
    /**
     * 实测报障：需求15 的 Run 被取消之后，用户在这个框里点了半天打不出字——框还在，只是发不出去。
     * 一个**按下去没反应**的输入框，比直接把框收走更糟：它默认了"这里还能说话"。
     * 换成提示之后，提示必须自己给出下一步（去探索对话 / 查看方案），否则只是把困惑从
     * "为什么打不出字"挪到"那我该去哪"。
     */
    it("把输入框换成提示，而不是留一个灰掉的框", () => {
      expect(flat(runDetailSource)).toContain(flat('<div v-if="!canSendExecutionMessage" class="composer-closed">'));
      expect(flat(runDetailSource)).toContain(flat('<div v-else class="composer-input">'));
      // 发送键跟着输入框一起收走：提示里那个圆圈按钮点不动，就又是一次"按下去没反应"。
      expect(flat(runDetailSource)).toContain(flat('<div v-if="canSendExecutionMessage" class="composer-footer">'));
      // 原因那句话仍然来自同一个判据（不要在这里另写一套文案对不上号的理由）。
      expect(flat(runDetailSource)).toContain(flat('class="composer-closed-note">{{ executionComposerDisabledReason }}'));
      expect(runDetailStyles).toContain(flat(".composer-closed"));
      expect(runDetailStyles).toContain(flat(".composer-closed-actions"));
    });

    it("提示带两个入口：去探索对话、查看方案", () => {
      // 改计划的两条现成路径，不为此新开接口：探索对话说一句让模型改版，或者进「方案」点「继续编辑」。
      expect(flat(runDetailSource)).toContain(flat('@click="openExplorerConversation">去探索对话</el-button>'));
      expect(flat(runDetailSource)).toContain(flat('@click="openPlanDetail">查看方案</el-button>'));
      // 版本号按当前 Plan 的修订号 +1 说，别写死成 V2。
      expect(flat(runDetailSource)).toContain(flat("run?.planRevision ?? 1"));
    });

    it("「去探索对话」只发事件，不自己跳路由", () => {
      /**
       * 它就在需求抽屉里。自己 `router.push` 会把抽屉连同右侧面板一起换掉，所以只喊一声，
       * 由 `ExplorerView` 把左下的页签切到「探索对话」——那排页签怎么切只有一处知道。
       *
       * **这条判据此前要复杂得多**：整页形态还在的时候，这个组件得自己拼一条带
       * `explorerId` + `explorerPlanId` 的跳转（只带一个会静默落到别人家的需求上），
       * 还得分「内嵌 / 整页」两种。整页退役之后那整套都不需要了——落点归宿主，这里只剩发事件。
       */
      expect(flat(runDetailSource)).toContain(flat("function openExplorerConversation(): void {"));
      expect(flat(runDetailSource)).toContain(flat('emit("open-explorer");'));
      expect(flat(runDetailSource)).not.toContain("explorerEntryQuery");
      expect(runDetailSource).not.toContain("router.push");
    });
  });

  it("把 Run 级活动移出执行会话：时间线只留执行步骤与你说的话", () => {
    // 判据是 "activity 且无 taskId"——不再按事件类型列举，否则每加一种 Run 级事件都要回来补。
    // **但补充轮要排掉**：它的条目同样没有 taskId，却属于「你补的那一轮」那一组，不该被吸进这张卡。
    expect(flat(executionConversationSource)).toContain(flat("export function isRunActivity(item: ExecutionStreamItem): boolean {"));
    expect(flat(executionConversationSource)).toContain(flat('return item.kind === "activity" && !item.taskId && !item.continuation;'));
    // 它们改由顶部 RUN CONTEXT 卡片承载。
    expect(flat(runDetailSource)).toContain(flat(':run-activity="runActivityItems"'));
    // 旧标题与旧说明不再出现：它们把一个常态（Run 的创建 / 钩子 / 验证）写成了异常。
    // 断言的是标题元素本身，不是这四个字——注释里仍会引用旧名说明改了什么。
    expect(runDetailSource).not.toContain("<strong>未关联执行步骤</strong>");
    expect(runDetailSource).not.toContain("此处保留旧 Run 或未提供执行步骤标识的事件。");
    // 归因缺口组换名，模板与样式两侧一起改，不留死样式。
    expect(flat(runDetailSource)).toContain(flat("group.kind === 'unattributed'"));
    expect(flat(runDetailSource)).toContain(flat("未归属事件"));
    expect(runDetailStyles).toContain(flat(".execution-unattributed-heading"));
    expect(runDetailStyles).not.toContain(".execution-unassigned-heading");
    // 你在执行线程里发的消息，**和它起的那一轮一起独立成组**：此前它挂在「未关联执行步骤」下面，
    // 等于把用户自己说的话标成了"没有归属的执行步骤"；再往后又被算进了某个已完成任务的分组里
    // （那正是用户报的"补充内容被放进了最后那个 task"）。现在这一组自己一壳，并在标题上写明它
    // 不属于任何计划任务。
    expect(flat(executionConversationSource)).toContain(flat("const rounds = new Map<number, ExecutionStreamItem[]>();"));
    expect(flat(executionConversationSource)).toContain(
      flat('for (const [index, items] of rounds) groups.push({ id: `continuation-${index}`, kind: "continuation", items });'),
    );
    expect(flat(runDetailSource)).toContain(flat("group.kind === 'continuation'"));
    expect(flat(runDetailSource)).toContain(flat("不属于任何计划任务"));
    expect(runDetailStyles).toContain(flat(".execution-conversation-group-continuation"));
    // 旧的 user 组随这次改动退役（那批条目现在都带 continuation），别留下死样式。
    expect(runDetailStyles).not.toContain(".execution-conversation-group-user");
    // 补充轮的条目已经在它自己那一组里，**不能又被算进「未归属」**——不排就是同一条渲染两次。
    expect(flat(executionConversationSource)).toContain(flat("!item.continuation && !isRunActivity(item)"));
  });

  it("执行过程有阶段感，且呈现方式由一张表统一决定", () => {
    // 四阶段条：回答"现在在干什么、下一步是什么"——此前页面最缺的就是这一句。
    expect(flat(runDetailSource)).toContain(flat('class="execution-phase-strip"'));
    expect(flat(runDetailSource)).toContain(flat("executionPhaseSteps"));
    expect(runDetailStyles).toContain(flat(".execution-phase.current"));
    // **权重不再散在视图里**：视图只问权重表，那张表是那个"消息清单"的唯一落点。
    // 判据本身这一轮搬进了 utils/executionConversation.ts（纯函数 + 可单测），视图只取它算好的结果。
    expect(flat(executionConversationSource)).toContain(
      flat("export function visibleItems(group: ExecutionConversationGroup, threadState: string)"),
    );
    expect(flat(executionConversationSource)).toContain(
      flat("export function foldedItems(group: ExecutionConversationGroup, threadState: string)"),
    );
    expect(flat(executionConversationSource)).toContain(flat("executionMessageWeight(item)"));
    expect(runDetailSource).not.toContain("isActivityNoise");
    expect(runDetailStyles).toContain(flat(".execution-folded-log"));
    expect(runDetailStyles).not.toContain(".execution-activity-noise");
    // 折叠区是"过程记录"，不是"活动噪音"——措辞跟着语义走。
    expect(flat(runDetailSource)).toContain(flat("条过程记录"));
    // 连续的空执行步骤折成一行，只在**连续**时合并（中间夹着有内容的步骤要分开）。
    expect(flat(executionConversationSource)).toContain(flat("function collapsePendingTaskGroups"));
    expect(flat(executionConversationSource)).toContain(flat('group.kind === "task" && group.task && group.items.length === 0'));
    expect(flat(runDetailSource)).toContain(flat("个执行步骤尚未开始"));
  });
});

/**
 * 补充要求让同一个 Run 有了**多条执行 Loop**、并且能从 `MERGE_READY` 回到 `IN_PROGRESS`。
 * 页面有两处当初是按"一个 Run 只有一轮、跑完就结束"写的，两条都在实测里现了形。
 */
describe("Run 详情页对多轮执行的适配", () => {
  it("**取最新的执行 Loop，而不是第一条** —— 否则补充要求开始后页头还停在上一轮的「已完成 1/40 步」", () => {
    // `.find((loop) => loop.role === "executor")` 会永远返回第一轮；这里必须按 startedAt 取最新。
    expect(flat(runDetailSource)).toContain(flat('const loops = (run.value?.agentLoops ?? []).filter((loop) => loop.role === "executor")'));
    expect(flat(runDetailSource)).toContain(flat('(loop.startedAt ?? "") >= (latest.startedAt ?? "")'));
    expect(flat(runDetailSource)).not.toContain(flat('agentLoops?.find((loop) => loop.role === "executor")'));
  });

  it("**`MERGE_READY` 不再关事件流** —— 它现在可以被补充要求推回 `IN_PROGRESS` 再跑一轮", () => {
    // 在 MERGE_READY 关流，页面就再也收不到那之后的事件：用户看到的是「已完成 / 等待合并」一动不动，
    // 直到手动刷新（实测症状）。真正终结的只有取消与合并。
    // 判据这一轮收成了**一处常量**（建连与收流两处共用），值仍然只有这三个。
    expect(flat(runControlsSource)).toContain(
      flat('export const RUN_STREAM_TERMINAL_STATUSES: readonly string[] = ["BLOCKED", "CANCELLED", "MERGED"];'),
    );
    expect(runControlsSource).not.toContain('"MERGE_READY", "MERGED"');
    expect(flat(useRunStreamSource)).toContain(flat("RUN_STREAM_TERMINAL_STATUSES.includes(event.runStatus)"));
    expect(flat(useRunStreamSource)).toContain(flat("RUN_STREAM_TERMINAL_STATUSES.includes(run.status)"));
  });

  /**
   * 终止 Run 的确认框换成了共用的 `ConfirmDialog`（与删除需求同一份骨架）。
   *
   * 与它一起改掉的还有两处：**确认与执行分家**（点终止只开框，真终止在 `confirmTerminateRun`），
   * 以及那句一直是英文的文案（"Terminate this run? …"）——这个页面上别处都是中文。
   * 没有活着的 Run 时点不到这颗按钮，所以这里用源码断言钉住接线（本文件一直是这个风格）。
   */
  it("终止走共用确认框：只负责问、文案是中文、失败留在框里", () => {
    // 「开框」与「真终止」分家这件事现在在 useRunControl 里，所以那一段从那边读。
    // 收尾的 `}` 允许有缩进——它现在住在 `useRunControl` 里面，不再是文件顶层函数。
    const open = useRunControlSource.match(/function terminateRun\(\): void \{[\s\S]*?\n\s*\}/)?.[0] ?? "";
    expect(open).not.toBe("");
    expect(flat(open)).toContain(flat("terminateOpen.value = true;"));
    expect(flat(open)).not.toContain(flat("api.cancelRun"));

    expect(flat(useRunControlSource)).toContain(flat("async function confirmTerminateRun(): Promise<void>"));
    expect(flat(useRunControlSource)).toContain(flat("terminateError.value ="));
    expect(flat(useRunControlSource)).not.toContain(flat("ElMessageBox"));
    expect(flat(runDetailSource)).not.toContain(flat("ElMessageBox"));

    // 只看那个组件块：文案是不是中文、接线对不对，都在这一段里。
    // （不整文件搜"Terminate"——`canTerminateRun` / `confirmTerminateRun` 这两个**函数名**里就有它，
    //   负向断言会被自己绊倒；正面断言中文文案才是这条用例想证的事。）
    const confirmBlock = runDetailSource.slice(runDetailSource.indexOf("<ConfirmDialog"));
    expect(flat(confirmBlock)).toContain(flat('heading="终止 Run"'));
    expect(flat(confirmBlock)).toContain(flat("终止后这次执行就停在这里"));
    expect(flat(confirmBlock)).toContain(flat('cancel-label="继续运行"'));
    expect(flat(confirmBlock)).toContain(flat('@confirm="confirmTerminateRun"'));
    expect(flat(confirmBlock)).toContain(flat(':error="terminateError"'));
  });
});
