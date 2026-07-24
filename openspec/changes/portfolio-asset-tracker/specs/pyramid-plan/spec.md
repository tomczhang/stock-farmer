# pyramid-plan

## ADDED Requirements

### Requirement: 参数化金字塔加仓计划
系统 SHALL 支持按标的创建金字塔加仓计划：基准价、总预算、币种，以及可增删排序的档位列表。
每档触发方式 SHALL 支持相对基准价跌幅 %（pct_drop）或绝对价格（price）二选一；
每档仓位 SHALL 支持占总预算 %（pct）或绝对金额（amount）二选一。

#### Scenario: 计划计算
- **WHEN** 用户保存含 N 档的计划
- **THEN** 系统对每档返回：触发买入价、投入金额、可买股数、累计投入、累计摊薄成本

#### Scenario: 档位自定义
- **WHEN** 用户把第 2 档从"跌 10%"改为"具体价格 85.5"，仓位从 20% 改为固定金额 5000
- **THEN** 计算结果按新参数重算

### Requirement: 闲置现金可行性校验
计划总投入 SHALL 与用户当前闲置现金（同币种折算）比对；超出时 SHALL 返回警告但不阻断保存。

#### Scenario: 预算超出现金
- **WHEN** 计划总投入大于当前闲置现金
- **THEN** 响应包含 warning 字段说明缺口金额，计划仍保存成功

### Requirement: 档位成交追踪
系统 SHALL 支持将档位标记为已成交（filled_at），用于追踪计划执行进度。

#### Scenario: 标记已成交
- **WHEN** 用户对第 1 档打勾
- **THEN** 该档记录成交时间，计划进度反映已投入金额
