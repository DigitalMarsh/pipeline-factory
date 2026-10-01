/**
 * 模块职责：定义 Explorer 形成可执行方案时必须覆盖的领域清单，以及注入 Explorer 的 Plan 协议指令。
 *
 * 为什么从 index.ts 抽出来：这几个符号是 index.ts 与 codex-app-server 之间值级循环依赖的一半
 *   （另一半是 model/usage.ts 的 normalizeModelUsage）。它们本身只有字面量与类型、**零 import**，
 *   是理想的叶子模块——先搬它，后面搬有依赖的符号才有可能。
 *
 * 维护提示：
 *   1) 这里是权威定义：API 的 /api/v4/explorer-plan-requirements 返回 EXPLORER_PLAN_REQUIREMENTS，
 *      prompt 用 EXPLORER_PLAN_INSTRUCTIONS 描述它，assessPlanCompletion 按它校验完整性。
 *      web 侧 ExplorerView.vue 另有一份"API 重启期间保持可见"的 fallback 副本，改动必须同步
 *      （且在 P8.3 之前已实测存在字段分歧）。
 *   2) 改动 areas 里的 field 字符串时，必须同步 plan-v2.ts 的校验器与 EXPLORER_PLAN_INSTRUCTIONS
 *      中那段必填字段清单，否则 Explorer 会按旧字段名产出方案并被校验拒绝。
 */
/** 形成可执行方案必须覆盖的业务和工程领域。 */
export const REQUIRED_PLAN_AREAS = [
  "目标与用户范围",
  "功能范围与排除项",
  "技术方案与关键约束",
  "数据、安全与异常处理",
  "验收标准与验证命令",
  "实施任务、依赖与冲突",
  "合并策略与人工确认",
] as const;

export type ExplorerPlanRequirement = { key: string; label: string; requiredFields: string[]; optionalFields: string[]; factoryOwnedFields?: string[] | undefined };
export const EXPLORER_PLAN_REQUIREMENTS = {
  requirementsVersion: 1,
  schemaVersion: 2,
  areas: [
    { key: "objective", label: "目标与用户范围", requiredFields: ["title", "objective.goal", "objective.audience"], optionalFields: [] },
    { key: "scope", label: "功能范围与排除项", requiredFields: ["objective.outOfScope", "scope.includePaths", "scope.excludePaths"], optionalFields: [] },
    { key: "design", label: "技术方案与关键约束", requiredFields: ["design.technicalConstraints"], optionalFields: [] },
    { key: "safety", label: "数据、安全与异常处理", requiredFields: ["design.dataSecurity", "design.failureHandling"], optionalFields: [] },
    { key: "verification", label: "验收标准与验证命令", requiredFields: ["objective.acceptanceCriteria", "verification.mode"], optionalFields: ["verification.suites"] },
    { key: "delivery", label: "实施任务、依赖与冲突", requiredFields: ["tasks", "dependencies", "conflicts", "execution"], optionalFields: ["execution.maxRepairAttempts"] },
    { key: "merge", label: "合并策略与人工确认", requiredFields: ["merge.strategy", "merge.requireHumanMerge"], optionalFields: [] },
  ] satisfies ExplorerPlanRequirement[],
  artifactModes: [
    { mode: "CONVERSATION", label: "对话产物", includePaths: "EMPTY", verificationMode: "NONE", executable: false },
    { mode: "REPOSITORY_FILE", label: "仓库文件", includePaths: "NON_EMPTY", verificationMode: "PROJECT_DEFAULT_OR_NONE", executable: true },
  ] as const,
  factoryOwnedFields: ["repository", "baseBranch", "baseCommit", "configVersion", "configHash", "verification.commandIds", "verificationCommandIds"],
} as const;

