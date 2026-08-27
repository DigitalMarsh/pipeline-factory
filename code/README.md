# AI Software Pipeline Factory v3

这是 v3 设计对应的 TypeScript/Vue 最小可运行实现，代码范围限定在本目录。

## 目录

- `packages/domain`：Plan 状态、ExplorerThread 谱系投影、生命周期 Hook 领域服务。
- `apps/api`：Node.js + Fastify API，提供 ExplorerThread、Plan confirm/enqueue、Plan 查询和 Hook 配置接口。
- `apps/web`：Vue 3 + Vite + Element Plus 控制台，提供 ExplorerThread 工作区、Full Plan 抽屉和 Plan Center。

## 本地运行

```bash
pnpm install
pnpm --filter @pipeline-factory/domain build
pnpm --filter @pipeline-factory/api dev -- --config ./config/pipeline-factory.config.json
pnpm --filter @pipeline-factory/web dev
```

API 默认监听 `http://127.0.0.1:4310`，前端默认监听 `http://127.0.0.1:5173`。API 的运行参数全部来自 `config/pipeline-factory.config.json`，也可以通过 `--config` 指定其他配置文件；不读取环境变量。

复制 `config/pipeline-factory.config.example.json` 后，按受管项目修改 `project.root`、`storage`、固定命令和 `model` 配置：

```json
{
  "project": {
    "root": "/absolute/path/to/your/project",
    "commands": [
      { "commandId": "project.start", "argv": ["/absolute/path/to/node", "scripts/start.mjs"], "environment": { "PATH": "/absolute/path/to/bin:/usr/bin:/bin" } },
      { "commandId": "project.cleanup", "argv": ["/absolute/path/to/node", "scripts/cleanup.mjs"], "environment": { "PATH": "/absolute/path/to/bin:/usr/bin:/bin" } }
    ]
  }
}
```

默认配置通过 `codex app-server --stdio` 接入本机 Codex App Server。Codex 的登录态和认证由 Codex 自身管理，Factory 不读取或保存 API Key。Explorer 会以 `read-only`/`never approval` 创建线程；Executor 使用独立角色配置和受控工作区策略。

可选后端也在配置文件中声明：`stub`，或 `openai-responses`（需要在配置文件的 `model.openai.apiKey` 提供密钥）。

## 验证

```bash
./node_modules/.bin/vitest run packages/domain/src/index.test.ts apps/api/src/server.test.ts
./node_modules/.bin/tsc -p packages/domain/tsconfig.json
./node_modules/.bin/tsc -p apps/api/tsconfig.json --noEmit
./apps/web/node_modules/.bin/vue-tsc -p apps/web/tsconfig.json --noEmit
./apps/web/node_modules/.bin/vite build
```

测试中可注入内存适配器；运行时默认使用 SQLite WAL。当前还未接入自动 Merge 操作，合并仍必须由人工完成后通过 `confirm_merged` 语义确认。
