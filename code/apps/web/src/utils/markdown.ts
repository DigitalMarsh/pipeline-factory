/**
 * 模块职责：提供 Pipeline Factory Web 层的类型、请求或状态辅助能力。
 *
 * 维护提示：本文件的公共契约或关键状态约束变化时，应同步更新说明。
 */
import createDOMPurify, { type DOMPurify } from "dompurify";
import { marked } from "marked";

/** 消息中一律移除的高风险标签；input 只保留只读 checkbox 以支持 GFM 任务列表。 */
const FORBIDDEN_TAGS = ["script", "iframe", "form", "img", "video", "audio", "style", "object", "embed", "link", "meta", "base"];

const MARKDOWN_OPTIONS = { gfm: true, breaks: true, async: false } as const;

let purifier: DOMPurify | null = null;

function getPurifier(): DOMPurify {
  if (purifier) return purifier;
  const instance = createDOMPurify(window);
  // 外链统一新窗口打开并断开 opener；非 checkbox 的 input 一律移除，checkbox 强制只读。
  instance.addHook("afterSanitizeAttributes", (node) => {
    if (node.nodeName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
      return;
    }
    if (node.nodeName !== "INPUT") return;
    if (node.getAttribute("type") !== "checkbox") {
      node.parentNode?.removeChild(node);
      return;
    }
    node.setAttribute("disabled", "disabled");
  });
  purifier = instance;
  return instance;
}

/**
 * 把模型返回的 Markdown 渲染为可安全插入的 HTML。
 * marked 关闭原始 HTML，输出再经 DOMPurify 消毒，因此消息里的脚本、事件属性、图片与危险链接不会落地。
 */
export function renderMarkdown(source: string): string {
  if (!source) return "";
  const html = marked.parse(source, MARKDOWN_OPTIONS) as string;
  return getPurifier().sanitize(html, { FORBID_TAGS: FORBIDDEN_TAGS });
}
