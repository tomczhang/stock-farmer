# Tasks: ledger-ui-v2

## 1. Token 与基础样式（global.css）

- [x] 1.1 新增 `--gain/--loss`；`.pos/.neg/.warn-text` 改引用；`.btn.priority` 墨色按钮；KPI 卡去彩色顶边类；`.table td` 与 `.kpi .v` 启用 tabular-nums；chip 方角
- [x] 1.2 动效基建：`--ease-enter/--ease-leave` 曲线变量；`.fade-in` 升级（0.22s 位移+缩放+模糊）；`.btn-twin` 隐形双胞胎；`.scope-toggle` 滑块（`::before` + `:has()`）；`.vf` value-flash 类；`prefers-reduced-motion` 降级块

## 2. 组件与页面

- [x] 2.1 新增 `components/ValueFlash.tsx`（hook + span：数值变化按方向闪色 900ms，箭头固定占位）
- [x] 2.2 DashboardPage：总净资产/持仓市值 KPI 接 ValueFlash；历史柱状图去渐变改 `--gain/--loss` 纯色；「刷新市值」按钮加 btn-twin
- [x] 2.3 PerformancePage：GAIN/LOSS 常量改 B 色；月度盈亏焦点柱（最值月全饱和+label，其余 opacity .38）；净值主线墨色 + 品牌黄端点标注；直方图纯色
- [x] 2.4 ReviewsPage 保存按钮改 `.btn.priority`；WatchlistPage「刷新报价」加 btn-twin，现价接 ValueFlash
- [x] 2.5 App.tsx 防窥按钮 emoji → SVG 双态图标

## 3. 验证

- [x] 3.1 `npm run build` 通过；涨跌色 grep 无三套残留
- [ ] 3.2 本地起服务人工核验四个动效与 reduced-motion
- [x] 3.3 提交 UI 变更 commit
