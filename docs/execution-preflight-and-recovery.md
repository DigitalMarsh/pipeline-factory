# Run 执行预检与恢复流程

## 复盘：Run `run-9c9b3644-cee`

2026-09-26 的 Run 在第 1/40 步停留 30 分钟后因 `MAX_DURATION_EXCEEDED` 被阻塞。Executor 的 Provider 活动记录显示，它从工作树根目录启动了 `npm install --ignore-scripts`，而 `package.json` 位于 `code/personal-site/`。该活动没有完成事件，项目配置中的 `defaultTimeoutMs` 也没有应用到 Provider 代执行的 shell 命令，因此只能等整个 30 分钟 Loop 超时。

恢复时还暴露出数据保全风险：创建 Revision Draft 并选择清理未合并 Run，会调用 `Scheduler.finish`，移除旧 Git worktree。清理前必须先归档工作树内容；不能仅凭 Run 已阻塞就开始“继续编辑”。

## 新的执行流程

1. **派发前解析工作目录。** 优先使用已批准 Plan 的 `artifactPath` 确定产物目录；没有该字段时，从 `include` 范围推导共同目录，若范围分散则使用 worktree 根目录。拒绝越界路径和符号链接，安全创建尚不存在的目标目录。
2. **明确执行上下文。** 将 worktree 根目录与 Provider shell 的实际 `cwd` 同时传给 Executor。Plan 的范围和完成报告仍使用 worktree 相对路径；shell 命令从解析出的项目目录运行。
3. **检查项目入口。** 执行依赖安装或构建前核对 `pwd` 和项目 manifest。目标目录或 manifest 缺失时，Executor 必须报告阻塞原因，不得在上级目录猜测性安装。
4. **限制单条 Provider 命令。** `commandExecution` 使用项目 `defaultTimeoutMs`；超时后取消 Provider Turn，并以 `PROVIDER_COMMAND_TIMEOUT` 阻塞。审计步骤记录命令活动 ID、工作目录和超时值。整轮 `executionTimeoutMs` 仍作为最后一道总时限。
5. **阻塞后先诊断，再恢复。** 读取 Run、Agent Loop、Provider 活动和命令 CWD；区分真实进程仍在运行、Provider 活动未完成、错误工作目录和模型调用错误。不得把“命令已启动”视作命令仍在运行。
6. **清理前保全现场。** 若要新建 Revision Draft 并清理未合并 Run，先把目标 worktree 的变更（含未跟踪文件）打包到独立恢复位置，记录文件清单与校验和。Draft 创建后恢复原分支和基线，再还原并核对文件；确认 Revision 1 的 artifact hash 未变化。
7. **只把新版本留在草稿。** 将修正后的目录约束写进下一 Revision Draft，检查范围、依赖、命令和失败处理后交给用户审阅。没有用户确认，不冻结 Revision、不派发 Run。
8. **首条命令即时验收。** 新 Run 开始后，检查首条 Provider 命令的 `cwd`、命令行和开始/完成事件；若入口不匹配或命令在 `defaultTimeoutMs` 内无结果，立即停止并报告，不等待整轮超时。

## 个人网站 Plan 的命令约束

Run 的工作树根目录不是网站的 npm 工程目录。该 Plan 的 `cwd` 应解析为 `code/personal-site/`。从 worktree 根目录运行时，命令应显式使用 `npm --prefix code/personal-site ...`；进入网站目录后才可使用裸 `npm` 命令。不得在仓库根目录生成 `package.json`、`package-lock.json` 或 `node_modules/`。

## 责任边界

- Pipeline Factory 负责解析并设置执行目录、限制 Provider 命令时长、持久化活动 CWD 和超时诊断。
- Plan 必须声明项目 manifest 的位置、正确的包管理器命令、缺少入口时的阻塞处理和范围外副产物检查。
- 恢复操作负责在破坏性 worktree 清理前备份与校验，并在 Draft 建立后恢复工作树。
- Revision 确认和 Run 派发必须保持独立的人工确认步骤。
