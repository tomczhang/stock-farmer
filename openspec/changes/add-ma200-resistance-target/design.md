## Context

诊断报告由 `pipeline/analyze.py` → `pipeline/analyzer/renderer.py:render_html` 产出静态 HTML。当前支撑位体系(`signals.py` 的 `_calc_support_zones` / `_select_display_support_zones`)硬性过滤 `center < current`,**只显示现价下方支撑**,缺失「反弹会在哪里遇压力」这一维度。

相关现状:

- `analyze.py:analyze()` 已用 `get_klines(ticker, period="1d", count=1260)` 拉取约 5 年日 K,**MA200 数据充足**;算完信号后构造 `chart_data = {klines, index_klines, volume_profile, ...}`,调 `render_html(..., chart_data=chart_data)`。
- `render_html` 把 `chart_payload = dict(chart_data or {})` 注入前端 `const DATA = {chart_json}`,JS 端可直接读 `DATA.<key>`。已有 `DATA.signal_data`、`DATA.klines` 等。
- Hero 主图 JS `renderHeroTrendChart(id, klines)`:`addAreaSeries`(收盘 area,色 `#2563eb`)+ `addHistogramSeries`(成交量),在 `window.load` 时立刻渲染。`area` 变量持有 series 引用。
- 回踩不破图 JS `renderSupportChart(id, klines, signalData)` → 内部 `drawSupportFrame(tf)` 用 `series.createPriceLine({price, color, lineWidth:1, lineStyle:2, ...})` 画支撑上下沿,已有「前低 / 支撑」priceLine 的成熟用法。
- 信号引擎 `compute_all_signals` 返回 11 个 `SignalResult`;`phase.py` 按 `light=="green"` 计数 + `compute_overall_strength` 加权。**本变更绝不触碰这条链路。**

## Goals / Non-Goals

**Goals**

- 计算 MA200,并在「现价低于 MA200」时把它标注为「上方第一压力位 / 反弹第一目标位」。
- 在 Hero 主图与回踩不破图(chart-7,`renderSupportChart`)上各画一条 MA200 水平虚线,与下方支撑形成「上压力 / 下支撑」夹击视图。
- Hero 区文案给出 MA200 价格与距现价百分比。
- 数据不足 / 已站上 MA200 时可靠降级,报告不出错、不误导。

**Non-Goals**

- 不把 MA200 做成第 6 个右侧绿灯信号(不进 `compute_all_signals`、不参与 phase 计数与加权强度)。
- 不画整条 MA200 历史曲线(只画「当前 MA200 值」的水平参考位,符合「目标位」语义,与现有 priceLine 风格一致)。
- 不动 MA200 斜率分级 / 牛熊环境过滤(那是被推迟的方案 A,后续独立变更)。
- 不引入 echarts / React / 新 npm 依赖;不改数据源、GitHub Actions、`api/`。

## Decisions

### D1 — MA200 计算落在 `signals.py` 的独立纯函数,不进信号列表

**选择**:在 `pipeline/analyzer/signals.py` 新增模块级纯函数:

```python
def compute_ma200_levels(df: pd.DataFrame, current: float | None = None) -> dict | None:
    """计算 MA200 趋势位。非信号——不进入 compute_all_signals。

    返回 None 当 len(df) < 200。否则返回:
      {
        "ma200": float,            # 最新 MA200 值
        "current": float,          # 现价(传入或取 df 末收盘)
        "role": "resistance"|"above",  # current<ma200 → resistance;否则 above
        "distance_pct": float,     # (ma200-current)/current*100,resistance 为正
      }
    """
```

`current` 缺省时取 `float(df["close"].iloc[-1])`。MA200 = `float(df["close"].astype(float).tail(200).mean())`。

**为什么不**:放进 `compute_all_signals` —— 用户已明确否决「等权绿灯」(底部反转早期价格必然在 MA200 下方,会长期压低综合强度)。放独立纯函数,信号引擎零改动,且易于单测。

**为什么不**:新建 `levels.py` 模块 —— 单个小函数,与现有 `_calc_atr` 等辅助函数同处 `signals.py` 即可,避免过度拆分。

### D2 — 数据流走 `chart_data["trend_levels"]`,零签名改动

**选择**:`analyze.py:analyze()` 在构造 `chart_data` 时加一行 `"trend_levels": compute_ma200_levels(df, price)`(`price` 即现有的现价变量)。`render_html` 已 `chart_payload = dict(chart_data or {})` 透传,`trend_levels` 自动进 `DATA`。JS 端读 `DATA.trend_levels`。

