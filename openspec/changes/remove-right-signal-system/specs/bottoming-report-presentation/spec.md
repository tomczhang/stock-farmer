## MODIFIED Requirements

### Requirement: 报告 payload 以筑底判读为第一结论
报告 payload SHALL 包含 `bottoming` 顶层区块与恰好 3 项筑底迹象；signals 仅保留 6 个 left 类别信号。payload MUST NOT 包含右侧分组、右侧得分、右侧状态或右侧触发条件。

#### Scenario: payload 结构
- **WHEN** 生成任意 ticker 报告
- **THEN** bottoming.signs 恰好 3 项且 signals 不含 right 类别

### Requirement: 静态 HTML 报告筑底判读区块
静态 HTML SHALL 在首屏展示筑底结论、洗盘干净度和三迹象卡片，后续可展示保留的左侧证据，但不得渲染右侧出手确认层。

#### Scenario: 静态报告无右侧区块
- **WHEN** 打开生成报告
- **THEN** 页面显示筑底判读且不存在右侧信号卡片、右侧确认度或四态说明

### Requirement: React 前端筑底判读展示
React 信号报告页 SHALL 以筑底判读为主结论，并展示保留的左侧证据和结构历史图；不得渲染右侧分组或右侧筛选。

#### Scenario: React 渲染 bottoming-only 报告
- **WHEN** 前端收到新版 payload
- **THEN** 页面正常展示且不访问任何右侧字段
