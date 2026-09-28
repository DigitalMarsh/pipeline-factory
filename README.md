# AI Software Pipeline Factory v4

把一条需求变成可执行、可验证、可追溯的软件流水线：Explorer 对话澄清需求 → 生成 Plan 契约 →
确认入队 → 派发执行 → 门禁验证，全过程事件溯源，随时可回放。

这是一个 TypeScript / Vue 的单机实现，代码在 [`code/`](code/README.md)。

## 快速开始

依赖 pnpm ≥ 11。所有命令都从 `code/` 执行。

```bash
cd code && pnpm install
```

开发模式（API 与 Vite 两个进程，默认 <http://127.0.0.1:5173>）：

```bash
cd code && pnpm dev
```

生产/单进程模式（API 在 <http://127.0.0.1:4310> 同时托管 Web 构建产物）：

```bash
cd code && pnpm build && pnpm start
```

配置在 `code/config/pipeline-factory.config.json`，字段说明见 `pipeline-factory.config.example.json`。
至少要按受管项目改 `project.root` 与 `storage.databasePath`。仓库里已有一份本地配置，**不要**
用模板直接覆盖它——那会丢掉本机的项目路径与模型设置。

## 文档

- [code/README.md](code/README.md) —— 目录结构、配置字段、运行与停止、API 约定。**从这里开始。**
- [docs/COMMENTING.md](docs/COMMENTING.md) —— 代码注释规范。
- [CHANGELOG.md](CHANGELOG.md) —— 按日期记录每次改动的动机、影响面与验证方式。

## 开发门禁

改动提交前跑一次全量校验（domain 构建 → 三包 typecheck → 三包测试 → 循环依赖检查）：

```bash
cd code && pnpm verify
```

`scripts/test-baseline.json` 是已知失败的豁免清单，**空清单是期望状态**；任何不在此列的新失败
都会让 `verify` 失败。
