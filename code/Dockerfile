# 单进程镜像：API + Web（apps/web/dist）同源，监听 4310。
#
# 构建：docker build -t pipeline-factory .
# 运行（配置与数据都从宿主机挂载）：
#   docker run --rm -p 4310:4310 \
#     -v "$PWD/config/pipeline-factory.config.json:/app/config/pipeline-factory.config.json:ro" \
#     -v "$PWD/var:/app/var" \
#     pipeline-factory
#
# 说明：
# - 镜像里**没有**真实配置（只有 example），启动时缺 config 会明确失败，而不是拿一份猜的配置跑。
# - 需要访问宿主机上的代码仓库与 Codex CLI 时，把相应目录/命令挂进容器；Claude 侧凭据同理。
# - SQLite 与附件都落在 /app/var，必须挂卷才能跨容器保留。

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY config ./config
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:22-bookworm-slim
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api ./apps/api
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages ./packages
COPY --from=build /app/config ./config
RUN mkdir -p /app/var
EXPOSE 4310
VOLUME ["/app/var"]
CMD ["node", "--disable-warning=ExperimentalWarning", "apps/api/dist/main.js", "--config", "/app/config/pipeline-factory.config.json"]
