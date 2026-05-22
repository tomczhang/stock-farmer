#!/usr/bin/env bash
# stock-farmer 一键部署脚本 (Cloudflare 部分)
#
# 用法:
#   ./scripts/deploy.sh init       # 一次性：创建 D1，把 database_id 写回 wrangler.toml
#   ./scripts/deploy.sh schema     # 建表 + 种子 watchlist (远程 + 本地)
#   ./scripts/deploy.sh worker     # 部署 Workers
#   ./scripts/deploy.sh all        # 上面三步连跑
#   ./scripts/deploy.sh smoke      # 部署后冒烟测试
#
# 前置:
#   1. 已 npm i -g wrangler
#   2. 已 wrangler login（会打开浏览器登录 Cloudflare）
#
# Pages（前端）需要在 Cloudflare Dashboard UI 操作，不放进脚本（见 README）。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

DB_NAME="stock-farmer"
WRANGLER_TOML="api/wrangler.toml"

cmd_init() {
  echo "==> 创建 D1 数据库: $DB_NAME"
  if grep -q "REPLACE_WITH_PRODUCTION_DATABASE_ID" "$WRANGLER_TOML"; then
    output="$(cd api && wrangler d1 create "$DB_NAME" 2>&1)"
    echo "$output"
    # 解出 database_id
    db_id="$(echo "$output" | grep -oE 'database_id = "[^"]+"' | head -1 | cut -d'"' -f2)"
    if [ -z "$db_id" ]; then
      echo "❌ 没解析到 database_id，请手动从上面输出复制并替换 $WRANGLER_TOML 中两个 REPLACE_WITH_*"
      exit 1
    fi
    echo "==> 写入 wrangler.toml: database_id=$db_id"
    sed -i.bak "s|REPLACE_WITH_PRODUCTION_DATABASE_ID|$db_id|" "$WRANGLER_TOML"
    sed -i.bak "s|REPLACE_WITH_PREVIEW_DATABASE_ID|$db_id|" "$WRANGLER_TOML"
    rm -f "$WRANGLER_TOML.bak"
    echo "✅ D1 创建完成，wrangler.toml 已更新"
  else
    echo "⚠️  wrangler.toml 中 database_id 已不是占位，跳过创建"
  fi
}

cmd_schema() {
  echo "==> 在远程 D1 建表"
  (cd api && wrangler d1 execute "$DB_NAME" --remote --file=../db/schema.sql)
  echo "==> 在远程 D1 写入 watchlist seed"
  (cd api && wrangler d1 execute "$DB_NAME" --remote --file=../db/seed_watchlist.sql)
  echo "==> 在本地 D1 也建一份 (供 wrangler dev 本地开发)"
  (cd api && wrangler d1 execute "$DB_NAME" --local --file=../db/schema.sql)
  (cd api && wrangler d1 execute "$DB_NAME" --local --file=../db/seed_watchlist.sql)
  echo "✅ schema + seed 完成"
}

cmd_worker() {
  echo "==> 部署 Workers"
  (cd api && wrangler deploy)
  echo "✅ Workers 部署完成"
  echo ""
  echo "🌐 你的 Worker 域名应该形如: https://stock-farmer-api.<你的 cf 子域>.workers.dev"
  echo "   记录下来，下一步 Pages 项目要设 VITE_API_BASE_URL 指向它"
}

cmd_smoke() {
  read -p "请输入 Workers 域名 (不带斜杠结尾，如 https://stock-farmer-api.xxx.workers.dev): " worker_url
  worker_url="${worker_url%/}"
  echo ""
  echo "==> 测试 /api/health"
  curl -fsS "$worker_url/api/health" | python3 -m json.tool || echo "❌ /api/health 失败"
  echo ""
  echo "==> 测试 /api/watchlist"
  curl -fsS "$worker_url/api/watchlist" | python3 -m json.tool | head -30 || echo "❌ /api/watchlist 失败"
  echo ""
  echo "==> 测试 /api/pe-history/SPX?range=5y (注意 pipeline 没回填时序列为空，但 status 200 即 OK)"
  curl -fsS "$worker_url/api/pe-history/SPX?range=5y" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'series: {len(d.get(\"series\",[]))} 行, live: {d.get(\"live\")}')"
}

cmd_all() {
  cmd_init
  cmd_schema
  cmd_worker
}

case "${1:-}" in
  init)    cmd_init ;;
  schema)  cmd_schema ;;
  worker)  cmd_worker ;;
  all)     cmd_all ;;
  smoke)   cmd_smoke ;;
  *)
    grep '^#' "$0" | head -20
    exit 1
    ;;
esac
