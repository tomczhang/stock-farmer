## 1. MA200 计算(信号引擎外的纯函数)

- [x] 1.1 在 `pipeline/analyzer/signals.py` 新增模块级纯函数 `compute_ma200_levels(df: pd.DataFrame, current: float | None = None) -> dict | None`:`len(df) < 200` 返回 `None`;否则 `ma200 = float(df["close"].astype(float).tail(200).mean())`,`current` 缺省取 `float(df["close"].astype(float).iloc[-1])`,`role = "resistance" if current < ma200 else "above"`,`distance_pct = (ma200 - current) / current * 100`,返回 `{"ma200", "current", "role", "distance_pct"}`(数值适度 round)
- [x] 1.2 确认 `compute_all_signals` 返回列表 **不含** MA200,`phase.py` 不引用该函数(零改动验证)

## 2. 数据流贯通

- [x] 2.1 在 `pipeline/analyze.py:analyze()` 顶部 import 处加入 `compute_ma200_levels`(与 `compute_all_signals` 同源)
- [x] 2.2 在 `analyze()` 构造 `chart_data` 字典时加 `"trend_levels": compute_ma200_levels(df, price)`(`price` 为现有现价变量)
- [x] 2.3 验证 `render_html` 已通过 `chart_payload = dict(chart_data or {})` 透传 `trend_levels` 进 `DATA`(无需改 `render_html` 签名)

## 3. Hero 主图渲染 MA200 压力线 + 文案

- [x] 3.1 在 `renderer.py` 的 `renderHeroTrendChart` JS 段,`area.setData(...)` 之后加:`const tl = DATA.trend_levels; if (tl && tl.role === 'resistance') area.createPriceLine({ price: tl.ma200, color: '#7c3aed', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'MA200 压力' });`
- [x] 3.2 在 Hero 趋势面板渲染函数(`_render_hero` / `_render_hero_trend_panel`,`chart-hero` 容器附近)读取 `chart_data["trend_levels"]`,Python 端静态输出文案行:`resistance` → 「上方第一压力(MA200):$X · 距现价 +Y%」;`above` → 「已站上 MA200(牛熊线上方)」;`None` → 不输出。需把 `trend_levels` 传入相应渲染函数(或在 `render_html` 内组装该行 HTML 片段后插入 Hero)

## 4. 回踩不破图渲染 MA200 压力线

- [x] 4.1 在 `renderer.py` 的 `renderSupportChart` → `drawSupportFrame(tf)` 内,`zones.forEach(...)` 画完支撑后加:`const tl = DATA.trend_levels; if (tl && tl.role === 'resistance') series.createPriceLine({ price: tl.ma200, color: '#7c3aed', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'MA200 压力' });`
- [x] 4.2 确认 `above` / `null` 态两图均不画线(可选链短路),不报错

## 5. 单测扩展

- [x] 5.1 `pipeline/tests/test_analyzer.py` 加 `compute_ma200_levels` 单测:① 199 行 → `None`;② ≥200 行且现价低于均值 → `role=="resistance"` 且 `distance_pct > 0` 且 `ma200` 与 `tail(200).mean()` 一致(±0.01);③ 现价高于均值 → `role=="above"`;④ `compute_all_signals(df)` 仍返回 11 项且不含 MA200
- [x] 5.2 `pipeline/analyzer/test_renderer.py` 加端到端断言:① `trend_levels` resistance 态 → HTML 含 "MA200"、"压力"、价格数、百分比数,且 JS 段含 `trend_levels` 与两处 `createPriceLine` MA200 调用;② `above` 态 → 含 "站上" 且不含 "MA200 压力" 文案;③ 无 `trend_levels` → 不含 "MA200 压力"

## 6. 实盘验证

- [x] 6.1 `python3 -m pytest pipeline/tests/test_analyzer.py pipeline/analyzer/test_renderer.py -v` 全绿
- [x] 6.2 `python3 pipeline/analyze.py 0700.HK` 报告生成无异常(0700.HK 现价多在 MA200 上下,验证 resistance/above 至少一态)
- [ ] 6.3 用 chrome devtools MCP 打开报告,确认 Hero 主图与回踩不破图各有一条紫色 MA200 虚线(resistance 态)+ Hero 含「上方第一压力(MA200)」文案;截图存 `pipeline/output/`
- [ ] 6.4 `mcp__chrome-devtools__list_console_messages types=["error","warn"]` 无 lightweight-charts / undefined 报错(仅允许 Tailwind CDN 警告)

## 7. 收尾

- [x] 7.1 `git diff --stat` 仅 `pipeline/analyzer/signals.py` + `pipeline/analyze.py` + `pipeline/analyzer/renderer.py` + 2 测试文件改动(+ openspec 文档)
- [x] 7.2 确认 `signals.py` / `phase.py` 的信号算法与加权强度逻辑无改动(`git diff` 仅新增 `compute_ma200_levels`,无既有函数改动)
