# 筑底迹象判读器（bottoming-signs-detector）

## Why

现有右侧信号分析器把 11 个信号平铺展示（左侧 6 + 右侧 5），普通投资者看完一堆红黄绿灯，仍然回答不了最关心的问题：**"这只票筑底了没有？现在能不能等右侧出手？"** 且现有左右两侧信号的口径被用户判断为不够准（如"筹码集中"只看成交密集区占比，反映不了"筹码稳定"）。

需要以经典的筑底三迹象——**缩量下跌、假破位能收回、筹码稳定**（大白话："想跌却跌不动、洗盘洗干净了"）——为核心重新构建判读逻辑，让报告第一眼就给出"筑底迹象"结论和逐项证据。

## What Changes

- 新增 `pipeline/analyzer/bottoming.py`：筑底三迹象判读引擎
  - 迹象一「缩量下跌」：复用并收敛现有 5 维缩量评估（单日/阶段/明显/趋势缩量 + 量价背离）
  - 迹象二「假破位收回」：复用现有支撑区间识别 + 破位收回检测，并叠加"跌不动"（不创新低/破位收回）证据
  - 迹象三「筹码稳定」：**新口径** = 筹码峰不下移（基于日线滚动 Volume Profile，比较近期与前期筹码峰价位是否下移）+ 低换手（20 日均量处于 250 日量能分位的低位区，作为换手率代理，港美股无流通股本数据）
  - 输出：每个迹象独立的 0–1 得分、状态灯（未出现/初现/明显）、大白话证据描述；三迹象聚合成**筑底判读结论**（如：仍在下跌 → 迹象初现 → 筑底基本成立 → 等待右侧出手点）+ **洗盘干净度**（结构强度语义，不是胜率/概率）
- **BREAKING** 报告结构重构：`report.py` 的 payload 以「筑底判读」为第一结论区，替代现有以 11 信号左右分组为主的结构；右侧触发信号（站回均线/放量反包/回踩不破）保留为"出手时机确认"辅助层，不再与筑底证据混排
- `analyzer/renderer.py` 静态 HTML 报告：新增筑底迹象判读区块（三迹象卡片 + 结论），置于报告首屏
- `web/` React 前端 `SignalTrendReport`：同步重构为筑底判读优先的展示结构；`pipeline/server.py` 接口透传新 payload
- as-of 历史复盘模式兼容：筹码峰计算改用日线 Volume Profile，使历史模式下迹象三可计算（现有分钟级 profile 在历史模式不可用）；前瞻标签仍仅用于证伪展示

## Capabilities

### New Capabilities
- `bottoming-signs-detection`: 筑底三迹象（缩量下跌 / 假破位收回 / 筹码稳定）的计算口径、聚合判读结论与洗盘干净度语义，含 as-of 截断要求
- `bottoming-report-presentation`: 筑底判读在报告 payload、静态 HTML 报告与 React 前端的展示结构与文案红线（不得使用胜率/概率/准确率措辞）

### Modified Capabilities
（无——现有 `openspec/specs/` 只有 data-source-routing / proxy-pool / stock-data-api，本变更不改这三者的需求）

## Impact

- `pipeline/analyzer/`：新增 `bottoming.py`；`report.py`（payload 重构）、`renderer.py`（HTML 区块）、`narrative.py`（结论文案）、`phase.py`（阶段判定改由筑底判读驱动或保留兼容）
- `pipeline/server.py`：透传新 payload 字段（接口路径不变）
- `web/src/components/SignalTrendReport.tsx` 及相关样式：展示结构重构
- `pipeline/tests/`：新增 `test_bottoming.py`；`test_analyzer.py`、`test_renderer.py`、`test_server.py`、`test_frontend_copy.py` 需适配
- 不改 D1 schema、Workers API（`api/`）与 PE 分位产品线
