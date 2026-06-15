## Why

stock-farmer 的诊断报告核心场景是「判断一只股票是否正从底部走出、进入右侧上涨趋势」。当前的支撑位体系(`signals.py` 的 `_calc_support_zones` / `_select_display_support_zones`)**只识别现价下方的支撑**——展示候选里硬性过滤 `center < current`。这意味着报告完全缺失「反弹之后会在哪里遇到压力 / 第一目标位在哪」这一维度。

200 日均线(MA200)是公认的「牛熊分界线」。在底部反转的早期场景里,价格几乎必然位于 MA200 **下方**,此时下行的 MA200 正是反弹的第一道大压力(套牢盘解套区 + 长期趋势空头盯防的位置 + 大量算法挂单)。把它标注为「上方第一压力位 / 反弹第一目标位」,恰好填补现有体系只有下方支撑的空白,给用户一个明确的「反弹到此要警惕 / 设减仓观察」的参考。

> 设计约束(已与作者确认):MA200 **不**作为第 6 个等权右侧绿灯信号进入 `compute_all_signals`。原因是底部反转早期价格必然在 MA200 下方,若当绿灯计数会在工具最该发挥价值的「右侧初步确认」阶段长期压低综合强度,与工具初衷冲突。因此 MA200 仅作为**报告级辅助标注**,不参与信号灯计数与加权强度计算。

## What Changes

- **新增纯函数计算 MA200 趋势位**:新增 `compute_ma200_levels(df, current)`(`pipeline/analyzer/signals.py`,作为非信号辅助函数,**不**加入 `compute_all_signals` 返回列表)。返回 `{ma200, slope_dir, role, distance_pct}`:
  - `role = "resistance"`:当 `current < ma200`,MA200 作为上方第一压力 / 反弹第一目标位。
  - `role = "above"`:当 `current >= ma200`,价格已站上牛熊线,MA200 转为支撑,**不**画压力线,仅做中性文案提示。
  - 数据不足(`len(df) < 200`)时返回 `None`,全程静默降级,报告不出现任何 MA200 元素。
- **数据流贯通**:`analyze.py` 在算完信号后调用该函数,把结果放进 `chart_data["trend_levels"]`,经 `render_html` 注入到前端 `DATA`。
- **Hero 主图渲染 MA200 线**:在 `renderHeroTrendChart` 中读取 `DATA.trend_levels`,当 `role == "resistance"` 时用 lightweight-charts 的 `createPriceLine` 画一条 MA200 水平虚线,`title` 含价格,与现有支撑/前低 priceLine 风格一致(虚线、语义色)。
- **Hero 文案标注**:在 Hero 趋势面板加一行说明:`role == "resistance"` → 「上方第一压力(MA200):$X · 距现价 +Y%」;`role == "above"` → 「已站上 MA200(牛熊线上方)」中性提示。
- **不影响信号引擎**:`compute_all_signals` 返回的 11 信号、`phase.py` 的绿灯计数与 `compute_overall_strength` 加权强度**完全不变**。

## Capabilities

### New Capabilities
<!-- 无新能力 -->

### Modified Capabilities
- `signal-report-rendering`: 在既有渲染契约基础上**扩展** Hero 区——新增「当现价低于 MA200 时,Hero 主图 MUST 画出 MA200 阻力线并以文案标注其价格与距现价百分比」的要求;当数据不足或价格已站上 MA200 时的降级行为也纳入契约。既有 Hero 圆环 / 双大卡 / 明细表的要求不变。

## Impact

- **受影响代码**:
  - `pipeline/analyzer/signals.py` —— 新增 `compute_ma200_levels` 纯函数(独立于信号引擎)。
  - `pipeline/analyze.py` —— 调用上述函数并写入 `chart_data["trend_levels"]`。
  - `pipeline/analyzer/renderer.py` —— `renderHeroTrendChart` JS 段读取 `trend_levels` 画 priceLine;Hero 趋势面板加文案。
  - `pipeline/analyzer/test_renderer.py` + `pipeline/tests/test_analyzer.py` —— 单测扩展(函数纯逻辑 + 端到端 HTML 断言)。
- **不影响**: `compute_all_signals` 的 11 信号算法、`phase.py`、`narrative.py`、数据源(`fetcher/*` / `data/*`)、GitHub Actions workflow、`api/`(Cloudflare Workers)、codex React/server spike。
- **依赖**: 仍用 lightweight-charts CDN,**不引入** echarts / React / 新 npm 依赖。`analyze.py` 已拉取 1260 日 K 线(`count=1260`),MA200 数据充足。
- **风险**: 1) 部分次新股 / 数据源回看不足 200 日时需可靠降级(返回 `None`,不画线);2) MA200 是概率性参考位而非精确价,文案需措辞为「参考压力 / 目标」避免被理解为精确预测。
- **回滚**: 改动集中在 3 个文件 + 2 个测试文件,git revert 可还原。
