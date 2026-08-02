## Context

as-of 判读链（`backtest.cutoff_daily` / `build_signal_report(as_of=...)`）与筑底判读（`bottoming.compute_bottoming`）已能防未来函数地回答"某日是否符合右侧"。本变更在其上加一层**逐日交易推演**：入场 → 金字塔加仓 → 停止买入红线 → 倒金字塔减仓 → 止损，输出完整账本。约束：仅日线 OHLCV；逐日重算 11 信号 + 筑底判读的成本是每决策日一次全量计算（120 日窗口 ≈ 120 次），纯 numpy/pandas 在百毫秒级，可接受。

## Goals / Non-Goals

**Goals:**
- `pipeline/analyzer/pyramid.py`：纯函数推演引擎，`run_pyramid_backtest(df, as_of, params) -> dict`（df 为全量日线，内部自行截断）
- 参数全部集中在 `PyramidParams` dataclass，带用户确认的默认值
- CLI（静态 HTML）+ server 路由 + React 交互页
- 逐笔账本与纪律事件可核对：每笔交易带原因与触发档位

**Non-Goals:**
- 不做批量多标的扫描/组合回测（单标的单时点，后续变更再扩展）
- 不做分钟级撮合、滑点模型（固定手续费率近似）
- 不做胜率/期望收益统计学结论（单次推演是复盘工具）
- 不改现有信号/筑底口径

## Decisions

### D1: 引擎接口与逐日决策循环
`run_pyramid_backtest(df, as_of, params, index_df=None)`：
1. `resolve_effective_date` 对齐 as-of 到有效交易日，回测窗口 = 其后 `params.window`（默认 120）个交易日；
2. 逐日循环：`day_df = cutoff_daily(df, date)`，未入场时算 `compute_all_signals(day_df)` + `compute_bottoming(day_df, signals)` 判入场；已入场后仅做价格驱动的档位/红线/止损判定（不再重算信号，避免右侧信号闪烁导致反复进出——入场只判一次，退出只看支撑价，规则可解释）；
3. 决策收盘生成订单，次日开盘撮合；最后一日形成的订单标记 `pending`。
- 备选"持仓期间每日重算筑底判读并据此动态退出"被否：判读为结构描述而非交易信号，逐日翻转会引入不可解释的进出；退出锚定支撑价更符合用户"右侧失效"语义。

### D2: 参数集（PyramidParams 默认值，全部可配置）
- `budget=100_000`，`entry_fraction=0.20`；`add_step_pct=0.05`，`add_ratios=(1.0, 0.5, 0.3)`（首元素即底仓相对基准，后续档按 50/30 相对底仓资金）；
- `stop_buy_progress=0.80`（目标空间走完 80% 红线）；
- `trim_trigger`：`min(目标空间 60%, 成本 +20%)` 先到；`trim_step_pct=0.05`，`trim_ratios=(0.3, 0.5, 0.8)`（占当前持仓比例逐档递增，最后一档后剩余即底仓）；
- `stop_loss_buffer = max(0.5*ATR20, support_low*0.005)`；`fee_rate=0.001` 双边；`hk_lot=100`；`window=120`。
- 加仓资金基准：底仓金额为基准 1.0，第 2 档 = 底仓金额 × 0.5，第 3 档 = × 0.3；三档之后不再加仓（与用户 100/50/30 示例一致）。

### D3: 目标价（压力位）识别
新增 `_resistance_target(day_df, entry_price)`：镜像支撑引擎思路但独立轻量实现——取近 250 日 swing high（3 日窗口局部高点）+ 日线 Volume Profile 高量桶上沿，聚类（容忍度 ATR 基准）后取入场价上方 3%~40% 区间内**最近的强聚类中枢**；无候选 → fallback `entry×1.2`。放入 `pyramid.py` 内部，不改 `signals.py`。

### D4: 支撑锚（止损线）
入场信号日的 `false_breakdown.data.active_support`（稳定性达标支撑）下沿为止损锚；无 active_support 时回退 `no_new_low` 的 prev_low；再无则入场价 × 0.92。锚定后整个推演期固定不变（不移动止损——首版保持规则最简，可解释）。

### D5: payload / 展示
- payload 按 presentation spec 的顶层键组织；`ledger_series` 逐日一行便于前端画成本线；金额四舍五入 2 位。
- HTML：新增 `pyramid_renderer.py`（独立文件，不塞进已 2000 行的 renderer.py），复用 `_DESIGN_TOKENS_CSS`（从 renderer import）+ lightweight-charts 标注买卖点（markers）+ 目标价/支撑/红线 priceLine。
- CLI：`pipeline/backtest_trade.py <ticker> --as-of ... [--window N] [--budget N] [--output-dir D]`。
- server：`/api/pyramid-backtest/<ticker>`，参数 as_of（必填，缺省报 400）、window、budget、demo；复用现有 handler 结构。
- React：`App.tsx` 增加页签或路由切换（现有单页结构，用简单 tab state），新组件 `PyramidBacktestPanel.tsx`（表单 + 结论卡 + ECharts 买卖点图 + 账本表）；`api.ts` 加 `fetchPyramidBacktest`。
- demo payload：`build_demo_pyramid_backtest()` 确定性构造（入场→3 档加仓→红线→3 批减仓→负成本底仓的完整剧本），供前端开发与 server demo。

### D6: 测试策略
`pipeline/tests/test_pyramid.py` 用手工构造 K 线（可控开盘价）覆盖：入场/未入场、次日开盘成交、港股整手、三档加仓递减、跳空只买一档、红线永久性（回落不补买）、红线不拦卖出、减仓递增与负成本、止损优先于加仓、截断一致性（追加未来行不变）、payload 契约与 JSON 序列化、文案红线。server 路由用例进 `test_server.py`。入场判定 monkeypatch `compute_bottoming`/`compute_all_signals` 构造确定性触发，避免测试对信号阈值敏感。

## Risks / Trade-offs

- [逐日重算信号较慢（未入场阶段）] → 入场一旦确定即停止重算；120 日窗口全程未入场最坏 ~120 次计算，秒级，可接受
- [压力位识别质量决定红线体验] → 标注 target_source 与依据，HTML/前端显式画出目标价线供人工校验；fallback 兜底
- [固定止损锚在长推演中可能过松/过紧] → 首版明确"不移动止损"为规则的一部分写进报告假设区，后续变更再迭代移动止损
- [次日开盘成交遇跳空，成交价偏离档位价] → 如实按开盘价记账（这正是真实执行成本），账本同时记录触发档位价便于对比
- [收益数字被误读为策略有效性证明] → 免责+假设与收益同屏（presentation spec 红线），单次推演不输出胜率类统计

## Migration Plan

1. `pyramid.py` + `test_pyramid.py`（纯新增）
2. `server.py` 路由 + demo + `test_server.py` 用例
3. `pyramid_renderer.py` + CLI `backtest_trade.py`
4. `web/`：types/api/组件/页签 + `test_frontend_copy.py` 断言
5. 验收：`python -m pytest pipeline` + web `typecheck`/`build`；回滚 = 移除新增文件与路由，零侵入

## Open Questions

（无——入场口径、目标价锚、止损规则、输出形态已由用户确认；梯度/资金/费率参数取默认值并全部可配置）
