/**
 * 测试职责：确保审计事件、Hook 输出和输入摘要不会把秘密或个人信息原文写入持久化事实。
 */
import { describe, expect, it } from "vitest";
import { redactAuditPayload } from "./redaction.js";

describe("redactAuditPayload", () => {
  it("redacts secret-shaped fields recursively while preserving operational facts", () => {
    const value = redactAuditPayload({
      status: "failed",
      attempts: 2,
      apiToken: "secret-token",
      authorization: "Bearer abc123",
      nested: { cookie: "session=private", email: "person@example.com", count: 1 },
      messages: ["normal output", "token=hidden-value"],
    });

    expect(value).toMatchObject({ status: "failed", attempts: 2, nested: { count: 1 }, messages: ["normal output", "token=[REDACTED]"] });
    expect(JSON.stringify(value)).not.toContain("secret-token");
    expect(JSON.stringify(value)).not.toContain("person@example.com");
    expect(JSON.stringify(value)).not.toContain("hidden-value");
  });
});
