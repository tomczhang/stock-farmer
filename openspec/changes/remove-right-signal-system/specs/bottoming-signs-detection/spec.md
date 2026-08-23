## MODIFIED Requirements

### Requirement: 筑底判读结论聚合
系统 SHALL 将三迹象聚合为唯一筑底结论：仍在下跌（0 项明显）→ 迹象初现（1 项明显或 ≥2 项初现）→ 筑底基本成立（≥2 项明显）→ 筑底成立（3 项明显）。同时 SHALL 输出洗盘干净度，其语义为结构强度。上升趋势中途 SHALL 单列为趋势运行中。

#### Scenario: 三迹象齐备
- **WHEN** 缩量下跌、假破位收回、筹码稳定三项均为明显
- **THEN** 结论为筑底成立，提示不得包含等待右侧出手点或右侧触发条件

#### Scenario: 迹象不足
- **WHEN** 三迹象均未出现
- **THEN** 结论为仍在下跌，提示为等待筑底迹象出现

### Requirement: as-of 历史复盘防未来函数
筑底三迹象与聚合结论在 as-of 模式下 SHALL 仅使用截至有效交易日的数据；前瞻标签 SHALL 仅用于证伪展示，MUST NOT 反向影响得分、档位、文案或回测入场。

#### Scenario: 历史模式截断
- **WHEN** 请求任意历史 as_of 日期
- **THEN** 三迹象和结论仅使用有效日期及以前的数据

## REMOVED Requirements

### Requirement: 右侧出手确认层
**Reason**: 用户不再需要完整右侧信号体系。
**Migration**: 筑底判读成为唯一结构结论，不提供替代右侧触发层。
