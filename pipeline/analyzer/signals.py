"""11 个信号的确定度计算。"""
from __future__ import annotations

from dataclasses import dataclass, field
import math
from typing import Any

import numpy as np
import pandas as pd

SUPPORT_STRONG_THRESHOLD = 0.60
SUPPORT_ACTIONABLE_THRESHOLD = 0.35


@dataclass
class SignalResult:
    id: str
    name: str
    category: str  # "left" | "right"
    confidence: float  # 0.0 ~ 1.0
    light: str  # "red" | "yellow" | "green"
    thresholds: tuple[float, float]  # (red_max, yellow_max)
    weight: int  # 1 or 2
    description: str
    data: dict = field(default_factory=dict)


def _clamp(v: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, v))


def _to_light(confidence: float, thresholds: tuple[float, float]) -> str:
    if confidence >= thresholds[1]:
        return "green"
    if confidence >= thresholds[0]:
        return "yellow"
    return "red"


# ---------- S1: 缩量下跌 ----------

def _calc_vol_shrink(df: pd.DataFrame) -> SignalResult:
    """缩量下跌 — 多维度递进评估：
    1) 单日缩量：最近一个下跌日量 < MA20
    2) 阶段缩量：近5-10个下跌日均量 < MA20
    3) 明显缩量：下跌日均量 < MA20 的 80%
    4) 趋势缩量：最近一轮下跌量能 < 上一轮下跌量能
    5) 量价背离：股价创新低但成交量低于前低，抛压边际减轻
    """
    thresholds = (0.35, 0.70)
    closes = df["close"].values
    vol = df["volume"].values
    n = len(vol)
    if n < 30:
        return SignalResult(
            id="vol_shrink", name="缩量下跌", category="left",
            confidence=0.0, light="red", thresholds=thresholds, weight=1,
            description="数据不足，无法判断", data={},
        )

    vol20 = float(np.mean(vol[-20:]))
    if vol20 == 0:
        vol20 = 1.0

    # 收集所有下跌日（收盘 < 前日收盘）
    down_indices = [i for i in range(1, n) if closes[i] < closes[i - 1]]

    if not down_indices:
        return SignalResult(
            id="vol_shrink", name="缩量下跌", category="left",
            confidence=0.0, light="red", thresholds=thresholds, weight=1,
            description="无下跌日，无法判断",
            data={"down_days": 0},
        )

    dates = df["date"].values

    # --- 维度1: 单日缩量 — 最近一个下跌日量 vs MA20 ---
    last_down_idx = down_indices[-1]
    last_down_vol = float(vol[last_down_idx])
    last_down_date = str(dates[last_down_idx])
    single_ratio = last_down_vol / vol20
    score_single = _clamp(1 - single_ratio) if single_ratio < 1 else 0.0

    # --- 维度2+3: 阶段缩量 — 近5~10个下跌日均量 vs MA20 ---
    recent_down_indices = [i for i in down_indices if i >= n - 10]
    if not recent_down_indices:
        recent_down_indices = [down_indices[-1]]
    recent_down_vols = [float(vol[i]) for i in recent_down_indices]
    avg_down_vol = float(np.mean(recent_down_vols))
    stage_ratio = avg_down_vol / vol20
    score_stage = _clamp(1 - stage_ratio) if stage_ratio < 1 else 0.0
    score_obvious = _clamp((0.8 - stage_ratio) / 0.3) if stage_ratio < 0.8 else 0.0

    # --- 维度4: 趋势缩量 — 用价格波峰/波谷划分下跌波段 ---
    # 找局部极值点：3日窗口内的最高/最低点
    highs_arr = df["high"].values
    lows = df["low"].values
    window = 3
    swing_highs: list[int] = []
    swing_lows: list[int] = []
    for i in range(window, n - window):
        if highs_arr[i] == max(highs_arr[i - window:i + window + 1]):
            swing_highs.append(i)
        if lows[i] == min(lows[i - window:i + window + 1]):
            swing_lows.append(i)
    # 边界处理：检查最后 window 天内是否有低点/高点
    tail_start = max(n - window, window)
    tail_low_idx = tail_start + int(np.argmin(lows[tail_start:]))
    if not swing_lows or lows[tail_low_idx] <= lows[swing_lows[-1]]:
        swing_lows.append(tail_low_idx)
    tail_high_idx = tail_start + int(np.argmax(highs_arr[tail_start:]))
    if not swing_highs or highs_arr[tail_high_idx] >= highs_arr[swing_highs[-1]]:
        swing_highs.append(tail_high_idx)

    # 配对：每个波谷找它前面最近的波峰，形成"高点→低点"下跌波段
    # 只保留跌幅 > 5% 的有效波段，过滤噪音
    down_swings: list[tuple[int, int]] = []
    for low_idx in swing_lows:
        prev_highs = [h for h in swing_highs if h < low_idx]
        if prev_highs:
            high_idx = prev_highs[-1]
            drop_pct = (highs_arr[high_idx] - lows[low_idx]) / highs_arr[high_idx]
            if drop_pct > 0.05:
                down_swings.append((high_idx, low_idx))

    trend_detail: dict = {}
    if len(down_swings) >= 2:
        recent_swing = down_swings[-1]
        prev_swing = down_swings[-2]
        # 计算每段下跌波段内所有交易日的平均成交量
        recent_vols = [float(vol[i]) for i in range(recent_swing[0], recent_swing[1] + 1)]
        prev_vols = [float(vol[i]) for i in range(prev_swing[0], prev_swing[1] + 1)]
        avg_recent_wave = float(np.mean(recent_vols)) if recent_vols else None
        avg_prev_wave = float(np.mean(prev_vols)) if prev_vols else None
        if avg_recent_wave and avg_prev_wave:
            trend_ratio = avg_recent_wave / avg_prev_wave if avg_prev_wave > 0 else 1.0
            score_trend = _clamp(1 - trend_ratio) if trend_ratio < 1 else 0.0
            trend_detail = {
                "recent_start": str(dates[recent_swing[0]]),
                "recent_end": str(dates[recent_swing[1]]),
                "recent_days": recent_swing[1] - recent_swing[0] + 1,
                "recent_high": float(highs_arr[recent_swing[0]]),
                "recent_low": float(lows[recent_swing[1]]),
                "prev_start": str(dates[prev_swing[0]]),
                "prev_end": str(dates[prev_swing[1]]),
                "prev_days": prev_swing[1] - prev_swing[0] + 1,
                "prev_high": float(highs_arr[prev_swing[0]]),
                "prev_low": float(lows[prev_swing[1]]),
            }
        else:
            avg_recent_wave = None
            avg_prev_wave = None
            trend_ratio = None
            score_trend = 0.0
    else:
        avg_recent_wave = None
        avg_prev_wave = None
        trend_ratio = None
        score_trend = 0.0

    # --- 维度5: 量价背离 — 价格创新低但成交量低于前低 ---
    score_divergence = 0.0
    div_detail: dict = {}
    lows = df["low"].values
    if n >= 40:
        recent_low = float(np.min(lows[-10:]))
        prev_low = float(np.min(lows[-30:-10]))
        if recent_low < prev_low:
            recent_low_idx = n - 10 + int(np.argmin(lows[-10:]))
            prev_low_idx = n - 30 + int(np.argmin(lows[-30:-10]))
            vol_at_recent_low = float(vol[recent_low_idx])
            vol_at_prev_low = float(vol[prev_low_idx])
            div_detail = {
                "recent_low_date": str(dates[recent_low_idx]),
                "recent_low_price": recent_low,
                "recent_low_vol": vol_at_recent_low,
                "prev_low_date": str(dates[prev_low_idx]),
                "prev_low_price": prev_low,
                "prev_low_vol": vol_at_prev_low,
            }
            if vol_at_recent_low < vol_at_prev_low:
                score_divergence = _clamp((vol_at_prev_low - vol_at_recent_low) / vol_at_prev_low * 2)

    # --- 综合评分 ---
    # 权重：量价背离(最强) 30% + 趋势缩量 25% + 明显缩量 20% + 阶段缩量 15% + 单日 10%
    conf = _clamp(
        score_divergence * 0.30
        + score_trend * 0.25
        + score_obvious * 0.20
        + score_stage * 0.15
        + score_single * 0.10
    )

    # --- 描述 ---
    n_down = len(recent_down_vols)
    hits = sum([
        score_single > 0, score_stage > 0, score_obvious > 0,
        score_trend > 0, score_divergence > 0,
    ])
    parts = [f"近10日有{n_down}天下跌"]
    if hits == 0:
        parts.append("5项观察均未达标，无缩量迹象")
    elif hits <= 2:
        parts.append(f"{hits}/5项达标，轻微缩量")
    elif hits <= 3:
        parts.append(f"{hits}/5项达标，缩量特征初现")
    else:
        parts.append(f"{hits}/5项达标，抛压明显减轻")
    desc = "，".join(parts)

    return SignalResult(
        id="vol_shrink", name="缩量下跌", category="left",
        confidence=conf, light=_to_light(conf, thresholds), thresholds=thresholds, weight=1,
        description=desc,
        data={
            "down_days": n_down, "avg_down_vol": avg_down_vol, "vol20": vol20,
            "single_ratio": single_ratio, "stage_ratio": stage_ratio,
            "trend_ratio": trend_ratio, "score_divergence": score_divergence,
            "last_down_date": last_down_date,
            "last_down_vol": last_down_vol,
            "avg_recent_wave": avg_recent_wave,
            "avg_prev_wave": avg_prev_wave,
            "trend_detail": trend_detail,
            "div_detail": div_detail,
            "scores": {
                "single": score_single, "stage": score_stage,
                "obvious": score_obvious, "trend": score_trend,
                "divergence": score_divergence,
            },
        },
    )


