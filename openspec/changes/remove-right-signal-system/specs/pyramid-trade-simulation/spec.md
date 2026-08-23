## MODIFIED Requirements

### Requirement: 入场判定与建仓
系统 SHALL 将用户请求的 as-of 有效交易日视为手动选择的决策日，不再扫描或判断自动买点。若存在下一交易日，系统 SHALL 在次日开盘买入标准首仓；若不存在则生成待执行订单。系统 MUST NOT 读取筑底档位或右侧信号决定是否入场。

#### Scenario: 手动决策日次日建仓
- **WHEN** 用户选择第 N 个交易日作为 as_of 且存在第 N+1 个交易日
- **THEN** 第 N+1 日以开盘价买入标准首仓，并将模式标注为 manual

#### Scenario: 决策日是数据末日
- **WHEN** as_of 是最后一个可用交易日
- **THEN** 入场订单标记为待执行，不得虚构成交

### Requirement: 防未来函数与执行价约定
支撑、目标、入场上下文和逐日决策 MUST 仅使用相应决策日及以前的数据。所有成交 SHALL 采用决策日收盘后形成、次一交易日开盘价成交的约定。

#### Scenario: 截断一致性
- **WHEN** 数据源追加决策日之后的 K 线
- **THEN** as-of 日锚定的支撑、目标和首仓订单不变

## REMOVED Requirements

### Requirement: 强右侧通道入场（可配置第二路径）
**Reason**: strong_right 完全依赖被删除的右侧信号体系。
**Migration**: 使用手动 as-of 决策日入场；删除相关参数、减半首仓、紧止损和元数据。
