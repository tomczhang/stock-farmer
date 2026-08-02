## 1. 推演引擎（pipeline/analyzer/pyramid.py）

- [x] 1.1 `PyramidParams` dataclass：预算/入场比例/加仓步长与比例/红线阈值/减仓触发与比例/止损缓冲/费率/港股整手/窗口，全部默认值集中定义
- [x] 1.2 目标价识别 `_resistance_target`：250 日 swing high + 日线 Volume Profile 高量桶聚类取上方最近强中枢，无候选回退 entry×1.2，标注 target_source
- [x] 1.3 入场判定：逐日截断重算 signals+bottoming，tier ≥ base_forming 且任一右侧触发绿灯；支撑锚（active_support 下沿 → prev_low → entry×0.92 三级回退）
- [x] 1.4 逐日推演循环：决策收盘/次日开盘成交、金字塔加仓（同档只买一次、单日一档、港股整手）、停止买入红线（永久作废未执行档）、倒金字塔减仓（触发线取先到、批量递增）、止损优先级最高、末日订单标 pending
- [x] 1.5 账本与 payload 组装：trades/events/ledger_series/summary/entry/params/verdict_context，金额含双边手续费，JSON 可序列化
- [x] 1.6 `pipeline/tests/test_pyramid.py`：入场/未入场、次日开盘成交、整手取整、三档递减、跳空只买一档、红线永久性与不拦卖出、减仓递增、负成本底仓、止损优先、截断一致性、payload 契约、文案红线

## 2. 本地 API（server.py）

- [x] 2.1 `/api/pyramid-backtest/<ticker>` 路由：as_of 必填校验（400）、window/budget 可选、demo=1 / DEMO 走演示数据
- [x] 2.2 `build_demo_pyramid_backtest()`：确定性完整剧本（入场→3 档加仓→红线→3 批减仓→负成本底仓）
- [x] 2.3 `test_server.py` 补路由用例（正常/缺 as_of/demo）

## 3. 静态 HTML 报告 + CLI

- [x] 3.1 `pipeline/analyzer/pyramid_renderer.py`：结论横幅（入场结果/收益/底仓净成本）、K 线买卖点标注 + 目标价/支撑/红线 priceLine、成本线与仓位曲线、账本明细表、纪律事件时间线、假设与免责同屏；复用 HeroUI token
- [x] 3.2 CLI `pipeline/backtest_trade.py <ticker> --as-of ... [--window] [--budget] [--output-dir]`
- [x] 3.3 渲染断言测试（结论横幅/账本表/免责与假设同屏/无胜率措辞）

## 4. React 交互页（web/）

- [x] 4.1 `types.ts` 加 PyramidBacktest 类型；`api.ts` 加 `fetchPyramidBacktest(ticker, asOf, opts)`
- [x] 4.2 `PyramidBacktestPanel.tsx`：表单（ticker+日期+窗口）、结论卡、ECharts 买卖点图（目标价/支撑/红线 markLine）、账本明细表、加载/错误/未入场态
- [x] 4.3 `App.tsx` 页签接入（信号报告 / 金字塔回测切换），样式沿用 global.css 模式
- [x] 4.4 联调：server + dev，DEMO 与真实 ticker 各跑一次
- [x] 4.5 `test_frontend_copy.py` 补回测页文案红线断言

## 5. 验收

- [x] 5.1 `python -m pytest pipeline` 全量通过
- [x] 5.2 `web`：`npm run typecheck` + `npm run build` 通过
- [x] 5.3 对照 specs 逐场景自查，勾选 tasks 并汇总关键决策

## 6. 增量：强右侧通道（用户反馈迭代）

- [x] 6.1 强右侧通道第二入场路径：右侧≥3绿灯+假破位收回初现→减半仓入场（spec 增补 + check_entry 双路径 + 单测）
- [x] 6.2 目标价最小空间约束 target_min_space_pct（修复深V近端压力导致梯度/红线无空间）
- [x] 6.3 港股整手减仓修复（批量取整为0但持仓够一手时按一手卖）
- [x] 6.4 强右侧紧止损：支撑距入场>8%时止损上收至入场价-7%（spec 场景 + 引擎 + 3 用例 + 14 单重跑验证）
