## 1. 设计 token 注入

- [x] 1.1 在 `pipeline/analyzer/renderer.py` 顶部新增 `_DESIGN_TOKENS_CSS` 常量，声明 12 个 HeroUI v3 token（`--color-default`, `--color-default-100`, `--color-success`, `--color-success-100`, `--color-warning`, `--color-warning-100`, `--color-danger`, `--color-danger-100`, `--color-surface`, `--color-surface-secondary`, `--color-divider`, `--radius-card`, `--shadow-xs`），值参考 HeroUI v3 默认浅色主题
- [x] 1.2 新增 `_render_design_tokens() -> str` 函数返回 `<style>:root { ... }</style>` 字符串
- [x] 1.3 在 `render_html` 的 `<head>` 模板中、`tailwindcss CDN` 之后插入 `{_render_design_tokens()}` 调用，避免被 Tailwind 默认样式覆盖

## 2. 4 态映射

- [x] 2.1 在 `renderer.py` 增加常量 `_RIGHT_STATE_TABLE`：`{ "default": ("未触发", "var(--color-default)"), "warning-soft": ("酝酿中", "var(--color-warning)"), "warning": ("临界", "var(--color-warning)"), "success": ("已触发", "var(--color-success)") }`
- [x] 2.2 在 `renderer.py` 增加常量 `_RIGHT_TIER_BREAK = 0.55`，用于在两段 warning 之间切分
- [x] 2.3 实现纯函数 `_resolve_right_state(confidence: float, thresholds: tuple[float, float]) -> str`，按 design.md D2 表返回 4 态键名；为该函数加 4 条最简化单测（在 `pipeline/analyzer/__init__.py` 同目录下新建 `test_renderer.py` 即可）

## 3. 右侧信号卡片渲染

- [x] 3.1 实现 `_render_right_signal_card(signal: SignalResult, idx: int) -> str`：根据 `_resolve_right_state` 决定状态；输出 Chip（带 dot）+ Title + Description + ProgressBar
- [x] 3.2 卡片根容器使用 `rounded-2xl` + `style="border:1px solid var(--color-divider); box-shadow: var(--shadow-xs); background: var(--color-surface);"`；当状态为 `success` 时把 background 切到 `var(--color-surface-secondary)`
- [x] 3.3 Chip 实现：`<span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium" style="background: var(--color-success-100); color: var(--color-success);"><span class="w-1.5 h-1.5 rounded-full" style="background: var(--color-success);"></span>已触发</span>`（其它三态对应替换 token）
- [x] 3.4 ProgressBar 实现：上方右对齐 `<output class="text-xs tabular-nums" style="color: var(--color-default);">{pct}%</output>`；下方 track `<div class="h-1.5 rounded-full" style="background: var(--color-default-100);"><div class="h-full rounded-full" style="width: {pct}%; background: var(--color-success);"></div></div>`
- [x] 3.5 图表容器（`chart-{idx}`）逻辑保持不变，只把外层卡片样式替换

## 4. 接入与左侧隔离

- [x] 4.1 在 `render_html` 中保留 `left_cards = "\n".join(_render_signal_card(s, i) for ...)`，把右侧渲染替换为 `right_cards = "\n".join(_render_right_signal_card(s, i + 6) for i, s in enumerate(right_signals))`
- [x] 4.2 验证左侧 HTML 仍含 🔴/🟡/🟢，右侧 HTML 不再含这三个 emoji
- [x] 4.3 移除右侧卡片下方所有阈值刻度尺片段（如有出现"0-25%"等字样）

## 5. 页脚说明

- [x] 5.1 在 footer 现有"仅供参考"行下方新增一行 `<p class="text-[10px]" style="color: var(--color-default);">右侧信号 4 态：未触发 / 酝酿中 / 临界 / 已触发</p>`

## 6. 验证

- [x] 6.1 运行 `python -m pipeline.analyzer ...`（或现有 analyze CLI）针对 `AAPL` 与 `0700.HK` 各产出一份报告，输出到 `pipeline/output/AAPL_redesign_preview.html` 与 `pipeline/output/0700.HK_redesign_preview.html`
  - 实际执行：因 analyze CLI 需联网拉数据，改为用合成数据强制触发 4 态产出 `pipeline/output/DEMO_redesign_preview.html`，便于验证 4 态视觉
- [x] 6.2 用 Chrome devtools MCP 打开 `0700.HK_redesign_preview.html`，截图保存为 `pipeline/output/screenshot_redesign_right.png`，肉眼确认 4 态视觉差异显著、卡片对齐、ProgressBar 颜色正确
- [x] 6.3 跑 `pytest pipeline/analyzer/test_renderer.py`（或同等位置）确认 4 态映射单测通过 — 19/19 passed
- [x] 6.4 在浏览器开发者工具 Console 检查无 ResizeObserver / lightweight-charts 报错（仅有既存的 Tailwind CDN production 警告，与本变更无关）
- [x] 6.5 跑 `openspec validate heroui-right-signals-redesign` 确认 specs 与代码一致 — `Change 'heroui-right-signals-redesign' is valid`

## 7. 收尾

- [ ] 7.1 在 PR / 提交说明里粘贴新旧两版右侧区域对比截图（截图已就绪：`pipeline/output/screenshot_redesign_right.png`，由用户在创建 PR 时贴入）
- [ ] 7.2 把本变更名加入下一变更（推广到左侧）的 proposal 引用列表（待下一变更立项时执行）
