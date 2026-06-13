## ADDED Requirements

### Requirement: 报告必须含 Hero 区(圆环 + 趋势主图 + 加权公式)

`render_html()` 输出 HTML 在 `<header>` 之后、综述卡之前 MUST 包含一个 Hero 区,并满足:

- 一个左侧子区(占 1/3 宽度)以 SVG 圆环展示综合强度(0-100% 整数百分比),圆环中心 MUST 显示与 `phase.strength_pct` 相同的整数;圆环颜色根据综合强度状态(<25%=danger / 25%~60%=warning / >=60%=success)取对应 token。
- 圆环子区下方 MUST 同时显示 `phase.phase` 与 `phase.action` 文字。
- Hero 子区 MUST 显示加权分公式,字面同时包含 "%" 与 "权重" 两个字符,且公式中出现的左侧加权分百分比、右侧加权分百分比与左右总权重数值 MUST 与 `_compute_confirmation(signals)` 返回的对应字段一致(整数百分比四舍五入)。
- Hero 子区内 MUST 包含两个独立的 meter(细进度条),分别表示左侧 / 右侧的加权分百分比;每个 meter 旁 MUST 同时出现 "K/N 项确认" 与 "权重 W" 两段文字,K = 该侧 light=="green" 的信号数,N = 该侧总信号数,W = 该侧总权重。
- 一个右侧子区(占 2/3 宽度)MUST 包含一个 `id="chart-hero"` 的 lightweight-charts 容器,在 `window.load` 时立刻渲染收盘价 area + 成交量 histogram。

#### Scenario: Hero 圆环数值与 strength_pct 一致

- **WHEN** 输入 `phase.strength_pct = 58`
- **THEN** Hero HTML MUST 包含 `>58</text>` 或 `>58<` 之类把数字 58 落到 SVG 文本节点的写法,且 SVG 圆环 stroke-dashoffset 数值与 `2π·42·(1 - 58/100)` 数学等价(允许 ±0.5 浮点误差)

#### Scenario: 加权公式数字与 _compute_confirmation 对齐

- **WHEN** 输入若干信号,且 `_compute_confirmation(signals)` 返回 `left.score_pct=63, left.weight=7, right.score_pct=60, right.weight=6`
- **THEN** Hero HTML MUST 同时出现字符串 "63" 与 "7" 与 "60" 与 "6" 与 "%" 与 "权重"(允许夹杂在不同 span 里)

#### Scenario: Hero 主图容器存在并立刻渲染

- **WHEN** 渲染任意一份报告
- **THEN** HTML MUST 包含字符串 `id="chart-hero"`,且 `<script>` 段 MUST 包含字符串 `renderHeroTrendChart`,且 `window.load` / `addEventListener('load'` 触发处 MUST 调用该函数

### Requirement: 信号区必须按"左右双大卡 · 列表式 details 行"布局

`render_html()` 输出 HTML 的信号区 MUST:

- 由两张并列大卡构成,左卡头部含 "左侧信号" + "权重 N" 文字与 "X% 加权分" 大字;右卡同理含 "右侧信号"。
- 每张大卡的主体 MUST 用若干 `<details>` 元素呈现各信号,**不再使用** "每个信号一张独立卡片" 的布局。
- 每个 `<details>` 的 `<summary>` 行 MUST 同时显示:信号名(粗) + 一句 `description`(灰) + 状态 Chip + `confidence%`,**不得**包含 🔴/🟡/🟢 emoji 字符。
- `<details>` 展开时(`open=true`)MUST 在其内部渲染一个 `id="chart-{idx}"` 的 lightweight-charts 容器(`idx` 与现有 `_render_signal_card` 的索引规则一致:左 0~5 / 右 6~9)。
- 当展开的信号 `id == "vol_shrink"` 且 `s.data` 内 `down_days > 0` 时,展开容器内 MUST 在 chart 上方先渲染既有 `_render_signal_detail(s)` 的全部内容(综合评分公式 + 5 行表格 + tooltip 气泡)。

