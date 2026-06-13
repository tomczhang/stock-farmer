## 1. 模块结构

- [x] 1.1 创建 `pipeline/analyzer/` 目录：`__init__.py`, `signals.py`, `phase.py`, `narrative.py`, `renderer.py`
- [x] 1.2 创建 CLI 入口 `pipeline/analyze.py`

## 2. 信号计算引擎

- [x] 2.1 实现 `signals.py` — `SignalResult` dataclass 定义 + 11 个信号的确定度计算函数
- [x] 2.2 实现 S1 缩量下跌：`clamp((1 - vol5/vol20) * 2.0, 0, 1)`
- [x] 2.3 实现 S2 跌不动：比较近5日最低价 vs 前一个波段低点
- [x] 2.4 实现 S3 假破位收回：检测破前低后3日内收回
- [x] 2.5 实现 S4 波动收敛：ATR 下降比例
- [x] 2.6 实现 S5 筹码集中：Volume Profile 前3桶占比
- [x] 2.7 实现 S6 大盘环境：指数相对 MA20 位置 + MA 方向
- [x] 2.8 实现 S7 站回均线：`(close - MA20) / ATR`
- [x] 2.9 实现 S8 放量反包：最近阳线成交量 / 20日均量
- [x] 2.10 实现 S9 回踩不破：假破位收回后回踩支撑区间且不跌破
- [x] 2.11 实现 S10 MACD金叉：DIF-DEA 差值归一化
- [x] 2.12 实现 S11 低点抬升：近期两个低点差 / ATR
- [x] 2.13 实现信号灯映射：confidence → light (red/yellow/green) 基于各信号独立阈值

## 3. 阶段判断与结论

- [x] 3.1 实现 `phase.py` — 阶段判断规则（5 个阶段 + 操作建议 + 触发条件生成）
- [x] 3.2 实现综合强度计算：加权平均 + 区间映射

## 4. 综述生成

- [x] 4.1 实现 `narrative.py` — 模板拼接生成 2-4 句分析综述

## 5. HTML 渲染

- [x] 5.1 实现 `renderer.py` — HTML 模板（暗色主题、Tailwind CDN、响应式）
- [x] 5.2 实现结论卡片区域：阶段图标 + 操作建议 + 综合强度条
- [x] 5.3 实现信号卡片：灯 + 名称 + 确定度 + range bar + 描述
- [x] 5.4 实现综述区域 + footer 免责声明

## 6. CLI 集成

- [x] 6.1 实现 `analyze.py`：参数解析 → 数据获取 → 信号计算 → 渲染 → 保存文件
- [x] 6.2 创建 `output/` 目录，输出格式 `output/<TICKER>_<YYYYMMDD>.html`

## 7. 测试

- [x] 7.1 为 signals.py 各信号公式编写单元测试（mock 数据）
- [x] 7.2 为 phase.py 阶段判断规则编写测试
- [x] 7.3 为 renderer.py 验证输出 HTML 结构正确性
