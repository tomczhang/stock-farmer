# 金字塔交易回测（pyramid-trade-backtest）

## Why

筑底/右侧判读已能回答"任意时刻这只票是否符合右侧逻辑"（as-of 模式），但用户无法验证**按纪律执行这套打法的实际结果**：右侧成立建仓 20%、金字塔加仓（越涨越买越少）、停止买入红线（不追高）、倒金字塔减仓（先回本金、底仓做成低/负成本）。需要一条交易模拟回测链路，选任意标的 + 任意历史时点，逐日推演完整的买卖账本，用于研究复盘与纪律校验。

## What Changes

- 新增 `pipeline/analyzer/pyramid.py`：金字塔交易推演引擎
  - **入场**：as-of 日（或其后首个满足日）筑底判读 ≥「筑底基本成立」且任一右侧触发信号（放量站上 MA20 / 放量反包 / 回踩不破）翻绿 → 建仓 20% 资金
  - **目标价**：入场日自动识别技术压力位（前高 / 密集成交区上沿，复用支撑区间引擎反向逻辑）；无可用压力位时回退为入场价 +20%
  - **金字塔加仓**：入场价每上涨一档（默认 +5%）加一档，每档资金按递减比例（默认 100:50:30 归一化），总买入不超过预算
  - **纪律红线（停止买入）**：价格走完「入场价→目标价」空间的 80%（可配置）后，未买的档位永久作废，绝不追高；红线触发要在账本中显式记录
  - **倒金字塔减仓**：浮盈达到预期收益（默认目标空间的 60% 或 +20%，取先到）后，价格每再涨一档分批卖出，数量递增（默认 30:50:80 归一化），优先收回本金
  - **止损退出**：收盘有效跌破入场时支撑区间下沿 → 全部清仓，标记"右侧失效"
  - **账本输出**：逐笔交易（日期/价格/股数/动作/原因）、持仓成本线序列、已收回本金、剩余底仓成本（可为负）、窗口末市值与收益
- 严防未来函数：入场判定复用 as-of 截断的判读链；推演期内每根日线只用当日及之前数据决策（信号重算按截断日）；成交价用次日开盘价（决策收盘后、次日执行）
- 新增 CLI：`python backtest_trade.py <ticker> --as-of YYYY-MM-DD [--window N]` 生成静态 HTML 回测报告
- `pipeline/server.py` 新增 `/api/pyramid-backtest/<ticker>?as_of=...` 只读接口 + demo 模式
- `web/` 新增回测交互页：选标的 + 日期直接跑，K 线标注买卖点、成本线/仓位曲线、账本明细表

## Capabilities

### New Capabilities
- `pyramid-trade-simulation`: 入场判定、目标价锚定、金字塔加仓、停止买入红线、倒金字塔减仓、止损退出与账本计算的完整规则，含防未来函数与执行价约定
- `pyramid-backtest-presentation`: 回测结果在 JSON payload、静态 HTML 报告与 React 前端的展示结构与文案红线（历史模拟仅供研究复盘，不构成收益承诺，不用胜率/概率措辞包装信号）

### Modified Capabilities
（无——不改动现有三个 spec；筑底判读与信号计算仅被复用，不改其需求）

## Impact

- `pipeline/analyzer/`：新增 `pyramid.py`；`backtest.py` 复用（cutoff_daily/resolve_effective_date）不改语义
- `pipeline/`：新增 `backtest_trade.py` CLI；`server.py` 加路由
- `pipeline/analyzer/renderer.py` 或新增 `pyramid_renderer.py`：回测 HTML 报告
- `web/src/`：新增回测页组件与路由入口、api.ts 加接口、types.ts 加类型
- `pipeline/tests/`：新增 `test_pyramid.py`；`test_server.py` 补路由用例
- 不改 D1 schema、Workers API、PE 分位产品线；数据约束：日线最多约 5 年（1260 根），更早时点不可回测
