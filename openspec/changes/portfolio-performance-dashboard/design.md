# Design: portfolio-performance-dashboard

## Context

持仓系统（`portfolio/server` Hono + better-sqlite3，`portfolio/web` React + ECharts 封装 `Chart` 组件）已有：
- 月结单快照（`statements`/`positions`/`cash_balances`，按券商、按 as_of）
- 资本事件（`capital_events`：cash_in/out、transfer_in/out、adjustment，带 event_date 与 fx_to_usd）
- 交易流水（`trades`：含 `cost_basis_disposed`、`realized_gain_loss`、`fx_to_usd`）
- 金字塔加仓计划（`pyramid_plans`/`plan_tiers`，跌幅/价格触发 + 逐档预览 + 安全评分）
- 行情服务（`quotes.ts`：腾讯 HK / Yahoo US，10 分钟缓存，QuoteFetcher 可注入 stub）
- 迁移机制（`db.ts` MIGRATIONS 数组，当前 version 4，`schema_migrations` 记录）
- 授予仓（grant bucket）与 self scope 剔除逻辑（`portfolio.ts summary()`）

缺失：时间序列绩效（净值/回撤/月度盈亏）、已平仓交易统计、月度复盘、卖出计划、观察窗口。

约束：
- 测试环境禁真实网络（QuoteFetcher 必须 stub）
- 净值内部统一 USD，展示层经 `cvt` 换算
- 摊薄成本主口径不变（股息单列，不抵减成本）

## Goals / Non-Goals

**Goals:**
- 单位净值序列（份额法）与衍生指标：累计/年化收益率、最大回撤、月度盈亏、累计入金
- 已平仓交易统计（仅平仓单）、持有时长、月度复盘报告（自动数据 + 手填归因）
- 卖出计划与卖出模拟预览、观察窗口（现价 + 高位回撤）
- 全程增量迁移，不破坏既有 API 与测试

**Non-Goals:**
- 日频净值（月度先行；日频留给后续每日快照任务升级）
- 夏普比率（净值样本 ≥ 12 个月后再评估，本变更不实现）
- TWR 日级精度 / Modified Dietz（份额法月度粒度足够）
- 派息抵减成本口径（明确不做）
- PE 分位 / 右侧信号的数据打通（观察窗口仅现价 + 高位回撤 + 手填备注；跨系统集成另立变更）
- 基准对比、回测

## Decisions

### D1 净值算法：份额法（unit-NAV），月度粒度
- `NAV_0 = 1`，`shares_0 = V_0 / 1`（V_0 = 首个有快照月份的月末净资产 USD）
- 第 t 月：`shares_t = shares_{t-1} + F_t / NAV_{t-1}`，`NAV_t = V_t / shares_t`
  - `F_t` = 当月外部净流入 USD（capital_events 聚合；出入金按「以上月末净值申购/赎回份额」处理）
  - `V_t` = 当月末净资产 USD（持仓市值 + 现金）
- 衍生：累计收益率 = `NAV_n − 1`；年化 = `NAV_n^(12/月数) − 1`（月数 < 12 时展示但标注"未满一年"）；最大回撤 = NAV 序列峰谷；当月盈亏 = `V_t − V_{t-1} − F_t`
- 备选方案：Modified Dietz（日加权）——被否，月结单粒度下日权重是伪精度；XIRR——是 MWR 不是净值，无法画曲线
- 理由：份额法确定性强、可单测（给定 V/F 序列输出唯一）、公式与思维导图口径一致

### D2 月度净资产序列：新建 `monthlyNetAssets()`，不复用 `history()`
`history()` 有两个对净值不可接受的缺陷：不含现金；券商缺月时该券商资产直接消失（序列塌陷）。新函数：
- 聚合 positions + cash_balances，每月每券商取最新 as_of
- **券商缺月 carry-forward**：某券商当月无快照时，沿用其最近一期快照值，该月 coverage 标记 `carried`（沿用现有三级 coverage 风格，前端净值曲线上以空心点/虚线段提示）
- scope=self 时剔除 grant bucket 持仓（复用 `bucketFor`）；grant 相关 transfer_in 事件同步从 F_t 剔除（symbol 归属 grant bucket 的 transfer 事件不计入外部流入）
- 起点：第一个存在任一券商快照的月份

### D3 已平仓统计：直接消费 `trades.realized_gain_loss`，不重算配对
- 平仓单 = `side='sell'` 且 `realized_gain_loss IS NOT NULL` 的交易（IBKR 导入已带该字段）
- 胜率 = 盈利平仓单数 / 平仓单总数；盈亏比 = 平均单笔盈利 / |平均单笔亏损|；分布直方图服务端分桶（固定桶数 11，对称围绕 0，桶宽按 P95 自适应）
- 持有时长：FIFO 配对近似——按 symbol 取「首次累计买入达到该笔卖出数量」的买入日期与卖出日期差；无买入记录（转仓入）时标记 unknown 不计入平均
- 手续费占比 = 累计手续费 / |经济盈亏|（economicTotal，复用 summary 的 PnL 分解）
- 备选：完整 lot-level FIFO 引擎——被否，IBKR 已给出 realized_gain_loss，重算引入两套口径冲突风险

