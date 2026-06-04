## Context

继 `heroui-right-signals-redesign`(已 archive 进 specs/)之后,作者用 codex 在 `web/` + `pipeline/server.py` + `pipeline/analyzer/report.py` 做了完整的 React 报告设计 spike(见 `127.0.0.1:5173/`)。生产链路是 GitHub Actions → 静态 HTML,**这条 React 链路不会上线**。

`renderer.py` 当前结构(单文件 ~700 行):

- `render_html(...)` 字符串模板:`<head>` + nav + header + Conclusion 卡 + Narrative 卡 + 左右两栏(各 6 / 4 张独立卡片) + footer + `<script>` 内含 10 个 chart 渲染函数。
- 渲染函数:`_render_signal_card`(左侧)/ `_render_right_signal_card`(右侧,上轮 commit 加的)/ `_render_signal_detail`(vol_shrink 5 维)/ `_render_range_bar`(左侧三段刻度尺)/ `_render_strength_bar`(conclusion 综合强度)/ `_render_design_tokens`。
- JS:`window.load` 时调 `initCharts()`,把 `chart-0..9` 容器全部塞入对应函数。`vol_shrink` 行的 5 维表 + tooltip 都用纯 CSS 实现,无依赖。

React spike 关键决策:**没有真用 HeroUI 包**。视觉 token 在 `web/src/styles/global.css:1-30` 的 `:root` 定义,组件全手写 CSS class。chart 用 echarts(双 grid)。

## Goals / Non-Goals

**Goals**

- HTML 报告整体视觉与 React 设计稿对齐:Hero 圆环 + 趋势主图、综述 + 下一触发、双大卡列表、子信号明细表 + tabs。
- chart 全部回到 lightweight-charts(信号 chart 9 个 + Hero 主图 1 个)。
- `vol_shrink` 的 5 维详情完整保留,迁入展开容器。
- 设计 token 与 React 端 `global.css` 命名 / 色值对齐,后续两端可同步演进。

**Non-Goals**

- 不动 codex React/server spike(留作 dev 预览)。
- 不引入构建工具(Tailwind CLI / PostCSS / Vite),保持 CDN。
- 不让 `renderer.py` 消费 `report.py` 的 payload(双轨合一是另一独立 follow-up)。
- 不动信号算法、数据源、GitHub Actions。
- 不重写 chart 内部配色(中国习惯红涨绿跌沿用)。

## Decisions

### D1 — Hero 区双栏布局

**选择**:`<header>` 之后插入新的 Hero 容器 `<div class="grid grid-cols-1 md:grid-cols-3 gap-6">`,左侧 1 列放 `_render_hero_circle(phase, conf)`,右侧 2 列放 `_render_hero_trend_panel()`。原 Conclusion 卡删除(其信息已被 Hero 全面覆盖:phase 名 / action / strength / trigger 移到 Hero 与综述卡)。

**为什么不**:保留 Conclusion 卡 + Hero 并列——信息冗余。React 设计稿也不并列。

### D2 — 圆环用手绘 SVG,不引第三方

**选择**:复刻 `SignalTrendReport.tsx:CircularScore`:viewBox 104×104,半径 42,圆周 `2πr ≈ 263.89`,用 `stroke-dasharray="263.89" stroke-dashoffset={263.89 * (1 - score/100)}` 表示进度。环色按整体状态映射(`success / warning / default`)。中心放 `strength_pct` 大字。

**为什么不**:用 lightweight-charts 假装画环——它专门画时间序列,圆环不是其能力域。

### D3 — Hero 趋势主图复用 lightweight-charts

**选择**:新增 JS 函数 `renderHeroTrendChart(klines)`:单 chart,价格 area series(浅蓝填充)叠加成交量 histogram 占下方 30%。比现有 `renderVolumeChart` 简化(不要 MA20/MA60 量均线,不要图例),让 Hero 显得轻量。

**为什么不**:复用 `renderVolumeChart`——那个含 K 线 + 双量均线 + 图例,信息密度过高,不合 Hero 的"概览"定位。

### D4 — 加权分算法重写在 renderer.py 内

**选择**:在 `renderer.py` 加 `_compute_confirmation(signals)` 私有函数。算法:

```
group_score = sum(s.confidence * s.weight for s in group) / sum(s.weight for s in group)
group_confirmed = sum(1 for s in group if s.light == "green")
total_score = (left_score * left_weight + right_score * right_weight) / (left_weight + right_weight)
```

返回 `dict { score_pct, total_weight, left: { score_pct, weight, confirmed_count, total_count }, right: {...} }`。

**为什么不**:让 renderer.py import `pipeline/analyzer/report.py:_group_summary`——那个函数耦合 React payload 构造,直接调会带入不需要的字段;复制算法成本低、解耦好,后续 follow-up 真要合一时一并整理。

### D5 — `<details>` 实现按需渲染

**选择**:每行用原生 `<details><summary>`。展开容器内放 `<div id="chart-{idx}" ...>` + 可选的 `_render_signal_detail(s)`。JS 段把 `initCharts()` 拆为:

- `renderHero()` 立刻调用(`window.load`)。
- `renderSignalChart(idx)` 单独函数,内含与现在 `configs[idx]()` 一样的逻辑。
- 监听全部 `<details data-chart-idx="..."` 的 `toggle` 事件,首次 `open=true` 时按 `idx` 调 `renderSignalChart(idx)` 并设标志位。

**为什么不**:用纯 CSS `:checked` + 隐藏 input——chart 容器在 `display:none` 下宽度 0,lightweight-charts 创建时无法测宽,需要展开后才创建。原生 `<details>` 的 `toggle` 事件正合此用途。

