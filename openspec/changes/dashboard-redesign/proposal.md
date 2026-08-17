# Proposal: dashboard-redesign

## Why

总览页信息架构升级（用户提供的首页设计稿评审后定稿）：现有 5 张 KPI 卡 + 三个饼图 + 市值/成本历史图，信息密度低、账本感弱。核心缺失是「净资产 vs 外部净投入」双线视图——两线间距即累计盈亏，是全页最有说服力的可视化。黑色 hero 方案已否，采用浅色版（B 案）。

## What Changes

- **Hero 资产走势卡（浅色）**：总净资产大数字 + 累计总盈亏（经济盈亏及占净投入比例）；月度双线图（净资产墨色实线带月点 / 累计外部净投入灰色虚线）；6月/1年/全部 时间范围；底部四指标条（持仓市值/账面成本/外部净投入/现金）替代原 5 张 KPI 卡
- **持仓分布右栏**：替换三个饼图——资产配置堆叠条 + Top5 排名表（市值/占比）+ 按标的/按三仓 tab + 关键约束摘要 + 查看全部持仓导流
- **盈亏拆解**：新增「占总资产 %」列与「累计总盈亏」合计行
- **资金安全边界表格化**：约束项/当前值/阈值/状态（充足/正常/超限）+ 分仓预算使用表（预算/已用/剩余/状态）
- **页头**：数据截至（最新快照日期 + 券商列表）
- **Server**：performance API 月度序列新增 `investedDisplay`（截至该月的累计外部净投入，含首个快照月之前的存量事件）
- 移除原「资产与账面成本历史」区块（信息由 hero 与绩效页覆盖）

## Capabilities

### New Capabilities
- `dashboard-hero-overview`: hero 双线资产走势、持仓分布重构、盈亏拆解百分比、安全边界表格、累计净投入序列 API 字段

### Modified Capabilities

（无——portfolio 相关能力尚未沉淀主规范）

## Impact

- Server：`performance.ts`（月度累计净投入）、测试补充
- Web：`DashboardPage.tsx` 重写渲染层、`types.ts`、`global.css`（hero/堆叠条/排名表/状态表样式）
- 保留：load 逻辑、scope/币种切换、ValueFlash、刷新按钮占位、grace spinner
