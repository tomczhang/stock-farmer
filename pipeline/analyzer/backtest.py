"""筑底历史复盘辅助函数。

提供 as-of 日期解析、日线截断、历史价格、前瞻结果标签和筑底历史序列。
前瞻标签仅作描述性证伪，绝不参与当日筑底结论、文案或交易推演。
"""
from __future__ import annotations

from datetime import date, datetime
import math
from typing import Any

import pandas as pd

from .bottoming import compute_bottoming
from .signals import compute_all_signals

MIN_SIGNAL_ROWS = 35
DEFAULT_TREND_WINDOW = 60
MAX_TREND_WINDOW = 120
_FORWARD_HORIZONS = (("d5_pct", 5), ("d10_pct", 10), ("d20_pct", 20))
_MAX_WINDOW = 20


class BacktestError(ValueError):
    """历史复盘输入错误的基类（由 API 层映射为 400）。"""


class InvalidAsOfDate(BacktestError):
    """as_of 日期格式非法。"""


class AsOfOutOfRange(BacktestError):
    """as_of 日期早于可用历史首日。"""


def parse_as_of(as_of: str) -> date:
    if as_of is None:
        raise InvalidAsOfDate("as_of 不能为空")
    text = str(as_of).strip()
    try:
        return datetime.strptime(text, "%Y-%m-%d").date()
    except ValueError as exc:
        raise InvalidAsOfDate(f"as_of 日期格式应为 YYYY-MM-DD：{as_of!r}") from exc


def _date_label(value: Any) -> str:
    text = str(value)
    return text.split()[0] if text else text


def resolve_effective_date(df: pd.DataFrame, as_of: date) -> str | None:
    if df is None or len(df) == 0 or "date" not in df.columns:
        return None
    as_of_str = as_of.strftime("%Y-%m-%d")
    labels = df["date"].map(_date_label)
    eligible = labels[labels <= as_of_str]
    return None if len(eligible) == 0 else str(eligible.iloc[-1])


def cutoff_daily(df: pd.DataFrame, effective_date: str) -> pd.DataFrame:
    if df is None or len(df) == 0 or "date" not in df.columns:
        return df
    labels = df["date"].map(_date_label)
    return df.loc[labels <= effective_date].copy()


def historical_price_and_change(df_cut: pd.DataFrame) -> tuple[float | None, float | None]:
    if df_cut is None or len(df_cut) == 0 or "close" not in df_cut.columns:
        return None, None
    closes = df_cut["close"].astype(float).values
    price = float(closes[-1])
    if len(closes) < 2 or float(closes[-2]) == 0:
        return price, None
    return price, (price / float(closes[-2]) - 1) * 100


def forward_outcome_labels(closes: list[float], idx: int) -> dict[str, float | None] | None:
    n = len(closes)
    if idx < 0 or idx >= n:
        return None
    base = float(closes[idx])
    if base == 0 or not math.isfinite(base) or idx + 1 >= n:
        return None

    labels: dict[str, float | None] = {}
    for key, horizon in _FORWARD_HORIZONS:
        target = idx + horizon
        labels[key] = (float(closes[target]) / base - 1) * 100 if target < n else None

    window = [float(c) for c in closes[idx + 1:idx + 1 + _MAX_WINDOW]]
    if len(window) >= _MAX_WINDOW:
        labels["max_gain_20d_pct"] = (max(window) / base - 1) * 100
        labels["max_drawdown_20d_pct"] = (min(window) / base - 1) * 100
    else:
        labels["max_gain_20d_pct"] = None
        labels["max_drawdown_20d_pct"] = None
    return labels


def clamp_trend_window(trend_window: int | None) -> int:
    if trend_window is None:
        return DEFAULT_TREND_WINDOW
    try:
        value = int(trend_window)
    except (TypeError, ValueError):
        return DEFAULT_TREND_WINDOW
    if value <= 0:
        return DEFAULT_TREND_WINDOW
    return min(value, MAX_TREND_WINDOW)


def build_bottoming_history(
    df: pd.DataFrame,
    *,
    effective_date: str,
    window: int = DEFAULT_TREND_WINDOW,
    index_df: pd.DataFrame | None = None,
) -> dict[str, Any]:
    """构建逐日截断的筑底历史序列。"""
    window = clamp_trend_window(window)
    if df is None or len(df) == 0 or "date" not in df.columns:
        return {"window": window, "points": []}

    labels = df["date"].map(_date_label)
    eligible_dates = [str(d) for d in labels[labels <= effective_date].tolist()]
    if not eligible_dates:
        return {"window": window, "points": []}

    point_dates = eligible_dates[-window:]
    closes_all = df["close"].astype(float).tolist()
    date_to_idx = {str(d): i for i, d in enumerate(labels.tolist())}
    points: list[dict[str, Any]] = []

    for point_date in point_dates:
        cut = cutoff_daily(df, point_date)
        if len(cut) < MIN_SIGNAL_ROWS:
            continue
        index_cut = cutoff_daily(index_df, point_date) if index_df is not None else None
        signals = compute_all_signals(cut, volume_profile=[], index_df=index_cut)
        verdict = compute_bottoming(cut, signals=signals)
        idx = date_to_idx.get(point_date)
        points.append({
            "date": point_date,
            "close": float(cut["close"].astype(float).values[-1]),
            "tier": verdict.tier,
            "tier_label": verdict.tier_label,
            "cleanliness_pct": verdict.cleanliness_pct,
            "sign_states": {s.id: s.state for s in verdict.signs},
            "sign_scores_pct": {s.id: int(round(s.score * 100)) for s in verdict.signs},
            "forward_returns": forward_outcome_labels(closes_all, idx) if idx is not None else None,
        })

    _attach_normalized_close(points)
    return {"window": window, "points": points}


def _attach_normalized_close(points: list[dict[str, Any]]) -> None:
    if not points:
        return
    closes = [p["close"] for p in points]
    lo, hi = min(closes), max(closes)
    span = hi - lo
    for point in points:
        point["normalized_close_pct"] = (
            50 if span <= 0 else int(round((point["close"] - lo) / span * 100))
        )