# ---------- S2: 跌不动 ----------

def _calc_no_new_low(df: pd.DataFrame) -> SignalResult:
    thresholds = (0.35, 0.70)
    if len(df) < 25:
        return SignalResult(
            id="no_new_low", name="跌不动", category="left",
            confidence=0.0, light="red", thresholds=thresholds, weight=1,
            description="数据不足", data={},
        )
    lows = df["low"].values
    recent_low = float(np.min(lows[-5:]))
    prev_low = float(np.min(lows[-25:-5]))
    highs = df["high"].values
    atr = float(np.mean(highs[-14:] - lows[-14:]))
    if atr == 0:
        atr = 1.0

    breach = max(0, prev_low - recent_low)
    conf = _clamp(1 - breach / atr)

    if conf >= thresholds[1]:
        desc = f"近5日最低 {recent_low:.2f}，未破前低 {prev_low:.2f}"
    elif conf >= thresholds[0]:
        desc = f"近5日最低 {recent_low:.2f}，轻微破前低 {prev_low:.2f} {breach:.2f}"
    else:
        desc = f"近5日最低 {recent_low:.2f}，有效破前低 {prev_low:.2f}"

    return SignalResult(
        id="no_new_low", name="跌不动", category="left",
        confidence=conf, light=_to_light(conf, thresholds), thresholds=thresholds, weight=1,
        description=desc, data={"recent_low": recent_low, "prev_low": prev_low, "breach": breach},
    )


