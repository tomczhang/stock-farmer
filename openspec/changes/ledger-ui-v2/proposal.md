# Proposal: ledger-ui-v2

## Why

平台涨跌色存在三套并存（global.css `#16a34a/#ef4444`、总览图表 `#22c55e/#ef4444`、绩效图表 `#14b8a6/#b91c1c`），语义不一致；同时图表带渐变装饰、KPI 卡彩色顶边、emoji 图标等"AI 味"元素，交互反馈存在按钮宽度跳变、状态瞬变等未完成细节。经 v2.1 定稿方案确认（pipeline/output/ledger_ui_v2_proposal.html），按「非 AI 化、高级、醒目」原则统一视觉与动效。

## What Changes

- **Token**：中性色维持现状 slate 冷轴不动；新增 `--gain #0E9F6E` / `--loss #D84C55` 统一全站涨跌语义（destructive 危险色 `--danger` 保留独立）；按钮新增墨色高优先级层级
- **图表 Lieflat 化**：柱状图去渐变改纯色；月度盈亏"焦点柱"（最值月全饱和+标数，其余 38% 饱和）；净值主线改墨色 + 品牌黄端点标注最新值；盈亏分布直方图同步 B 色
- **表格**：`tabular-nums` 等宽数字、方角 chip
- **KPI 卡**：去彩色顶边装饰，层级靠字号，语义色只出现在数值上
- **动效（CSS 实现，不引新依赖）**：value-flash 数值变化闪色（预留箭头占位格）；loading 按钮隐形双胞胎防宽度跳变；scope-toggle 滑动指示器；入场/出场不对称动画（入 0.22s 出 0.18s）；`prefers-reduced-motion` 降级
- **图标**：防窥按钮 emoji → 线性 SVG

## Capabilities

### New Capabilities
- `ledger-ui-tokens`: 涨跌语义色统一、按钮层级、KPI 卡去装饰、表格数字排版、图表 Lieflat 语法、微交互动效与 reduced-motion 降级

### Modified Capabilities

（无）

## Impact

- `portfolio/web/src/styles/global.css`（token/按钮/KPI/表格/动效/媒体查询）
- `portfolio/web/src/components/Chart.tsx`（去渐变工具沿用处）、新增 `components/ValueFlash.tsx`
- `portfolio/web/src/pages/`：DashboardPage、PerformancePage、HoldingsPage、ReviewsPage、WatchlistPage、PlansPage 局部类名与图表配置
- `portfolio/web/src/App.tsx`（防窥 SVG 图标）
- 无后端改动、无新依赖、无破坏性变更
