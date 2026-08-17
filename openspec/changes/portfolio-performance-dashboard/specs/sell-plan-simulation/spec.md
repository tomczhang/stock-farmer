## ADDED Requirements

### Requirement: 计划方向扩展
系统 SHALL 在 `pyramid_plans` 表新增 `direction` 字段（'add' | 'trim'，默认 'add'）。既有计划自动归为 add，行为不变。创建/编辑计划接口 SHALL 接受 direction；服务端 MUST 校验 direction 与 trigger_type 的合法组合：add 计划允许 `pct_drop`/`price`，trim 计划允许 `pct_gain`/`price`，错配返回 400。

#### Scenario: 既有计划兼容
- **WHEN** 迁移后查询迁移前创建的加仓计划
- **THEN** direction 为 'add'，预览与档位行为与迁移前一致

#### Scenario: 触发类型错配被拒绝
- **WHEN** 创建 direction='trim' 且档位 trigger_type='pct_drop' 的计划
- **THEN** 返回 400 与说明错误

### Requirement: 卖出计划档位语义
trim 计划的档位 SHALL 支持：`pct_gain` 触发（现价自基准价上涨达到阈值）或 `price` 触发（达到目标价）；分配方式 `pct`（卖出当前持仓数量的百分比）或 `amount`（按金额换算卖出数量）。服务端 MUST 校验计划全档位合计卖出数量不超过当前持仓数量。

#### Scenario: 超卖校验
- **WHEN** 持仓 100 股，trim 计划两档各配 pct=60%（按当前持仓计算合计 > 100%）
- **THEN** 创建/预览返回 400 并说明超出持仓

#### Scenario: pct_gain 档位触发价计算
- **WHEN** trim 计划 base_price=100、某档 pct_gain=20%
- **THEN** 预览显示该档触发价为 120

### Requirement: 卖出模拟预览
系统 SHALL 为 trim 计划提供逐档预览：每档执行后剩余持仓数量、剩余账面成本（按卖出数量等比结转，不改变每股摊薄成本）、预计回收现金（含估算费用扣减）、执行后该标的占持仓比例与所在仓别占比、执行后现金率。预览 MUST NOT 计算税负。

#### Scenario: 逐档预览数量与成本
- **WHEN** 持仓 100 股、账面成本 $1,000，某档卖出 40%（40 股）触发价 $15
- **THEN** 预览显示剩余 60 股、剩余账面成本 $600、回收现金 ≈ $600 − 估算费用

#### Scenario: 集中度随卖出下降
- **WHEN** 预览多档 trim 计划
- **THEN** 逐档展示的该标的集中度与仓别集中度单调不升，现金率单调不降

### Requirement: 卖出计划前端
PlansPage SHALL 支持创建与展示卖出计划：方向切换（加仓/减仓）、trim 档位表单（涨幅/目标价触发、卖出比例/金额）、逐档预览表格。加仓与减仓计划在列表中 SHALL 有明确视觉区分。

#### Scenario: 创建卖出计划
- **WHEN** 用户选择"减仓"方向，为某持仓标的配置两档（+20% 卖 30%、+40% 卖 30%）
- **THEN** 计划创建成功，预览表格展示两档触发价、卖出股数、剩余持仓与回收现金
