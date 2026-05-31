## Context

stock-farmer 已有统一数据层 `pipeline/data/`（东财/Yahoo/新浪/雪球多源 + 代理池 + 技术指标），现在需要在其之上构建一个信号分析引擎和 HTML 报告渲染器。

用户的使用场景：运行 `python analyze.py AAPL`，几秒后打开生成的 HTML 文件，看到：
1. 顶部一句话结论 + 操作建议
2. 10 个信号各自的红黄绿灯 + 确定度数字 + 进度条 + 文字解释
3. 底部一段综述，把逻辑串起来

## Goals / Non-Goals

### Goals
- 10 个信号各自有独立的确定度计算公式，物理可解释
- 每个信号的确定度映射为三档：🔴（未触发）🟡（有迹象）🟢（确认）
- 阶段判断基于信号计数规则，不是黑盒模型
- HTML 页面自包含（单文件、CDN 依赖、无构建工具）
- 响应式布局：PC 宽屏 + 手机竖屏都好看
- 综述段落由模板拼接生成，不依赖 LLM

### Non-Goals
- 不做实时监控/推送/自动刷新
- 不做回测验证（后续可加）
- 不接入 web 前端（独立 HTML 文件）
- 不做多股对比（每次只分析一只）
- 综述不调 AI API，纯规则模板拼接

## Decisions

### 决策 1：模块结构

```
pipeline/analyzer/
├── __init__.py         # CLI 入口 analyze(ticker) → html_path
├── signals.py          # 10 个信号的计算逻辑
├── phase.py            # 阶段判断 + 综合结论
├── narrative.py        # 综述文本生成（模板拼接）
└── renderer.py         # HTML 渲染（Jinja2 模板 or f-string）
```

### 决策 2：信号定义结构

每个信号是一个 dataclass：

```python
@dataclass
class SignalResult:
    id: str                # "vol_shrink"
    name: str              # "缩量下跌"
    category: str          # "left" | "right"
    confidence: float      # 0.0 ~ 1.0 (确定度)
    light: str             # "red" | "yellow" | "green"
    thresholds: tuple      # (red_max, yellow_max) e.g. (0.4, 0.7)
    weight: int            # 满分权重 (1 or 2)
    description: str       # "5日均量 = 20日均量的 55%，抛压明显减轻"
    data: dict             # 原始数据快照，用于综述生成
```

### 决策 3：10 个信号的确定度公式

| ID | 信号 | 公式 | 物理含义 |
|----|------|------|---------|
| S1 | 缩量下跌 | `clamp(1 - vol5/vol20, 0, 1) × 放大系数` | 缩到 50% 以下 → 满分 |
| S2 | 跌不动 | `clamp(1 - max(0, 破前低幅度)/ATR, 0, 1)` | 没破前低=1, 破了按ATR占比扣分 |
| S3 | 假破位收回 | 破位深度浅(50%) + 收回速度快(50%) | 两因子加权 |
| S4 | 波动收敛 | `clamp(ATR下降比例 / 0.5, 0, 1)` | ATR 降 50%+ = 满分 |
| S5 | 筹码集中 | VP 前3桶占比 / 0.6 | 前3桶占 60%+ = 满分 |
| S6 | 大盘环境 | 指数在 MA20 上方比例 + MA 方向 | 综合指数强弱 |
| S7 | 站回均线 | `clamp((close - MA20) / ATR, 0, 1)` | 站上 1 个 ATR = 满分 |
| S8 | 放量反包 | `clamp(阳线量/vol20 - 1, 0, 1)` | 量是均量 2 倍 = 满分 |
| S9 | MACD金叉 | DIF-DEA 差值归一化 | 金叉后叉开越多越确定 |
| S10 | 低点抬升 | `clamp(抬升幅度/ATR, 0, 1)` | 抬升 1 个 ATR = 满分 |

### 决策 4：信号灯阈值（每个信号独立）

默认阈值：`🔴 [0, 0.35)  🟡 [0.35, 0.70)  🟢 [0.70, 1.0]`

部分信号微调：
- 假破位收回（S3）：本身少见，降低绿区门槛 `🟢 ≥ 0.60`
- 放量反包（S8）：需要显著放量，提高绿区门槛 `🟢 ≥ 0.75`

### 决策 5：阶段判断规则

```python
left_green = count(left_signals where light == "green")
right_green = count(right_signals where light == "green")

if left_green <= 1:                        → "仍在下跌"      🔴
elif left_green <= 3 and right_green == 0: → "底部特征初现"   🟡
elif left_green >= 4 and right_green <= 1: → "底部基本成型"   🟡⭐
elif left_green >= 3 and right_green >= 2: → "右侧初步确认"   🟢
elif left_green >= 4 and right_green >= 3: → "趋势已确立"     🟢🟢
```

### 决策 6：综合强度计算

```
综合强度 = Σ(signal.confidence × signal.weight) / Σ(signal.weight)
```

旁边标注区间条，让用户校准直觉：
```
[🔴 0-25% │ 🟡 25-45% │ 🟡⭐ 45-60% │ 🟢 60-80% │ 🟢🟢 80%+]
```

### 决策 7：HTML 渲染方案

- 不用 Jinja2（避免额外依赖），用 Python f-string + 多行模板
- Tailwind CSS via CDN（`@tailwindcss/browser@4`）
- 响应式：mobile-first，PC 用 `md:` 断点
- 信号灯进度条：纯 CSS（`background: linear-gradient`）
- 图表：不需要（纯文字 + 进度条够了）

### 决策 8：综述文本生成

不调 LLM，用模板拼接：

```python
narrative = f"""{ticker} {name}近期{phase_description}。
左侧信号方面，{left_summary}。
右侧信号方面，{right_summary}。
{conclusion_sentence}"""
```

每段话根据信号状态从预定义的句子片段中选取拼接。

## Risks / Trade-offs

- **[信号公式准确性]** → 初版先跑通，后续可通过回测微调阈值和公式参数
- **[数据获取延迟]** → 分析需要拉 K 线 + 指标 + VP，总耗时约 3-10 秒，可接受（非实时场景）
- **[综述质量]** → 模板拼接的综述不如 LLM 自然，但可解释、无成本、无延迟
- **[单文件 HTML 大小]** → Tailwind CDN + 内容，估计 < 50KB，可接受

## Open Questions

- 是否需要保存历史报告？（每次生成覆盖 or 按日期保存）
- 是否需要支持批量分析多只股票生成汇总？
