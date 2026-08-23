## REMOVED Requirements

### Requirement: 右侧信号卡片必须使用 4 态视觉规范
**Reason**: 右侧信号卡片随整个右侧体系删除。
**Migration**: 不提供替代四态卡片；保留筑底三迹象与左侧证据。

### Requirement: 右侧信号卡片必须使用 HeroUI surface 层级
**Reason**: 不再渲染右侧信号卡片。
**Migration**: HeroUI 设计 token 可继续供报告其它区域使用。

### Requirement: 右侧信号区不展示阈值刻度尺
**Reason**: 右侧信号区已删除。
**Migration**: 无。

### Requirement: 报告页脚必须说明 4 态视觉规则
**Reason**: 未触发/酝酿中/临界/已触发四态属于被删除的右侧体系。
**Migration**: 页脚仅保留结构强度语义和投资免责说明。

## MODIFIED Requirements

### Requirement: 左侧信号渲染保持不变
`category == "left"` 的保留信号 SHALL 继续使用既有卡片视觉，不得因删除右侧组件而丢失状态、名称、描述和结构强度。

#### Scenario: 左侧卡片继续可用
- **WHEN** 渲染新版报告
- **THEN** 6 个保留信号均可展示且页面不需要任何右侧 CSS/HTML helper
