"""筑底综述文本生成（模板拼接，非 LLM）。"""
from __future__ import annotations

from .bottoming import BottomingVerdict
from .signals import SignalResult


_TIER_NARRATIVE = {
    "still_falling": "仍在下跌，筑底三迹象尚不完整，结构仍偏弱",
    "early_signs": "开始出现筑底迹象，但结构还不完整",
    "base_forming": "筑底迹象基本具备，洗盘结构接近稳定",
    "base_ready": "筑底三迹象齐备，洗盘结构较完整",
}


def generate_narrative(
    ticker: str,
    name: str,
    signals: list[SignalResult],
    verdict: BottomingVerdict,
) -> str:
    """生成只描述筑底结构的确定性综述。

    左侧信号只作为证据明细；洗盘干净度是结构强度，不是买点、胜率或概率。
    """
    if verdict.tier == "trend_running":
        return (
            f"{ticker} ({name}) 当前处于上升趋势中，筑底框架不适用。"
            "低筑底分不代表看空，只表示当前不是筑底结构。"
            f"{verdict.action}。{verdict.next_observation}。"
        )

    state = _TIER_NARRATIVE.get(verdict.tier, "筑底状态待定")
    signs_txt = "、".join(f"{s.name}「{s.state_label}」" for s in verdict.signs)

    left_green = [s.name for s in signals if s.light == "green"]
    evidence = (
        f"保留证据中，{'、'.join(left_green[:3])}处于确认状态。"
        if left_green else
        "保留证据中暂未出现确认状态。"
    )

    return (
        f"{ticker} ({name}) 当前{state}。"
        f"三项筑底迹象：{signs_txt}；洗盘干净度 {verdict.cleanliness_pct}%"
        "（结构强度口径，不代表买点、上涨把握或收益概率）。"
        f"{evidence}{verdict.action}。{verdict.next_observation}。"
    )
