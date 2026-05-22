# 价值观察站 (stock-farmer)

港美股 PE-TTM 历史分位观察工具：输入一个 ticker，看当前 PE 处在自己历史区间的哪一格，帮你判断"现在贵不贵"。零月成本、零运维、全栈跑在 Cloudflare 免费层 + GitHub Actions 上。

<!-- TODO: 加入截图 -->

## 这是什么

价值投资里最常用的"贵贱判断"之一，就是把当前 PE 放回它自己的历史区间，看处在 5 年 / 10 年 / 上市以来的哪个分位。A 股有理杏仁、果仁等成熟工具，港美股则要么靠 Wind / 雪球付费会员，要么手工去 Yahoo Finance 一格一格抄。这个项目把这件事自动化了：输入 `AAPL` 或 `0700.HK`，立刻看到 PE-TTM 历史曲线、当前点位置、对应分位数。

**适合**：

- 港美股价值投资者，需要快速判断目标标的"在自己的历史区间内贵不贵"
- 不想为低频自用场景付每月 $50+ 的数据订阅
- 接受"判断贵贱"级别的精度，不需要回测策略

**不适合**：

- 想做交易回测（本工具用最新版财报、不还原 Point-in-Time）
- A 股用户（请用理杏仁等成熟工具，本工具不覆盖）
- 需要 intraday / 实时 PE（本工具一天一更，盘后批处理）

## 技术架构

```
                   GitHub Actions (cron: 港股 HKT 16:30 / 美股 EST 16:30)
                                       │
                                       ▼
            ┌──────────────────────────────────────────────────┐
            │  Pipeline (Python + pandas + numpy)              │
            │  global-stock-data skill: 雅虎 / 东财 / 新浪 /   │
            │                            腾讯 / SEC EDGAR      │
            │  → 拉价格 + EPS → TTM 拼接 → 分位预计算          │
            └──────────────────────────────────────────────────┘
                                       │  HTTPS batch INSERT
                                       ▼
            ┌──────────────────────────────────────────────────┐
            │  Cloudflare D1 (SQLite, 边缘副本)                │
            │  prices / eps_quarterly / pe_series /            │
            │  watchlist / fetch_log                           │
            └──────────────────────────────────────────────────┘
                                       │
                                       ▼
            ┌──────────────────────────────────────────────────┐
            │  Cloudflare Workers API (TypeScript, 薄层)       │
            │  /api/pe-history/{ticker}  /api/watchlist        │
            └──────────────────────────────────────────────────┘
                                       │
                                       ▼
            ┌──────────────────────────────────────────────────┐
            │  Cloudflare Pages 前端                           │
            │  React + Vite + ECharts                          │
            └──────────────────────────────────────────────────┘
```

- **离线 Pipeline**（Python + GitHub Actions）：每日盘后批处理，跑数据清洗、TTM 拼接、分位预计算
- **在线 API**（Cloudflare Workers + D1）：薄层，只做 "读 D1 → 转 JSON"，p95 百毫秒级
- **前端**（React + Vite + ECharts + Cloudflare Pages）：单页应用，PE 主图 + 指标卡片 + watchlist 管理
- **数据源**（`global-stock-data` skill）：雅虎、东财、新浪、腾讯、SEC EDGAR 五个零密钥 HTTP 源

## 仓库结构

```
stock-farmer/
├── pipeline/         # Python 离线流水线（数据抓取 + 计算 + 写入 D1）
├── api/              # Cloudflare Workers API（TypeScript，hono 框架）
├── web/              # React + Vite + ECharts 前端
├── db/               # D1 schema 与 seed 数据
├── .github/          # GitHub Actions workflow（pipeline 定时调度）
└── openspec/         # OpenSpec 变更与规范文档
```

## 本地开发

### 5.1 前置依赖

- Node 18+
- Python 3.11+
- `wrangler` CLI：`npm i -g wrangler`
- Cloudflare 账号（免费层即可）

### 5.2 安装 global-stock-data skill

```bash
mkdir -p ~/.claude/skills/global-stock-data
curl -fsSL -o ~/.claude/skills/global-stock-data/SKILL.md \
  https://raw.githubusercontent.com/simonlin1212/global-stock-data/main/SKILL.md
```

