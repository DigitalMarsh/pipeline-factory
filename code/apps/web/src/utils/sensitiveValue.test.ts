/**
 * 测试职责：钉住展示边界的脱敏与截断——以及它与领域侧 `platform/redaction.ts` 的镜像关系。
 *
 * 为什么需要这个文件：`utils/sensitiveValue.ts` 是 web 侧唯一一处"把原始载荷变成可展示文本"的
 *   地方，规则改错一次就是一次泄漏或者一次误伤正文。另外它与领域侧的 `redactAuditText` 是
 *   一对镜像（web 不能运行时依赖领域层），两边漂移会让"同一个值在库里被抹掉、在页面上露出来"。
 */
import { describe, expect, it } from "vitest";
import { redactAuditText } from "@pipeline-factory/domain";
import { presentableText, presentableValue, redactSensitiveValue, truncateForDisplay } from "./sensitiveValue";

/** 有代表性的样例：两边必须给出同一个结论。 */
const SAMPLES = [
  "curl -H 'Authorization: Bearer sk-abc123' https://api.example.com",
  "TOKEN=ghp_deadbeefdeadbeef pnpm run deploy",
  "api_key: 3f2a1b",
  "cookie=session%3Dabc",
  "联系 alice@example.com 复核",
  "password = hunter2",
  "pnpm --filter @pipeline-factory/web test",
  "读取 src/App.vue 并在 100ms 内完成——这行没有敏感值。",
  "修订说明：token: 见附件",
];

describe("展示边界的脱敏", () => {
  it.each(SAMPLES)("%s", (sample) => {
    expect(redactSensitiveValue(sample)).toBe(redactAuditText(sample));
  });

  it("**保住键名、抹掉值** —— 「这里有令牌」是有用的事实，「令牌是什么」不是", () => {
    const redacted = redactSensitiveValue("TOKEN=ghp_deadbeef pnpm run deploy");
    expect(redacted).toContain("TOKEN=");
    expect(redacted).not.toContain("ghp_deadbeef");
    expect(redacted).toContain("[REDACTED]");
  });

  it("普通正文一个字都不动（脱敏不能误伤内容）", () => {
    const plain = "读取 src/App.vue 并在 100ms 内完成——这行没有敏感值。";
    expect(redactSensitiveValue(plain)).toBe(plain);
  });
});

describe("推理正文（与工具结果走同一个口）", () => {
  it("模型复述出的凭据同样会被抹掉", () => {
    // 模型可能把它读到的令牌、邮箱原样写进推理里——推理正文从 240 放到 2000 之后尤其值得挡一道。
    const reasoning = "I read config.js and it contains api_key: sk-live-9f2a, so I will avoid printing it. Ops contact is ops@example.com.";
    const shown = presentableText(reasoning);

    expect(shown).not.toContain("sk-live-9f2a");
    expect(shown).not.toContain("ops@example.com");
    // 保住键名：读的人仍要知道"那里有个 api_key"。
    expect(shown).toContain("api_key:");
    expect(shown).toContain("I read config.js");
  });

  it("普通推理一个字都不动（脱敏不误伤内容）", () => {
    const plain = "The README currently has a title and one line of description, so I will append a new section.";
    expect(presentableText(plain)).toBe(plain);
  });
});

describe("展示边界的截断", () => {
  it("够短就原样，超长才截，而且**如实说明截了多少**", () => {
    expect(truncateForDisplay("短", 10)).toBe("短");

    const long = "x".repeat(25);
    const truncated = truncateForDisplay(long, 10);
    expect(truncated.startsWith("x".repeat(10))).toBe(true);
    // "这里还有下文"与"这就是全部"是两件事，得说清楚。
    expect(truncated).toContain("共 25 字");
  });

  it("**先脱敏再截断** —— 反过来会把半个令牌与半个正文拼成规则认不出的东西", () => {
    // 令牌横跨截断点：先截断，第二段就只剩半截，正则再也认不出来。
    const text = `${"a".repeat(6)} TOKEN=ghp_secretvalue tail`;
    const result = presentableText(text, 12);
    expect(result).not.toContain("ghp_secretvalue");
  });
});

describe("结构化值变成可展示的一段文本", () => {
  it("对象走 JSON、缩进两格；空对象不算有内容", () => {
    expect(presentableValue({ command: "pnpm test" })).toBe('{\n  "command": "pnpm test"\n}');
    expect(presentableValue({})).toBeNull();
    expect(presentableValue([])).toBeNull();
    expect(presentableValue(undefined)).toBeNull();
    expect(presentableValue("   ")).toBeNull();
  });

  it("脱敏对结构化值同样生效", () => {
    expect(presentableValue({ authorization: "Bearer sk-live-1" })).not.toContain("sk-live-1");
  });
});
