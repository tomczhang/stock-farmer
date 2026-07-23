"""阶段判断 + 综合强度 + 操作建议。"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .signals import SignalResult


@dataclass
class PhaseResult:
    phase: str          # "仍在下跌" / "底部特征初现" / "趋势运行中" / ...
    icon: str           # 🔴 / 🟡 / 🟡⭐ / 🟢 / 🟢🟢 / 📈
    action: str         # 操作建议
    trigger: str        # 触发条件
    strength: float     # 综合强度 0-1
    strength_pct: int   # 百分比展示
    regime: str = "unknown"  # 价格趋势状态：uptrend / downtrend / range / unknown


def compute_trend_regime(df: "pd.DataFrame | None") -> str:
    """从价格结构判断宏观趋势状态，独立于 11 个反转信号。

    这套框架本质是底部反转探测器；对已经在上升趋势中途的个股，反转信号天然
    不触发、得分很低，但这并不等于"下跌趋势"。本函数用均线结构区分：
    - uptrend：收盘 > MA200 且 MA50 > MA200 且 MA50 上行
    - downtrend：收盘 < MA200 且 MA50 < MA200 且 MA50 下行
    - 数据不足 200 根时退化为 MA50 与其斜率的简化判断
    - 其余为 range / unknown
    """
    if df is None or len(df) < 60 or "close" not in df:
        return "unknown"
    closes = df["close"].astype(float).values
    n = len(closes)
    last = float(closes[-1])

    def _ma(window: int) -> float | None:
        return float(np.mean(closes[-window:])) if n >= window else None

    ma50 = _ma(50)
    ma200 = _ma(200)
    # MA50 在约 20 个交易日前的值，用于判断斜率。
    ma50_prev = float(np.mean(closes[-70:-20])) if n >= 70 else None

    if ma200 is None:
        if ma50 is not None and ma50_prev is not None:
            if last > ma50 and ma50 > ma50_prev:
                return "uptrend"
            if last < ma50 and ma50 < ma50_prev:
                return "downtrend"
        return "range"

    rising = ma50_prev is not None and ma50 > ma50_prev
    falling = ma50_prev is not None and ma50 < ma50_prev
    if last > ma200 and ma50 > ma200 and rising:
        return "uptrend"
    if last < ma200 and ma50 < ma200 and falling:
        return "downtrend"
    return "range"


_PHASES = [
    # (left_green_min, right_green_min, phase, icon, action)
    (4, 3, "趋势已确立", "🟢🟢", "持有或加仓"),
    (3, 2, "右侧初步确认", "🟢", "可考虑建仓"),
    (0, 3, "右侧强势突破", "🟢", "右侧信号充分，可考虑建仓（注意左侧底部特征不足）"),
    (4, 0, "底部基本成型", "🟡⭐", "高度关注，等待右侧确认"),
    (2, 2, "底部初现+右侧确认", "🟡⭐", "信号共振，可小仓位试探"),
    (2, 0, "底部特征初现", "🟡", "列入观察清单"),
    (0, 0, "仍在下跌", "🔴", "不碰，等待底部信号出现"),
]


def determine_phase(
    signals: list[SignalResult],
    df: "pd.DataFrame | None" = None,
) -> PhaseResult:
    left_green = sum(1 for s in signals if s.category == "left" and s.light == "green")
    right_green = sum(1 for s in signals if s.category == "right" and s.light == "green")

    phase = "仍在下跌"
    icon = "🔴"
    action = "不碰，等待底部信号出现"

    for lg_min, rg_min, p, ic, act in _PHASES:
        if left_green >= lg_min and right_green >= rg_min:
            phase, icon, action = p, ic, act
            break

    trigger = _compute_trigger(signals, phase)
    strength = compute_overall_strength(signals)
    strength_pct = int(round(strength * 100))

    regime = compute_trend_regime(df) if df is not None else "unknown"
    # regime 修正：框架判为"仍在下跌"但价格其实在上升趋势中途，
    # 说明它只是"没有反转买点"，不是看空——单列为「趋势运行中」。
    if phase == "仍在下跌" and regime == "uptrend":
        phase = "趋势运行中"
        icon = "📈"
        action = "已在上升趋势中，非本框架的右侧反转买点；如需参与请用趋势跟随 / 回调策略"
        trigger = "等待出现回调筑底后，本框架才会再给右侧反转信号"

    return PhaseResult(
        phase=phase, icon=icon, action=action,
        trigger=trigger, strength=strength, strength_pct=strength_pct,
        regime=regime,
    )


def compute_overall_strength(signals: list[SignalResult]) -> float:
    total_weight = sum(s.weight for s in signals)
    if total_weight == 0:
        return 0.0
    weighted_sum = sum(s.confidence * s.weight for s in signals)
    return weighted_sum / total_weight


def _compute_trigger(signals: list[SignalResult], phase: str) -> str:
    """生成下一步触发条件——找最可能翻绿的黄灯信号。"""
    yellow_signals = [s for s in signals if s.light == "yellow"]
    if not yellow_signals:
        if phase in ("趋势已确立", "右侧初步确认"):
            return "维持当前趋势，关注量能是否持续"
        red_right = [s for s in signals if s.category == "right" and s.light == "red"]
        if red_right:
            s = red_right[0]
            return f"等待{s.name}信号出现"
        return "等待更多信号确认"

    # 找确定度最高的黄灯信号（最接近翻绿）
    best = max(yellow_signals, key=lambda s: s.confidence)

    if best.id == "above_ma" and "ma20" in best.data:
        ma20 = best.data["ma20"]
        return f"放量站上 MA20 (${ma20:.2f}) 则确认右侧"
    if best.id == "macd_cross":
        return "MACD 金叉确认则趋势转强"
    if best.id == "volume_breakout":
        return "出现放量阳线（成交量 > 20日均量）则确认"
    if best.id == "support_retest_hold":
        return "回踩支撑位不破则确认右侧站稳"
    if best.id == "vol_shrink":
        return "成交量继续萎缩则底部信号加强"

    return f"{best.name}信号即将确认（当前 {best.confidence*100:.0f}%）"
