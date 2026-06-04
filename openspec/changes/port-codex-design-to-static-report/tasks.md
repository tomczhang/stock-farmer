## 1. 设计 token 增量扩展

- [x] 1.1 在 `pipeline/analyzer/renderer.py` 的 `_DESIGN_TOKENS_CSS` 内,在保留既有 12 个 token 不变的前提下新增 `--accent: #2563eb`、`--text-primary: #0f172a`、`--text-secondary: #475569`、`--text-muted: #94a3b8`、`--bg-app: #f8fafc` 5 个变量

## 2. 计算与状态映射

- [x] 2.1 实现纯函数 `_compute_confirmation(signals: list[SignalResult]) -> dict`,返回 `{score_pct, total_weight, left:{score_pct,weight,confirmed_count,total_count}, right:{...}}`,各组 `score_pct = round(100 * sum(c*w) / sum(w))`,`confirmed_count = count(light=="green")`;空组返回 `score_pct=0, weight=0`
- [x] 2.2 实现常量 `_LEFT_STATE_TABLE: dict[str, tuple[str, str, str]]`,键 `red/yellow/green` → `(label, color_var, color_100_var)`(详见 spec)
- [x] 2.3 实现纯函数 `_resolve_left_state(light: str) -> str`,返回 `_LEFT_STATE_TABLE` 的键

## 3. Hero 区渲染

- [x] 3.1 实现 `_render_hero_circle(phase: PhaseResult, conf: dict) -> str`:输出 SVG 圆环(viewBox 104×104,r=42,圆周 ≈263.89,`stroke-dashoffset = 263.89 * (1 - strength_pct/100)`)+ 中心 strength_pct 大字 + 下方 phase 名 + action 副文案;颜色按 strength_pct 区间(<25=danger / 25-60=warning / >=60=success)
- [x] 3.2 实现 `_render_hero_formula(conf: dict) -> str`:输出形如 `63% × 7权重 + 60% × 6权重` 的加权公式与左右双 meter(细进度条 + "K/N 项确认 · 权重 W")
- [x] 3.3 实现 `_render_hero_trend_panel() -> str`:输出右侧 2/3 列容器,内含 `<div id="chart-hero" class="chart-container">` 与简短的卡片标题"价格趋势 · 趋势确认轨迹"
- [x] 3.4 在 `render_html` 模板中,把原 Conclusion 卡 + 阈值刻度尺整段删除,替换为 Hero 双栏 grid(`grid-cols-1 md:grid-cols-3 gap-6`)

## 4. 综述卡 + 下一触发

- [x] 4.1 改写既有 Narrative section:左侧 narrative 文字、右侧 "下一触发" 小标签 + `phase.trigger`,卡片外壳 `rounded-2xl` + `var(--color-divider)` 边框 + `var(--shadow-xs)` 阴影 + `var(--color-surface)` 底色

## 5. 双信号大卡(列表式 details 行)

- [x] 5.1 实现 `_render_signal_row(s: SignalResult, idx: int, side: str) -> str`:外层 `<details data-chart-idx="{idx}">`;`<summary>` 行同时含 name(粗) / description(灰) / Chip / `confidence%`;展开容器内含可选 `_render_signal_detail(s)` 与 `<div id="chart-{idx}">`
- [x] 5.2 实现 `_render_signal_group_panel(side: str, signals: list[SignalResult], conf_group: dict, idx_offset: int) -> str`:大卡头部 "左侧信号 / 右侧信号" + "权重 N" 胶囊 + "X% 加权分" 大字;主体是若干 `_render_signal_row(s, i + idx_offset, side)`;Chip 配色:左侧用 `_resolve_left_state` + `_LEFT_STATE_TABLE`,右侧沿用 `_resolve_right_state` + `_RIGHT_STATE_TABLE`
- [x] 5.3 在 `render_html` 中替换原 "Left + Right Signals (side by side)" 区段为 `_render_signal_group_panel("left", ...)` + `_render_signal_group_panel("right", ...)` 双栏 grid(`grid-cols-1 lg:grid-cols-2 gap-6`),`idx_offset` 左侧 0,右侧 6
- [x] 5.4 移除 `<summary>` 旋转三角:`<style>` 内加 `summary::-webkit-details-marker { display: none; } summary::marker { content: ""; }`,改用自定义 `+`/`−` 图标(纯 CSS)
- [x] 5.5 验证 `render_html` 不再调用 `_render_signal_card` 与 `_render_right_signal_card`(保留函数本身但加 deprecation comment)

## 6. 子信号明细表 + tabs

