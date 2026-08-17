## ADDED Requirements

### Requirement: 交易原因记录
系统 SHALL 在 `trades` 表新增可选 `reason` 文本字段。交易创建与编辑接口 SHALL 接受该字段，交易列表与详情响应 SHALL 返回该字段。历史交易无 reason 时返回 null，不影响既有功能。

#### Scenario: 录入交易时填写原因
- **WHEN** 用户通过交易录入接口提交含 `reason: "阶梯-10%触发加速"` 的买入交易
- **THEN** 交易保存成功，后续查询该交易返回相同 reason

#### Scenario: 历史交易兼容
- **WHEN** 查询迁移前导入的既有交易
- **THEN** reason 字段为 null，响应结构其余部分不变

### Requirement: 已平仓交易统计
系统 SHALL 提供 `GET /api/trades/closed-stats`，仅统计已平仓交易（`side='sell'` 且 `realized_gain_loss` 非空），持仓浮盈 MUST NOT 计入。输出：总平仓笔数、盈利/亏损笔数、胜率、平均单笔盈利、平均单笔亏损、盈亏比（平均盈利 ÷ |平均亏损|）、最大单笔盈利/亏损、累计手续费、手续费占经济盈亏比例。`realized_gain_loss` 缺失的卖出交易 SHALL 单独计数为 `unknownCount`，不进入胜率分母。

#### Scenario: 基础统计
- **WHEN** 用户有 3 笔平仓：+$300、+$100、−$200
- **THEN** 胜率 = 2/3，平均盈利 = $200，平均亏损 = $200，盈亏比 = 1.0

#### Scenario: 缺失盈亏字段的卖出单
- **WHEN** 存在 1 笔 realized_gain_loss 为 null 的卖出交易
- **THEN** 该笔计入 unknownCount，不影响胜率与盈亏比

#### Scenario: 无平仓交易
- **WHEN** 用户从未卖出
- **THEN** 返回全零/null 统计，HTTP 200

### Requirement: 单笔盈亏分布直方图
系统 SHALL 在 closed-stats 响应中返回服务端分桶的单笔盈亏分布：桶数固定 11、围绕 0 对称、桶宽按盈亏绝对值 P95 自适应；每桶含区间与笔数。前端 SHALL 以柱状图展示并在图旁标注核心统计文字（总笔数、盈利/亏损单数、胜率、平均单笔盈亏、盈亏比、最大单笔盈亏）。

#### Scenario: 分桶输出
- **WHEN** 存在至少 1 笔平仓交易
- **THEN** 响应含 11 个桶，各桶笔数之和 = 平仓总笔数（不含 unknown）

### Requirement: 持有时长
系统 SHALL 以 FIFO 近似计算持有时长：平仓单持有时长 = 卖出日 − 按 symbol 首次累计买入量覆盖该笔卖出数量的买入日；无法配对（如转仓入）标记 unknown 且不计入平均。closed-stats SHALL 输出平均持有时长（天）。持仓页 SHALL 为每个持仓标的展示自首次买入日起算的持有时长列，无交易记录的持仓显示"—"。

#### Scenario: 平仓单持有时长
- **WHEN** 2026-01-10 买入 10 股，2026-03-10 卖出 10 股
- **THEN** 该笔平仓持有时长 = 59 天并计入平均

#### Scenario: 转仓入无法配对
- **WHEN** 卖出的标的在 trades 中无任何买入记录
- **THEN** 该笔持有时长为 unknown，不计入平均持有时长
