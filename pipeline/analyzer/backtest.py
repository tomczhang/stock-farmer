"""历史复盘（right-signal backtest）辅助函数。

本模块只提供纯数据处理 helper：as-of 日期解析、日线截断、历史价格、
前瞻结果标签和右侧趋势序列构建。所有计算复用 `signals` / `phase` 既有
公式，不改变任何信号语义；前瞻结果标签仅作描述性证伪用途，绝不参与
as-of 当天的信号、阶段、确认度或文案计算。
"""
from __future__ import annotations

from datetime import date, datetime
import math
from typing import Any

import pandas as pd

from .phase import determine_phase
from .signals import compute_all_signals

# 计算 11 个信号所需的最小日线行数（MACD 需要 35 根）。
MIN_SIGNAL_ROWS = 35
DEFAULT_TREND_WINDOW = 60
MAX_TREND_WINDOW = 120

# 前瞻结果标签的水平线（交易日）。
_FORWARD_HORIZONS = (("d5_pct", 5), ("d10_pct", 10), ("d20_pct", 20))
_MAX_WINDOW = 20


class BacktestError(ValueError):
    """历史复盘输入错误的基类（由 API 层映射为 400）。"""


class InvalidAsOfDate(BacktestError):
    """as_of 日期格式非法。"""


class AsOfOutOfRange(BacktestError):
    """as_of 日期早于可用历史首日。"""


def parse_as_of(as_of: str) -> date:
    """解析 `YYYY-MM-DD` 形式的 as-of 日期，非法格式抛出 InvalidAsOfDate。"""
    if as_of is None:
        raise InvalidAsOfDate("as_of 不能为空")
    text = str(as_of).strip()
    try:
        return datetime.strptime(text, "%Y-%m-%d").date()
    except ValueError as exc:
        raise InvalidAsOfDate(f"as_of 日期格式应为 YYYY-MM-DD：{as_of!r}") from exc


def _date_label(value: Any) -> str:
    """把 K 线 date 列的值统一成 `YYYY-MM-DD` 字符串。"""
    text = str(value)
    # 分钟线可能带时间部分，这里只取日期。
    return text.split()[0] if text else text


def resolve_effective_date(df: pd.DataFrame, as_of: date) -> str | None:
    """返回不晚于 as_of 的最近交易日（字符串）。

    若 as_of 早于首个可用交易日，返回 None（调用方据此返回越界错误）。
    """
    if df is None or len(df) == 0 or "date" not in df.columns:
        return None
    as_of_str = as_of.strftime("%Y-%m-%d")
    labels = df["date"].map(_date_label)
    eligible = labels[labels <= as_of_str]
    if len(eligible) == 0:
        return None
    return str(eligible.iloc[-1])


def cutoff_daily(df: pd.DataFrame, effective_date: str) -> pd.DataFrame:
    """只保留 date <= effective_date 的日线行，避免未来数据泄漏。"""
    if df is None or len(df) == 0 or "date" not in df.columns:
        return df
    labels = df["date"].map(_date_label)
    return df.loc[labels <= effective_date].copy()


def historical_price_and_change(df_cut: pd.DataFrame) -> tuple[float | None, float | None]:
    """从截断后的日线计算 effective_date 收盘价及相对上一交易日的涨跌幅。"""
    if df_cut is None or len(df_cut) == 0 or "close" not in df_cut.columns:
        return None, None
    closes = df_cut["close"].astype(float).values
    price = float(closes[-1])
    if len(closes) < 2:
        return price, None
    prev = float(closes[-2])
    if prev == 0:
        return price, None
    change_pct = (price / prev - 1) * 100
    return price, change_pct


def forward_outcome_labels(
    closes: list[float],
    idx: int,
) -> dict[str, float | None] | None:
    """计算 idx 这一交易日之后的轻量前瞻结果标签。

    - d5/d10/d20_pct：后 5/10/20 个交易日涨跌幅。
    - max_gain_20d_pct / max_drawdown_20d_pct：后 20 个交易日内最高涨幅 / 最大回撤。

    某个水平的未来交易日不足时，对应字段为 None。完全没有未来数据时返回 None。
    """
    n = len(closes)
    if idx < 0 or idx >= n:
        return None
    base = float(closes[idx])
    if base == 0 or not math.isfinite(base):
        return None
    if idx + 1 >= n:
        # 没有任何未来交易日。
        return None

    labels: dict[str, float | None] = {}
    for key, horizon in _FORWARD_HORIZONS:
        target = idx + horizon
        if target < n:
            labels[key] = (float(closes[target]) / base - 1) * 100
        else:
            labels[key] = None

    window = [float(c) for c in closes[idx + 1: idx + 1 + _MAX_WINDOW]]
    if len(window) >= _MAX_WINDOW:
        max_gain = (max(window) / base - 1) * 100
        max_drawdown = (min(window) / base - 1) * 100
        labels["max_gain_20d_pct"] = max_gain
        labels["max_drawdown_20d_pct"] = max_drawdown
    else:
        labels["max_gain_20d_pct"] = None
        labels["max_drawdown_20d_pct"] = None

    return labels