# ---------- S3: 假破位收回 ----------

def _calc_atr(df: pd.DataFrame, window: int = 20) -> float:
    highs = df["high"].astype(float).values
    lows = df["low"].astype(float).values
    closes = df["close"].astype(float).values
    if len(df) < 2:
        return float(np.mean(highs - lows)) if len(df) else 1.0
    tr = []
    for i in range(1, len(df)):
        tr.append(max(
            highs[i] - lows[i],
            abs(highs[i] - closes[i - 1]),
            abs(lows[i] - closes[i - 1]),
        ))
    atr = float(np.mean(tr[-window:])) if tr else float(np.mean(highs - lows))
    return atr if atr > 0 else 1.0


def _support_round_step(price: float) -> float:
    if price >= 500:
        return 20.0
    if price >= 300:
        return 10.0
    if price >= 100:
        return 5.0
    if price >= 50:
        return 2.0
    return 1.0


def _support_tolerance(current: float, atr: float) -> float:
    return max(current * 0.015, atr * 0.8, 1.0)


def _support_cluster_tolerance(current: float, atr: float) -> float:
    """候选点聚合容忍度。

    支撑识别可以用较宽容忍度判断破位，但最终区间展示必须更窄，
    否则会把相邻支撑粘成一个很宽的带。
    """
    return max(current * 0.006, atr * 0.20, 1.5)


def _support_stability_label(strength: float) -> str:
    if strength >= SUPPORT_STRONG_THRESHOLD:
        return "强"
    if strength >= SUPPORT_ACTIONABLE_THRESHOLD:
        return "中"
    return "弱"