### 5.3 配置 D1

```bash
# 创建 D1 数据库
wrangler d1 create stock-farmer
# 把返回的 database_id 写入 api/wrangler.toml
# 创建表
wrangler d1 execute stock-farmer --file=db/schema.sql --local
wrangler d1 execute stock-farmer --file=db/seed_watchlist.sql --local
```

### 5.4 跑 pipeline（dry run）

`D1_DRY_RUN=1` 时，pipeline 不会真正写 D1，只把要执行的 SQL 打到 stdout，方便首次调试。

```bash
cd pipeline
pip install -r requirements.txt
D1_DRY_RUN=1 python run.py --ticker AAPL
```

### 5.5 启动 API

```bash
cd api
npm install
npm run dev    # 默认监听 http://localhost:8787
```

### 5.6 启动前端

```bash
cd web
npm install
cp .env.example .env  # 默认指向 http://localhost:8787
npm run dev    # 默认监听 http://localhost:5173
```

## 部署

### 6.1 创建 Cloudflare 账号 + Pages 项目

在 [Cloudflare Dashboard](https://dash.cloudflare.com/) 注册账号；在 `Workers & Pages` 中创建 Pages 项目，连接本 GitHub 仓库，构建配置：

- Framework preset: Vite
- Build command: `cd web && npm install && npm run build`
- Build output directory: `web/dist`

### 6.2 配置前端环境变量

在 Pages 项目的 `Settings → Environment variables` 中设置：

| 变量 | 值 |
|---|---|
| `VITE_API_BASE_URL` | 生产 Workers 域名，如 `https://stock-farmer-api.<account>.workers.dev` |

### 6.3 部署 Workers

```bash
cd api
wrangler deploy
```

### 6.4 配置 GitHub Secrets

在 GitHub 仓库 `Settings → Secrets and variables → Actions` 添加：

| Secret | 说明 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | D1:Write 权限的 API token（在 Cloudflare Dashboard → My Profile → API Tokens 创建） |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账户 ID（Dashboard 右侧栏可见） |
| `D1_DATABASE_ID` | 由 `wrangler d1 create stock-farmer` 命令输出的 UUID |

### 6.5 在远程 D1 跑 schema

```bash
wrangler d1 execute stock-farmer --file=db/schema.sql --remote
wrangler d1 execute stock-farmer --file=db/seed_watchlist.sql --remote
```

### 6.6 首次回填

在 GitHub Actions 页面手动触发一次 `pipeline` workflow（`workflow_dispatch`，参数留默认 `market=all`），等批处理跑完做首次回填。预计耗时 30-60 分钟（取决于 watchlist 大小）。

### 6.7 冒烟测试

打开 Pages 域名（如 `https://stock-farmer.pages.dev`），输入 watchlist 中的任意 ticker，确认图表能正常渲染。

## 数据口径与免责

- **最新版财报**：所有 EPS 使用最新可得财报数据，**不还原历史时点**（restatement 后的口径会回溯影响历史 PE）
- **亏损期处理**：TTM EPS ≤ 0 的日期不参与分位计算，但在 UI 主图上以灰色阴影标出
- **PE-TTM 口径**：`PE = 复权 Close ÷ Σ 最近 4 季复权 EPS`，分子分母都用复权值；EPS 优先用 diluted，缺失时回退到 basic
- **数据准确性**：本工具的目的是"判断当前贵不贵"的定性结论，与 Wind / 雪球的数值可能在小数位有差异。所有结果**仅供个人决策参考，不构成投资建议**

## 路线图

- **v1**（当前）：watchlist 模式，覆盖港美股 PE-TTM，5y / 10y / 上市以来三个时间窗
- **v2**（计划）：
  - 开放式 ticker 查询（输入任意股票，按需触发实时抓取）
  - 多指标支持（PB、PS、股息率分位）
  - 多用户 watchlist（加 Cloudflare Access 鉴权）
  - 移动端优化（图表降采样、触屏交互）

## License

[Apache License 2.0](./LICENSE) — 与上游 `global-stock-data` skill 保持一致，方便代码复用。
