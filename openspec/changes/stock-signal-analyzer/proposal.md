## Why

用户需要一个"输入 ticker，输出诊断报告"的工具，帮助判断一只股票是否正在从底部走出、进入右侧上涨趋势。当前项目只有 PE 分位的历史视图，缺少对价量形态和技术信号的综合研判。

核心痛点：散户看到各种技术指标但不知道如何综合判断，需要一个把多信号汇总成一个清晰结论的工具——不是给一个看不懂的百分比，而是直接告诉用户"现在是什么阶段、该怎么做"。

## What Changes

- 新增信号分析引擎：10 个信号（左侧 6 + 右侧 4）各自计算确定度（0-100%），映射为三档信号灯（🔴🟡🟢）
- 新增阶段判断逻辑：基于信号计数判定当前处于 5 个阶段之一（下跌中/底部初现/底部成型/右侧确认/趋势确立）
- 新增 HTML 报告生成：输出自包含 HTML 文件，兼容 PC 和移动端，包含结论区 + 信号明细 + 综述
- 新增 CLI 入口：`python analyze.py AAPL` 生成报告文件

## Capabilities

### New Capabilities

- `signal-engine`: 信号判断引擎 — 10 个信号的确定度计算、信号灯映射、阶段判断、综合结论生成
- `report-renderer`: HTML 报告渲染 — 将信号分析结果渲染为响应式 HTML 页面（含信号灯、确定度条、文字分析、综述）

### Modified Capabilities

（无现有 spec 需修改）

## Impact

- **新增代码**：`pipeline/analyzer/` 模块（信号引擎 + HTML 渲染 + CLI 入口）
- **依赖**：使用 `pipeline/data/` 层获取所有数据（get_klines / get_indicators / get_volume_profile / get_quotes / get_money_flow）
- **输出物**：生成 `.html` 文件，用浏览器直接打开即可查看
- **无 breaking change**：纯新增功能，不影响现有 pipeline/api/web
