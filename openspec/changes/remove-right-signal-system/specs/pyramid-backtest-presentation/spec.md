## MODIFIED Requirements

### Requirement: 回测结果 payload
系统 SHALL 输出可 JSON 序列化的回测 payload，entry SHALL 标注用户选择的手动决策日、次日成交、支撑和目标；筑底判读仅可作为背景快照，不得被描述为自动入场条件。params、entry、trades、events、ledger_series 与 summary MUST NOT 包含右侧绿灯、strong_right 模式或 strong_right 参数。

#### Scenario: payload 无右侧字段
- **WHEN** 对任意 ticker 执行回测
- **THEN** payload 可完整渲染且不存在 right_green、right_green_all、strong_right 或紧止损来源

### Requirement: React 回测交互页
React 回测页 SHALL 将入场规则描述为“手动选择决策日的纪律推演”，并继续展示结论、价格轨迹、买卖点、纪律事件和账本；不得展示右侧触发信号或宣称系统识别了买点。

#### Scenario: 入场卡只展示筑底上下文
- **WHEN** 回测已经入场
- **THEN** 入场卡展示筑底档位、洗盘干净度、支撑和目标，不展示右侧信号列表
