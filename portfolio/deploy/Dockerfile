# syntax=docker/dockerfile:1
# 构建上下文 = 仓库的 portfolio/ 目录：docker build -f deploy/Dockerfile .

# ---- 前端构建 ----
FROM node:20-slim AS web-build
WORKDIR /build/web
COPY web/package.json web/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---- 后端构建 ----
FROM node:20-slim AS server-build
WORKDIR /build/server
COPY server/package.json server/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY server/ ./
RUN npm run build && npm prune --omit=dev

# ---- 运行时 ----
FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=server-build /build/server/node_modules ./node_modules
COPY --from=server-build /build/server/dist ./dist
COPY --from=server-build /build/server/package.json ./
COPY --from=web-build /build/web/dist ./public

ENV PORT=8790 DB_PATH=/data/portfolio.db STATIC_DIR=/app/public
VOLUME /data
EXPOSE 8790
CMD ["node", "dist/index.js"]
