# 部署指南 (一步步)

按下面 5 个阶段顺序执行。**前 4 个阶段你需要自己跑命令**（涉及账号登录和密钥）；最后 1 个我能帮你跑。

## 总览

```
   阶段 1: 准备工具 & 登录  Cloudflare         (5 分钟)
   阶段 2: D1 + Workers 部署                  (3 分钟)
   阶段 3: 前端 Pages 部署                    (5 分钟，纯 UI)
   阶段 4: GitHub Secrets + 触发首次回填       (5 分钟)
   阶段 5: 端到端冒烟测试                     (2 分钟)
```

---

## 阶段 1: 准备工具

```bash
# 1.1 安装 wrangler CLI (Cloudflare 官方)
npm install -g wrangler

# 1.2 登录 Cloudflare (会打开浏览器)
wrangler login

# 1.3 验证登录成功
wrangler whoami
# → 应该显示你的 email 和 account_id
```

**记下你的 Account ID** —— 阶段 4 配 GitHub Secret 要用。

---

## 阶段 2: D1 数据库 + Workers API

在仓库根目录跑：

```bash
# 2.1 一条命令搞定 D1 创建 + 写入 schema/seed + 部署 Workers
./scripts/deploy.sh all

# 输出会包含:
#   ✅ D1 创建完成，wrangler.toml 已更新
#   ✅ schema + seed 完成 (11 只 watchlist 已写入)
#   ✅ Workers 部署完成
#   🌐 Worker URL: https://stock-farmer-api.<你的子域>.workers.dev
```

**记下 Worker URL** —— 阶段 3 配 Pages 要用。

> 💡 想分步跑也行: `deploy.sh init` / `deploy.sh schema` / `deploy.sh worker`

---

## 阶段 3: 前端 Pages 部署

这一步全在 Cloudflare Dashboard UI 操作：

1. 打开 https://dash.cloudflare.com → Workers & Pages → Create → Pages → Connect to Git
2. 选你刚 push 的 GitHub repo `tomczhang/stock-farmer`
3. 配置:
   ```
   Project name:           stock-farmer  (或你想要的名字)
   Production branch:      main
   Build command:          cd web && npm install && npm run build
   Build output directory: web/dist
   ```
4. 展开 "Environment variables" 加一个:
   ```
   VITE_API_BASE_URL = <阶段 2 拿到的 Worker URL，如 https://stock-farmer-api.xxx.workers.dev>
   ```
5. 点 **Save and Deploy**，等 2-3 分钟构建
6. 部署完会给你一个 `https://stock-farmer.pages.dev` 域名

**记下 Pages URL** —— 阶段 2 的 wrangler.toml 里 CORS 白名单要加。

### 3.1 把 Pages 域名加进 Workers CORS

打开 `api/wrangler.toml`，把 `ALLOWED_ORIGINS` 改成包含你的 Pages 域名：

```toml
[vars]
ALLOWED_ORIGINS = "http://localhost:5173,https://stock-farmer.pages.dev"
```

然后重新部署 Workers：

```bash
cd api && wrangler deploy && cd ..
```

---

## 阶段 4: GitHub Secrets + 首次回填

### 4.1 创建 Cloudflare API Token

打开 https://dash.cloudflare.com/profile/api-tokens → Create Token → Custom token，权限设：

```
Account → D1 → Edit
Account → Workers Scripts → Edit  (可选，如果想从 Actions deploy worker)
Zone   → 没要求
```

点 **Continue to Summary** → **Create Token** → 复制 token（**只显示一次**）。

### 4.2 GitHub Repo Settings → Secrets and variables → Actions → New secret

加 3 个：

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 上面拿到的 token |
| `CLOUDFLARE_ACCOUNT_ID` | 阶段 1.3 `wrangler whoami` 显示的 account ID |
| `D1_DATABASE_ID` | 看 `api/wrangler.toml` 里的 `database_id` 值 |

### 4.3 手动触发首次回填

打开 https://github.com/tomczhang/stock-farmer/actions → 选 "pipeline" workflow → **Run workflow**：

```
market:              all
ticker:              (留空)
force_full_refresh:  false
```

点 Run。整个过程约 5-10 分钟（12 只股票 × 拉 10 年历史 + 计算分位 + 写 D1）。

完成后在 Actions 详情里看 log，应该有：

```
ticker=SPX     stage=multpl_full   duration_ms=1500  rows=1866 last_date=2026-05-21
ticker=AAPL    stage=xueqiu_full   duration_ms=900   rows=2600 last_date=2026-05-21
...
summary total=12 success=12 failure=0 failure_rate=0.00
```

---

## 阶段 5: 端到端冒烟测试

```bash
./scripts/deploy.sh smoke
# 会提示你输入 Worker URL，然后测三个端点
```

或者直接打开 Pages URL（如 `https://stock-farmer.pages.dev`）：

- ✓ 左侧应显示 watchlist 12 只
- ✓ 点击 SPX → 主图显示 PE 月度曲线
- ✓ 卡片显示当前 PE 32.06，5y 分位 99.2%
- ✓ 点击 AAPL → 主图切换为日度 PE
- ✓ 切换时间窗 5y / 10y / 全部

如果有问题：

```bash
# 看 Workers 日志（实时）
cd api && wrangler tail

# 看 D1 数据
cd api && wrangler d1 execute stock-farmer --remote --command="SELECT ticker, COUNT(*) FROM pe_series GROUP BY ticker"
```

---

## 排错 FAQ

### "Authentication error" 部署 Workers 时

```bash
wrangler login  # 重新登录
```

### Pages 构建失败 "vite: command not found"

Build command 改成 `cd web && npm install && npm run build`（确保装依赖）

### Workers 报 "DB not bound"

`api/wrangler.toml` 里 `database_id` 还是占位 `REPLACE_*`。重跑 `./scripts/deploy.sh init` 或手动填入。

### Pipeline workflow 报 "Authentication failed" 写 D1

检查 GitHub Secret `CLOUDFLARE_API_TOKEN` 权限是不是 D1:Edit。

### 前端访问 API 报 CORS

检查 `api/wrangler.toml` 的 `ALLOWED_ORIGINS` 是不是含你的 Pages 域名，然后 `wrangler deploy` 重新部署。

---

## 后续维护

```bash
# 加新股票到 watchlist
curl -X POST https://<your-worker>/api/watchlist \
  -H "Content-Type: application/json" \
  -d '{"ticker":"AVGO","market":"US"}'

# 手动触发一次 pipeline 拉新数据
# GitHub Actions → pipeline → Run workflow → ticker=AVGO

# 看 Pipeline 自动调度状态
# GitHub Actions → pipeline
# 默认: 港股 UTC 08:30 / 美股 UTC 21:30 (工作日)
```
