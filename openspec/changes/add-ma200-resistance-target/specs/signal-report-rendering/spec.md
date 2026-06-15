## ADDED Requirements

### Requirement: MA200 趋势位必须由独立纯函数计算且不进入信号引擎

`pipeline/analyzer/signals.py` MUST 提供模块级纯函数 `compute_ma200_levels(df, current=None)`,且该函数 MUST NOT 出现在 `compute_all_signals` 返回的信号列表中,也 MUST NOT 影响 `phase.py` 的绿灯计数或 `compute_overall_strength` 加权强度。

函数行为:

- 当 `len(df) < 200` 时 MUST 返回 `None`。
- 否则 MUST 返回字典,至少含:`ma200`(最近 200 个收盘价的均值)、`current`(传入的 `current`,缺省取 `df` 末位收盘)、`role`、`distance_pct`。
- `role` MUST 为 `"resistance"`(当 `current < ma200`)或 `"above"`(当 `current >= ma200`)。
- `distance_pct` MUST 等于 `(ma200 - current) / current * 100`;`role == "resistance"` 时该值 MUST 为正。

#### Scenario: 数据不足时返回 None

- **WHEN** 传入一个仅含 199 行收盘价的 DataFrame
- **THEN** `compute_ma200_levels(df)` MUST 返回 `None`

#### Scenario: 现价低于 MA200 标记为 resistance

- **WHEN** 传入 ≥200 行数据,且末位现价低于最近 200 日收盘均值
- **THEN** 返回字典的 `role` MUST 为 `"resistance"`,`distance_pct` MUST > 0,`ma200` MUST 与最近 200 个收盘价均值数学一致(允许 ±0.01 浮点误差)

#### Scenario: 现价站上 MA200 标记为 above

- **WHEN** 传入 ≥200 行数据,且末位现价 ≥ 最近 200 日收盘均值
- **THEN** 返回字典的 `role` MUST 为 `"above"`

#### Scenario: 不污染信号引擎

- **WHEN** 对同一份数据调用 `compute_all_signals(df)`
- **THEN** 返回的信号列表长度 MUST 仍为 11,且其中 MUST NOT 含 `id` 为 MA200 相关的项

### Requirement: 现价低于 MA200 时报告必须标注 MA200 上方压力位

当 `chart_data["trend_levels"]` 的 `role == "resistance"` 时,`render_html()` 输出 HTML MUST:

- 在 Hero 趋势面板(`id="chart-hero"` 容器附近)以 Python 端静态文本输出一行 MA200 压力标注,字面 MUST 同时包含字符串 "MA200" 与 "压力",且 MUST 含与 `trend_levels.ma200` 对应的价格数值与 `distance_pct` 对应的百分比数值(整数或一位小数,四舍五入)。
- 在 `<script>` 段的 Hero 主图渲染函数(`renderHeroTrendChart`)内 MUST 含基于 `DATA.trend_levels` 且 `role === 'resistance'` 条件调用 `createPriceLine` 画 MA200 水平线的代码。
- 在 `<script>` 段的回踩不破图渲染函数(`renderSupportChart` / `drawSupportFrame`)内 MUST 含同样基于 `DATA.trend_levels` 的 `createPriceLine` MA200 线代码。
- `DATA` MUST 含 `trend_levels` 字段(由 `chart_data` 透传)。

#### Scenario: resistance 态 Hero 含压力文案

- **WHEN** `chart_data["trend_levels"] = {"ma200": 420.0, "current": 400.0, "role": "resistance", "distance_pct": 5.0}` 渲染报告
- **THEN** HTML MUST 同时包含字符串 "MA200" 与 "压力" 与 "420" 与 "5"

#### Scenario: resistance 态两图均含 MA200 priceLine 代码

- **WHEN** 渲染任意 resistance 态报告
- **THEN** `<script>` 段 MUST 含 `trend_levels` 引用,且 `renderHeroTrendChart` 与 `renderSupportChart`(或其内部 `drawSupportFrame`)两处 MUST 各含一处 `createPriceLine` 的 MA200 绘制调用

### Requirement: 数据不足或已站上 MA200 时报告必须可靠降级

`render_html()` MUST 满足:

- 当 `chart_data["trend_levels"]` 为 `None`(或缺失)时,输出 HTML MUST NOT 出现 "MA200 压力" 文案,且 MA200 priceLine 在两图均不绘制(JS 以可选链 / 空值判断短路)。
- 当 `role == "above"` 时,Hero 区 MUST 输出中性提示文案(字面含 "MA200" 与 "站上"),且 MUST NOT 输出 "MA200 压力" 字样,两图 MUST NOT 绘制 MA200 压力线。

#### Scenario: trend_levels 为 None 时无 MA200 元素

- **WHEN** `chart_data` 不含 `trend_levels`(或为 `None`)渲染报告
- **THEN** HTML MUST NOT 包含字符串 "MA200 压力"

#### Scenario: above 态显示中性提示而非压力

- **WHEN** `chart_data["trend_levels"] = {"ma200": 380.0, "current": 400.0, "role": "above", "distance_pct": -5.0}` 渲染报告
- **THEN** HTML MUST 包含同时含 "MA200" 与 "站上" 的文案,且 MUST NOT 包含字符串 "MA200 压力"
