## 1. Project Scaffolding

- [x] 1.1 创建 monorepo 目录结构：`pipeline/`、`api/`、`web/`、`db/`、`.github/workflows/`
- [x] 1.2 在 `pipeline/` 初始化 Python 项目（`pyproject.toml` 或 `requirements.txt`），依赖：`pandas`、`numpy`、`requests`、`python-dateutil`
- [x] 1.3 安装 `global-stock-data` skill 到 `~/.claude/skills/global-stock-data/`（按其 README 步骤），并验证 `SKILL.md` 中函数可在 Python 中 import
- [x] 1.4 在 `api/` 初始化 Cloudflare Workers TypeScript 项目（`wrangler init`），生成 `wrangler.toml` 与 `package.json`
- [x] 1.5 在 `web/` 初始化 React + Vite 项目（`npm create vite@latest`，模板 `react-ts`），安装 `echarts`、`echarts-for-react`
- [x] 1.6 在仓库根写一个 `README.md`，列出三个子项目用途与本地开发命令

## 2. Cloudflare 资源准备

- [ ] 2.1 创建 Cloudflare 账户（如尚无），开启 Workers / D1 / Pages（**待用户执行**）
- [ ] 2.2 用 `wrangler d1 create stock-farmer` 创建生产 D1 数据库，记录 database_id（**待用户执行**）
- [x] 2.3 在 `wrangler.toml` 配置 D1 binding（`[[d1_databases]]`），同时为 preview/local 配置（**database_id 占位为 `REPLACE_WITH_PRODUCTION_DATABASE_ID`，等用户回填**）
- [ ] 2.4 准备 GitHub Actions 所需 secrets：`CLOUDFLARE_API_TOKEN`（D1 写权限）、`CLOUDFLARE_ACCOUNT_ID`、`D1_DATABASE_ID`（**待用户执行**）

## 3. Database Schema

- [x] 3.1 在 `db/schema.sql` 定义 5 张表：`prices`、`eps_quarterly`、`pe_series`、`watchlist`、`fetch_log`，遵循 design.md 中的列定义
- [x] 3.2 给每张表加合适的索引：`prices(ticker, date)` 主键即可；`pe_series(ticker, date)` 主键；`watchlist(ticker)` 主键
- [ ] 3.3 用 `wrangler d1 execute --file=db/schema.sql` 在远程 D1 创建表（**待用户执行：需 CF 凭据**）
- [x] 3.4 写一个 `db/seed_watchlist.sql` 预置几只测试股票（如 `0700.HK`、`AAPL`、`MSFT`），便于开发
- [ ] 3.5 用 `wrangler d1 execute --local --file=db/schema.sql` 创建本地 D1 副本，供 Workers 本地开发使用（**待用户执行**）

## 4. Pipeline – Data Fetching Layer

- [x] 4.1 实现 `pipeline/fetcher/prices.py`：封装 `stock_kline_yahoo`，支持首次（`range_="max"`）与增量（`period1`/`period2`）两种模式
- [x] 4.2 实现 `pipeline/fetcher/eps.py`：封装 `key_indicators_eastmoney`，提取 `BASIC_EPS`、`DILUTED_EPS`、`REPORT_DATE` 字段
- [x] 4.3 实现 `pipeline/fetcher/ticker_normalize.py`：港股 `0700.HK` ↔ 东财 `00700.HK` 双向映射；美股保持原样
- [x] 4.4 给所有 fetcher 加单元测试（mock HTTP 响应），覆盖空数据 / 错误响应 / 非典型字段

## 5. Pipeline – Computation Layer

- [x] 5.1 实现 `pipeline/compute/ttm.py`：把季度 EPS 序列转成日度 TTM EPS 序列（前向填充至下一财报日，不足 4 季度时输出空）
- [x] 5.2 实现 `pipeline/compute/pe.py`：日度 `PE_ttm = adj_close / TTM_EPS`；EPS ≤ 0 时输出 NULL 并标记 `is_loss=true`
- [x] 5.3 实现 `pipeline/compute/percentile.py`：对每日 PE 计算 5y / 10y / all 三个窗口的分位（剔除 NULL/is_loss 后排序），使用 numpy
- [x] 5.4 给三个 compute 模块写单元测试：阶梯跳变、亏损段、新上市公司不足 4 季度、windowed percentile 边界