**为什么不**:给 `render_html` 加新参数 —— 透传链路已存在,加参数反而扩大签名 / 改调用点,收益为零。

### D3 — 两图都画水平 priceLine,JS 从 `DATA.trend_levels` 读

**选择**:

- Hero 主图 `renderHeroTrendChart`:在 `area.setData(...)` 之后,若 `DATA.trend_levels?.role === 'resistance'`,调 `area.createPriceLine({ price: ma200, color: '#7c3aed', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'MA200 压力' })`。
- 回踩不破图 `renderSupportChart` 的 `drawSupportFrame`:在 `zones.forEach(...)` 画完支撑后,同样条件下在 `series` 上 `createPriceLine` 画 MA200 线(同色 `#7c3aed` 紫,与成交量图 MA60 紫一致,且区别于支撑绿 / 前低红)。
- `role === 'above'` 或 `trend_levels` 为 `null` 时:两图都不画 MA200 线。

**为什么紫色**:报告里红=前低/破位、绿=支撑/涨、橙=次级支撑,紫色(`#7c3aed`,已用于成交量 MA60)未被支撑/阻力占用,语义上「长期均线」与量能 MA60 同源,辨识度高。

### D4 — Hero 文案行

**选择**:在 Hero 趋势面板(`_render_hero` / `_render_hero_trend_panel` 输出的右 2/3 列容器,chart-hero 标题附近)加一行 Python 端静态文案:

- `role == "resistance"` → 「上方第一压力(MA200):$X · 距现价 +Y%」(X、Y 来自 `trend_levels`,Python 端格式化,避免依赖 JS)。
- `role == "above"` → 「已站上 MA200(牛熊线上方)」中性提示。
- `trend_levels` 为 `None` → 不输出该行。

文案在 Python 端渲染(`render_html` 能拿到 `chart_data["trend_levels"]`),不依赖前端 JS,保证无 JS 环境(如截图工具)也能看到。

**为什么不**:纯 JS 注入文案 —— Python 端已有数据,静态渲染更稳、可被端到端 HTML 断言直接覆盖。

### D5 — 措辞为「参考压力 / 目标」,不暗示精确预测

**选择**:文案统一用「第一压力 / 参考」字样,proposal 风险点要求。priceLine 的 `title` 用「MA200 压力」。

## Risks / Trade-offs

- **[数据回看不足 200 日]** → `compute_ma200_levels` 返回 `None`,`analyze.py` 写入 `trend_levels: None`,两图 JS `?.role` 短路不画,Hero 文案行不输出。已用 `len(df) < 200` 守卫。
- **[现价已站上 MA200]** → `role="above"`,不画压力线(C 只在线下成立),Hero 给中性提示,避免把支撑画成「压力」。
- **[MA200 水平线横跨全图与历史价格交叉,可能被误读为历史 MA200]** → 接受:与现有「前低 / 支撑」priceLine 同一视觉范式(都是贯穿水平线表示「一个价位」);`title`「MA200 压力」明确其为当前参考位。
- **[`price` 在 analyze.py 偶为 None]** → `compute_ma200_levels` 的 `current` 缺省回退到 `df` 末收盘,函数内自洽。
- **[MA200 是概率位非精确价]** → D5 文案措辞缓解。

## Migration Plan

1. `signals.py` 加 `compute_ma200_levels` 纯函数。
2. `analyze.py` 构造 `chart_data` 时加 `"trend_levels": compute_ma200_levels(df, price)`。
3. `renderer.py`:`renderHeroTrendChart` JS 段加 MA200 priceLine;`renderSupportChart`/`drawSupportFrame` JS 段加 MA200 priceLine;Hero 趋势面板加文案行(读 `chart_data["trend_levels"]`)。
4. 单测:`test_analyzer.py` 加 `compute_ma200_levels`(数据足/不足/线上/线下)纯逻辑断言;`test_renderer.py` 加端到端 HTML 断言(resistance 含文案 + priceLine JS;above 含中性提示;None 不含 MA200 元素)。
5. 实盘:`python3 pipeline/analyze.py 0700.HK` 跑通,chrome devtools 截图确认两图 MA200 线 + Hero 文案。

回滚:改动集中 `signals.py` + `analyze.py` + `renderer.py` + 2 测试文件,git revert 可还原。

## Open Questions

- MA200 priceLine 是否需要在「距现价过近(如 <2%)」时合并/抑制以免与支撑线视觉重叠?暂不处理,若实盘观感差再加阈值。
- 是否在 `above` 态把 MA200 当支撑画到回踩不破图(角色翻转)?本变更不做,留待方案 A(趋势环境)统一处理。
