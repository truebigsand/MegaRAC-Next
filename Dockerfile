# MegaRAC-Next 生产镜像：一个进程同时提供 SPA 与 API（单端口）
#
# 为什么用 Node 24：历史趋势用内置的 node:sqlite，它在 Node 23.4 之前需要
# --experimental-sqlite 开关，24 起免开关。
#
# 构建：docker build -t megarac-next .
# 运行：docker run -d -p 5177:5177 -e BMC_BASE=https://192.168.0.200 -v megarac-data:/app/server/data megarac-next
# （或直接用仓库根的 docker-compose.yml）

# 国内网络往往拉不到 Docker Hub / npm 官方源，这里留两个构建参数（默认值对公网用户不变）：
#   docker build \
#     --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:24-alpine \
#     --build-arg NPM_REGISTRY=https://registry.npmmirror.com .
ARG NODE_IMAGE=node:24-alpine
ARG NPM_REGISTRY=https://registry.npmjs.org

# ---------- 构建阶段 ----------
FROM ${NODE_IMAGE} AS build
ARG NPM_REGISTRY
WORKDIR /app
# 先只复制清单，让依赖层能被缓存
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --registry="$NPM_REGISTRY"
COPY . .
RUN npm run build
# 去掉开发依赖（vite / tsx / typescript 等），运行阶段直接复用这份 node_modules
RUN npm prune --omit=dev

# ---------- 运行阶段 ----------
FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5177

COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY server/package.json server/
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist

# 历史趋势库落在这里（compose 里挂卷持久化）
RUN mkdir -p /app/server/data && chown -R node:node /app
USER node
EXPOSE 5177

# 健康检查直接打进程自己的 /api/health（不依赖 BMC 是否可达）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5177)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
