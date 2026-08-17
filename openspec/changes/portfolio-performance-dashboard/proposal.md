# Proposal: portfolio-performance-dashboard

## Why

持仓系统目前只有「状态看板」（资产结构、占比、风控约束的横截面视图），缺少「绩效看板」（时间序列视角）：由于持续入金，总资产上涨无法区分"赚的"还是"存的"，系统回答不了"我投得怎么样"。同时缺少已平仓交易统计、月度复盘、卖出计划与观察窗口，导致 IPS 中的卖出规则与纪律审计无处落地。

## What Changes

按 P0 → P1 → P2 三阶段推进，全部在 `portfolio/`（server + web）内完成：

**P0 绩效数据链**
- 新增单位净值计算（份额法，剔除出入金干扰）：月度净值序列、累计/年化收益率、最大回撤、月度盈亏
- 新增累计入金/出金 KPI（基于既有 `capital_events` 聚合）
- `trades` 表新增 `reason` 字段（交易原因），录入与展示链路打通
- 前端新增「绩效」页：KPI 行 + 净值/回撤双轴曲线 + 月度盈亏柱状图（叠累计收益率折线与平均线）

**P1 交易分析与复盘**
- 已平仓交易统计：胜率、盈亏比、平均单笔盈亏、总交易次数、平均持仓时长、手续费占总盈亏比例、单笔盈亏分布直方图（仅统计已平仓，浮盈不计入）
- 持仓页新增「持有时长」列（自首次买入日起算）
- 月度复盘报告：核心数据自动生成（总资产变化、月度收益、回撤、TOP3 盈利/亏损已平仓交易、按仓别纪律审计），归因/错误总结/改进措施为手填结构化字段并持久化

**P2 计划补全与观察窗口**
- 加仓计划扩展方向字段，支持卖出（减仓）计划：上涨/价格触发档位 + 卖出模拟预览（模拟卖出后持仓、成本、现金、集中度变化）
- 观察窗口：watchlist 管理（标的、备注、观察高点、可选估值备注），接入既有行情服务展示现价与高位回撤比例

## Capabilities

### New Capabilities
- `portfolio-performance-nav`: 单位净值与绩效指标——月度净值序列（份额法）、累计/年化收益率、最大回撤、月度盈亏、累计入金，及绩效页展示
- `closed-trade-analytics`: 已平仓交易统计与交易原因记录——胜率/盈亏比/持仓时长/盈亏分布/手续费占比，`trades.reason` 字段
- `monthly-review-report`: 月度复盘报告——自动核心数据 + 手填归因的结构化持久化与展示
- `sell-plan-simulation`: 卖出计划与卖出模拟——计划方向扩展、上涨触发档位、卖出侧预览
- `watchlist-window`: 观察窗口——watchlist CRUD、现价、观察高点棘轮维护、高位回撤比例

### Modified Capabilities

（无——现有 `openspec/specs/` 下的 data-source-routing / proxy-pool / stock-data-api 均属数据管线产品线，本变更不触及）

## Impact

- **Server**（`portfolio/server/src`）：新增 `performance.ts`（净值/绩效/已平仓统计/复盘）、`watchlist.ts`；`plans.ts` 扩展方向与卖出预览；`db.ts` 新增迁移 v5（`trades.reason`、`pyramid_plans.direction`、`monthly_reviews` 表、`watchlist` 表）；`app.ts` 新增路由
- **Web**（`portfolio/web/src`）：新增 PerformancePage（绩效）、ReviewPage（复盘）、WatchlistPage（观察）；PlansPage 支持卖出计划；HoldingsPage 加持有时长列；DataPage 交易录入加 reason；App.tsx 导航更新
- **兼容性**：全部为增量迁移与新端点，无破坏性变更；既有测试不受影响
- **口径约束**：净值内部统一 USD 计算、展示层换算；scope 默认 self（剔除授予仓）；摊薄成本主口径不变（不引入派息抵减）
