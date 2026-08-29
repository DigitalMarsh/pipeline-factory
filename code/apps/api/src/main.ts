import { createApp } from "./server.js";
import { loadFactoryConfig, resolveConfigPath } from "./config.js";

const configPath = resolveConfigPath(readConfigPath(process.argv.slice(2)));
const config = loadFactoryConfig(configPath);
const app = createApp({ config });

app.listen({ port: config.server.port, host: config.server.host }).then(() => {
  console.log(`Pipeline Factory API v4 listening on http://${config.server.host}:${config.server.port}`);
}).catch((error: unknown) => {
  app.log.error(error);
  console.error(`Pipeline Factory API failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});

function readConfigPath(args: string[]): string | undefined {
  const index = args.indexOf("--config");
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value) throw new Error("--config requires a file path");
  return value;
}
