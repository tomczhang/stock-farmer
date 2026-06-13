"""阶段判断 + 综合强度 + 操作建议。"""
from __future__ import annotations

from dataclasses import dataclass

from .signals import SignalResult


@dataclass
class PhaseResult:
    phase: str          # "仍在下跌" / "底部特征初现" / ...
    icon: str           # 🔴 / 🟡 / 🟡⭐ / 🟢 / 🟢🟢
    action: str         # 操作建议
    trigger: str        # 触发条件
    strength: float     # 综合强度 0-1
    strength_pct: int   # 百分比展示


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


def determine_phase(signals: list[SignalResult]) -> PhaseResult:
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

    return PhaseResult(
        phase=phase, icon=icon, action=action,
        trigger=trigger, strength=strength, strength_pct=strength_pct,
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