def clamp_trend_window(trend_window: int | None) -> int:
    """约束 trend_window 到 [1, MAX_TREND_WINDOW]，None 时使用默认值。"""
    if trend_window is None:
        return DEFAULT_TREND_WINDOW
    try:
        value = int(trend_window)
    except (TypeError, ValueError):
        return DEFAULT_TREND_WINDOW
    if value <= 0:
        return DEFAULT_TREND_WINDOW
    return min(value, MAX_TREND_WINDOW)


def build_right_trend(
    df: pd.DataFrame,
    *,
    effective_date: str,
    window: int = DEFAULT_TREND_WINDOW,
    index_df: pd.DataFrame | None = None,
) -> dict[str, Any]:
    """构建截至 effective_date 的近 N 个交易日右侧趋势序列。

    每个趋势点都用截断到当天的日线重新计算信号，确保不含未来数据。
    成交密集区在历史循环中统一降级为空 profile（见 design D5）。
    前瞻结果标签从完整日线读取未来交易日，只作展示，不回灌当天判断。
    """
    window = clamp_trend_window(window)
    if df is None or len(df) == 0 or "date" not in df.columns:
        return {"window": window, "points": []}

    labels = df["date"].map(_date_label)
    eligible_mask = labels <= effective_date
    eligible_dates = [str(d) for d in labels[eligible_mask].tolist()]
    if not eligible_dates:
        return {"window": window, "points": []}

    point_dates = eligible_dates[-window:]
    closes_all = df["close"].astype(float).tolist()
    date_to_idx = {str(d): i for i, d in enumerate(labels.tolist())}

    raw_points: list[dict[str, Any]] = []
    for point_date in point_dates:
        cut = cutoff_daily(df, point_date)
        if len(cut) < MIN_SIGNAL_ROWS:
            continue
        index_cut = cutoff_daily(index_df, point_date) if index_df is not None else None
        signals = compute_all_signals(cut, volume_profile=[], index_df=index_cut)
        phase = determine_phase(signals, df=cut)
        right = [s for s in signals if s.category == "right"]
        right_weight = sum(s.weight for s in right)
        right_score = (
            sum(s.confidence * s.weight for s in right) / right_weight
            if right_weight else 0.0
        )
        states = {
            s.id: _right_state(s.confidence, s.thresholds) for s in right
        }
        idx = date_to_idx.get(point_date)
        forward = (
            forward_outcome_labels(closes_all, idx) if idx is not None else None
        )
        raw_points.append({
            "date": point_date,
            "close": float(cut["close"].astype(float).values[-1]),
            "score_pct": int(round(phase.strength * 100)),
            "right_score_pct": int(round(right_score * 100)),
            "phase": phase.phase,
            "right_confirmed_count": sum(1 for s in right if s.light == "green"),
            "right_total_count": len(right),
            "states": states,
            "forward_returns": forward,
        })

    _attach_normalized_close(raw_points)
    return {"window": window, "points": raw_points}


def _attach_normalized_close(points: list[dict[str, Any]]) -> None:
    """把每个点的 close 归一化为 0~100，方便与确认度同轴叠放。"""
    if not points:
        return
    closes = [p["close"] for p in points]
    lo = min(closes)
    hi = max(closes)
    span = hi - lo
    for p in points:
        if span <= 0:
            p["normalized_close_pct"] = 50
        else:
            p["normalized_close_pct"] = int(round((p["close"] - lo) / span * 100))


# resolve_right_state 与 report.resolve_right_state 同源；为避免循环依赖在此内联。
_RIGHT_TIER_BREAK = 0.55


def _right_state(confidence: float, thresholds: tuple[float, float]) -> str:
    red_max, yellow_max = thresholds
    if confidence >= yellow_max:
        return "success"
    if confidence < red_max:
        return "default"
    if confidence < _RIGHT_TIER_BREAK:
        return "warning-soft"
    return "warning"
