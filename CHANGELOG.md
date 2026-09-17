# Changelog

## [Unreleased] - 2026-09-17

### Added

- ExplorerThread 支持一等 ExplorerPlan 分区：默认 Plan 1、Plan 级消息/活动/候选方案隔离，所有 Plan 复用同一 Provider Thread 与完整会话上下文。
- 增加同一 ExplorerThread 下多个 ExplorerPlan 的持久化 FIFO 后台队列、运行状态、重启恢复和线程级上下文摘要。
- 增加 ExplorerPlan 分组、创建、重命名、激活和 workspace API；turn、activity、input request、Agent Loop、candidate Plan 和 revision draft 均支持按 ExplorerPlan 隔离。
- 将聊天区消息快捷入口改为 Task → Plan 树：Task 节点支持展开/收起、运行状态和新建 Task，子 Plan 可定位到时间线；Plan 卡片也可反向定位对应 Task。
- 为 Explorer 增加标题栏状态摘要组件，集中展示需求契约、Provider Loop 和探索进度；支持点击查看详情、键盘操作，以及在 Provider Loop 详情中暂停/恢复循环。
- 将计划中心入口加入左侧主导航并显示计划数量；保留右侧上下文面板中的候选、已确认、已入队、已派发、运行中和待处理分区。
- 将用户消息改为可折叠的标题/摘要卡片，展开后查看完整 Markdown；新增消息摘要工具及对应测试。
- 将聊天区消息时间线改为窄型浮动标记轨道，支持 hover、focus、active 状态和消息定位；最新消息按钮改为水平居中。

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

### Tests and documentation

- 新增 `ExplorerHeaderStatus`、用户消息摘要和相关交互覆盖；同步更新 Explorer、ThreadRail、计划需求和 Project 模型迁移测试。
- 新增 `design-qa.md`，记录 Explorer 聊天区视觉/交互验收结果和现场截图依据。
- 修正 ThreadRail 样式断言，使测试与当前三列 Grid 项目上下文布局一致。
- 新增 `taskTree.ts` 及测试，覆盖 Task 排序、Plan 归属、去重、未归属 Plan 隔离、展示术语和时间线定位目标。
- 扩展 Explorer domain/API 测试，覆盖默认 Plan 1、多 Plan FIFO 与共享 Provider Thread、跨项目 workspace 拒绝和无效 Plan turn 拒绝；同步记录探索流程设计文档和待办事项。

### Verification

- `pnpm --dir code test`：81 个测试文件、469 个测试通过（domain 35/206、web 44/221、API 2/42）。
- `pnpm --dir code typecheck`：domain、web、API 均通过。
- `pnpm --dir code build`：domain、web、API 均通过；仅有既有的 chunk size warning。
- API smoke check：health、Project、Explorer、ExplorerPlan、workspace 和 Plan endpoints 均返回成功；跨项目访问按预期拒绝。
- `git diff --check`：通过。
- 浏览器可视化验收尚未完成：当前桌面浏览器自动化通道不可用，因此不能将截图级布局检查宣称为已通过。
