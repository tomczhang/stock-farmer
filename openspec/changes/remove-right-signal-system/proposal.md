## Why

右侧 5 信号及其二次聚合已经渗透阶段、叙事、历史趋势、入场实验室和金字塔回测，但用户不再需要这套判断。继续保留会增加认知负担、接口复杂度和维护成本，并使“筑底诊断”与“右侧触发”形成不必要的双重决策体系。

## What Changes

- **BREAKING** 删除 5 个右侧信号：站回均线、回踩不破、放量反包、MACD 金叉、低点抬升，以及右侧触发度、右侧绿灯数和四态展示。
- **BREAKING** 信号报告改为“筑底结构诊断”：删除左右阶段矩阵与混合总确认度；以筑底档位和洗盘干净度为唯一主结论/主分数，左侧 6 信号仅作为证据明细。
- **BREAKING** 删除右侧趋势序列与基于右侧信号的入场实验室；保留严格 as-of 的筑底历史序列和前瞻证伪标签。
- **BREAKING** 金字塔回测不再自动寻找买点：用户选择的 `as_of` 作为手动决策日，下一交易日开盘建立标准首仓。删除右侧门槛、`strong_right` 旁路、参数、紧止损及 payload 字段；后续价格档位加仓、停买红线、减仓、止损和次日开盘撮合保持不变。
- 更新 Python 静态报告、React 页面、API 类型、demo、测试、项目文档与现有 OpenSpec 规格中的相关语义。

## Capabilities

### New Capabilities

- `bottoming-only-analysis`: 定义删除右侧体系后统一的筑底/左侧诊断、历史序列、叙事和回测入场契约。

### Modified Capabilities

- `signal-engine`: 移除右侧信号、左右阶段矩阵与混合总确认度。
- `right-signal-backtest`: 移除右侧趋势能力，将历史复盘收敛为筑底结构序列与事后证伪。
- `bottoming-signs-detection`: 筑底判读成为唯一报告结论，不再与额外触发层组合。
- `bottoming-report-presentation`: 报告不再展示“等待右侧”或右侧出手条件。
- `pyramid-trade-simulation`: 改为 as-of 手动决策日入场，移除自动信号入场、`strong_right` 与右侧门槛。
- `pyramid-backtest-presentation`: payload/UI 移除右侧入场元数据和文案。
- `signal-report-rendering`: 删除右侧面板、筛选、确认度和相关解释文案。

## Impact

- Python：`pipeline/analyzer/signals.py`、`phase.py`、`bottoming.py`、`narrative.py`、`report.py`、`backtest.py`、`entry_lab.py`、`pyramid.py`、`renderer.py`、`server.py` 及测试。
- Web：信号报告、筑底面板、金字塔回测、API 类型与样式；历史 payload 发生 breaking change。
- CLI/API：`/api/signal-report`、`/api/pyramid-backtest` 的响应字段改变；`/api/entry-scan` 与 `/entry-lab` 删除，调用方需同步升级。
- 文档：README、AGENTS、Wiki 与相关 OpenSpec 工件需要更新，语义统一为“筑底结构强度”，仍不得表达为胜率或概率。
- 不影响 Cloudflare PE-TTM 产品与独立 Portfolio 应用。
