# Explorer 状态栏视觉 QA

- 日期：2026-08-29
- 源图：`/var/folders/d9/nl_fdkks6t1dsrdyvshyqjr00000gp/T/codex-clipboard-d32abf6d-84c6-445e-b651-96267d9c3b8c.png`
- 实现截图：`/Users/Bill/Project/ai-tools/codex-workflow/design-qa/explorer-status-bar.png`
- 验证页面：`http://localhost:5173/projects/project-demo/explorer`
- 实现视口：983 × 720 CSS px

## 对比结论

状态栏位于 composer 底部，保留原有 Plan Mode 和发送按钮，并在同一行展示当前模型、上下文估算值和 `STATUS` 用量入口。点击入口后显示深色 Codex 风格面板，包含模型、会话/对话串、背景信息、5 小时限额和 7 天限额；当前服务未提供速率限制遥测，因此明确显示不可用，不伪造百分比。

## QA 记录

- [x] 页面可加载并显示状态栏
- [x] `MODEL`、`CONTEXT`、`STATUS` 三组信息可见
- [x] 点击 `STATUS` 可打开 Codex 用量状态面板
- [x] 会话 ID 和上下文估算值可见
- [x] 缺少速率限制数据时显示 `Unavailable / Not provided`
- [x] 桌面视口下未遮挡输入框和发送按钮
- [x] 保留 Plan Mode 入口与现有 composer 结构

final result: passed
