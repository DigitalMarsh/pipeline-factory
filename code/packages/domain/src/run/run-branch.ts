import type { ModelGateway } from "../index.js";

const RUN_BRANCH_PREFIX = "factory";
const FALLBACK_RUN_BRANCH_SLUG = "change";
const MAX_SUMMARY_WORDS = 4;
const RUN_BRANCH_GENERATION_TIMEOUT_MS = 30_000;
const RUN_BRANCH_SUMMARY_PROMPT = `
Generate a short English Git branch summary for the requested software change.
Return only 2 to 4 lowercase ASCII words separated by spaces.
Do not include a date, branch prefix, punctuation, Markdown, explanation, or quotes.

Plan title:
<plan-title>
{{PLAN_TITLE}}
</plan-title>

Plan goal:
<plan-goal>
{{PLAN_GOAL}}
</plan-goal>
`;

export type RunBranchNameInput = {
  createdAt: string;
  planTitle: string;
  goal: string;
};

export type RunBranchNameGenerator = {
  generate(input: RunBranchNameInput): Promise<string>;
};

/**
 * Format a Run's creation time — **到秒**——in the user's configured Shanghai business timezone.
 *
 * 为什么是"日期+时间"而不是只到天：这个戳是分支名（也是 worktree 目录名）的一部分，而分支名撞了
 * 就直接把 Run 打成 BLOCKED（`git worktree add -b` 拒绝已存在的分支）。只到天的话，
 * **同一天里标题相近的两次 Run 会拿到同一个 slug**，实测就撞过。秒级把撞名窗口压到"同一秒内
 * 同一个 slug"，剩下的交给 `allocateRunBranchLeaf`。
 *
 * 时区是产品口径（Asia/Shanghai），不是运行机器的本地时区——分支名不该随开发机漂移。
 */
export function runBranchStamp(createdAt: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    // 只写 `hour12: false` 在部分 ICU 版本上会把午夜给成 `24`；`h23` 才是"00…23"。
    hourCycle: "h23",
  }).formatToParts(new Date(createdAt));
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${value("year")}${value("month")}${value("day")}-${value("hour")}${value("minute")}${value("second")}`;
}

/** Convert model output into a bounded Git-safe English slug. */
export function normalizeRunBranchSlug(value: string): string | null {
  const normalized = value
    .trim()
    .replace(/^```(?:text|markdown)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/^["'“‘「『]+|["'”’」』]+$/gu, "")
    .normalize("NFKD")
    // 有意匹配控制字符：这一行的目的就是**把所有非 ASCII 字符换成空格**再走 slug 化，
    // `\x00-\x7F` 是"可打印 ASCII 的全集"这个意图最直白的写法（写成 ` -~` 反而看不出这层意思）。
    // eslint-disable-next-line no-control-regex -- 见上
    .replace(/[^\x00-\x7F]+/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const words = normalized.split("-").filter(Boolean).slice(0, MAX_SUMMARY_WORDS);
  return words.length ? words.join("-") : null;
}

export function composeRunBranchLeaf(createdAt: string, summary: string): string {
  return `${runBranchStamp(createdAt)}-${normalizeRunBranchSlug(summary) ?? FALLBACK_RUN_BRANCH_SLUG}`;
}

export function runBranchName(leaf: string): string {
  return `${RUN_BRANCH_PREFIX}/${leaf}`;
}

/**
 * Reserve a readable leaf against **persisted Run branches** without changing history.
 *
 * 二级防线，不是主防线：主防线是叶子里的秒级时间戳（见 `runBranchStamp`）。这里对付的是
 * "同一秒、同一个 slug"那种真正的同时撞。
 *
 * **它的输入是"库里还记着的 Run 分支"，不是仓库里真实存在的分支。** 两者会分家——删掉 Run 行之后，
 * 它建过的分支还在仓库里，而这里已经不知道了（实测撞过一次：仓库里有同名分支 + 同名 worktree 目录，
 * 库里那条 Run 早被删了）。真要堵这条路得去问 git（`git branch --list`），但那要给 WorkspaceAdapter
 * 加一个方法、十二处测试桩跟着改——秒级时间戳之后这条路的收益已经很小，先不做。
 */
export function allocateRunBranchLeaf(baseLeaf: string, existingBranches: readonly string[]): string {
  const occupied = new Set(existingBranches);
  if (!occupied.has(runBranchName(baseLeaf))) return baseLeaf;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${baseLeaf}-${suffix}`;
    if (!occupied.has(runBranchName(candidate))) return candidate;
  }
}

/** Generate the summary with the existing Explorer model role and title transport. */
export class ModelRunBranchNameGenerator implements RunBranchNameGenerator {
  constructor(private readonly model: ModelGateway) {}

  async generate(input: RunBranchNameInput): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RUN_BRANCH_GENERATION_TIMEOUT_MS);
    let text = "";
    try {
      for await (const event of this.model.stream({
        role: "explorer",
        purpose: "title",
        // 与起标题同理：借用 explorer 角色的命名调用必须是 default 模式，不能继承探索的 plan 语义。
        mode: "default",
        conversationId: `run-branch-${input.createdAt}`,
        messages: [
          {
            role: "user",
            content: RUN_BRANCH_SUMMARY_PROMPT.replace("{{PLAN_TITLE}}", input.planTitle).replace("{{PLAN_GOAL}}", input.goal),
          },
        ],
        signal: controller.signal,
      })) {
        if (event.type === "text.delta") text += event.text;
        if (event.type === "turn.failed") throw new Error(event.error);
        if (event.type === "turn.cancelled") throw new Error("Run branch summary generation cancelled");
      }
    } finally {
      clearTimeout(timeout);
    }
    const normalized = normalizeRunBranchSlug(text);
    if (!normalized) throw new Error("Run branch summary model returned an invalid slug");
    return normalized;
  }
}
