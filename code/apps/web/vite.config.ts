import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const factoryConfig = JSON.parse(readFileSync(fileURLToPath(new URL("../../config/pipeline-factory.config.json", import.meta.url)), "utf8")) as {
  server?: { host?: string; port?: number };
  web?: { host?: string; port?: number };
};
const apiHost = factoryConfig.server?.host ?? "127.0.0.1";
const apiPort = factoryConfig.server?.port ?? 4310;

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    host: factoryConfig.web?.host ?? "127.0.0.1",
    port: factoryConfig.web?.port ?? 5173,
    proxy: { "/api": `http://${apiHost}:${apiPort}` },
  },
});
