# Explorer 聊天区视觉验收

参考截图：

- `/var/folders/d9/nl_fdkks6t1dsrdyvshyqjr00000gp/T/codex-clipboard-91995df5-caa5-4cc8-9951-94f09cc98536.png`
- `/var/folders/d9/nl_fdkks6t1dsrdyvshyqjr00000gp/T/codex-clipboard-223d3a29-42d1-4fe5-bbd0-825b199469ea.png`
- `/var/folders/d9/nl_fdkks6t1dsrdyvshyqjr00000gp/T/codex-clipboard-04e17ff5-c53f-4de9-9048-55f954ec80fc.png`
- `/var/folders/d9/nl_fdkks6t1dsrdyvshyqjr00000gp/T/codex-clipboard-5cce595b-4f52-4b30-928c-f49db30ea99c.png`
- `/var/folders/d9/nl_fdkks6t1dsrdyvshyqjr00000gp/T/codex-clipboard-9239b745-a144-4701-a1c9-38b467f14662.png`

测试环境：Chrome 中运行的 Pipeline Factory，Explorer 页面桌面视口，保留 Plan Center/Plans 区域。

## 视觉与交互检查

- 独立的 `MESSAGES` 文字型左侧时间线已替换为浮动的紧凑消息索引轨道；轨道不参与布局、不占用聊天列宽度，仅显示短横线，不常驻显示标题、计数、时间或类型文字。
- 消息索引轨道绝对定位在聊天时间线左边缘，不参与聊天内容滚动；桌面浮层宽度 32px，小屏收窄为 28px，聊天内容保持原有可用宽度。
- 消息索引标记具备 hover、键盘 focus 和 active 状态；原生 `title` 与 `aria-label` 提供时间及消息/提问/回答信息。
- 用户消息默认以 Codex Desktop 风格的标题、摘要和展开入口呈现；展开后完整 Markdown 原文可见。
- 用户消息入口具备语义化按钮、`aria-expanded`、可见焦点态；鼠标点击和 Space 键均可切换展开状态。
- 点击消息索引标记、Enter 或 Space 均可定位到对应消息；当前消息 active 标记随时间线滚动更新。
- 切换 Explorer 线程后，用户消息展开状态和消息索引 active 状态被清空并恢复默认状态。
- assistant 活动、流式/失败状态、Plan 卡片和底部 composer 保持可见且未改变交互。
- 最新消息提示按钮保持位于聊天时间线水平居中位置；点击后滚动到最新内容并隐藏按钮。
- 窄视口下消息索引不挤压或遮挡聊天内容，composer 保持固定可见。
- 右侧 Plans 导航点击后仍能定位到对应 Plan 卡片。

## 自动化检查

- Chrome 现场截图（CUA）：当前桌面视口中，透明浮动 marker-only 轨道贴在聊天区左侧；点击消息标记后可定位，Space/Enter 可触发定位，active 标记保持蓝色高亮；内联用户卡片、Plans 和 composer 均保持可见。
- `pnpm --dir code --filter @pipeline-factory/web test`：43 个测试文件、217 个测试通过。
- `pnpm --dir code --filter @pipeline-factory/web typecheck`：通过。
- `pnpm --dir code --filter @pipeline-factory/web build`：通过；仅保留既有 chunk size warning。
- `git diff --check`：通过。

final result: passed
