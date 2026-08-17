# Tasks: portfolio-performance-dashboard

按 P0 → P1 → P2 顺序推进；每个阶段完成后跑对应验证再进入下一阶段。

## 1. Schema 与类型（P0-P2 共用基础）

- [x] 1.1 `db.ts` 新增迁移 v5：`trades.reason`、`pyramid_plans.direction`（DEFAULT 'add'）、`monthly_reviews` 表、`watchlist` 表
- [x] 1.2 `types.ts` 扩展：TradeInput 增 reason；PlanInput 增 direction；新增 MonthlyReviewInput、WatchlistInput 类型；tier trigger_type 增 `pct_gain`
- [x] 1.3 验证：既有测试全绿（迁移幂等、旧数据兼容）

## 2. P0 绩效数据链（portfolio-performance-nav + trades.reason）

- [x] 2.1 新建 `performance.ts`：`monthlyNetAssets(userId, scope)`——positions+cash_balances 按月按券商聚合、券商缺月 carry-forward（标记 carried）、scope=self 剔除 grant 持仓
- [x] 2.2 `performance.ts`：月度外部净流入 `monthlyFlows(userId, scope)`——capital_events USD 聚合，scope=self 剔除 grant 标的 transfer 事件
- [x] 2.3 `performance.ts`：份额法净值序列 + 衍生指标（累计/年化收益率含 annualizedPartial、最大回撤、当月盈亏、累计入金/出金、|F_t|/V_{t-1}>20% 警示）
- [x] 2.4 `app.ts` 挂 `GET /api/portfolio/performance`（scope/display 参数，鉴权，display 换算仅作用于金额字段）
- [x] 2.5 `ledger.ts`/`app.ts`：trades 创建/编辑/列表链路透传 `reason` 字段
- [x] 2.6 Server 测试：净值算法单测（入金不改净值、无流入月随资产变动、回撤 −25% 用例、carry-forward、scope 剔除、空数据 200、大额流入 warning、annualizedPartial）；trades.reason 往返
- [x] 2.7 Web：`api.ts` 增 performance 接口与类型；新建 `PerformancePage`（KPI 行 + 净值/回撤双轴图 + 月度盈亏柱状图叠累计收益率折线与均值虚线，青绿/暗红配色，carried 视觉区分，scope/货币切换）；`App.tsx` 导航加「绩效」
- [x] 2.8 Web：DataPage 交易表单增 reason 输入，交易列表展示 reason
- [x] 2.9 P0 验证：`cd portfolio/server && npm test`、`npm run typecheck`（如有）；`cd portfolio/web && npm run build`

## 3. P1 交易分析与复盘（closed-trade-analytics + monthly-review-report）

- [x] 3.1 `performance.ts`：已平仓统计——胜率/盈亏比/平均与最大单笔盈亏/unknownCount/手续费占经济盈亏比例/11 桶对称直方图（P95 自适应桶宽）
- [x] 3.2 `performance.ts`：持有时长 FIFO 近似（平仓单配对 + 持仓标的首次买入日）；unknown 不入平均
- [x] 3.3 `app.ts` 挂 `GET /api/trades/closed-stats`
- [x] 3.4 `performance.ts`：复盘自动块（月资产变化、当月盈亏、月度收益率、截至当月最大回撤、TOP3 盈利/亏损平仓交易含 reason、当月手续费、纪律审计 a/b）
- [x] 3.5 `monthly_reviews` upsert/查询服务；`app.ts` 挂 `GET /api/reviews`、`GET/PUT /api/reviews/:month`（month 格式校验）
- [x] 3.6 Server 测试：closed-stats（基础统计 2/3 胜率用例、unknown 桶、无平仓 200、直方图桶数与总数守恒）；持有时长（59 天用例、转仓 unknown）；复盘（自动块、无数据月份 null、upsert 更新、纪律审计定投缺席/现金达标）
- [x] 3.7 Web：PerformancePage 追加平仓统计块（直方图 + 标注文字）；HoldingsPage 增持有时长列（无记录显示 —）
- [x] 3.8 Web：新建 `ReviewsPage`（月份列表 + 自动块表格 + TOP3 明细 + 四个手填文本域保存）；导航加「复盘」
- [x] 3.9 P1 验证：server 全量测试 + web build

## 4. P2 计划补全与观察窗口（sell-plan-simulation + watchlist-window）

- [x] 4.1 `plans.ts`：direction 支持——创建/编辑接受 direction，direction×trigger_type 组合校验（错配 400），既有计划默认 add 行为不变
- [x] 4.2 `plans.ts`：trim 档位语义（pct_gain 触发价 = base×(1+pct)；pct 按当前持仓数量、amount 换算股数）；全档位合计超卖校验 400
- [x] 4.3 `plans.ts`：trim 逐档预览（剩余数量/账面成本等比结转/回收现金−估算费用/标的与仓别集中度/现金率），不计税负
- [x] 4.4 新建 `watchlist.ts`：CRUD（唯一约束 409）、添加时报价初始化 ref_high、refresh 批量报价 + 棘轮只升不降 + 回撤计算 + 报价失败降级 null
- [x] 4.5 `app.ts` 挂 watchlist 路由与 plans direction 分支
- [x] 4.6 Server 测试：plans（兼容、错配 400、超卖 400、pct_gain 触发价 120 用例、预览数量/成本/集中度单调性）；watchlist（CRUD、409、棘轮升/不降、refresh 降级、ref_high 手动重置）——报价一律注入 stub QuoteFetcher
- [x] 4.7 Web：PlansPage 方向切换 + trim 档位表单 + 预览表格 + 列表视觉区分
- [x] 4.8 Web：新建 `WatchlistPage`（表格 + 添加/编辑/删除 + 刷新 + 回撤着色）；导航加「观察」
- [x] 4.9 P2 验证：server 全量测试 + web build

## 5. 收尾验证

- [x] 5.1 Server：`npm test` 全绿（含既有 6 个测试文件无回归）
- [x] 5.2 Web：`npm run build` 通过（tsc + vite）
- [ ] 5.3 手工冒烟：本地起 server+web，依次走绩效页（scope/货币切换）、复盘页（保存手填）、卖出计划预览、观察页刷新
- [ ] 5.4 OpenSpec：核对实现与 specs 一致，准备 verify/archive
