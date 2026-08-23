# syntax=docker/dockerfile:1
# 构建上下文 = 仓库根目录：docker build -f deploy/Dockerfile .
# 产物：单容器 = Python 筑底/纪律推演 API + web 前端静态资源（同源部署）

# ---- 前端构建 ----
FROM node:20-slim AS web-build
WORKDIR /build/web
COPY web/package.json web/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY web/ ./
# 同源部署：API 与静态资源同域，VITE_API_BASE_URL 留空
ENV VITE_API_BASE_URL=
RUN npm run build

# ---- 运行时 ----
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1
WORKDIR /app
COPY pipeline/requirements.txt ./pipeline/requirements.txt
RUN pip install --no-cache-dir -r pipeline/requirements.txt
COPY pipeline/ ./pipeline/
COPY --from=web-build /build/web/dist ./public

# PYTHONPATH 含 /app/pipeline 以兼容 `import global_stock_data` 等包内顶层导入
ENV STATIC_DIR=/app/public \
    PYTHONPATH=/app:/app/pipeline

EXPOSE 8765
CMD ["python", "-m", "pipeline.server", "--host", "0.0.0.0", "--port", "8765"]
