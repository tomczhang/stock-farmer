## Context

当前分析链固定计算 6 个左侧信号和 5 个右侧信号，再把右侧结果传播到阶段矩阵、结构强度、模板叙事、历史 `right_trend`、入场实验室、金字塔回测和两套报告 UI。用户决定不再使用整个右侧判断体系，因此不能只隐藏前端卡片；必须从计算、契约、决策和测试中完整删除，避免“界面看不到但仍影响结论”的隐性行为。

本变更不影响 PE-TTM Cloudflare 产品和独立 Portfolio 应用。历史模式仍必须以 as-of 截断，前瞻标签仍只能用于事后证伪。

## Goals / Non-Goals

**Goals:**

- 彻底移除 5 个右侧信号的计算函数、常量、聚合、文案、payload、UI 和测试。
- 让筑底三迹象成为唯一结构结论和主分数，左侧 6 信号只作为证据明细。
- 让金字塔回测改为用户手动选择决策日，仍遵守次日开盘成交和防未来函数规则。
- 删除 `strong_right`、右侧入场实验室及相关服务端入口。
- 用新的结构历史序列继续提供 as-of 证伪，但不保留任何“右侧”命名或字段。

**Non-Goals:**

- 不修改筑底三迹象的数学公式和阈值。
- 不修改金字塔建仓后的价格档位加仓、停买红线、倒金字塔减仓和支撑止损。
- 不修改 PE 产品、Portfolio 应用或行情数据源。
- 不为旧版 signal report payload 提供长期双写兼容层。

## Decisions

### 1. 物理删除而不是 feature flag

删除右侧函数、`RIGHT_TRIGGER_IDS`、`strong_right_*` 参数和右侧 UI，而不是增加默认关闭开关。用户已确认能力不再需要；feature flag 会继续维护死代码，也可能让右侧结果在服务端悄悄参与结论。

### 2. 筑底判读成为规范结论

`compute_bottoming()` 的 `tier/tier_label/action/cleanliness_pct/signs` 成为报告首要结论。`trend_running` 仍保留，用于明确上升趋势中途不适用筑底框架。原 `determine_phase()` 的左右绿灯矩阵、右侧阶段和“下一右侧触发”删除；`compute_trend_regime()` 可继续作为筑底适用性辅助。

删除原混合 `confirmation.score`，不再为 6 个左侧信号创建第二套竞争性总分；顶层主分数直接使用筑底判读已有的洗盘干净度，并明确标注为筑底结构强度。左侧信号只作证据明细。任何得分都不得称为概率、胜率或准确率。

### 3. Breaking payload 直接收敛

报告规则版本升级。删除：

- 整个 `confirmation` 混合总分和 `left/right` 层级；
- `right_trend`、每点的 `right_score_pct/right_confirmed/right_states`；
- 右侧类别 signals；
- `phase.next_trigger` 中基于右侧信号的内容。

新增/保留 `bottoming_history`：每点只含日期、价格、归一化价格、筑底档位、洗盘干净度、三迹象状态和可用的前瞻标签。`trend_window` 查询参数暂时保留，避免无意义地同时改变请求接口。

### 4. 删除入场实验室

`entry_lab.py`、`/api/entry-scan/:ticker`、`/entry-lab` 和独立 HTML 删除。该能力的核心价值是组合右侧信号筛选；降级成单一筑底筛选会和历史 `structure_trend` 重复，保留会制造第二套入口。

### 5. 金字塔改为手动决策日入场

删除 `check_entry()` 的自动扫描职责。用户传入的 `as_of` 就是手动选择的决策日；系统只用该日及以前数据锚定支撑和目标，并在下一交易日开盘建立标准首仓。删除 `strong_right` 第二路径、减半首仓、紧止损和所有右侧元数据。后续价格档位加仓、停买红线、减仓和支撑止损保持现状。

不采用“筑底成立自动入场”：筑底是结构诊断，不等于买点。直接替换会在用户未授权时把系统变成左侧自动买入器。

### 6. 当前/历史/静态/React 四个出口同步迁移

Python JSON 报告、Python 静态 HTML、React 信号页面和 demo payload 必须在同一变更中同步。旧字段不做空值占位，测试应断言响应中不存在右侧字段和文案，防止残留。

## Risks / Trade-offs

- [Risk] 手动决策日回测与旧版自动寻找入场的样本语义不同。 → UI 和 payload 明确标注“手动选择决策日的纪律推演”，规则版本升级，不与旧结果直接比较。
- [Risk] 外部调用方依赖 `right_trend`、右侧 signal ID 或 `strong_right_*`。 → 采用 breaking 版本迁移，更新仓库内所有调用方和类型；不静默返回伪空结构。
- [Risk] `phase.py` 中仍有通用趋势 regime，被误认为右侧残留。 → 仅保留与筑底适用性有关的 MA50/MA200 regime，并删除左右绿灯阶段矩阵。
- [Risk] 大量静态 renderer 字符串和 demo 容易残留右侧文案。 → 使用全仓 `rg` 加测试黑名单检查生产源码和当前文档，历史生成物不作为运行时源码修改。
- [Risk] 活跃 OpenSpec change 之间存在重叠。 → 本 change 作为后续 breaking delta 记录删除语义；归档时先同步/整理旧 change，再同步本 change。

## Migration Plan

1. 提交本 OpenSpec proposal/spec/design/tasks。
2. 先修改 Python 核心模型与测试，再迁移 JSON/demo/server。
3. 删除入场实验室和 route。
4. 更新 React/静态 renderer/types 和文档。
5. 运行 Python 全量测试、主 Web typecheck/build，并用 `rg` 检查运行时右侧字段残留。
6. 部署 Python + Web 同源镜像；旧前端和旧 API 必须同时替换。

回滚方式：整体回滚该变更提交并恢复同版本 Python/Web 镜像，不支持新旧 payload 混跑。

## Open Questions

无。用户已明确选择删除整个右侧信号体系；本设计采用筑底-only 结论与手动决策日纪律推演。
