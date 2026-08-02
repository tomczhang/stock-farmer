## ADDED Requirements

### Requirement: 回测结果 payload
系统 SHALL 输出 JSON 可序列化的回测 payload，至少包含：`params`（全部生效参数与默认值）、`entry`（信号日/成交日/入场价/支撑锚/目标价与来源）、`trades`（逐笔：日期、动作 buy/add/trim/stop_loss、价格、股数、金额、原因、档位）、`events`（stop_buy 红线、减仓启动、止损等）、`ledger_series`（逐日：收盘价、持仓股数、持仓成本线、已投入、已收回、浮动盈亏）、`summary`（总投入、已收回、剩余底仓股数与净成本、negative_cost、窗口末估值、总收益额与收益率、是否触发红线/止损）、`verdict_context`（入场日筑底判读摘要）。

#### Scenario: payload 契约
- **WHEN** 对任意 ticker + as_of 执行回测
- **THEN** payload 含上述全部顶层键且可 JSON 序列化，未入场时 trades/events 为空、summary 标注 not_entered

#### Scenario: 本地 API 透传
- **WHEN** 请求 `/api/pyramid-backtest/<ticker>?as_of=YYYY-MM-DD`（可选 window、budget 参数）
- **THEN** 返回与引擎一致的 payload；`demo=1` 或 ticker=DEMO 时返回确定性演示数据

### Requirement: 静态 HTML 回测报告
CLI SHALL 生成单页 HTML 回测报告：结论横幅（是否入场 / 触发红线 / 止损或持有到期 / 总收益与底仓净成本）、K 线图标注买卖点与目标价/支撑线/红线位、持仓成本线与仓位变化、逐笔账本明细表、纪律事件时间线。样式沿用现有 HeroUI v3 设计 token。

#### Scenario: 报告要素完整
- **WHEN** 打开生成的回测 HTML
- **THEN** 不滚动可见结论横幅；页面包含买卖点标注图、账本明细表与纪律事件（红线/止损）标记

### Requirement: React 回测交互页
web 前端 SHALL 提供回测页：输入标的 + 选择 as-of 日期（可选窗口天数）后调用本地 API 直接跑回测；展示结论卡、K 线买卖点图（ECharts）、账本明细表；demo 模式无需真实数据可预览。

#### Scenario: 交互回测
- **WHEN** 用户在回测页选择 ticker 与日期提交
- **THEN** 页面渲染该次回测的结论卡、图表与明细，加载/错误态有明确提示

### Requirement: 文案与语义红线
回测所有展示（payload 文案、HTML、前端）MUST 标注「历史模拟，仅供研究复盘，不构成投资建议或收益承诺」；MUST NOT 将信号质量表述为胜率/概率/准确率；收益数字 SHALL 与参数假设（手续费、执行价约定）一并展示，不得脱离假设单独渲染收益率。

#### Scenario: 免责与假设并列
- **WHEN** 渲染任一回测结果
- **THEN** 收益摘要旁同屏可见执行假设（次日开盘成交、手续费）与历史模拟免责声明
