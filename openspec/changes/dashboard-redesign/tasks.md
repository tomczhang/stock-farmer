# Tasks: dashboard-redesign

## 1. Server

- [x] 1.1 `performance.ts`：月度序列新增 `investedDisplay`（flows 前缀和，含首月前基线；scope 过滤沿用）
- [x] 1.2 `performance.test.ts` 补断言（基线含快照前事件、逐月累计）

## 2. Web

- [x] 2.1 `types.ts`：PerformanceMonth 加 `investedDisplay`
- [x] 2.2 D1：盈亏拆解表格化（金额+占总资产%+累计总盈亏合计行）；页头「数据截至」；安全边界表格（约束项/当前值/阈值/状态）+ 分仓预算表
- [x] 2.3 D2：持仓分布右栏（按标的/按三仓 tab + 堆叠条 + Top5 表 + 关键约束摘要 + 查看全部持仓）
- [x] 2.4 D3：hero 卡（总净资产大数字 + 累计总盈亏 + 双线图 + 6月/1年/全部 + 底部四指标条）；移除 KPI 行/三饼图/旧历史图
- [x] 2.5 `global.css`：hero/堆叠条/排名表/状态表/指标条样式

## 3. 验证

- [x] 3.1 server tests + web build/tests 全绿
- [x] 3.2 重启本地 server（新 API 字段生效），页面冒烟
- [x] 3.3 提交
