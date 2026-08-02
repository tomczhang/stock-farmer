"""筑底三迹象判读引擎。

以「缩量下跌 / 假破位收回 / 筹码稳定」三迹象为核心，聚合出唯一的筑底判读
结论与洗盘干净度（结构强度语义，不代表胜率 / 概率 / 准确率）。

- 迹象一复用 signals._calc_vol_shrink 的五维缩量评估；
- 迹象二组合 signals._calc_false_breakdown 与 signals._calc_no_new_low；
- 迹象三为新算法：日线筹码峰对比（不下移）+ 量能分位低换手代理。

全部基于日线 OHLCV 计算，as-of 模式下只需截断日线即可保证无未来函数。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd

from .phase import compute_trend_regime
from .signals import (
    SignalResult,
    _calc_atr,
    _calc_false_breakdown,
    _calc_no_new_low,
    _calc_vol_shrink,
    _clamp,
)

# 三档状态阈值：与现有信号红黄绿习惯一致
SIGN_EARLY_THRESHOLD = 0.35
SIGN_CLEAR_THRESHOLD = 0.70

# 迹象二内部权重：假破位收回为主、跌不动为辅
FALSE_BREAKDOWN_WEIGHT = 0.65
NO_NEW_LOW_WEIGHT = 0.35

# 迹象三参数：筹码峰窗口 / 量能分位窗口 / 内部权重
CHIP_PEAK_WINDOW = 30
CHIP_MIN_BARS = 60
TURNOVER_LOOKBACK = 250
CHIP_PEAK_WEIGHT = 0.60
LOW_TURNOVER_WEIGHT = 0.40

# 洗盘干净度权重：假破位收回 2x（与现有框架一致），其余 1x
CLEANLINESS_WEIGHTS = {"vol_dry_up": 1.0, "false_break_recover": 2.0, "chip_stability": 1.0}

_STATE_LABELS = {"absent": "未出现", "early": "初现", "clear": "明显"}

_TIER_META: dict[str, dict[str, str]] = {
    "still_falling": {
        "label": "仍在下跌",
        "icon": "🔴",
        "action": "不碰，等待筑底迹象出现",
    },
    "early_signs": {
        "label": "筑底迹象初现",
        "icon": "🟡",
        "action": "列入观察清单，跟踪三迹象是否继续走强",
    },
    "base_forming": {
        "label": "筑底基本成立",
        "icon": "🟡⭐",
        "action": "筑底迹象已具备，等待右侧触发信号确认后再考虑出手，不要抢跑",
    },
    "base_ready": {
        "label": "筑底成立·等待右侧出手点",
        "icon": "🟢",
        "action": "三迹象齐备，洗盘基本干净，等待右侧触发（如放量站上 MA20）出现出手点",
    },
    "trend_running": {
        "label": "趋势运行中",
        "icon": "📈",
        "action": "已在上升趋势中，非本框架的筑底买点；如需参与请用趋势跟随 / 回调策略",
    },
}


@dataclass
class BottomingSign:
    id: str
    name: str
    plain_name: str  # 大白话别名
    score: float  # 0.0 ~ 1.0
    state: str  # "absent" | "early" | "clear"
    state_label: str  # 未出现 / 初现 / 明显
    description: str
    dimensions: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class BottomingVerdict:
    tier: str  # still_falling / early_signs / base_forming / base_ready / trend_running
    tier_label: str
    icon: str
    action: str
    next_trigger: str
    cleanliness: float  # 洗盘干净度 0-1（结构强度语义）
    cleanliness_pct: int
    signs: list[BottomingSign]
    regime: str = "unknown"


def _to_state(score: float) -> str:
    if score >= SIGN_CLEAR_THRESHOLD:
        return "clear"
    if score >= SIGN_EARLY_THRESHOLD:
        return "early"
    return "absent"


def _make_sign(
    sign_id: str,
    name: str,
    plain_name: str,
    score: float,
    description: str,
    dimensions: list[dict[str, Any]],
) -> BottomingSign:
    score = _clamp(float(score))
    state = _to_state(score)
    return BottomingSign(
        id=sign_id, name=name, plain_name=plain_name,
        score=score, state=state, state_label=_STATE_LABELS[state],
        description=description, dimensions=dimensions,
    )


# ---------- 迹象一：缩量下跌 ----------

_VOL_DIM_LABELS = {
    "single": "单日缩量",
    "stage": "阶段缩量",
    "obvious": "明显缩量",
    "trend": "趋势缩量",
    "divergence": "量价背离",
}


def build_vol_dry_up_sign(vol_shrink: SignalResult) -> BottomingSign:
    """迹象一：包装现有五维缩量评估，输出大白话证据。"""
    scores: dict[str, float] = (vol_shrink.data or {}).get("scores") or {}
    dimensions = [
        {"key": key, "label": label, "score": round(float(scores.get(key, 0.0)), 2)}
        for key, label in _VOL_DIM_LABELS.items()
    ]
    score = vol_shrink.confidence
    state = _to_state(score)
    if not scores:
        desc = "数据不足，无法判断"
    elif state == "clear":
        desc = "下跌时明显缩量——想卖的人基本卖完了，抛压明显减轻"
    elif state == "early":
        desc = "下跌日量能开始低于近期平均，抛压有减轻迹象，但还不彻底"
    else:
        desc = "下跌时量能没有收缩，抛压还在，谈不上缩量下跌"
    hits = sum(1 for v in scores.values() if v >= 0.5)
    if scores:
        desc += f"（{hits}/5 项缩量观察达标）"
    return _make_sign(
        "vol_dry_up", "缩量下跌", "跌的时候没人卖了", score, desc, dimensions,
    )


# ---------- 迹象二：假破位收回 ----------

def build_false_break_recover_sign(
    false_breakdown: SignalResult,
    no_new_low: SignalResult,
) -> BottomingSign:
    """迹象二：假破位收回为主证据，跌不动为辅证据。"""
    fb_conf = false_breakdown.confidence
    nn_conf = no_new_low.confidence
    score = fb_conf * FALSE_BREAKDOWN_WEIGHT + nn_conf * NO_NEW_LOW_WEIGHT

    fb_data = false_breakdown.data or {}
    event = fb_data.get("breakdown_event") or {}
    has_support = bool(fb_data.get("active_support"))

    if event.get("recover_date"):
        desc = (
            f"出现假破位：{event.get('break_date', '?')} 跌破支撑后"
            f"{event.get('recover_days', '?')}日内收回，砸下去马上被买回来"
        )
        if nn_conf >= SIGN_EARLY_THRESHOLD:
            desc += "；且近期没有再创新低（跌不动）"
    elif not has_support:
        desc = "未识别到可靠支撑，暂无法判断假破位"
        if nn_conf >= SIGN_EARLY_THRESHOLD:
            desc += "；但价格没有再创新低，先按「跌不动」观察"
        else:
            desc += "，价格也仍在创新低"
    else:
        if nn_conf >= SIGN_EARLY_THRESHOLD:
            desc = "近期没有出现破位后收回，但价格也没有再创新低（跌不动）"
        else:
            desc = "近期没有出现假破位收回，价格仍在向下破位"

    dimensions = [
        {
            "key": "false_breakdown", "label": "假破位收回",
            "score": round(fb_conf, 2), "detail": false_breakdown.description,
        },
        {
            "key": "no_new_low", "label": "跌不动",
            "score": round(nn_conf, 2), "detail": no_new_low.description,
        },
    ]
    return _make_sign(
        "false_break_recover", "假破位收回", "想跌却跌不动", score, desc, dimensions,
    )


# ---------- 迹象三：筹码稳定 ----------

def _volume_profile_fn():
    """兼容包内（pipeline.data）与测试根（data）两种导入。"""
    try:
        from pipeline.data.indicators import build_volume_profile
    except ModuleNotFoundError:
        from data.indicators import build_volume_profile
    return build_volume_profile


def _profile_peak(df_slice: pd.DataFrame) -> float | None:
    """取一段日线的最大成交密集价位（筹码峰）。"""
    build_volume_profile = _volume_profile_fn()
    profile = build_volume_profile(df_slice, num_bins=20)
    if not profile:
        return None
    peak_bin = max(profile, key=lambda b: b.volume)
    return float(peak_bin.price_level)


def build_chip_stability_sign(df: pd.DataFrame) -> BottomingSign:
    """迹象三：筹码峰不下移（0.6）+ 量能分位低换手代理（0.4）。

    纯日线口径：无需分钟数据与流通股本，as-of 模式同样可算。
    低换手为「相对自身历史」的量能分位代理，不与其他个股横向比较。
    """
    n = len(df)
    if n < CHIP_MIN_BARS:
        return _make_sign(
            "chip_stability", "筹码稳定", "洗盘洗干净了", 0.0,
            "数据不足，无法判断", [],
        )

    atr = _calc_atr(df, 20)

    # --- 维度1: 筹码峰不下移 ---
    recent_peak = _profile_peak(df.iloc[-CHIP_PEAK_WINDOW:])
    prev_peak = _profile_peak(df.iloc[-2 * CHIP_PEAK_WINDOW:-CHIP_PEAK_WINDOW])
    if recent_peak is None or prev_peak is None:
        peak_score = 0.0
        peak_drop = None
    else:
        peak_drop = max(0.0, prev_peak - recent_peak)
        peak_score = _clamp(1 - peak_drop / atr)

    # --- 维度2: 低换手代理 — 当前20日均量在自身历史量能分布中的分位 ---
    volumes = df["volume"].astype(float).values
    lookback = min(n, TURNOVER_LOOKBACK)
    vol_series = pd.Series(volumes[-lookback:])
    rolling20 = vol_series.rolling(20).mean().dropna().values
    current_vol20 = float(np.mean(volumes[-20:]))
    if len(rolling20) == 0:
        turnover_q = 1.0
    else:
        turnover_q = float(np.mean(rolling20 <= current_vol20))
    turnover_score = _clamp((0.5 - turnover_q) / 0.35)

    score = peak_score * CHIP_PEAK_WEIGHT + turnover_score * LOW_TURNOVER_WEIGHT
    state = _to_state(score)

    if recent_peak is None or prev_peak is None:
        desc = "成交分布数据不足，无法定位筹码峰"
    elif peak_drop is not None and peak_score == 0.0:
        desc = (
            f"筹码峰从 {prev_peak:.2f} 下移到 {recent_peak:.2f}，"
            "仍有筹码向下换手，洗盘还没洗完"
        )
    elif state == "clear":
        desc = (
            f"筹码峰稳定在 {recent_peak:.2f} 附近没有下移，"
            "且量能处于自身历史低位——套牢盘没有割肉，浮筹已清洗"
        )
    elif state == "early":
        desc = "筹码峰基本没下移，量能也在收缩，筹码趋于稳定但还需确认"
    else:
        desc = "筹码峰或量能分位不达标，筹码尚未稳定下来"

    dimensions = [
        {
            "key": "chip_peak_hold", "label": "筹码峰不下移",
            "score": round(peak_score, 2),
            "recent_peak": None if recent_peak is None else round(recent_peak, 2),
            "prev_peak": None if prev_peak is None else round(prev_peak, 2),
        },
        {
            "key": "low_turnover", "label": "低换手（量能分位）",
            "score": round(turnover_score, 2),
            "turnover_quantile": round(turnover_q, 2),
            "detail": f"当前20日均量处于自身近{lookback}日量能分位 {turnover_q*100:.0f}%",
        },
    ]
    return _make_sign("chip_stability", "筹码稳定", "洗盘洗干净了", score, desc, dimensions)


# ---------- 聚合判读 ----------

def _resolve_tier(signs: list[BottomingSign]) -> str:
    clear = sum(1 for s in signs if s.state == "clear")
    early = sum(1 for s in signs if s.state == "early")
    if clear == 3:
        return "base_ready"
    if clear >= 2:
        return "base_forming"
    if clear == 1 or early >= 2:
        return "early_signs"
    return "still_falling"


def _default_next_trigger(tier: str, signs: list[BottomingSign]) -> str:
    if tier in ("base_forming", "base_ready"):
        return "等待右侧触发：放量站上 MA20 / 放量反包 / 回踩支撑不破"
    if tier == "trend_running":
        return "等待出现回调筑底后，本框架才会再给筑底判读信号"
    pending = [s for s in signs if s.state != "clear"]
    if pending:
        closest = max(pending, key=lambda s: s.score)
        return f"关注「{closest.name}」是否走强（当前 {closest.score*100:.0f}%）"
    return "等待筑底迹象出现"


def compute_cleanliness(signs: list[BottomingSign]) -> float:
    """洗盘干净度 = 三迹象加权分（结构强度语义）。"""
    total = sum(CLEANLINESS_WEIGHTS.get(s.id, 1.0) for s in signs)
    if total == 0:
        return 0.0
    weighted = sum(s.score * CLEANLINESS_WEIGHTS.get(s.id, 1.0) for s in signs)
    return _clamp(weighted / total)


def compute_bottoming(
    df: pd.DataFrame,
    signals: list[SignalResult] | None = None,
) -> BottomingVerdict:
    """计算筑底三迹象与聚合判读结论。

    `signals` 可传入 compute_all_signals 的结果以复用已算好的
    缩量下跌 / 假破位收回 / 跌不动，避免重复计算。
    """
    by_id = {s.id: s for s in (signals or [])}
    vol_shrink = by_id.get("vol_shrink") or _calc_vol_shrink(df)
    false_breakdown = by_id.get("false_breakdown") or _calc_false_breakdown(df)
    no_new_low = by_id.get("no_new_low") or _calc_no_new_low(df)

    signs = [
        build_vol_dry_up_sign(vol_shrink),
        build_false_break_recover_sign(false_breakdown, no_new_low),
        build_chip_stability_sign(df),
    ]

    regime = compute_trend_regime(df)
    tier = _resolve_tier(signs)
    # 上升趋势中途：筑底框架不适用，单列为「趋势运行中」。
    # 趋势中「跌不动 / 筹码峰上移」天然成立，会误报“迹象初现”，
    # 因此 uptrend 无条件覆写，避免被读成看空或误读为筑底中。
    if regime == "uptrend":
        tier = "trend_running"

    meta = _TIER_META[tier]
    cleanliness = compute_cleanliness(signs)
    return BottomingVerdict(
        tier=tier,
        tier_label=meta["label"],
        icon=meta["icon"],
        action=meta["action"],
        next_trigger=_default_next_trigger(tier, signs),
        cleanliness=cleanliness,
        cleanliness_pct=int(round(cleanliness * 100)),
        signs=signs,
        regime=regime,
    )