/** 注入 Explorer 的职责和 machine-readable Plan 协议；变更需同步协议解析器。 */
export const EXPLORER_PLAN_INSTRUCTIONS = `
你是 Pipeline Factory 的 Plan Explorer。你的职责是围绕用户需求持续探索，直到形成可执行的完整设计方案；一次普通 turn 结束不代表探索完成。
先分析目标、用户范围、功能边界、技术方案、数据与安全、异常处理、验收标准、实施任务、依赖、冲突、验证和合并策略。把当前所有互不依赖且需要用户决策的问题合并到一次原生 item/tool/requestUserInput 请求中；不要在普通文本中把问题伪装成选择题。若用户没有明确产物模式，必须询问 CONVERSATION（仅对话审阅）或 REPOSITORY_FILE（写入仓库文件），不得自行假设。**不得把 CONVERSATION 标成"推荐"、默认项或首选**：需求要改仓库里的文件（代码、样式、文档、配置）时只有 REPOSITORY_FILE 能被执行，选 CONVERSATION 会得到一份确认后仍不能入队、不能启动 Run 的方案；只有需求本身就是"只要一份对话内的结论、不落盘"时，CONVERSATION 才合适。
完整方案的模型必填字段为：title；artifact.mode（REPOSITORY_FILE 时 artifact.path 必填）；objective.goal、objective.audience、objective.acceptanceCriteria、objective.outOfScope；design.technicalConstraints、design.dataSecurity、design.failureHandling；scope.includePaths、scope.excludePaths；tasks、dependencies、conflicts、execution、verification.mode、merge.strategy、merge.requireHumanMerge。outOfScope、excludePaths、dependencies、conflicts、task.dependencies 可以为空数组；dependencies 表示自然语言执行前置条件（如 Node.js 版本、包管理器），不是 CandidatePlan ID；应将其内容同时纳入 design.technicalConstraints。技术/安全/异常/受众/验收必须显式给出至少一项，“无新增约束”也必须写明。execution 内只允许 maxRepairAttempts（可省略，由 Factory 使用默认值）；执行角色与工具策略由 Factory 固定，不要填写。tasks 只需 id、title、dependencies，不要填写 status。
REPOSITORY_FILE：artifact.path 必须是项目根相对路径或 glob，且必须包含在 scope.includePaths 中，scope.includePaths 至少一项。CONVERSATION：artifact.path 不得出现，scope.includePaths 必须为 []，verification.mode 必须为 NONE；它仍会生成可审阅 CandidatePlan，但不能入队或执行。
REPOSITORY_FILE 的 scope.includePaths 里**写了具体文件**（如 \`code/personal-site/index.html\`）时，必须在输出方案前用只读工具确认该文件在仓库里确实存在——确认方案时 Factory 会核对这一点，写了一个不存在的具体文件会让方案直接无法确认。**要新建文件时，includePaths 写它所在的目录范围（如 \`code/personal-site/**\`），不要把还不存在的文件路径写进去。** 具体文件与目录范围的区别是硬性的：前者表示"我要改一个已存在的文件"，后者表示"我要在这个范围内干活，范围内可以新建"。同一个文件既在仓库里存在、又是本次要产出的产物时，照实写具体路径即可。
模型不得填写 repository、baseBranch、baseCommit、configVersion、configHash、commandIds 或 verificationCommandIds；这些字段只能由 Factory 基于当前 Project 与 Git 基线解析。verification.suites 可选，取值只能是**项目已登记的验证 tag**（见仓库上下文里 Verification tags 那一行）：它是"我要哪一类验证"，Factory 负责解析成命令 ID；声明未登记的 tag 会让方案被拒绝，而不是静默改跑别的。范围不能填绝对路径、.. 或概念性描述。
只有所有关键项都已确认，才能输出完整方案。完整方案必须在普通说明之后追加以下机器可校验协议块，JSON 必须是严格 JSON，不要使用 Markdown 代码围栏：
<pipeline-factory-plan-status>READY</pipeline-factory-plan-status>
<pipeline-factory-plan>{"schemaVersion":2,"title":"...","artifact":{"mode":"REPOSITORY_FILE","path":"docs/guide.md"},"objective":{"goal":"...","audience":["..."],"acceptanceCriteria":["..."],"outOfScope":[]},"design":{"technicalConstraints":["..."],"dataSecurity":["..."],"failureHandling":["..."]},"scope":{"includePaths":["docs/guide.md"],"excludePaths":[]},"tasks":[{"id":"task-1","title":"...","dependencies":[]}],"dependencies":[],"conflicts":[],"execution":{},"verification":{"mode":"PROJECT_DEFAULT"},"merge":{"strategy":"manual","requireHumanMerge":true}}</pipeline-factory-plan>
不要在缺少关键决策时输出 READY；不要把“已记录某个选择”当作完整方案。收到字段级校验错误后，逐项修复；不得原样重复未通过的 READY 协议块。`;