## 6. Pipeline – Persistence Layer

- [x] 6.1 实现 `pipeline/db/d1_client.py`：通过 Cloudflare D1 REST API 执行 SQL（使用 `CLOUDFLARE_API_TOKEN`），支持批量 UPSERT
- [x] 6.2 实现 `pipeline/db/writers.py`：分别写 `prices`、`eps_quarterly`、`pe_series` 表，全部使用 `INSERT OR REPLACE` 实现幂等
- [x] 6.3 实现 `pipeline/db/fetch_log.py`：读写 `fetch_log` 表的辅助函数（`get_last_fetched`、`update_last_fetched`）
- [x] 6.4 D1 REST 单条 statement 有体积上限，writers 实现按 chunk（如 500 行）拆分写入

## 7. Pipeline – Orchestration

- [x] 7.1 实现 `pipeline/run.py` 主入口：读 watchlist → 对每只股票按顺序跑 fetch → compute → persist
- [x] 7.2 在 orchestration 中实现"每月首次运行触发全量价格重拉"逻辑（检查 `fetch_log` 中最近一次 full-refresh 时间）
- [x] 7.3 实现单只股票失败时跳过且记录的容错（不让整个 job 退出非零）
- [x] 7.4 加结构化日志输出（每只股票：拉了多少行、跳过原因、耗时）
- [x] 7.5 加 `--ticker <X>` CLI 参数支持单股票回填，便于调试

## 8. GitHub Actions – Scheduling

- [x] 8.1 在 `.github/workflows/pipeline.yml` 定义两个 cron job：港股盘后（UTC 09:30）、美股盘后（UTC 22:00），均匹配 周一至周五
- [x] 8.2 workflow 步骤：checkout → setup Python → install deps → install global-stock-data skill → 运行 `python pipeline/run.py --market=hk`（或 us）
- [x] 8.3 注入 secrets 为环境变量供 d1_client 使用
- [x] 8.4 加 `workflow_dispatch` 手动触发入口，参数支持 ticker 与 market

## 9. API – Workers Implementation

- [x] 9.1 在 `api/src/index.ts` 用 Hono 或裸 Workers 路由实现 `GET /api/pe-history/{ticker}`，查 `pe_series` + 计算 metrics card
- [x] 9.2 实现 `GET /api/watchlist`、`POST /api/watchlist`、`DELETE /api/watchlist/{ticker}`
- [x] 9.3 实现 `GET /api/health`：读 `fetch_log` 中最近一次更新时间返回
- [x] 9.4 实现 CORS middleware：允许 Pages 域名与 `localhost:5173`
- [x] 9.5 实现统一错误响应格式 `{ error, message }`，覆盖 404 / 400 / 500
- [x] 9.6 为 GET 端点设置 `Cache-Control: public, max-age=3600`
- [x] 9.7 写 `api/src/__tests__/` 端到端测试（使用 `wrangler dev` 或 Miniflare），针对每个端点的成功与失败路径

## 10. Frontend – React/ECharts

- [x] 10.1 实现根布局组件：左侧/抽屉 watchlist、右侧主区域、底部免责角标
- [x] 10.2 实现 watchlist 组件：列表渲染、添加表单（自动识别 `.HK` 后缀分配 market）、删除按钮、与 API 集成
- [x] 10.3 实现时间窗切换 `TimeRangeToggle` 组件（5y / 10y / all 三按钮）
- [x] 10.4 实现主图 `PEHistoryChart` 组件（基于 ECharts）：折线、当前点高亮、25/50/75 百分位横线、亏损期阴影
- [x] 10.5 实现 `MetricsCards` 组件：4 卡片（当前 PE、历史中位、当前分位、min/max），亏损中时当前 PE 卡显示"亏损中"
- [x] 10.6 实现 API 客户端 `web/src/api.ts`：基于 `fetch`，base URL 取自 `import.meta.env.VITE_API_BASE_URL`
- [x] 10.7 实现 loading 骨架与错误状态（含重试按钮）
- [x] 10.8 实现响应式布局：媒体查询切换桌面/移动版（移动版 watchlist 折叠成抽屉）
- [x] 10.9 在 `.env.example` 中列出 `VITE_API_BASE_URL` 等变量

