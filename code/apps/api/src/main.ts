/**
 * API 进程入口：解析启动参数并加载 Factory 配置后创建 HTTP 服务。
 * 入口保持轻量，实际路由和运行时组装由 server 模块负责。
 */
import { createApp } from "./server.js";
import { loadFactoryConfig, resolveConfigPath } from "./config.js";
import { probeClaudeEndpoint } from "./runtime/model-gateway.js";

const configPath = resolveConfigPath(readConfigPath(process.argv.slice(2)));
const config = loadFactoryConfig(configPath);

// 配了 Claude 端点就先探一次（缺省不探，见 probeClaudeEndpoint 的说明）。放在创建 app 之前，
// 与"缺配置时启动期失败"同一条原则：宁可起不来，也不要第一个探索回合跑到一半才发现端点不通。
try {
  await probeClaudeEndpoint(config);
} catch (error) {
  console.error(`Pipeline Factory API failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const app = createApp({ config });

app
  .listen({ port: config.server.port, host: config.server.host })
  .then(() => {
    console.log(`Pipeline Factory API v4 listening on http://${config.server.host}:${config.server.port}`);
  })
  .catch((error: unknown) => {
    app.log.error(error);
    console.error(`Pipeline Factory API failed to start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exitCode = 1;
  });

function readConfigPath(args: string[]): string | undefined {
  const index = args.indexOf("--config");
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value) throw new Error("--config requires a file path");
  return value;
}
