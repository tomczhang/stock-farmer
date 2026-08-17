## ADDED Requirements

### Requirement: Watchlist 管理
系统 SHALL 新增 `watchlist` 表（user_id + market + symbol 唯一），字段含名称、备注（note，可承载 PE 等手填估值信息）、观察高点（ref_high）与其日期。提供 `GET/POST/PATCH/DELETE /api/watchlist` 完成增删改查。添加时若未手填 ref_high，SHALL 以当时报价初始化；报价不可得时 ref_high 为 null 待后续刷新补齐。

#### Scenario: 添加观察标的
- **WHEN** POST /api/watchlist 提交 market=US、symbol=VOO，未填 ref_high，报价服务返回 $590
- **THEN** 记录创建，ref_high = 590，ref_high_date 为当日

#### Scenario: 重复添加拒绝
- **WHEN** 再次添加同一 market+symbol
- **THEN** 返回 409

#### Scenario: 手动重置观察高点
- **WHEN** PATCH 更新 ref_high 为 650
- **THEN** ref_high 更新为 650 且 ref_high_date 更新为当日

### Requirement: 观察高点棘轮更新
`POST /api/watchlist/refresh` SHALL 批量拉取 watchlist 标的现价（复用既有报价服务与缓存）：当现价 > ref_high 时自动上调 ref_high 并更新日期（只升不降）；现价 ≤ ref_high 时不变。刷新响应 SHALL 返回每个标的的现价、观察高点与高位回撤比例 `(price − ref_high) / ref_high`。

#### Scenario: 现价创新高触发棘轮
- **WHEN** 某标的 ref_high=590，刷新时报价 600
- **THEN** ref_high 更新为 600，高位回撤显示 0%

#### Scenario: 现价低于高点
- **WHEN** 某标的 ref_high=600，刷新时报价 540
- **THEN** ref_high 保持 600，高位回撤 = −10%

#### Scenario: 报价失败降级
- **WHEN** 某标的报价服务返回 null
- **THEN** 该标的现价与回撤为 null，其余标的正常返回，不抛错

### Requirement: 观察窗口前端
前端 SHALL 新增「观察」页（/watchlist）：表格列含标的、名称、现价、观察高点（含起始日期提示）、高位回撤比例、备注；支持添加/编辑/删除与手动刷新报价；高位回撤按深度着色（回撤越深越醒目）。导航栏 SHALL 增加入口。

#### Scenario: 观察页展示
- **WHEN** 用户访问 /watchlist 且已有观察标的
- **THEN** 表格展示各标的现价与高位回撤，点击刷新后数据更新