- [x] 6.1 实现 `_render_signal_detail_table(signals: list[SignalResult]) -> str`:头部 "子信号明细" + "权重、确认度与状态";右上 3 个 `<button data-filter="all|left|right" class="..."`;表格 5 列(信号 / 类别 / 权重 / 状态 / 确认度);每行 `<tr data-category="{side}">`
- [x] 6.2 "确认度"列内含整数百分比文本 + 细进度条 `<div class="h-1.5 rounded-full" style="background: var(--color-default-100);"><div style="width: {pct}%; background: {state_color};"></div></div>`
- [x] 6.3 在 `render_html` 中把明细表插入到双信号大卡之后、footer 之前
- [x] 6.4 `<script>` 段加 tabs filter 逻辑:监听 3 个按钮 click,根据 `data-filter` 设置 tbody 上某 data 属性;CSS 用 `tbody[data-active="left"] tr[data-category="right"] { display: none; }` 等规则隐藏

## 7. JS 段:Hero 主图 + 按需渲染

- [x] 7.1 在 `<script>` 段新增 `renderHeroTrendChart(klines)` 函数:单 chart,价格 area series(`addAreaSeries`,色 `var(--accent)` 或 `#2563eb`)+ 成交量 histogram(下方 30%);沿用 `createChart` 套路加 ResizeObserver
- [x] 7.2 把现有 `initCharts()` 中遍历 0..9 立刻渲染的逻辑拆为:`renderHero()` 立刻调用 + `renderSignalChart(idx)` 单函数(switch idx 路由到 9 个既有渲染函数)
- [x] 7.3 `window.load` 时仅调 `renderHero()`,不再批量渲染信号 chart
- [x] 7.4 加 `document.querySelectorAll('details[data-chart-idx]').forEach(d => d.addEventListener('toggle', ...))`:首次 `open=true` 且 idx 未渲染时调 `renderSignalChart(idx)`,用 `Set` 标志位防重
- [x] 7.5 `toggle` 回调内用 `requestAnimationFrame` 包一层,确保浏览器先 layout 让 chart 容器拿到非 0 宽度

## 8. 单测扩展

- [x] 8.1 `pipeline/analyzer/test_renderer.py` 加 `_resolve_left_state` 3 条参数化(red→red, yellow→yellow, green→green)与"未知 light fallback 到 red"的边界条
- [x] 8.2 加 `_compute_confirmation` 单测:用 spec scenario 中那组数(left conf [0.3..0.7] w[1,1,2,1,1,1] / right conf [0.9,0.6,0.5,0.2] w[2,2,1,1])断言 `left.score_pct=59 / right.score_pct=62 / score_pct=60 / total_weight=13 / left.confirmed_count(基于 light)`
- [x] 8.3 端到端断言 `render_html` 输出包含:"加权分"、"权重"、`<details`、`data-chart-idx`、`id="chart-hero"`、`data-filter="all"`、`data-filter="left"`、`data-filter="right"`、"子信号明细"、"renderHeroTrendChart"
- [x] 8.4 端到端断言 vol_shrink 5 维表头("观察项 / 权重 / 判断标准 / 数据明细 / 比值 / 状态")出现在某个 `<details>` 的展开内容中
- [x] 8.5 端到端断言 HTML 不含 "echarts"、"recharts"、"react-dom"、"@heroui"、"unpkg.com/react"
- [x] 8.6 端到端断言:左侧任一 green 信号渲染含 "确认";yellow 含 "观察";red 含 "未触发"。任一 `<details>` 内不含 🔴/🟡/🟢

## 9. 实盘验证

- [x] 9.1 `python3 -m pytest pipeline/analyzer/test_renderer.py -v` 全绿
- [x] 9.2 `python3 pipeline/analyze.py 0700.HK` 报告生成无异常,产物在 `pipeline/output/0700.HK_<date>.html`
- [x] 9.3 用 chrome devtools MCP 打开报告,viewport 1280×2400 全页截图保存到 `pipeline/output/0700.HK_full_v3.png`
- [x] 9.4 在浏览器里点击 vol_shrink 行 details 展开,截图 `pipeline/output/screenshot_vol_shrink_expanded.png`,确认含 5 维表 + 公式 + chart 容器
- [x] 9.5 在浏览器里点 "右侧" tab,截图 `pipeline/output/screenshot_detail_tab_right.png`,确认明细表只显示右侧 4 行
- [x] 9.6 `mcp__chrome-devtools__list_console_messages types=["error","warn"]` —— 仅允许 Tailwind CDN production 警告,无 ResizeObserver / lightweight-charts / undefined 报错
- [x] 9.7 `grep -n "echarts" pipeline/analyzer/renderer.py` 应为空;`grep -n "lightweight-charts" pipeline/analyzer/renderer.py` 应至少出现 2 处(CDN + Hero 渲染)

## 10. 收尾

- [x] 10.1 `git diff --stat` 仅 `pipeline/analyzer/renderer.py` + `pipeline/analyzer/test_renderer.py` 两文件改动(+ openspec 文档)
- [x] 10.2 `openspec validate port-codex-design-to-static-report` 通过
- [x] 10.3 在 PR / 提交说明里粘贴 9.3 / 9.4 / 9.5 三张截图;附上对照的 codex React demo 截图(`pipeline/output/codex_new_report.png`)以便 reviewer 比较视觉对齐度
