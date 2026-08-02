## ADDED Requirements

### Requirement: 报告 payload 以筑底判读为第一结论
报告 payload SHALL 新增 `bottoming` 顶层区块，包含：聚合结论（档位 / 图标 / 大白话操作提示 / 下一步触发条件）、洗盘干净度得分与百分比、三迹象数组（每项含 id、名称、得分、三档状态、证据描述、子维度明细）。原 11 信号左右分组数据 SHALL 保留在 payload 中供出手确认层与明细展示使用，但结论字段 SHALL 由筑底判读驱动。

#### Scenario: payload 结构
- **WHEN** 调用 build_signal_report 生成任意 ticker 的报告
- **THEN** payload 顶层含 `bottoming` 区块，`bottoming.signs` 恰好 3 项且顺序固定为缩量下跌、假破位收回、筹码稳定

#### Scenario: 本地 API 透传
- **WHEN** 请求 `/api/signal-report/<ticker>`
- **THEN** 响应 JSON 原样包含 `bottoming` 区块，接口路径与既有查询参数（as_of、demo 等）不变

### Requirement: 静态 HTML 报告筑底判读区块
analyze.py 生成的静态 HTML 报告 SHALL 在首屏展示筑底判读区块：聚合结论横幅（档位 + 洗盘干净度）+ 三迹象卡片（状态灯、得分、大白话证据），右侧出手确认层排在其后。样式沿用现有 HeroUI v3 设计 token。

#### Scenario: 首屏可见结论
- **WHEN** 用户打开生成的单票 HTML 报告
- **THEN** 不滚动即可看到筑底判读结论与三迹象状态，每张迹象卡片均含大白话证据描述

### Requirement: React 前端筑底判读展示
web 前端信号报告页 SHALL 以筑底判读区块为首屏主结论：聚合结论 + 三迹象卡片 + 出手确认层，K 线与支撑区间图表保留。demo 模式（`?demo=1`）SHALL 提供含 `bottoming` 区块的确定性演示数据。

#### Scenario: 前端渲染三迹象
- **WHEN** 前端获取到含 `bottoming` 区块的报告
- **THEN** 页面首屏渲染聚合结论与三张迹象卡片，三档状态以不同视觉状态区分

#### Scenario: demo 模式可用
- **WHEN** 以 demo=1 请求报告
- **THEN** 返回的演示 payload 含完整 `bottoming` 区块，前端无需真实数据即可开发调试

### Requirement: 文案语义红线
筑底判读相关的一切文案（得分标签、结论、证据描述、HTML 与前端展示）MUST NOT 使用"胜率、概率、准确率、必涨"等措辞；洗盘干净度 SHALL 标注为结构强度语义；报告 SHALL 保留"仅供研究复盘，不构成投资建议"免责声明。

#### Scenario: 文案检查
- **WHEN** 生成任意 ticker 的报告（payload、HTML、前端文案）
- **THEN** 筑底判读区块不出现"胜率/概率/准确率"字样，且洗盘干净度附带结构强度说明