def _support_display_role(zone: dict[str, Any], *, near: bool) -> str:
    strength = float(zone.get("strength", 0.0) or 0.0)
    if strength >= SUPPORT_STRONG_THRESHOLD:
        return "下个强支撑"
    if bool(zone.get("is_major_support")):
        return "关键观察支撑，稳定性待确认"
    if strength >= SUPPORT_ACTIONABLE_THRESHOLD:
        return "下个中等支撑"
    return "近端观察支撑，稳定性不足" if near else "观察支撑，稳定性不足"


def _add_swing_low_candidates(
    candidates: list[dict[str, Any]],
    df: pd.DataFrame,
    lookback: int,
    source: str,
) -> None:
    lows = df["low"].astype(float).values
    highs = df["high"].astype(float).values
    volumes = df["volume"].astype(float).values
    dates = df["date"].astype(str).values
    n = len(df)
    start = max(0, n - lookback)
    swing = 3
    idxs: set[int] = set()
    for i in range(max(start + swing, swing), n - swing):
        window = lows[i - swing:i + swing + 1]
        if lows[i] <= float(np.min(window)):
            idxs.add(i)
    if n > start:
        idxs.add(start + int(np.argmin(lows[start:])))

    for i in sorted(idxs):
        low = float(lows[i])
        future_highs = highs[i:min(n, i + 11)]
        immediate_highs = highs[i:min(n, i + 4)]
        future_rebounds = (
            np.maximum(0.0, (future_highs - low) / low)
            if low and len(future_highs) else np.array([0.0])
        )
        immediate_rebound_pct = (
            max(0.0, (float(np.max(immediate_highs)) - low) / low)
            if low and len(immediate_highs) else 0.0
        )
        best_rebound_pct = float(np.max(future_rebounds)) if len(future_rebounds) else 0.0
        best_rebound_days = int(np.argmax(future_rebounds)) if len(future_rebounds) else 0
        vol_window = volumes[max(0, i - 19):i + 1]
        vol_base = float(np.mean(vol_window)) if len(vol_window) else 1.0
        volume_ratio = volumes[i] / vol_base if vol_base else 1.0
        recency = math.exp(-(n - 1 - i) / 120)
        immediate_rebound_score = _clamp(immediate_rebound_pct / 0.08)
        speed_score = _clamp(best_rebound_pct / 0.08) * math.exp(-best_rebound_days / 3)
        volume_score = _clamp((volume_ratio - 0.8) / 1.2)
        score = (
            immediate_rebound_score * 0.35
            + speed_score * 0.20
            + volume_score * 0.20
            + _clamp(recency) * 0.25
        )
        candidates.append({
            "price": low,
            "score": float(score),
            "source": source,
            "date": str(dates[i]),
            "kind": "前低",
            "immediate_rebound_pct": float(immediate_rebound_pct),
            "best_rebound_pct": float(best_rebound_pct),
            "best_rebound_days": best_rebound_days,
            "volume_ratio": float(volume_ratio),
        })


def _add_platform_candidates(candidates: list[dict[str, Any]], df: pd.DataFrame) -> None:
    lows = df["low"].astype(float).values
    closes = df["close"].astype(float).values
    dates = df["date"].astype(str).values
    for window in (20, 30, 45, 60):
        if len(df) < window:
            continue
        recent_lows = lows[-window:]
        recent_closes = closes[-window:]
        low_edge = float(np.quantile(recent_lows, 0.20))
        high_edge = float(np.quantile(recent_closes, 0.80))
        if low_edge <= 0:
            continue
        box_width = (high_edge - low_edge) / low_edge
        if box_width > 0.12:
            continue
        touches = int(np.sum(np.abs(recent_lows - low_edge) / low_edge <= 0.025))
        tightness_score = _clamp((0.12 - box_width) / 0.08)
        duration_score = _clamp(window / 60)
        touch_score = _clamp(touches / 4)
        score = tightness_score * 0.45 + duration_score * 0.30 + touch_score * 0.25
        candidates.append({
            "price": low_edge,
            "score": float(score),
            "source": f"{window}日平台下沿",
            "date": str(dates[-window]),
            "kind": "平台下沿",
        })


