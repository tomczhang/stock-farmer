# Design: ledger-ui-v2

## Context

前端为 React + 自定义 CSS（global.css 单文件 token 体系）+ ECharts 封装 `Chart` 组件。v2.1 定稿方案（`pipeline/output/ledger_ui_v2_proposal.html`）已获确认；动效规范源自 interior.dev DESIGN.md（两曲线/占位/出场短于入场/reduced-motion）与 lieflat-charts Mono 语法（发丝线/纯色/焦点落点）。

## Goals / Non-Goals

**Goals:** 涨跌色统一为 B（`#0E9F6E/#D84C55`）；图表去渐变 + 焦点柱 + 墨色净值线；KPI 去彩色装饰；按钮加高优先级；表格 tabular-nums；四个 CSS 动效 + reduced-motion。

**Non-Goals:** 中性色改动（slate 保留）；引入 `motion` 依赖（预留升级路径）；骨架屏时序（120/380/220ms）本期不做；后端任何改动。

## Decisions

- **D1 涨跌色与危险色分离**：新增 `--gain/--loss` 承担涨跌语义（.pos/.neg 与全部图表引用它们）；`--danger #ef4444` 保留给删除/错误等 destructive 场景——涨跌是数据语义、危险是操作语义，不混用
- **D2 动效 CSS-first**：value-flash 用 React hook + CSS class（900ms 后清除，事件驱动）；loading 按钮用 grid 隐形双胞胎；scope-toggle 滑块用容器 `::before` + `:has()` 选择器（目标浏览器均支持）；曲线统一 `cubic-bezier(.23,1,.32,1)` 入 / `cubic-bezier(.4,0,1,1)` 出
- **D3 焦点柱判定**：月度盈亏取 |pnl| 最大月全饱和 + label，其余 opacity .38；直方图不做焦点（分布图无单一落点）
- **D4 净值线**：主线 `--ink`，最新有效点 markPoint 品牌黄 + 净值标注；回撤面积改 `rgba(216,76,85,.06)`
- **D5 高优先级按钮应用面**：`.btn.priority`（墨色）用于「保存复盘」；其余 CTA 保持主黄

## Risks / Trade-offs

- [`:has()` 兼容] → 目标环境为现代桌面浏览器，Safari 15.4+/Chrome 105+ 均支持；不支持时降级为无滑块的现状样式，功能无损
- [焦点柱 38% 饱和在弱色管屏幕上偏淡] → 保留 hover tooltip 完整数值；如反馈不佳可调至 .5

## Migration Plan

纯前端样式与组件变更，`npm run build` 通过即可部署；无数据迁移、可整体回滚。

## Open Questions

（无）