#### Scenario: 双大卡且不再有独立信号卡

- **WHEN** 渲染任意一份报告
- **THEN** HTML MUST 包含字符串 "左侧信号" 与 "右侧信号" 各一,且包含至少 10 个 `<details` 标签

#### Scenario: 信号行不含 emoji 状态

- **WHEN** 渲染任意一份报告
- **THEN** 任一 `<details>` 元素的 HTML 文本 MUST NOT 包含字符 🔴、🟡、🟢

#### Scenario: vol_shrink 展开容器含 5 维表

- **WHEN** 输入一个 `id="vol_shrink"`、`data["down_days"] >= 1`、含完整 5 维 data 的 SignalResult
- **THEN** 该信号对应的 `<details>` 内 HTML MUST 同时包含字符串 "综合评分 = "、"观察项"、"权重"、"判断标准"、"数据明细"、"比值"、"状态"

### Requirement: 信号 chart 必须按需渲染,Hero 主图除外

JS 段 MUST 提供:

- 一个 `renderHero()`(或等价名)函数,在 `window.load` 时立刻调用,用于渲染 `id="chart-hero"`。
- 一个按 idx 渲染单个信号 chart 的函数(可名为 `renderSignalChart(idx)` 或保留既有 9 个函数 + 路由 switch)。
- 监听全部带 `data-chart-idx` 属性的 `<details>` 的 `toggle` 事件,首次 `open=true` 时按 idx 调用对应渲染函数,**已渲染过的 idx 不重复创建**。

JS 段 MUST NOT 在 `window.load` 时立刻把 9 个信号 chart 全部渲染。

#### Scenario: 首屏不批量渲染信号 chart

- **WHEN** 检视 JS 源码
- **THEN** `window.load` / `addEventListener('load'` 触发处 MUST NOT 出现遍历 0..9 立刻调用 9 个信号 chart 渲染函数的代码;只允许出现 Hero 主图渲染调用

#### Scenario: toggle 触发按需渲染并防重复

- **WHEN** 检视 JS 源码
- **THEN** 必须存在监听 `<details>` 的 `'toggle'` 事件并基于已渲染标志位避免重复创建 chart 的逻辑

### Requirement: 报告必须含子信号明细表 + 全部/左/右 tabs

`render_html()` 输出 HTML 在双大卡之后 MUST 包含第三块 "子信号明细" 区,并满足:

- 区头 MUST 同时含 "子信号明细" 与 "权重、确认度与状态"(或 "权重 / 确认度 / 状态")字样。
- MUST 含一组 segmented-control 风格的过滤按钮,3 个按钮的 `data-filter` 属性分别为 "all"、"left"、"right",可见文案分别含 "全部"、"左侧"、"右侧"。
- 表格 MUST 是 5 列(信号 / 类别 / 权重 / 状态 / 确认度);每个 `<tr>` MUST 带 `data-category` 属性,值为 "left" 或 "right"。
- "确认度" 列 MUST 同时含 confidence 整数百分比文本与一个细进度条(token 化色填充)。
- JS 段 MUST 监听 3 个 filter 按钮的点击,把表格行按 `data-category` 显隐(filter="all" 时全部显示)。

#### Scenario: 明细表包含 10 行且都有 data-category

- **WHEN** 输入完整 11 个信号
- **THEN** "子信号明细" 区内 MUST 出现至少 10 个 `<tr` 标签,且每个含 `data-category="left"` 或 `data-category="right"` 之一

#### Scenario: tabs 三个按钮齐备

- **WHEN** 渲染任意一份报告
- **THEN** HTML MUST 同时包含 `data-filter="all"`、`data-filter="left"`、`data-filter="right"` 三个属性

### Requirement: 左侧信号 Chip 必须按 light 字段映射 3 态

每个 `category="left"` 的信号在双大卡内的 Chip MUST 按以下规则映射文案与色彩:

| `light` | Chip 文案 | 色彩 token              |
| ------- | --------- | ----------------------- |
| `red`    | 未触发    | `var(--color-default)`  |
| `yellow` | 观察      | `var(--color-warning)`  |
| `green`  | 确认      | `var(--color-success)`  |

