## Why

当前由 `pipeline/analyzer/renderer.py` 产出的诊断报告中，"右侧信号 · 趋势确认" 一栏与 "左侧信号" 共用一套朴素 Tailwind 样式：白底卡片 + 单行标题 + 一句结论 + 进度条，视觉层级扁平、缺乏语义颜色与状态标识，不利于用户快速分辨"已触发 / 边缘 / 未触发"等关键状态。本次借鉴 HeroUI v3 的设计语言（Card / Chip / ProgressBar 的语义色与 surface 层级、间距、圆角、阴影规范）对右侧信号区进行视觉重构，使报告与项目 React 端（`web/`，已规划接入 HeroUI）保持一致的视觉调性。

> 约束：报告本身是 Python 端生成的静态 HTML，无法直接挂载 React 组件。本变更**只迁移 HeroUI 的设计 token / Tailwind 类风格**，组件化的真正接入由后续独立变更负责。

## What Changes

- 重写 `pipeline/analyzer/renderer.py` 中右侧信号区（`右侧信号 · 趋势确认`）的卡片渲染逻辑：
  - 引入语义状态色 `success / warning / danger / default`，对应信号 `green / yellow / red / 未触发` 四种结果。
  - 卡片头部加入 HeroUI 风格的 Chip（圆角胶囊 + 语义色 dot + 状态文案），替换当前的 emoji + 文字混排。
  - 进度条改用 HeroUI ProgressBar 的视觉规范（细高度、语义色填充、track 圆角、`Output` 数值右对齐）。
  - Card 采用 HeroUI `surface` 层级（默认 `bg-surface`、激活/触发态 `bg-surface-secondary`），统一 `rounded-2xl`、`shadow-xs`、`border-divider` 取代当前 `rounded-xl`、`shadow-sm`、`border-gray-200`。
  - 标题层级：信号名 + 一句结论改为 `Card.Title` + `Card.Description` 排版规范（字重、字号、行高）。
- 在 HTML `<head>` 中注入与 HeroUI v3 一致的 CSS 设计 token（语义色变量、surface、divider、radius、shadow），以 inline `<style>` 暴露给 Tailwind CDN 任意 class 使用。
- 左侧信号区不动；仅当后续验证视觉一致后再考虑同步（见 Non-goals）。
- 增加快照测试夹具：在 `pipeline/output/` 下保留一份 `*_redesign_preview.html` 用于人工对比。

## Capabilities

### New Capabilities
- `signal-report-rendering`: 报告 HTML 的视觉规范——颜色 / 圆角 / 阴影 / 层级 / 信号状态映射，作为 `renderer.py` 输出的契约。

### Modified Capabilities
<!-- 暂无现有 spec 命中此领域；archive 中的 stock-signal-analyzer 关注信号算法，不涉及视觉规范 -->

## Impact

- 受影响代码：
  - `pipeline/analyzer/renderer.py`（核心改动）
  - `pipeline/analyzer/signals.py` 的 `SignalResult.color` 字段语义保持不变，但消费方调整。
- 新增/修改资产：报告 `<head>` 内 CSS 设计 token block。
- 依赖：仍使用 Tailwind CDN（`https://cdn.tailwindcss.com`）；不引入 npm 依赖、不打包 React。
- 风险：Tailwind CDN 不识别自定义 token 时需 fallback 到具体 hex 颜色；ResizeObserver / lightweight-charts 与新色系不冲突。
- 不影响：API、数据管道、左侧信号、TradingView chart 渲染逻辑、首页（`index.html`）。
