## Context

`pipeline/analyzer/renderer.py` 把 10 个信号（左 6 + 右 4）渲染成单页 HTML 报告，使用 Tailwind CDN + lightweight-charts，无构建步骤。`SignalResult.light` 已有 `red / yellow / green` 三态，`category` 区分 `left / right`，但渲染端把两栏视为同样的视觉模板：

- 卡片头：emoji（🔴/🟡/🟢） + 信号名 + confidence 百分比。
- 主体：一句 `description`。
- 底部：水平 fill bar（`bg-{red|amber|green}-500`）。

视觉问题集中在右侧（趋势确认）：

1. 右侧信号是"决策触发器"（站回均线 / 放量反包 / MACD 金叉 / 低点抬升），用户希望一眼看到 **是否触发** 而不是先读 confidence 再算阈值。
2. emoji + 文本混排在密集报告里识别成本高。
3. 现有色板（Tailwind 默认 red-500 / amber-500 / green-500）跨深浅主题切换时与项目其它 UI（已规划接入 HeroUI v3）不一致。
4. 项目同时存在 `web/`（React + Vite，未来接入 HeroUI），需要让静态 HTML 报告与之保持视觉一致。

约束：

- 报告由 Python 字符串模板生成，不能引入 React/HeroUI npm 包。
- 必须保持 Tailwind CDN 路线（用户产线机器无 Node 构建）。
- 不影响 lightweight-charts 区域和 chart 配色（已是中国习惯红涨绿跌，沿用）。
- 改动只动右侧 4 个 signal 的卡片样式 + `<head>` 注入的 CSS token；左侧信号 6 个保持现状以便对比验证。

## Goals / Non-Goals

**Goals:**

- 右侧信号卡片采用 HeroUI v3 视觉语言（语义色 / surface 层级 / Chip / ProgressBar 风格）。
- 提供清晰的 4 态视觉编码：`未触发(default 灰) / 弱(warning 琥珀) / 边缘(warning 实心) / 已触发(success 绿)`，把 `red light` 重新解读为"未触发 default"以避免和大盘下跌的 chart 红色冲突。
- 设计 token 通过内联 `<style>` 注入，所有自定义颜色在 Tailwind CDN 中以 `[color:var(--xxx)]` 任意值类生效。
- 重构后报告在桌面、移动两个断点视觉一致，无需打包工具。

**Non-Goals:**

- 不做左侧信号的视觉重构（留待后续变更，便于 A/B 对比）。
- 不引入 React、JSX、构建产物、npm 依赖。
- 不改变 `SignalResult` 的字段语义、阈值算法、信号 id。
- 不改 chart 内部配色与 K 线红涨绿跌习惯。
- 不重写报告整体框架（Header / Conclusion / Narrative / Footer 不动）。

## Decisions

### D1：在 HTML `<head>` 内联 HeroUI 设计 token，而不是引 HeroUI CSS 包

**选择**：在 `_render_design_tokens()` 中输出一段 `<style>:root { --color-success: ... }`，对齐 HeroUI v3 命名（`--color-default / --color-success / --color-warning / --color-danger / --color-surface / --color-surface-secondary / --color-divider / --radius-card / --shadow-xs`）。在 Tailwind CDN 模式下用 `[color:var(--color-success)]` / `[background-color:var(--color-surface)]` 等任意值类引用。

**为什么不**：

- 直接引 `@heroui/react` 的 CSS：包含 React runtime + 主题文件，体积大且污染全局；CDN 路线没有打包器无法 tree-shake。
- 直接写死 hex：丢失语义，未来切深色主题需要全文搜索替换。

**代价**：每个自定义类都要写成任意值（`[color:var(--xxx)]`）；接受，作为静态报告这是一次性成本。

### D2：4 态映射 `confidence → 视觉状态`

| confidence              | light（旧） | HeroUI 状态（新） | Chip 文案     |
| ----------------------- | ----------- | ----------------- | ------------- |
| `< thresholds[0]`       | red         | `default`（灰）   | "未触发"     |
| `[thresholds[0], 0.55)` | yellow      | `warning`（弱）   | "酝酿中"     |
| `[0.55, thresholds[1])` | yellow      | `warning`（强）   | "临界"       |
| `>= thresholds[1]`      | green       | `success`         | "已触发"     |