#### Scenario: green light 渲染为"确认"

- **WHEN** 输入 `category="left"`、`light="green"` 的 SignalResult
- **THEN** 对应 `<details>` 的 summary 行 HTML MUST 包含字符串 "确认",且引用 `var(--color-success)`

#### Scenario: yellow light 渲染为"观察"

- **WHEN** 输入 `category="left"`、`light="yellow"` 的 SignalResult
- **THEN** 对应 summary 行 HTML MUST 包含字符串 "观察",且引用 `var(--color-warning)`

#### Scenario: red light 渲染为"未触发"

- **WHEN** 输入 `category="left"`、`light="red"` 的 SignalResult
- **THEN** 对应 summary 行 HTML MUST 包含字符串 "未触发",且引用 `var(--color-default)`(不引用 success / warning / danger)

### Requirement: `_compute_confirmation` 必须按 weight 加权 confidence

`renderer.py` MUST 提供纯函数 `_compute_confirmation(signals: list[SignalResult]) -> dict`,返回值结构:

```
{
  "score_pct": int,
  "total_weight": int,
  "left":  { "score_pct": int, "weight": int, "confirmed_count": int, "total_count": int },
  "right": { "score_pct": int, "weight": int, "confirmed_count": int, "total_count": int },
}
```

定义:

- 各组 `score_pct = round(100 * sum(c_i * w_i) / sum(w_i))`
- 各组 `confirmed_count = count(s.light == "green")`
- 总 `score_pct = round(100 * (sum(c_i * w_i for both)) / sum(w_i for both))`
- 总 `total_weight = sum(w_i for both)`

当某组无信号时,该组 `score_pct = 0`,`weight = 0`。

#### Scenario: 加权分算法对齐预期

- **WHEN** 输入 6 个左信号 confidence=[0.3,0.5,0.8,0.4,0.6,0.7] weight=[1,1,2,1,1,1] 与 4 个右信号 confidence=[0.9,0.6,0.5,0.2] weight=[2,2,1,1]
- **THEN** `_compute_confirmation` 返回的 `left.score_pct` MUST 等于 `round(100 * (0.3+0.5+1.6+0.4+0.6+0.7)/7) = 59`
- **AND** `right.score_pct` MUST 等于 `round(100 * (1.8+1.2+0.5+0.2)/6) = 62`
- **AND** `score_pct` MUST 等于 `round(100 * (4.1+3.7)/13) = 60`
- **AND** `total_weight` MUST 等于 13

### Requirement: `_LEFT_STATE_TABLE` 与 `_resolve_left_state` 必须存在

`renderer.py` MUST 暴露 `_LEFT_STATE_TABLE` 常量(键集 ⊇ `{"red", "yellow", "green"}`,值为三元组 `(label, color_var, color_100_var)`)与 `_resolve_left_state(light: str) -> str` 函数。

#### Scenario: 三个 light 取值都被映射

- **WHEN** 调用 `_resolve_left_state("red")`、`_resolve_left_state("yellow")`、`_resolve_left_state("green")`
- **THEN** 三次返回值 MUST 落在 `_LEFT_STATE_TABLE.keys()` 内,且与上文映射表一致

### Requirement: 设计 token 必须扩展但保持向后兼容

`_DESIGN_TOKENS_CSS` block MUST 在保留 `heroui-right-signals-redesign` 引入的 12 个 token 之外,新增以下 token,且每个变量都有具体值:

- `--accent`、`--text-primary`、`--text-secondary`、`--text-muted`、`--bg-app`

#### Scenario: 既有 token 全部保留

- **WHEN** 检视 `<head>` 中 token 块
- **THEN** 此前的 `--color-default`、`--color-success`、`--color-warning`、`--color-danger`、`--color-surface`、`--color-surface-secondary`、`--color-divider`、`--radius-card`、`--shadow-xs`(及其各 -100 变体)MUST 仍然全部存在

#### Scenario: 新增 token 出现

