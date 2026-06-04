## ADDED Requirements

### Requirement: 报告 HTML 必须注入 HeroUI 设计 token

`render_html()` 输出的 HTML `<head>` MUST 包含一段内联 `<style>`，在 `:root` 上声明以下 CSS 变量，命名与 HeroUI v3 设计 token 对齐：

- `--color-default`、`--color-default-100`
- `--color-success`、`--color-success-100`
- `--color-warning`、`--color-warning-100`
- `--color-danger`、`--color-danger-100`
- `--color-surface`、`--color-surface-secondary`、`--color-divider`
- `--radius-card`、`--shadow-xs`

每个变量 MUST 提供具体值（hex 或 rgb），不能仅声明名称。

#### Scenario: token block 出现在 head 中

- **WHEN** 调用 `render_html(...)` 并解析返回的字符串
- **THEN** `<head>` 内 MUST 至少存在一处 `<style>` 块，且该块文本中同时包含 `--color-success` 与 `--color-surface`

#### Scenario: 所有必需 token 已声明

- **WHEN** 检视 token block 的内容
- **THEN** 上文列出的 12 个 CSS 变量名 MUST 全部出现，且每个都跟随一个非空值（形如 `--color-success: #16a34a;`）

### Requirement: 右侧信号卡片必须使用 4 态视觉规范

针对 `category == "right"` 的每一个 `SignalResult`，`renderer.py` MUST 渲染出一张卡片，且根据 `confidence` 与 `thresholds` 映射为以下 4 个视觉状态之一：

| 条件                                            | 状态名（语义）   | Chip 文案 |
| ----------------------------------------------- | ---------------- | --------- |
| `confidence < thresholds[0]`                    | `default`（灰） | 未触发    |
| `thresholds[0] <= confidence < 0.55`            | `warning-soft`   | 酝酿中    |
| `0.55 <= confidence < thresholds[1]`            | `warning`        | 临界      |
| `confidence >= thresholds[1]`                   | `success`        | 已触发    |

每张卡片 MUST 含有：

- 一个 Chip（圆角胶囊 + 同状态色实心圆点 + 状态文案）
- 信号名作为标题（`Card.Title` 等价排版）
- 一句 `description` 作为副文案
- 一个 ProgressBar，fill 颜色与状态色一致，右上角显示百分比

卡片不再使用 emoji（🔴🟡🟢）做状态指示。

#### Scenario: 已触发信号渲染为 success

- **WHEN** 输入一个 `category="right"`、`confidence=0.82`、`thresholds=(0.4, 0.7)` 的 `SignalResult`
- **THEN** 输出 HTML MUST 包含字符串"已触发"，且对应卡片 MUST 引用 `var(--color-success)`（无论以 class 任意值还是内联 style 形式）

#### Scenario: 未触发信号渲染为 default 灰

- **WHEN** 输入一个 `category="right"`、`confidence=0.20`、`thresholds=(0.4, 0.7)` 的 `SignalResult`
- **THEN** 输出 HTML MUST 包含字符串"未触发"，且对应卡片 MUST NOT 引用 `var(--color-success)` 或 `var(--color-warning)`

#### Scenario: 临界态信号区分酝酿中与临界

- **WHEN** 同一阈值 `(0.4, 0.7)` 下分别输入 `confidence=0.45` 与 `confidence=0.60`
- **THEN** 前者 HTML MUST 包含"酝酿中"且不包含"临界"；后者 MUST 包含"临界"且不包含"酝酿中"

#### Scenario: 卡片不含 emoji 状态指示

- **WHEN** 检视任一右侧信号卡片对应的 HTML 片段
- **THEN** 该片段 MUST NOT 出现字符 🔴、🟡、🟢

### Requirement: 右侧信号卡片必须使用 HeroUI surface 层级

每张右侧信号卡片的根容器 MUST：

- 圆角等于 `--radius-card`（实现可通过 `rounded-2xl` 或 `style="border-radius: var(--radius-card);"`）
- 边框颜色等于 `--color-divider`
- 背景：`success` 状态使用 `--color-surface-secondary`；其它三态使用 `--color-surface`
- 投影等于 `--shadow-xs`

#### Scenario: 已触发卡片使用次级 surface

- **WHEN** 输入一个 `success` 状态的右侧信号
- **THEN** 卡片根容器 MUST 引用 `var(--color-surface-secondary)`

#### Scenario: 默认/警告卡片使用主 surface

- **WHEN** 输入 `default`、`warning-soft`、`warning` 三种非触发态信号
- **THEN** 卡片根容器 MUST 引用 `var(--color-surface)` 而非 `var(--color-surface-secondary)`

### Requirement: 右侧信号区不展示阈值刻度尺

旧版 conclusion 卡底部的 `🔴 0-25% 🟡 25-45% 🟡⭐ 45-60% 🟢 60-80% 🟢🟢 80%+` 提示在右侧信号区内 MUST NOT 出现。该刻度尺仅保留在 conclusion 卡（综合强度），不在每张右侧信号卡片下方重复。

#### Scenario: 卡片下方无刻度尺

- **WHEN** 渲染任意右侧信号卡片
- **THEN** 该卡片 HTML 片段 MUST NOT 包含字符串"0-25%"或"80%+"

### Requirement: 报告页脚必须说明 4 态视觉规则

`render_html` 的 footer 区域 MUST 在原有"仅供参考，不构成投资建议"行之外，新增一行简短说明，描述右侧信号 4 态对应关系（至少包含"未触发 / 酝酿中 / 临界 / 已触发"四个标签词）。

#### Scenario: 4 态说明出现在页脚

- **WHEN** 渲染任意一份报告
- **THEN** footer 区域 HTML MUST 同时包含字符串"未触发"、"酝酿中"、"临界"、"已触发"

### Requirement: 左侧信号渲染保持不变

`category == "left"` 的信号 MUST 继续使用既有的 `_render_signal_card` 实现，本变更 MUST NOT 修改其输出。

#### Scenario: 左侧卡片仍含 emoji 状态指示

- **WHEN** 渲染任意一份左侧信号卡片
- **THEN** 该片段 MUST 至少包含 🔴、🟡、🟢 三个字符之一（即维持旧版视觉）

#### Scenario: 左侧未引用 HeroUI surface 变量

- **WHEN** 检视左侧信号区 HTML
- **THEN** 该区域 MUST NOT 引用 `var(--color-surface-secondary)`（用于验证视觉边界没有被错误推广到左侧）
