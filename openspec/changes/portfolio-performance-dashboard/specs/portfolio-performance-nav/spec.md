## ADDED Requirements

### Requirement: 月度净资产序列（含现金、缺月结转）
系统 SHALL 提供按月聚合的净资产序列（USD 口径）：每月每券商取最新月结单快照，净资产 = 持仓市值 + 现金余额。当某券商当月无快照时，系统 SHALL 沿用该券商最近一期快照值（carry-forward），并将该月标记为 `carried`。序列起点为首个存在任一券商快照的月份。

#### Scenario: 双券商正常月份
- **WHEN** 用户在 2026-07 有 IBKR 与 Futu 两份月结单（各含持仓与现金）
- **THEN** 2026-07 净资产 = 两家持仓市值 USD + 两家现金 USD 之和，coverage 为正常

#### Scenario: 单券商缺月 carry-forward
- **WHEN** IBKR 有 2026-06 与 2026-08 快照但缺 2026-07，Futu 三个月齐全
- **THEN** 2026-07 净资产中 IBKR 部分沿用其 2026-06 快照值，该月标记 `carried`，序列不出现塌陷

#### Scenario: scope=self 剔除授予仓
- **WHEN** 请求 scope=self 且持仓中存在 bucket=grant 的标的
- **THEN** 该标的市值不计入净资产序列，且 grant 标的的 transfer_in/transfer_out 资本事件不计入当月外部净流入

### Requirement: 单位净值计算（份额法）
系统 SHALL 以份额法计算月度单位净值：`NAV_0 = 1`，`shares_0 = V_0`；第 t 月 `shares_t = shares_{t-1} + F_t / NAV_{t-1}`，`NAV_t = V_t / shares_t`，其中 `F_t` 为当月外部净流入（capital_events USD 聚合），`V_t` 为当月末净资产。出入金 MUST 只改变份额、不直接改变净值。

#### Scenario: 入金不改变单位净值
- **WHEN** 某月无任何持仓涨跌（V_t = V_{t-1} + F_t）且当月有入金 F_t > 0
- **THEN** 该月 NAV_t 与 NAV_{t-1} 相等（误差 < 1e-9）

#### Scenario: 无出入金月份净值随资产变动
- **WHEN** 某月 F_t = 0 且 V_t = V_{t-1} × 1.05
- **THEN** NAV_t = NAV_{t-1} × 1.05

#### Scenario: 大额出入金警示
- **WHEN** 某月 |F_t| / V_{t-1} > 20%
- **THEN** API 响应中该月带 warning 标记，前端展示"本月净值受大额出入金影响"

### Requirement: 绩效衍生指标
系统 SHALL 基于净值序列输出：累计收益率（NAV_n − 1）、年化收益率（NAV_n^(12/月数) − 1，月数不足 12 时 MUST 附 `annualizedPartial` 标记）、最大回撤（序列峰谷最深跌幅）、当月盈亏（V_t − V_{t-1} − F_t）序列、累计入金/出金（capital_events 按类型聚合）。

#### Scenario: 最大回撤计算
- **WHEN** 净值序列为 [1, 1.2, 0.9, 1.1]
- **THEN** 最大回撤 = (0.9 − 1.2) / 1.2 = −25%

#### Scenario: 未满一年的年化标注
- **WHEN** 净值序列只有 6 个月
- **THEN** 年化收益率照常计算但响应带 `annualizedPartial: true`

#### Scenario: 累计入金聚合
- **WHEN** capital_events 含 cash_in $10,000、cash_in $5,000、cash_out $2,000
- **THEN** 累计入金 = $15,000，累计出金 = $2,000（transfer 类按估值金额并入各自方向）

### Requirement: 绩效 API 端点
系统 SHALL 提供 `GET /api/portfolio/performance`，支持 `scope`（self/all，默认 self）与 `display`（USD/CNY）参数，返回净值序列（含每月 NAV、回撤、当月盈亏、coverage、warning）、KPI（累计/年化收益率、最大回撤、累计入金出金、当月盈亏）。内部计算 MUST 统一 USD，仅展示金额经汇率换算。

#### Scenario: 未登录拒绝
- **WHEN** 无有效会话 cookie 请求该端点
- **THEN** 返回 401

#### Scenario: 无月结单数据
- **WHEN** 用户无任何 statements
- **THEN** 返回空序列与 null KPI，HTTP 200，不抛错

### Requirement: 绩效页前端展示
前端 SHALL 新增「绩效」页（/performance）：KPI 行（累计收益率、年化收益率、最大回撤、累计入金、当月盈亏）；净值曲线图（左轴单位净值折线、右轴回撤填充面积，carried 月份视觉区分）；月度盈亏柱状图（盈利青绿、亏损暗红，叠加月度累计收益率折线双 Y 轴与全期平均月度盈亏虚线）。导航栏 SHALL 增加入口。

#### Scenario: 绩效页渲染
- **WHEN** 用户登录后访问 /performance 且存在 ≥ 2 个月净值数据
- **THEN** 页面展示 KPI 行与两张图表，数值与 API 响应一致

#### Scenario: 支持 scope 与货币切换
- **WHEN** 用户切换「剔除授予仓/含授予仓」或 USD/CNY
- **THEN** 页面重新拉取对应参数的数据并刷新展示