### D4 复盘报告：自动数据即时计算 + 手填字段落库 `monthly_reviews`
- 新表 `monthly_reviews(id, user_id, month UNIQUE(user_id,month), attribution TEXT, mistakes TEXT, improvements TEXT, macro_note TEXT, created_at, updated_at)`
- `GET /api/reviews/:month` 返回：自动块（总资产变化、当月盈亏、月度收益率、当月最大回撤、TOP3 盈利/亏损平仓交易含 reason、当月手续费、纪律审计）+ 手填块
- 纪律审计（按仓别）：当月 trades 中 bucket=stable（稳健仓）的买入是否存在（定投执行）；现金率是否始终 ≥ cashFloor（月末快照口径）；输出布尔 + 说明，不做主观评分
- 备选：复用 notes 表加 month 列——被否，复盘是结构化四字段且 (user,month) 唯一，语义与自由笔记不同

### D5 卖出计划：扩展 `pyramid_plans.direction`，复用 tier 机制
- 迁移：`ALTER TABLE pyramid_plans ADD COLUMN direction TEXT NOT NULL DEFAULT 'add'`（'add' | 'trim'）
- trim 计划：trigger_type 复用 `price`（目标价）并新增 `pct_gain`（自基准价涨幅）；alloc 语义变为「卖出当前持仓数量的百分比」（pct）或「卖出金额」（amount）
- trim 预览：逐档模拟卖出后 持仓数量/摊薄成本（成本口径：账面成本按卖出数量等比例结转，主口径不变）/现金增加/该标的集中度/仓别集中度变化；**不做** 已实现盈亏预估的税负计算
- 风控方向反转：卖出无需 safe-add 检查，但需校验卖出数量 ≤ 当前持仓
- 备选：独立 sell_plans 表——被否，tier 结构完全同构，一张表加方向字段维护成本最低

### D6 观察窗口：`watchlist` 表 + 观察高点棘轮
- 新表 `watchlist(id, user_id, market, symbol, name, note, ref_high REAL, ref_high_date TEXT, created_at, UNIQUE(user_id, market, symbol))`
- 高位回撤 = `(price − ref_high) / ref_high`；`ref_high` 初始 = 添加时现价（或用户手填），此后每次报价刷新若 `price > ref_high` 自动上调并记日期（棘轮，只升不降；用户可手动重置）
- 理由：系统无历史 K 线存储，棘轮是零依赖且随使用时间收敛到真实高点的方案；手填入口兜底（如添加时直接填 52 周高）
- PE 等估值指标：仅提供手填 `note` 字段承载，不自动拉取（Non-Goal）

### D7 API 与前端结构
- Server 新增 `performance.ts`（D1-D4 的计算与查询）、`watchlist.ts`（D6）；`plans.ts` 扩展 direction 分支；`app.ts` 挂路由：
  - `GET /api/portfolio/performance?scope=&display=`（净值序列 + KPI + 月度盈亏 + 累计入金）
  - `GET /api/trades/closed-stats?scope=&display=`（P1 统计 + 直方图分桶）
  - `GET/PUT /api/reviews/:month`；`GET /api/reviews`（列表）
  - `GET/POST/PATCH/DELETE /api/watchlist`；`POST /api/watchlist/refresh`（拉报价 + 棘轮更新）
- Web：新增 `/performance`（PerformancePage：KPI 行、净值/回撤双轴、月度盈亏柱状图叠累计收益率折线与均值虚线；P1 后追加平仓统计块）、`/reviews`（列表 + 单月编辑）、`/watchlist`；PlansPage 增方向切换；HoldingsPage 增持有时长列；DataPage 交易表单增 reason
- 月度盈亏柱状图配色遵循导图：盈利青绿（`#14b8a6` 系）、亏损暗红（`#b91c1c` 系）

### D8 迁移 v5（单次迁移覆盖全部 schema 变更）
```sql
ALTER TABLE trades ADD COLUMN reason TEXT;
ALTER TABLE pyramid_plans ADD COLUMN direction TEXT NOT NULL DEFAULT 'add';
CREATE TABLE monthly_reviews (...);
CREATE TABLE watchlist (...);
```
一次迁移而非三次：P0-P2 同变更交付，避免中间版本状态。

## Risks / Trade-offs

- [券商缺月 carry-forward 使净值失真] → coverage=carried 标注 + 前端视觉区分；月结单齐全后自动修复
- [月内出入金按上月末净值折算份额，大额入金当月净值有偏差] → 月度粒度下不可避免；F_t 单月占比 > 20% 时 API 返回 warning 字段，前端提示"本月净值受大额出入金影响"
- [realized_gain_loss 依赖券商导入质量] → 平仓单缺该字段时归入 `unknown` 桶单独计数展示，不混入胜率分母
- [持有时长 FIFO 近似在部分卖出+再买入场景有偏差] → 展示口径标注"近似"；unknown 不计入平均
- [棘轮高点冷启动不准] → 添加时允许手填 ref_high；UI 明示"观察高点自 YYYY-MM-DD 起跟踪"
- [pct_gain 触发档与既有 pct_drop 语义相邻易混] → types 层用 direction 约束合法 trigger_type 组合，服务端校验拒绝错配

## Migration Plan

1. 迁移 v5 随服务启动自动执行（幂等，`schema_migrations` 守护）
2. 新端点全部增量，旧端点响应结构不变（`trades` 列表新增 reason 字段为可选附加）
3. 回滚：新表/新列无删除风险，回滚代码即可，schema 残留无害

## Open Questions

（无——口径均已在会话中确认：scope 默认 self、USD 内部计算、股息不抵减成本、夏普暂缓）
