## 1. 核心信号与结论模型

- [x] 1.1 删除 5 个右侧信号计算函数、常量与 `compute_all_signals()` 装配，保留 6 个左侧证据信号
- [x] 1.2 删除左右绿灯阶段矩阵与混合总确认度，以 `BottomingVerdict`/洗盘干净度作为唯一主结论与主分数
- [x] 1.3 更新筑底档位、action 和模板叙事，移除等待右侧、出手点、建仓/加仓等右侧决策措辞

## 2. 历史报告与服务契约

- [x] 2.1 将 `right_trend` 替换为严格逐日截断的 `bottoming_history`，保留隔离的前瞻证伪标签
- [x] 2.2 升级 signal report schema/rules version，删除 confirmation/right/group/right-state 等旧字段并更新 demo
- [x] 2.3 删除 `entry_lab.py`、entry scan API、entry-lab 静态入口与 renderer

## 3. 金字塔纪律推演

- [x] 3.1 将 as-of 改为手动决策日、次日开盘标准首仓，删除自动信号扫描
- [x] 3.2 删除 `RIGHT_TRIGGER_IDS`、`strong_right_*`、减半首仓、紧止损和 right_green 元数据
- [x] 3.3 更新回测 payload、demo、静态/React 文案为手动决策日纪律推演，保留价格档位加减仓和支撑止损

## 4. 报告 UI 与类型

- [x] 4.1 精简 Python 静态 renderer：删除右侧分组、四态卡、双侧公式和右侧趋势图，渲染筑底历史证伪图
- [x] 4.2 更新 React types 与 SignalTrendReport：删除右侧字段/筛选/卡片，展示筑底主结论、左侧证据和 bottoming history
- [x] 4.3 更新应用导航、布局、回测页和样式中的产品文案，确保不再宣称右侧判断

## 5. 测试与文档

- [x] 5.1 重写 Python 信号、历史报告、renderer、server 和金字塔测试，删除 entry lab 测试
- [x] 5.2 更新 README、AGENTS、CLAUDE、项目 Wiki 与相关当前文档的产品边界和术语
- [x] 5.3 运行 Python 全量 pytest、Web typecheck/build，并全仓检查生产源码无右侧 signal ID/旧 payload 字段残留