### D6 — Chip 文案与色彩双表

**选择**:已有 `_RIGHT_STATE_TABLE`(右侧 4 态)继续用。新增:

```python
_LEFT_STATE_TABLE: dict[str, tuple[str, str, str]] = {
    "red":    ("未触发", "var(--color-default)", "var(--color-default-100)"),
    "yellow": ("观察",   "var(--color-warning)", "var(--color-warning-100)"),
    "green":  ("确认",   "var(--color-success)", "var(--color-success-100)"),
}

def _resolve_left_state(light: str) -> str:
    return light if light in _LEFT_STATE_TABLE else "red"
```

**为什么不**:左右合并成一张大表——左侧只看 `light`(算法上的 3 段),右侧看 `confidence + thresholds + 0.55 break`(连续 4 态),口径不同,合表反而复杂。

### D7 — 子信号明细表用纯 HTML 表 + 客户端 JS tabs

**选择**:`<table>` 5 列(信号 / 类别 / 权重 / 状态 / 确认度),每 `<tr data-category="left|right">`。tabs 是 3 个 `<button data-filter="all|left|right">`,JS 给 tbody 加 / 去 `data-active` 属性,CSS `tr:not([data-category="left"])` 隐藏等。无第三方 table lib。

**为什么不**:用 React 的 sortable 表(codex 在 React 端的实现)——本来就是想抛掉 React。

### D8 — 设计 token 增量同步,不破坏既有命名

**选择**:`_DESIGN_TOKENS_CSS` 在保留 `--color-default/--color-success/--color-warning/--color-danger/--color-surface/--color-surface-secondary/--color-divider/--radius-card/--shadow-xs` 的前提下,新增:

- `--accent: #2563eb`(Hero 主图折线、各种链接 / 强调色)
- `--text-primary: #0f172a` / `--text-secondary: #475569` / `--text-muted: #94a3b8`(替代散落的 `text-gray-X00`)
- `--bg-app: #f8fafc`(背景色)
- 已有 `--color-success-100` 等保持不变作为 chip 浅底色。

**为什么不**:整体重命名为 React 端那套 `--success / --success-soft`——会把 `heroui-right-signals-redesign` 已 archive 的 spec 打破,已 ship 的右侧卡需要联动改;增量扩展更安全。

## Risks / Trade-offs

- **[`<details>` 展开瞬间 chart 宽度为 0]** → Mitigation: `toggle` 事件回调里先 `requestAnimationFrame` 一次再 `renderSignalChart(idx)`,确保浏览器先 layout;ResizeObserver 既有套路覆盖。
- **[Hero 主图首屏立刻加载,容器尚未稳定布局可能宽度异常]** → Mitigation: 沿用既有 `window.load` 时 `setTimeout(initCharts, 100)` 套路,够用。
- **[token 增量与 React 端 `global.css` 命名漂移]** → Mitigation: design.md 列明双方对照表(后续 follow-up 任务可统一);本变更不强制 100% 命名一致。
- **[`<details>` 默认行为是 summary 旋转 ▶ 三角]** → Mitigation: CSS `summary::-webkit-details-marker { display: none; }` + 自定义 `+`/`-` 图标;主流浏览器支持。
- **[移除 Conclusion 卡可能让没读过 React 设计稿的用户感觉信息丢失]** → Mitigation: 信息已 100% 覆盖到 Hero 圆环(strength)+ phase 名 + action + 加权公式;narrative 卡含 trigger;无丢失。
- **[左侧 emoji 移除导致截图比对/历史报告链接看起来不一致]** → 接受:这是视觉重构的目标,与 `heroui-right-signals-redesign` 同方向。
- **[`renderer.py` 单文件继续膨胀]** → 接受:此次重构后约 ~900 行,仍在可读范围;真要拆分留作 follow-up。

## Migration Plan

1. `_DESIGN_TOKENS_CSS` 增量扩 token(D8)。
2. 加 `_compute_confirmation`、`_resolve_left_state`、`_LEFT_STATE_TABLE`。
3. 加 `_render_hero_circle`、`_render_hero_trend_panel`、`_render_signal_group_panel`、`_render_signal_detail_table`、`_render_signal_row`(每行 details)。
4. 改写 `render_html` 模板:删 Conclusion 卡 + 阈值刻度尺、删原左/右两栏、插入 Hero / Narrative / 双大卡 / 明细表。
5. 改写 `<script>` JS 段:Hero 主图 + 按需渲染逻辑;扩 `renderHeroTrendChart`;`<details>` toggle 监听。
6. 删 `_render_signal_card` / `_render_right_signal_card` 二者(被 group panel 内 `_render_signal_row` 取代)?——保留 `_render_signal_card` 作为 fallback 不删,但不再调用;`_render_right_signal_card` 已无引用可删,但出于跟 `heroui-right-signals-redesign` spec 兼容**保留并标 deprecation 注释**。
7. 单测扩展(见 specs)。
8. 实盘 0700.HK 跑一遍 + chrome devtools 截图。

回滚:本变更只动 `renderer.py` + `test_renderer.py`,git revert 即可。

## Open Questions

- 子信号明细表的"确认度"列用进度条还是纯数字?React 设计稿是进度条(细 1.5px + token 色),本次按 React 设计稿做。后续若反馈密度仍高再调。
- `vol_shrink` 5 维表展开后宽度受 `<details>` 内嵌限制,5 列在窄屏可能过挤。Mitigation: 沿用既有 `colgroup` 固定列宽,行内文字折行。后续若反馈差再调。
