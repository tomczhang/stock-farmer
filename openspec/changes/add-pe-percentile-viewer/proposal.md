## Why

价值投资中最常用的判断"现在贵不贵"的方法之一，就是看当前 PE 处于自己历史区间的哪个分位。但市面上免费工具大多只覆盖 A 股（如理杏仁），港美股投资者要么手工去 Wind/雪球翻数据，要么订阅付费工具。我们需要一个零成本、可自托管的港美股 PE 历史分位观察站，作为自用的价值投资决策辅助。

## What Changes

- **新建** "价值观察站" web 工具，输入 ticker 即可查看 PE-TTM 历史曲线和当前所处分位
- **覆盖** 港股（`0700.HK`）和美股（`AAPL`），通过 `global-stock-data` skill 的 5 个零密钥数据源拉取
- **支持** 三种时间窗口的分位计算：5 年、10 年、上市以来
- **支持** 用户维护的 watchlist（MVP 阶段仅 watchlist 内股票可查；开放式输入查询留到 v2）
- **离线批处理 + 在线读取** 架构：Python 脚本通过 GitHub Actions 每日盘后跑一次，预先算好所有指标写入 Cloudflare D1；Workers API 只做"读 DB 转 JSON"
- **正确处理** 复权（拆股不引起 PE 跳变）、负 EPS（亏损期标记并剔除出分位计算）、TTM 阶梯函数（季报发布日跳变是真实信号）
- **不做** Point-in-Time 数据还原（统一使用最新版财报，UI 加角标说明）

## Capabilities

### New Capabilities

- `stock-data-pipeline`: 离线数据流水线能力。从 `global-stock-data` skill 拉取港美股的历史价格、季度 EPS 和当前 PE 快照；执行复权对齐、TTM EPS 拼接、PE 序列计算、分位预计算；将结果增量写入 Cloudflare D1。涵盖调度、抓取、清洗、计算、入库的端到端职责。

- `pe-analytics-api`: 在线 PE 分析 API 能力。基于 Cloudflare Workers + D1 提供薄 HTTP API：返回单只股票的 PE-TTM 时间序列、当前指标卡片数据、watchlist 列表管理。所有重计算都已在流水线阶段完成，本能力只做读取和格式化。

- `pe-viewer-ui`: 前端可视化能力。React + ECharts 实现的单页应用：股票输入框、时间窗按钮（5y/10y/全部）、PE 历史主图（含当前点高亮和分位横线）、指标卡片区（当前 PE、历史中位、当前分位、极值）、亏损期遮罩、watchlist 管理、数据口径免责角标。

### Modified Capabilities

无（项目为全新建立）。

## Impact

- **新增代码库结构**：
  - `pipeline/` — Python 离线任务（依赖 `global-stock-data`、`pandas`、`numpy`、`cloudflare` SDK 或 `wrangler` CLI）
  - `api/` — Cloudflare Workers（TypeScript）
  - `web/` — React + Vite + ECharts 前端
  - `db/schema.sql` — D1 表结构与迁移
- **外部依赖**：
  - 安装 `global-stock-data` skill（已存在的开源 SKILL.md）
  - Cloudflare 账户（D1、Workers、Pages 均使用免费层）
  - GitHub Actions（免费 2000 分钟/月，远超需要）
- **部署目标**：全栈托管在 Cloudflare 边缘网络，月成本 $0
- **数据准确性边界**：使用最新版财报数据，不还原历史时点；负 EPS 期间剔除出分位计算；统一使用复权口径
- **MVP 范围限制**：仅 watchlist 内的股票（用户在 web UI 中维护）；开放式 ticker 查询是 v2 工作