> `0.55` 是右侧信号的内部分级线，单独定义在 `renderer.py` 的常量里，不进 `signals.py`（视觉问题不污染算法层）。

**为什么不**：保留旧的 3 态—— "未触发" 与 "弱失败" 在右侧场景需要进一步区分，否则用户分不清"接近触发"和"远未达到"。

### D3：用 Chip 替换 emoji 状态指示

右侧卡片头部布局：

```
[●  已触发]                       confidence 78%
站回均线
价格站上 MA20，3 日内未跌破。
─────────────────────────  ProgressBar 75%
```

Chip 用 `inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium`，配合 `before:` 圆点；语义色由 D2 决定。

**为什么不**：保留 emoji——emoji 在不同字体渲染差异大（Mac / Windows / 截图工具），Chip 用 CSS 控制更稳定。

### D4：ProgressBar 视觉规范

- track：`h-1.5 rounded-full bg-[var(--color-default-100)]`（HeroUI 浅色 track）
- fill：同状态色 `[background-color:var(--color-success)]`
- 数值用 `Output`（HeroUI 命名）放在 track 上方右对齐 `text-xs tabular-nums`
- 不显示阈值刻度（旧报告底部的"🔴 0-25% 🟡 25-45% ..."）—右侧只关心"是否触发"

### D5：Card 层级与 hover

- 默认 `rounded-2xl shadow-xs border border-[var(--color-divider)] bg-[var(--color-surface)]`
- 已触发态 `bg-[var(--color-surface-secondary)]`（HeroUI 用更深一档 surface 强调"被点亮"）
- hover 不加（静态报告无交互重点）

### D6：放在 `_render_signal_card` 之外做新函数 `_render_right_signal_card`

保持左右两套渲染函数共存，便于：

- 视觉 A/B 对比；
- 后续推广到左侧时只需把调用点从 `_render_signal_card` 切到统一函数；
- 单测可独立 snapshot。

## Risks / Trade-offs

- **[Tailwind CDN 不识别任意值变量]** → 实测在 v3 CDN 上 `[color:var(--x)]` 是支持的；Mitigation：渲染时同时写 `style="color: var(--x);"` 内联兜底，让 CDN 失败时仍生效。
- **[左右两套样式并存增加维护成本]** → 接受：本变更明确把对比作为 Goal，左侧推广列入下一变更的 `tasks.md`。
- **[重新映射 4 态可能让"原本 red 的信号"在新版变成灰色 default，改变用户感知]** → Mitigation：proposal/design 双双说明语义变化；在报告底部页脚加一行小字说明 4 态规则；保留现网旧报告链接 30 天用于回溯。
- **[lightweight-charts 容器仍用 hex 配色]** → 接受：chart 内部配色与外卡分离是合理边界；token 不下钻到 chart。
- **[设计 token 与 `web/` 端 HeroUI 真实 token 漂移]** → Mitigation：token 命名与 HeroUI v3 docs 一致（`--color-success` 等），后续 `web/` 接入时核对一次；本次提交在 `proposal.md` 链出 token 表。

## Migration Plan

1. 在 `renderer.py` 顶部新增 `_DESIGN_TOKENS_CSS` 常量与 `_render_design_tokens()` 函数。
2. 新增常量 `_RIGHT_STATE_TABLE`（4 态映射）。
3. 新增 `_render_right_signal_card(signal, idx)`，使用 D2~D5 的样式。
4. 把 `render_html` 中右侧信号 cards 的渲染从 `_render_signal_card` 切换到 `_render_right_signal_card`。
5. 在 `<head>` 调用 `_render_design_tokens()`。
6. 跑一次现有 ticker（`AAPL` / `0700.HK`）产出 `*_redesign_preview.html` 到 `pipeline/output/`，肉眼比对。
7. 不改 `signals.py`；不删除 `_render_signal_card`（左侧仍用）。

回滚：把第 4 步的调用点切回 `_render_signal_card` 即可，token 注入为纯增量不影响其它部分。

## Open Questions

- 是否需要把"未触发"的卡片折叠成更紧凑的一行？本次按"等高 4 卡"先做，后续若密度仍不够再考虑 Disclosure 折叠。
- 4 态规则中的 0.55 阈值是否要随信号类别动态调整？暂用全局常量，后续根据用户反馈调。
