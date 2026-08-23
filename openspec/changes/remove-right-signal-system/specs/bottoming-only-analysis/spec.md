## ADDED Requirements

### Requirement: 筑底-only 分析契约
系统 SHALL 仅计算 6 个左侧结构信号与筑底三迹象，不得计算、返回或展示站回均线、回踩不破、放量反包、MACD 金叉、低点抬升等右侧信号及其聚合结果。

#### Scenario: 当前报告不含右侧体系
- **WHEN** 调用当前模式 signal report
- **THEN** signals 仅含 left 类别，payload 不含 right score、right count、right states 或 right phase

### Requirement: 筑底结论与结构强度
系统 SHALL 以筑底档位和洗盘干净度作为唯一主结论与主分数；左侧信号仅作为证据明细，不得再聚合成竞争性的总确认度。`trend_running` SHALL 继续表示上升趋势中途不适用筑底框架。所有得分语义 MUST 为结构强度，不得表述为胜率、概率或准确率。

#### Scenario: 三迹象齐备
- **WHEN** 三项筑底迹象均为明显
- **THEN** 结论为筑底成立，操作提示不得要求等待右侧确认

### Requirement: 筑底历史结构序列
历史报告 SHALL 提供 `bottoming_history`，每点至少包含日期、收盘价、归一化价格、筑底档位、洗盘干净度和三迹象状态；不得包含右侧状态或左侧聚合总分。日线、指数和所有结构输入 MUST 截断到每点日期。

#### Scenario: 历史点防未来函数
- **WHEN** 为历史日期生成 bottoming history 点
- **THEN** 该点结构结论仅使用该日及以前的数据，追加未来 K 线不改变该点结论

### Requirement: 前瞻标签保持隔离
系统 SHALL 继续提供后 5/10/20 日收益与 20 日最大涨幅/回撤等事后证伪标签，但这些标签 MUST NOT 影响结构强度、筑底档位、文案或回测入场。

#### Scenario: 前瞻结果不回灌
- **WHEN** 某历史点后续出现大涨或大跌
- **THEN** 该历史点的筑底判断与不知道未来时完全一致

### Requirement: 手动决策日回测入场
金字塔回测 SHALL 将用户选择的 `as_of` 作为手动决策日，并于下一交易日开盘建立标准首仓；不得自动扫描筑底或右侧信号寻找买点。支撑、目标和后续决策只能使用相应决策日及以前的数据。

#### Scenario: 手动决策日次日入场
- **WHEN** 用户选择 as_of 且存在下一交易日
- **THEN** 系统按标准首仓在下一交易日开盘买入，不检查筑底或右侧触发

### Requirement: 删除右侧入场实验室
系统 MUST NOT 提供基于右侧信号组合筛选的入场扫描 API 或页面。

#### Scenario: 旧入场扫描入口不可用
- **WHEN** 调用旧 `/api/entry-scan/:ticker` 或访问 `/entry-lab`
- **THEN** 服务不得返回旧右侧筛选能力
