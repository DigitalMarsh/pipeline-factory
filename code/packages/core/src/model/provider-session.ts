/**
 * 模块职责：Provider-controlled 后端（codex-app-server、claude-agent-sdk）共用的两个纯函数 ——
 *   本次调用的模式解析，以及会话重建时的本地历史回放。
 *
 * 为什么单独一个叶子文件：这两件事此前分别以"按角色硬编码 plan"和"只发最新一条用户消息"的形态
 *   散在两个实现里，于是同一份语义有两套写法、其中一套还是错的（config 里的 roleConfig.mode 从没
 *   被读过）。放在一处之后，"配置 / 请求 / 角色默认"三者的优先级只有一个定义。
 *
 * 维护提示：
 *   1) **优先级是 请求 > 角色配置 > 按角色默认**。按角色默认这一层保留是为了兼容没写 mode 的旧配置；
 *      新代码请显式配置，不要依赖它。
 *   2) replayConversation 是**会话丢失后的兜底**，不是常规路径：常规续接只发最新一条用户消息，
 *      历史由 Provider 自己的 thread/session 持有。重建时把整段对话塞进一条用户消息是有损的
 *      （没有工具调用细节），但比丢失全部上下文好得多。
 *   3) 这里不 import 任何实现模块，只依赖 types.js 的类型 —— 保持 type-only 叶子，避免制造值级环。
 */
import type { ModelImagePart, ModelMessage, ModelMode, ModelRoleConfig } from "./types.js";

/** 解析本次调用的模式：请求级覆盖优先，其次角色配置，最后按角色取默认。 */
export function resolveModelMode(
  request: { role: "explorer" | "executor"; mode?: ModelMode | undefined },
  roleConfig: ModelRoleConfig,
): ModelMode {
  return request.mode ?? roleConfig.mode ?? (request.role === "explorer" ? "plan" : "default");
}

/** 会话丢失后把本地持久化的完整对话压成一条提示，供重建的新会话接着做。 */
export function replayConversation(messages: ModelMessage[]): string {
  const transcript = messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      const header = `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`;
      // 回放是一条纯文本提示，图片本身没法重新挂上去；把落盘路径写进去，让有读文件能力的
      // 后端仍能自己打开看（Codex / Claude 都有读取工具），而不是让用户以为图丢了。
      return message.images?.length ? `${header}\n[attached images: ${message.images.map((image) => image.path).join(", ")}]` : header;
    })
    .join("\n\n");
  if (!transcript) return "Continue.";
  return `Our conversation so far (replayed because the provider session was lost):\n\n${transcript}\n\nContinue from this point.`;
}

/** 最新一条用户消息的正文；没有用户消息时退到最后一条，再没有就是 "Continue."。 */
export function latestUserMessage(messages: ModelMessage[]): string {
  return [...messages].reverse().find((message) => message.role === "user")?.content ?? messages.at(-1)?.content ?? "Continue.";
}

/** 最新一条用户消息随带的图片（常规续接路径上要原生发给 Provider 的那几张）。 */
export function latestUserImages(messages: ModelMessage[]): ModelImagePart[] {
  return [...messages].reverse().find((message) => message.role === "user")?.images ?? [];
}
