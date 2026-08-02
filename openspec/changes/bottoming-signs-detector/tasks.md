## 1. 筑底判读引擎（pipeline/analyzer/bottoming.py）

- [x] 1.1 创建 `bottoming.py`：定义 `BottomingSign` / `BottomingVerdict` dataclass、三档状态映射（<0.35 未出现 / 0.35–0.70 初现 / ≥0.70 明显）与模块常量（窗口、权重、容忍度）
- [x] 1.2 实现迹象一「缩量下跌」：包装 `signals._calc_vol_shrink` 的五维得分与明细，输出大白话证据描述
- [x] 1.3 实现迹象二「假破位收回」：组合 `_calc_false_breakdown`（0.65）+ `_calc_no_new_low`（0.35），处理无稳定支撑退化路径与真破位不误判
- [x] 1.4 实现迹象三「筹码稳定」：日线双 30 日窗口筹码峰对比（ATR 容忍度）+ 250 日量能分位低换手代理，0.6/0.4 加权；不足 60 根日线时"数据不足"
- [x] 1.5 实现 `compute_bottoming` 聚合：tier 判档（still_falling/early_signs/base_forming/base_ready）、洗盘干净度 `(s1+2*s2+s3)/4`、uptrend 覆写为 trend_running、下一步触发提示
- [x] 1.6 新增 `pipeline/tests/test_bottoming.py`：三迹象各自的明显/未出现/数据不足场景、真破位不误判、筹码峰下移归零、聚合档位边界（0/1/2/3 项明显）、文案红线（无胜率/概率/准确率字样）

## 2. 报告 payload 接入（report.py / narrative.py / server.py）

- [x] 2.1 `report.py`：`build_signal_report` 调用 `compute_bottoming`，payload 新增顶层 `bottoming` 区块（verdict + signs 固定顺序 + cleanliness），`conclusion` 改由 verdict 映射生成（字段形状不变）
- [x] 2.2 `narrative.py`：结论文案改为筑底判读口径（大白话"想跌却跌不动/洗盘洗干净"叙述），保留语义红线
- [x] 2.3 `build_demo_signal_report` 补全 `bottoming` 演示数据（确定性）
- [x] 2.4 验证 as-of 模式：`bottoming` 全链路仅用截断后日线，`test_backtest.py`/`test_bottoming.py` 补 as-of 截断一致性与前瞻标签隔离断言
- [x] 2.5 适配存量测试：`test_analyzer.py`、`test_server.py` 补 `bottoming` 区块断言并修复受 payload 变化影响的用例

## 3. 静态 HTML 报告（renderer.py）

- [x] 3.1 `renderer.py` 首屏新增筑底判读区块：结论横幅（tier 图标 + 结论 + 洗盘干净度进度条，标注结构强度）+ 三迹象卡片（状态灯/得分/证据/子维度小字），沿用 HeroUI v3 token
- [x] 3.2 右侧 5 信号重组为「出手时机确认」区块，排在筑底判读之后；左侧信号明细降级到折叠/次级区域
- [x] 3.3 `test_renderer.py` 补断言：首屏含筑底区块与三迹象卡片、文案红线；跑通 `cd pipeline && python analyze.py <ticker>` 生成报告人工核对

## 4. React 前端（web/）

- [x] 4.1 report 类型定义补可选 `bottoming` 字段；缺失时回退现有结论区渲染
- [x] 4.2 新增 `BottomingVerdictPanel` 组件（聚合结论 + 三迹象卡片 + 出手确认层入口），插入 `SignalTrendReport` 页首；左侧信号组折叠为次级明细
- [x] 4.3 样式沿用 `global.css` 现有卡片/状态灯模式，三档状态视觉区分
- [x] 4.4 联调：`python -m pipeline.server` + `npm run dev`，用 DEMO(?demo=1) 与真实 ticker 验证渲染
- [x] 4.5 `test_frontend_copy.py` 补前端筑底文案红线断言

## 5. 验收

- [x] 5.1 `python -m pytest pipeline` 全量通过
- [x] 5.2 `web`：`npm run typecheck` + `npm run build` 通过
- [x] 5.3 对照 specs 逐场景自查（openspec verify），关键决策同步进变更说明
