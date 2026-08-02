## Context

现有分析链：`compute_all_signals`（11 信号）→ `determine_phase`（按左右绿灯数分档）→ `make_report_payload` → `server.py` / `renderer.py` / React `SignalTrendReport`。用户判定这套"11 信号平铺 + 左右分组"结构判读不清晰，要求以筑底三迹象（缩量下跌 / 假破位收回 / 筹码稳定）为核心重构判读层，结论一眼可读。约束：日线 OHLCV 是唯一可靠数据（港美股无流通股本、分钟数据在 as-of 模式不可用）；as-of 防未来函数是硬红线；文案不得出现胜率/概率措辞。

## Goals / Non-Goals

**Goals:**
- 新增筑底三迹象判读引擎 `pipeline/analyzer/bottoming.py`，输出三迹象得分 + 聚合结论 + 洗盘干净度
- 报告 payload / 静态 HTML / React 前端全部以筑底判读为第一结论区
- 三迹象在 as-of 历史复盘模式下完整可算（纯日线口径）
- 右侧触发信号降级为"出手时机确认"辅助层

**Non-Goals:**
- 不删除现有 11 信号计算函数（其中 S1/S3 的计算被迹象一/二复用；右侧 5 信号保留为确认层）
- 不改 D1 schema、Cloudflare Workers API、PE 分位产品线
- 不做交易回测/胜率统计（语义红线）
- 不引入换手率绝对值（无流通股本数据源）

## Decisions

### D1: 引擎独立成模块，复用而非重写底层计算
`bottoming.py` 定义 `BottomingSign`（id/name/score/state/description/dimensions）与 `BottomingVerdict`（tier/icon/action/next_trigger/cleanliness/signs），入口 `compute_bottoming(df, index_df=None) -> BottomingVerdict`。
- 迹象一直接调用 `signals._calc_vol_shrink(df)` 取其 `data["scores"]` 五维明细重新包装（不复制算法）。
- 迹象二组合 `signals._calc_false_breakdown(df)`（权重 0.65）与 `signals._calc_no_new_low(df)`（权重 0.35）；无稳定支撑时退化为仅"跌不动"证据并如实描述。
- 迹象三为新算法（见 D2）。
- 备选方案"在 signals.py 里加第 12 个信号"被否：判读层与信号层职责不同，混在一起又回到平铺问题。

### D2: 筹码稳定 = 日线筹码峰对比 + 量能分位低换手
- **筹码峰不下移**：用 `data.indicators.build_volume_profile`（对日线同样适用，close 计价、volume 加权）分别对近 30 个交易日窗口与其前 30 个交易日窗口构建 profile，取各自最大量能桶的 `price_level` 为筹码峰。得分 = `clamp(1 - max(0, prev_peak - recent_peak) / ATR20)`；下移超 1 个 ATR 记 0 分。
- **低换手（代理）**：计算近 250 日（不足则全量，最少 60 日）的 20 日滚动均量序列，取当前 20 日均量在该序列中的分位 `q`；得分 = `clamp((0.5 - q) / 0.35)`，即分位 ≤15% 满分、≥50% 零分。
- 迹象三得分 = 筹码峰 0.6 + 低换手 0.4。日线不足 60 根时迹象三为"未出现，数据不足"。
- 备选"沿用分钟级 Volume Profile"被否：as-of 模式不可用，违反历史复盘完整性。

### D3: 三档状态与聚合档位
- 单迹象状态：score < 0.35 → 未出现；0.35–0.70 → 初现；≥ 0.70 → 明显（与现有信号红黄绿阈值习惯一致）。
- 聚合结论 tier（按 specs）：`still_falling`（0 明显且 <2 初现）/ `early_signs`（1 明显 或 ≥2 初现）/ `base_forming`（≥2 明显）/ `base_ready`（3 明显）。
- 洗盘干净度 = 加权分：迹象二权重 2（现有框架中假破位收回即 2x 权重）、迹象一/三各 1，`(s1 + 2*s2 + s3) / 4`，展示为百分比并标注"结构强度"。
- uptrend regime 复用 `phase.compute_trend_regime`，命中时 tier 覆写为 `trend_running`。

### D4: payload 结构——新增 `bottoming` 区块，`conclusion` 由其驱动
`make_report_payload` 增加 `bottoming` 顶层键（verdict + signs + cleanliness）；顶层 `conclusion`（phase/icon/action/trigger）改由 `BottomingVerdict` 映射生成，保持字段形状不变以减少前端/renderer 断裂面。`confirmation`、`signals`、`groups` 保留：左侧组降级为"明细参考"，右侧组即"出手确认层"。`next_trigger` 沿用 `phase._compute_trigger` 对右侧信号的择优逻辑。demo payload（`build_demo_signal_report`）同步补 `bottoming` 区块。

### D5: 展示结构
- **HTML（renderer.py）**：首屏 = 结论横幅（tier 图标 + 大白话结论 + 洗盘干净度进度条）+ 三迹象卡片行（状态灯 + 得分 + 证据 + 子维度小字）；其后为"出手时机确认"（右侧 5 信号现有卡片样式复用）→ K 线图 → 明细。沿用现有 HeroUI v3 token。
- **React（SignalTrendReport.tsx）**：新增 `BottomingVerdictPanel` 子组件渲染同样结构，插在页首；现有左右信号分组区块保留但左侧组折叠为次级明细。类型定义在 `web/src/` 的 report 类型中补 `bottoming` 字段（可选字段，兼容旧 payload 缓存）。

### D6: 测试策略
- 新增 `pipeline/tests/test_bottoming.py`：用构造 K 线覆盖三迹象各自的 明显/未出现/数据不足 场景、聚合档位边界（0/1/2/3 项明显）、as-of 截断一致性（同一数据截断前后 verdict 相同）、文案红线（无"胜率/概率/准确率"）。
- `test_analyzer.py` / `test_server.py` 补 `bottoming` 区块断言；`test_renderer.py` 补首屏区块断言；`test_frontend_copy.py` 补前端文案红线。
- 数据源仍走 `tests/conftest.py` stub，禁止真实网络。

## Risks / Trade-offs

- [低换手分位代理失真：长期缩量的票分位天然偏低] → 取分位窗口下限 60 日 + 描述中写明"相对自身历史"口径，不与他股横向比较
- [30 日筹码峰窗口对慢牛慢熊钝化] → 窗口作为模块常量集中定义，便于后续调参；ATR 容忍度吸收正常波动
- [payload 结构变化影响前端旧缓存] → `bottoming` 为前端可选字段，缺失时前端回退到现有结论区渲染
- [复用 `_calc_*` 私有函数产生耦合] → 在 `signals.py` 保持这些函数签名稳定即可，bottoming 只读其 SignalResult，不触其内部
- [三迹象同时"明显"较罕见，`base_ready` 触发少] → 属预期行为（宁缺勿滥），`early_signs` 档已给出观察引导

## Migration Plan

1. 先落 `bottoming.py` + 单测（纯新增，无破坏）
2. 再改 `report.py`/`narrative.py` 接入 payload 与结论映射，适配存量测试
3. 最后改 `renderer.py` 与 React 前端；`python -m pytest pipeline` + `web` 的 `typecheck`/`build` 全绿后交付
4. 回滚策略：`bottoming` 区块为纯计算叠加层，回滚只需恢复 `conclusion` 由 `determine_phase` 直接驱动

## Open Questions

（无——口径已由用户确认：筹码峰不下移 + 低换手代理；展示两端都要；走 OpenSpec）