- **WHEN** 检视 `<head>` 中 token 块
- **THEN** `--accent`、`--text-primary`、`--text-secondary`、`--text-muted`、`--bg-app` 5 个变量名 MUST 全部出现并跟随非空值

### Requirement: 报告 HTML 必须不依赖 echarts 与 React

输出 HTML 的 `<head>` 与 `<script>` 段 MUST NOT 引用 echarts、recharts、@heroui、react、react-dom 等任何 JS 库 CDN;允许的 CDN 仅 `cdn.tailwindcss.com` 与 lightweight-charts。

#### Scenario: 无 echarts / react CDN 引用

- **WHEN** 检视任意一份报告 HTML
- **THEN** 全文 MUST NOT 包含字符串 "echarts"、"recharts"、"@heroui"、"react-dom"、"unpkg.com/react"

## MODIFIED Requirements

### Requirement: 右侧信号 Chip 必须使用 4 态视觉规范

针对 `category == "right"` 的每一个 `SignalResult`,`renderer.py` MUST 在双大卡内对应的 `<details>` summary 行渲染一个状态 Chip,且根据 `confidence` 与 `thresholds` 映射为以下 4 个视觉状态之一:

| 条件                                            | 状态名(语义)   | Chip 文案 |
| ----------------------------------------------- | ---------------- | --------- |
| `confidence < thresholds[0]`                    | `default`(灰)   | 未触发    |
| `thresholds[0] <= confidence < 0.55`            | `warning-soft`   | 酝酿中    |
| `0.55 <= confidence < thresholds[1]`            | `warning`        | 临界      |
| `confidence >= thresholds[1]`                   | `success`        | 已触发    |

每行 MUST:

- 含一个 Chip(圆角胶囊 + 同状态色实心圆点 + 状态文案)
- 含信号名作为标题等价排版、一句 `description` 作为副文案、`confidence` 整数百分比展示

行内 MUST NOT 出现 emoji 状态指示(🔴🟡🟢)与 ProgressBar(进度条已不属于该行布局,移到子信号明细表)。

#### Scenario: 已触发信号渲染为 success

- **WHEN** 输入一个 `category="right"`、`confidence=0.82`、`thresholds=(0.4, 0.7)` 的 SignalResult
- **THEN** 输出 HTML MUST 包含字符串 "已触发",且对应 `<details>` summary 行 MUST 引用 `var(--color-success)`

#### Scenario: 未触发信号渲染为 default 灰

- **WHEN** 输入 `confidence=0.20`、`thresholds=(0.4, 0.7)` 的右信号
- **THEN** 输出 HTML MUST 包含 "未触发",且 summary 行 MUST NOT 引用 `var(--color-success)` 或 `var(--color-warning)`

#### Scenario: 临界态信号区分酝酿中与临界

- **WHEN** 同一阈值 `(0.4, 0.7)` 下分别输入 `confidence=0.45` 与 `confidence=0.60`
- **THEN** 前者 HTML MUST 包含 "酝酿中" 且不含 "临界";后者 MUST 包含 "临界" 且不含 "酝酿中"

#### Scenario: summary 行不含 emoji

- **WHEN** 检视任一右侧信号对应的 `<details>` summary 行
- **THEN** 该片段 MUST NOT 出现字符 🔴、🟡、🟢

## REMOVED Requirements

### Requirement: 左侧信号渲染保持不变

**Reason**: 本变更明确把"双大卡 · 列表式 details" 视觉推广到全报告,左侧不再使用旧版 `_render_signal_card` 的 emoji + 三段刻度尺布局,而是与右侧统一为 Chip + summary 行 + 展开容器。

**Migration**: 左侧信号现在由新的 `_render_signal_group_panel("left", ...)` + `_render_signal_row(...)` 渲染;Chip 文案规则参见新增 Requirement "左侧信号 Chip 必须按 light 字段映射 3 态";emoji 与三段刻度尺被移除。`_render_signal_card` 函数允许保留为 dead code 但不得被 `render_html` 调用。
