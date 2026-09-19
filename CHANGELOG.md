# Changelog

## [Unreleased] - 2026-09-19

### Added

- ExplorerThread 支持一等 ExplorerPlan 分区：默认 Plan 1、Plan 级消息/活动/候选方案隔离，所有 Plan 复用同一 Provider Thread 与完整会话上下文。
- 增加同一 ExplorerThread 下多个 ExplorerPlan 的持久化 FIFO 后台队列、运行状态、重启恢复和线程级上下文摘要。
- 增加 ExplorerPlan 分组、创建、重命名、激活和 workspace API；turn、activity、input request、Agent Loop、candidate Plan 和 revision draft 均支持按 ExplorerPlan 隔离。
- 将聊天区消息快捷入口改为 Element Plus Tree：Explorer Thread 作为根节点，Task 和 Plan 默认展开，子 Plan 可定位到时间线；Plan 卡片也可反向定位对应 Task。
- 为 Explorer 增加标题栏状态摘要组件，集中展示需求契约、Provider Loop 和探索进度；支持点击查看详情、键盘操作，以及在 Provider Loop 详情中暂停/恢复循环。
- 将计划中心入口加入左侧主导航并显示计划数量；保留右侧上下文面板中的候选、已确认、已入队、已派发、运行中和待处理分区。
- 将用户消息改为可折叠的标题/摘要卡片，展开后查看完整 Markdown；新增消息摘要工具及对应测试。
- 将聊天区消息时间线改为窄型浮动标记轨道，支持 hover、focus、active 状态和消息定位；最新消息按钮改为水平居中。
- 为 Explorer Tree 增加根节点到 Task、Task 到 Plan 的树形连接线，并保留当前 Task 的轻量选中态。
- 增加 `ProviderUsageFooter`，在聊天底部展示当前模型、上下文用量和账户级 5 小时/7 天限额。
- 增加共享 `TaskLifecycleCard`，统一候选、已确认、已入队、已派发、运行中和待处理 Plan 的生命周期展示、异常状态和执行线程入口。
- 增加 ExplorerThread 删除 API 与领域级级联删除能力；删除前阻止仍有活动 Run 或 Explorer Loop 的线程，并在删除最后一个线程时创建替代线程。
- 增加 Explorer Task 归属和 Plan 生命周期工具及测试，明确未归属记录不得猜测挂到 Task 1。

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
- 修复本地开发服务的过期 PID 文件判断；status/start 脚本优先以健康端点和监听端口判断 API/Web 是否可用。
- 修正本地配置中的项目仓库根目录和 Codex App Server cwd，避免从 `code/config` 解析到非 Git 的上级目录。
- Candidate 查询支持显式 `explorerPlanId` 并默认使用活动 Task；Plan、Revision 和执行详情响应统一补充生命周期投影与执行线程摘要。
- Plan 状态变化统一写入 `plan.status.changed` 事件；旧数据中缺少确认记录却已进入后续状态的 Plan 会被修复为 `BLOCKED`，避免无确认执行。
- 执行时间线保留不可变 Plan 快照；Explorer 线程切换时仅刷新当前 Task 的 Candidate、Revision Draft、消息、输入请求和 Plan 绑定。

### Tests and documentation

- 新增 `ExplorerHeaderStatus`、用户消息摘要和相关交互覆盖；同步更新 Explorer、ThreadRail、计划需求和 Project 模型迁移测试。
- 新增 `design-qa.md`，记录 Explorer 聊天区视觉/交互验收结果和现场截图依据。
- 修正 ThreadRail 样式断言，使测试与当前三列 Grid 项目上下文布局一致。
- 新增 `taskTree.ts` 及测试，覆盖 Task 排序、Plan 归属、去重、未归属 Plan 隔离、展示术语和时间线定位目标。
- 扩展 Explorer domain/API 测试，覆盖默认 Plan 1、多 Plan FIFO 与共享 Provider Thread、跨项目 workspace 拒绝和无效 Plan turn 拒绝；同步记录探索流程设计文档和待办事项。
- 新增 Explorer 删除、Task 归属、Plan 生命周期、Provider 用量页脚和共享生命周期卡测试；扩展 API、domain、ExplorerView、ThreadRail、执行流和状态事件测试。
- 更新原始需求合规计划、UI 完整性计划、探索流程说明和 `待办事项.md`，标注当前自动化结果与剩余浏览器矩阵验收项。

### Verification

- `pnpm --dir code test`：88 个测试文件、526 个测试通过（当前工作区）。
- `pnpm --dir code typecheck`：domain、web、API 均通过。
- `pnpm --dir code build`：domain、web、API 均通过；仅有既有的 chunk size warning。
- API smoke check：health、Project、Explorer、ExplorerPlan、workspace 和 Plan endpoints 均返回成功；跨项目访问按预期拒绝。
- `git diff --check`：通过。
- 浏览器已完成 Explorer Tree 基础交互和 API 健康检查；完整的 Explorer、Plan Center、Workbench、Run、Settings 桌面/平板/窄屏矩阵仍待完成。

### Changed files in this working-tree update

- Explorer UI：`code/apps/web/src/components/ThreadRail.vue`、`code/apps/web/src/components/ThreadRail.test.ts`、`code/apps/web/src/views/ExplorerView.vue`、`code/apps/web/src/views/ExplorerView.test.ts`、`code/apps/web/src/styles.css`、`code/apps/web/src/types.ts`。
- Explorer UI utilities：`code/apps/web/src/utils/explorerScope.ts`、`code/apps/web/src/utils/explorerScope.test.ts`、`code/apps/web/src/utils/explorerStatus.ts`、`code/apps/web/src/utils/explorerStatus.test.ts`、`code/apps/web/src/utils/planLifecycle.ts`、`code/apps/web/src/utils/planLifecycle.test.ts`。
- Explorer UI components：`code/apps/web/src/components/ProviderUsageFooter.vue`、`code/apps/web/src/components/ProviderUsageFooter.test.ts`、`code/apps/web/src/components/TaskLifecycleCard.vue`、`code/apps/web/src/components/TaskLifecycleCard.test.ts`、`code/apps/web/src/components/ExecutionHeaderStatus.test.ts`、`code/apps/web/src/components/ProjectSettingsDialog.test.ts`。
- Web API and execution flow：`code/apps/web/src/api.ts`、`code/apps/web/src/api.test.ts`、`code/apps/web/src/utils/executionStream.ts`、`code/apps/web/src/utils/executionStream.test.ts`、`code/apps/web/src/utils/executionTelemetry.ts`、`code/apps/web/src/utils/executionTelemetry.test.ts`。
- API：`code/apps/api/src/server.ts`、`code/apps/api/src/server.test.ts`。
- Domain：`code/packages/domain/src/index.ts`、`code/packages/domain/src/executor-agent.ts`、`code/packages/domain/src/recovery-coordinator.ts`、`code/packages/domain/src/change-proposal.test.ts`、`code/packages/domain/src/m0-m1.test.ts`、`code/packages/domain/src/explorer-delete.test.ts`。
- Runtime and configuration：`startApi.sh`、`startWeb.sh`、`status.sh`、`code/config/pipeline-factory.config.json`、`code/config/pipeline-factory.config.example.json`。
- Documentation and tracking：`CHANGELOG.md`、`待办事项.md`、`docs/superpowers/plans/2026-08-30-ui-completeness.md`、`docs/superpowers/plans/2026-09-01-original-requirement-compliance.md`、`docs/探索的流程/流程优化升级.txt`。
