## ADDED Requirements

### Requirement: 月度复盘报告数据
系统 SHALL 提供 `GET /api/reviews/:month`（month 格式 YYYY-MM），返回自动计算块与手填块。自动块 MUST 包含：月初/月末总资产与变化额、当月投资盈亏（月末净资产 − 月初净资产 − 当月净入金）、月度收益率（NAV 环比）、截至当月的最大回撤、当月 TOP3 盈利与 TOP3 亏损平仓交易（含标的、盈亏金额、交易原因 reason）、当月手续费、纪律审计结果。自动块 SHALL 即时计算，不落库。

#### Scenario: 获取有数据月份的复盘
- **WHEN** 请求 2026-08 且该月有净值数据与平仓交易
- **THEN** 返回完整自动块，TOP3 列表按盈亏绝对值降序且每笔附 reason（可为 null）

#### Scenario: 请求无数据月份
- **WHEN** 请求的月份无任何快照
- **THEN** 自动块字段为 null，手填块照常返回，HTTP 200

### Requirement: 纪律审计（按仓别）
自动块 SHALL 包含纪律审计：(a) 稳健仓定投执行——当月是否存在 bucket=stable 的买入交易；(b) 现金底线——月末现金率是否 ≥ risk_settings.cashFloor。每项输出布尔与说明文字，MUST NOT 输出主观评分。

#### Scenario: 定投缺席
- **WHEN** 当月无任何 bucket=stable 的买入交易
- **THEN** 审计项 (a) 为 false，说明文字提示"本月未见稳健仓定投买入"

#### Scenario: 现金底线达标
- **WHEN** 月末现金率 35% 且 cashFloor 为 30%
- **THEN** 审计项 (b) 为 true

### Requirement: 复盘手填内容持久化
系统 SHALL 新增 `monthly_reviews` 表（user_id + month 唯一），含四个手填字段：归因分析（attribution）、典型错误（mistakes）、改进措施（improvements）、宏观环境（macro_note）。`PUT /api/reviews/:month` SHALL upsert 手填字段；`GET /api/reviews` SHALL 返回已有复盘月份列表。

#### Scenario: 首次保存复盘
- **WHEN** PUT /api/reviews/2026-08 提交四个手填字段
- **THEN** 创建记录，再次 GET 返回相同内容

#### Scenario: 重复保存为更新
- **WHEN** 对同一月份再次 PUT 修改 mistakes 字段
- **THEN** 记录被更新而非新增，updated_at 变化

### Requirement: 复盘页前端
前端 SHALL 新增「复盘」页（/reviews）：月份列表 + 单月详情。详情页以表格呈现自动块核心数据，TOP3 交易明细分列展示，手填块为四个可编辑文本域并支持保存。导航栏 SHALL 增加入口。

#### Scenario: 编辑并保存手填块
- **WHEN** 用户在 2026-08 复盘页填写归因分析并点击保存
- **THEN** 调用 PUT 接口成功后展示保存成功状态，刷新后内容保留