def _add_integer_level_candidates(
    candidates: list[dict[str, Any]],
    current: float,
    atr: float,
) -> None:
    if not candidates:
        return
    tolerance = _support_tolerance(current, atr)
    prices = [float(c["price"]) for c in candidates]
    min_level = max(min(prices), current * 0.75)
    max_level = current * 1.05
    step = _support_round_step(current)
    level = math.floor(min_level / step) * step
    while level <= max_level:
        proximity = max(0.0, 1 - min(abs(level - p) for p in prices) / tolerance)
        if proximity >= 0.35:
            candidates.append({
                "price": float(level),
                "score": float(proximity),
                "source": "整数关口",
                "date": "",
                "kind": "整数关口",
            })
        level += step


def _calc_support_zones(df: pd.DataFrame) -> list[dict[str, Any]]:
    if len(df) < 25:
        return []
    current = float(df["close"].astype(float).values[-1])
    atr = _calc_atr(df, 20)
    tolerance = _support_cluster_tolerance(current, atr)
    candidates: list[dict[str, Any]] = []
    _add_swing_low_candidates(candidates, df, 60, "近3个月前低")
    _add_swing_low_candidates(candidates, df, 120, "近6个月前低")
    _add_swing_low_candidates(candidates, df, 250, "近12个月前低")
    _add_platform_candidates(candidates, df)
    _add_integer_level_candidates(candidates, current, atr)

    if not candidates:
        return []

    candidates = sorted(candidates, key=lambda c: float(c["price"]))
    clusters: list[list[dict[str, Any]]] = []
    for c in candidates:
        price = float(c["price"])
        if not clusters:
            clusters.append([c])
            continue
        center = float(np.mean([float(x["price"]) for x in clusters[-1]]))
        if abs(price - center) <= tolerance:
            clusters[-1].append(c)
        else:
            clusters.append([c])

    source_weights = {"前低": 0.40, "平台下沿": 0.35, "整数关口": 0.15}
    zones: list[dict[str, Any]] = []
    zone_pad = max(current * 0.003, atr * 0.12, 1.0)
    for cluster in clusters:
        prices = [float(c["price"]) for c in cluster]
        center = float(np.average(prices, weights=[max(float(c["score"]), 0.05) for c in cluster]))
        sources = sorted({str(c["source"]) for c in cluster})
        kinds = sorted({str(c["kind"]) for c in cluster})
        kind_scores: dict[str, float] = {}
        for c in cluster:
            kind = str(c["kind"])
            kind_scores[kind] = max(kind_scores.get(kind, 0.0), float(c["score"]))
        raw_confluence = sum(score * source_weights.get(kind, 0.2) for kind, score in kind_scores.items())
        raw_low = float(min(prices) - zone_pad)
        raw_high = float(max(prices) + zone_pad)
        width_ratio = (raw_high - raw_low) / current if current else 1.0
        width_penalty = _clamp(1 - width_ratio / 0.06, 0.35, 1.0)
        diversity_bonus = {1: 0.0, 2: 0.08}.get(len(kinds), 0.15)
        repeat_bonus = _clamp((len(sources) - len(kinds)) / 3) * 0.08
        strength = _clamp((raw_confluence + diversity_bonus + repeat_bonus) * width_penalty)
        is_major_support = (
            "前低" in kinds
            and (
                any("近12个月" in source or "近6个月" in source for source in sources)
                or len(sources) >= 3
            )
        )
        zones.append({
            "low": round(raw_low, 2),
            "high": round(raw_high, 2),
            "center": round(center, 2),
            "strength": round(strength, 2),
            "confluence": round(_clamp(raw_confluence * width_penalty), 2),
            "stability_label": _support_stability_label(strength),
            "is_major_support": is_major_support,
            "sources": sources,
            "kinds": kinds,
            "candidate_count": len(cluster),
            "width_pct": round(width_ratio * 100, 1),
        })

    zones = [
        z for z in zones
        if (
            z["high"] >= current * 0.70
            and z["center"] <= current * 1.02
            and z["kinds"] != ["整数关口"]
        )
    ]
    return _separate_support_zones(zones, current=current, atr=atr)[:5]