## 11. Deployment

- [ ] 11.1 部署 Workers：`wrangler deploy`，记录得到的 `*.workers.dev` 域名（**待用户执行**）
- [ ] 11.2 在 Cloudflare Pages 创建项目，绑定 Git 仓库，构建命令 `cd web && npm run build`，输出目录 `web/dist`（**待用户执行**）
- [ ] 11.3 在 Pages 项目环境变量中设置 `VITE_API_BASE_URL` 指向 Workers 域名（**待用户执行**）
- [ ] 11.4 触发首次 Pages 部署，记录得到的 `*.pages.dev` 域名（**待用户执行**）
- [ ] 11.5 在 Workers CORS 允许列表中加入 Pages 域名后重新部署（**待用户执行：改 `api/wrangler.toml` 的 ALLOWED_ORIGINS 后 `wrangler deploy`**）
- [ ] 11.6 手动触发一次 GitHub Actions pipeline workflow，回填初始数据（**待用户执行：GH Actions 页面手动 dispatch**）
- [ ] 11.7 端到端冒烟测试：浏览器打开 Pages 域名，切换 watchlist 内股票、切时间窗、确认图表与卡片正确（**待用户执行**）

## 12. Documentation & Polish

- [x] 12.1 在 `README.md` 写本地开发指引：如何起 `wrangler dev`、如何起 `npm run dev`、如何用本地 D1 跑 pipeline
- [x] 12.2 在 `README.md` 写部署指引（包含所有 secrets / wrangler.toml 关键项）
- [x] 12.3 加 LICENSE（推荐 MIT 或 Apache 2.0，与 `global-stock-data` skill 一致）
- [x] 12.4 在 web 页脚加版本号 + Git commit hash（构建时注入），方便排查"看到的是哪个版本"

## 13. Post-Implementation Findings（本地 dry-run 实测发现）

实测期间发现并修复了 2 个 bug，还有 1 个**数据语义问题待后续修复**：

- [x] 13.1 修复 Yahoo K 线参数丢失（**已修**）
  - `global-stock-data` skill 的 `stock_kline_yahoo` 构造了 `params` 字典但没传给 `requests.get`，导致 `interval`/`range_` 被忽略，Yahoo 只返回 1-2 天的 intraday 数据
  - 修复：`pipeline/fetcher/prices.py` 改用 `_fetch_yahoo_chart` 直接调 Yahoo chart v8 API，正确传 params

- [x] 13.2 修复美股东财 secucode 后缀（**已修**）
  - 东财 GMAININDICATOR 对美股需要 `.O` (NASDAQ) / `.N` (NYSE) 后缀，原 `ticker_normalize` 只处理港股
  - 修复：`pipeline/fetcher/eps.py` 加 `_candidate_secucodes()` 自动 fallback，先试 `.O` 没数据再试 `.N`