def _separate_support_zones(
    zones: list[dict[str, Any]],
    current: float,
    atr: float,
) -> list[dict[str, Any]]:
    """最终展示的支撑区间必须互不重叠。

    候选点可以密集共振，但给用户看的区间如果重叠，会造成“到底看哪条”的歧义。
    因此按离现价最近的上方支撑带优先，把更低一档支撑的上沿裁到上一档下方。
    """
    if not zones:
        return []
    min_gap = max(current * 0.003, atr * 0.10, 0.5)
    ordered = sorted(
        zones,
        key=lambda z: (
            0 if float(z["center"]) <= current * 1.02 else 1,
            -float(z["center"]),
            -float(z["strength"]),
        ),
    )
    separated: list[dict[str, Any]] = []
    for zone in ordered:
        z = dict(zone)
        low = float(z["low"])
        high = float(z["high"])
        for upper in separated:
            upper_low = float(upper["low"])
            if high >= upper_low:
                high = min(high, upper_low - min_gap)
        if high <= low:
            continue
        z["low"] = round(low, 2)
        z["high"] = round(high, 2)
        z["center"] = round((low + high) / 2, 2)
        z["width_pct"] = round((high - low) / current * 100, 1) if current else z.get("width_pct", 0)
        z["overlap_adjusted"] = z["high"] != zone["high"]
        separated.append(z)
    return separated


def _select_active_support(zones: list[dict[str, Any]], current: float) -> dict[str, Any] | None:
    if not zones:
        return None
    eligible = [z for z in zones if float(z["low"]) <= current * 1.03]
    if not eligible:
        eligible = zones
    actionable = [z for z in eligible if float(z.get("strength", 0.0) or 0.0) >= SUPPORT_ACTIONABLE_THRESHOLD]
    pool = actionable or eligible
    pool.sort(key=lambda z: (
        0 if float(z["center"]) <= current else 1,
        abs(current - float(z["center"])),
        -float(z["strength"]),
    ))
    return pool[0]


def _support_level(strength: float) -> str:
    return _support_stability_label(strength)


def _select_display_support_zones(
    zones: list[dict[str, Any]],
    current: float,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """选择用户真正关心的支撑位。

    完整候选用于计算，图表只显示：离现价最近的弱/中支撑，以及下方主支撑。
    """
    below = sorted(
        [z for z in zones if float(z["center"]) < current],
        key=lambda z: -float(z["center"]),
    )
    near_support = below[0] if below else None
    strict_strong_support = next(
        (z for z in below if float(z["strength"]) >= SUPPORT_STRONG_THRESHOLD),
        None,
    )
    main_candidates = [
        z for z in below
        if not near_support or float(z["high"]) < float(near_support["low"]) * 0.98
    ]
    major_support = max(
        main_candidates,
        key=lambda z: (
            bool(z.get("is_major_support")),
            float(z.get("strength", 0.0) or 0.0),
            -abs(current - float(z["center"])),
        ),
    ) if main_candidates else None
    main_support = strict_strong_support or major_support

    display: list[dict[str, Any]] = []
    if near_support:
        z = dict(near_support)
        z["display_role"] = _support_display_role(z, near=True)
        display.append(z)
    if main_support and (
        not near_support or float(main_support["center"]) != float(near_support["center"])
    ):
        z = dict(main_support)
        z["display_role"] = _support_display_role(z, near=False)
        display.append(z)

    return display, {
        "has_near_support": near_support is not None,
        "has_main_support": main_support is not None,
        "has_strong_support": strict_strong_support is not None,
        "has_strict_strong_support": strict_strong_support is not None,
        "strong_threshold": SUPPORT_STRONG_THRESHOLD,
        "actionable_threshold": SUPPORT_ACTIONABLE_THRESHOLD,
    }


def _calc_false_breakdown(df: pd.DataFrame) -> SignalResult:
    thresholds = (0.30, 0.60)
    if len(df) < 25:
        return SignalResult(
            id="false_breakdown", name="假破位收回", category="left",
            confidence=0.0, light="red", thresholds=thresholds, weight=2,
            description="数据不足", data={},
        )
    lows = df["low"].astype(float).values
    closes = df["close"].astype(float).values
    volumes = df["volume"].astype(float).values
    dates = df["date"].astype(str).values
    current = float(closes[-1])
    atr = _calc_atr(df, 20)
    support_zones = _calc_support_zones(df)
    display_support_zones, support_focus = _select_display_support_zones(support_zones, current)
    active_support = next(
        (
            z for z in display_support_zones
            if float(z.get("strength", 0.0) or 0.0) >= SUPPORT_STRONG_THRESHOLD
        ),
        None,
    )
    prev_low = float(np.min(lows[-25:-5]))
    support_low = float(active_support["low"]) if active_support else prev_low
    support_high = float(active_support["high"]) if active_support else prev_low
    support_strength = float(active_support.get("strength", 0.0)) if active_support else 0.0
    support_quality = _clamp(support_strength / 0.60) if active_support else 0.5
    min_actionable_support = SUPPORT_STRONG_THRESHOLD

    conf = 0.0
    pattern_conf = 0.0
    event: dict[str, Any] = {}
    desc = (
        f"近期未出现跌破支撑区间 {support_low:.2f}–{support_high:.2f} 后收回"
        if active_support else "近期未出现破位后收回形态"
    )
    if not active_support:
        desc = "未识别到稳定性 ≥60% 的强支撑，暂不展示假破位收回"
        return SignalResult(
            id="false_breakdown", name="假破位收回", category="left",
            confidence=0.0, light=_to_light(0.0, thresholds), thresholds=thresholds, weight=2,
            description=desc,
            data={
                "prev_low": prev_low,
                "conf": 0.0,
                "pattern_conf": 0.0,
                "support_quality": support_quality,
                "support_zones": support_zones,
                "display_support_zones": display_support_zones,
                "support_focus": support_focus,
                "active_support": {},
                "breakdown_event": {},
                "atr20": atr,
                "min_actionable_support": min_actionable_support,
            },
        )
    start = max(0, len(df) - 10)
    vol20 = float(np.mean(volumes[-20:])) if len(volumes) >= 20 else float(np.mean(volumes))
    for i in range(start, len(df)):
        if lows[i] >= support_low:
            continue
        for j in range(i, min(len(df), i + 4)):
            if closes[j] < support_high:
                continue
            breach_depth = support_low - lows[i]
            recover_days = j - i
            depth_score = _clamp(breach_depth / max(atr, 1.0))
            strength_score = _clamp((closes[j] - support_high) / max(atr, 1.0))
            speed_score = _clamp(1 - recover_days / 3)
            volume_score = _clamp(volumes[j] / vol20 - 0.8) if vol20 else 0.0
            pattern_conf = _clamp(
                depth_score * 0.30
                + strength_score * 0.30
                + speed_score * 0.25
                + volume_score * 0.15
            )
            conf = _clamp(pattern_conf * support_quality)
            event = {
                "break_date": str(dates[i]),
                "break_low": float(lows[i]),
                "recover_date": str(dates[j]),
                "recover_close": float(closes[j]),
                "recover_days": int(recover_days),
                "breach_depth": float(breach_depth),
            }
            desc = (
                f"跌破支撑区间 {support_low:.2f}–{support_high:.2f} 后"
                f"{recover_days}日收回，但支撑稳定性 {support_strength*100:.0f}% 偏低"
            )
            break
        if event:
            break

    return SignalResult(
        id="false_breakdown", name="假破位收回", category="left",
        confidence=conf, light=_to_light(conf, thresholds), thresholds=thresholds, weight=2,
        description=desc,
        data={
            "prev_low": prev_low,
            "conf": conf,
            "pattern_conf": pattern_conf,
            "support_quality": support_quality,
            "support_zones": support_zones,
            "display_support_zones": display_support_zones,
            "support_focus": support_focus,
            "active_support": active_support or {},
            "breakdown_event": event,
            "atr20": atr,
        },
    )


# ---------- S4: 波动收敛 ----------

def _calc_vol_contraction(df: pd.DataFrame) -> SignalResult:
    thresholds = (0.35, 0.70)
    if len(df) < 30:
        return SignalResult(
            id="vol_contraction", name="波动收敛", category="left",
            confidence=0.0, light="red", thresholds=thresholds, weight=1,
            description="数据不足", data={},
        )
    highs = df["high"].values
    lows = df["low"].values
    closes = df["close"].values
    tr = np.maximum(highs - lows, np.abs(highs - np.roll(closes, 1)))
    atr_recent = float(np.mean(tr[-5:]))
    atr_prev = float(np.mean(tr[-25:-5]))
    if atr_prev == 0:
        atr_prev = 1.0

    decline_ratio = (atr_prev - atr_recent) / atr_prev
    conf = _clamp(decline_ratio / 0.5)

    if conf >= thresholds[1]:
        desc = f"ATR 从 {atr_prev:.2f} 降至 {atr_recent:.2f}，收敛 {decline_ratio*100:.0f}%"
    elif conf >= thresholds[0]:
        desc = f"ATR 轻微下降 {decline_ratio*100:.0f}%，波动开始收敛"
    else:
        desc = f"ATR 未明显下降（{decline_ratio*100:.0f}%），波动仍大"

    return SignalResult(
        id="vol_contraction", name="波动收敛", category="left",
        confidence=conf, light=_to_light(conf, thresholds), thresholds=thresholds, weight=1,
        description=desc, data={"atr_recent": atr_recent, "atr_prev": atr_prev, "decline": decline_ratio},
    )


# ---------- S5: 筹码集中 ----------

def _calc_chip_concentration(volume_profile: list) -> SignalResult:
    thresholds = (0.35, 0.70)
    if not volume_profile:
        return SignalResult(
            id="chip_concentration", name="筹码集中", category="left",
            confidence=0.0, light="red", thresholds=thresholds, weight=1,
            description="Volume Profile 数据不可用", data={},
        )
    sorted_bins = sorted(volume_profile, key=lambda b: b.volume, reverse=True)
    top3_pct = sum(b.pct for b in sorted_bins[:3])
    conf = _clamp(top3_pct / 60.0)

    if conf >= thresholds[1]:
        desc = f"前3价位桶占总成交量 {top3_pct:.1f}%，筹码高度集中"
    elif conf >= thresholds[0]:
        desc = f"前3价位桶占 {top3_pct:.1f}%，筹码较集中"
    else:
        desc = f"前3价位桶占 {top3_pct:.1f}%，筹码分散"

    return SignalResult(
        id="chip_concentration", name="筹码集中", category="left",
        confidence=conf, light=_to_light(conf, thresholds), thresholds=thresholds, weight=1,
        description=desc, data={"top3_pct": top3_pct},
    )


# ---------- S6: 大盘环境 ----------

def _calc_market_env(index_df: pd.DataFrame | None) -> SignalResult:
    thresholds = (0.35, 0.70)
    if index_df is None or len(index_df) < 20:
        return SignalResult(
            id="market_env", name="大盘环境", category="left",
            confidence=0.5, light="yellow", thresholds=thresholds, weight=1,
            description="指数数据不可用，按中性处理", data={},
        )
    closes = index_df["close"].values
    ma20 = float(np.mean(closes[-20:]))
    current = float(closes[-1])
    atr = float(np.mean(index_df["high"].values[-14:] - index_df["low"].values[-14:]))
    if atr == 0:
        atr = 1.0

    above_ratio = (current - ma20) / atr
    ma_direction = float(np.mean(closes[-5:])) - float(np.mean(closes[-10:-5]))
    direction_score = _clamp(ma_direction / atr + 0.5)

    conf = _clamp((above_ratio * 0.6 + direction_score * 0.4))

    if conf >= thresholds[1]:
        desc = f"指数站上 MA20 ({ma20:.0f})，市场环境偏强"
    elif conf >= thresholds[0]:
        desc = f"指数接近 MA20，市场中性"
    else:
        desc = f"指数在 MA20 下方，市场环境偏弱"

    return SignalResult(
        id="market_env", name="大盘环境", category="left",
        confidence=conf, light=_to_light(conf, thresholds), thresholds=thresholds, weight=1,
        description=desc, data={"index_close": current, "ma20": ma20},
    )

# ---------- 汇总 ----------

def compute_all_signals(
    df: pd.DataFrame,
    volume_profile: list | None = None,
    index_df: pd.DataFrame | None = None,
) -> list[SignalResult]:
    """计算 6 个筑底证据信号，返回值只包含 ``category="left"``。"""
    return [
        _calc_vol_shrink(df),
        _calc_no_new_low(df),
        _calc_false_breakdown(df),
        _calc_vol_contraction(df),
        _calc_chip_concentration(volume_profile or []),
        _calc_market_env(index_df),
    ]