- [x] 13.3 **美股 EPS 切到 SEC EDGAR XBRL（已修，方案 B+C）**
  - 问题确认：东财 GMAININDICATOR 对美股返回 YTD 累计（AAPL 2024-06-29=$5.13 实际是 Q1+Q2+Q3 累计），不是单季度
  - 实施方案：港股保留东财，美股切到 SEC EDGAR XBRL
  - 新增 `pipeline/fetcher/sec_facts.py`（~210 行 + 11 个测试）：
    - `get_cik(ticker)`：从 `sec.gov/files/company_tickers.json` 加载 10000+ 美股的 ticker→CIK 映射，模块级缓存
    - `_is_single_quarter()`：start/end 范围 85-100 天（覆盖 AAPL 偶发的 97 天 Q1）
    - `_derive_q4_from_annual()`：用 start/end 日期范围匹配同财年的 Q1/Q2/Q3，Q4 = Annual - 三者之和；**不依赖 `fy` 字段**（SEC 的 `fy` 指的是填报年份不是数据所属财年）
    - 自动 dedupe 同一 period_end 重述记录，保留 filed 最新者
  - `pipeline/fetcher/eps.py` 路由：`market_of(ticker) == "US"` → SEC；HK → 东财
  - 验证（vs 真实 AAPL 数据）：
    - 2024-06-29 Q3 FY24: 修复前 $5.13（错），修复后 $1.40 ✓
    - 2023-09-30 Q4 FY23 推导: $1.47 ✓ (真实 $1.46)
    - 2020 起每年 4 季度全齐
  - 已知局限：2013/2018/2019 的部分 Q4 推导有偏差（AAPL 历次拆股后旧 10-Q 数据未全部 restated），影响 5%-10y 历史的 PE 分位准确性，但近 5 年完全可靠

- [x] 13.4 **港股东财 EPS 也是 YTD 累计（已修）**
  - 实测 0700.HK 时发现：东财对港股的 EPS 同样是累计值，REPORT_TYPE 字段标记 `2025/Q1`、`Q6`、`Q9`、`FY`（分别是 3/6/9/12 个月累计）
  - 修复：`pipeline/fetcher/eps.py` 新增 `_ytd_to_single_quarter()` 按 fiscal year 内累计差分还原单季：Q2=Q6-Q1, Q3=Q9-Q6, Q4=FY-Q9
  - 验证（Tencent 真实数据）：
    - 修复前 TTM = ¥59 → PE 7.4（严重低估）
    - 修复后 TTM = ¥25.33 → PE 17.4 ✓（与 Bloomberg 22 接近，剩余差异来自 FX 和 IFRS 口径）
    - Tencent 2025 各季 EPS：Q1=5.13, Q2=5.99, Q3=6.76, Q4=6.27，与公开财报一致

- [x] 13.5 **港股货币 + IFRS/Non-IFRS 一并解决 (架构切换：雪球主路径)**
  - 实测发现：除 RMB/HKD 货币错配外，市场普遍使用 Non-IFRS 调整后 EPS（Tencent 等中概的标准做法），自己拼 TTM 路径与 Bloomberg / 富途 / 雪球差距 7-15% 无法对齐
  - 决定不自己算，直接消费雪球 K 线接口（含 indicator=pe）拿成品 PE-TTM 时间序列
  - 实测对齐结果（vs 用户期望值，5/21 收盘）：
    - AAPL: 36.5449 vs 36.54 → 差 0.01% ✓
    - 0700.HK: 15.1872 vs 15.11 → 差 0.51% ✓
  - 新增 `pipeline/fetcher/xueqiu.py`（~140 行 + 11 个测试）：
    - `fetch_pe_history(ticker, years, since)` 一次 HTTPS 拿 (date, close_adj, pe_ttm) 全序列
    - `fetch_current_pe(ticker)` 拿实时 quote 用于 sanity check
    - `_symbol_for_xueqiu` 自动 ticker → 雪球 symbol (0700.HK → 00700, AAPL → AAPL)
    - cookie 懒加载 + 单例 session
  - `run.py` 主流程切到 `_process_xueqiu` + `_sanity_check_xueqiu`，端到端 700-900ms / 2600 行
  - 旧的 fetch_quarterly_eps + sec_facts + ttm + pe 路径仍保留，作为 `process_ticker_legacy()` 备用降级
  - sanity check 阈值从 10% 收紧到 5%（雪球 quote 实时 PE 与 K 线收盘 PE 应只有 < 1% 噪声）
  - **已知风险**：雪球内部 API 未公开文档，可能变更；监控失败率 & 必要时降级到 legacy 路径
