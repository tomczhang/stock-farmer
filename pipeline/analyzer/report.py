"""筑底结构报告 payload，供 React 与本地 API 使用。"""
from __future__ import annotations

from dataclasses import asdict
from datetime import datetime
import math
from typing import Any

import pandas as pd

from .backtest import (
    DEFAULT_TREND_WINDOW,
    AsOfOutOfRange,
    build_bottoming_history,
    clamp_trend_window,
    cutoff_daily,
    forward_outcome_labels,
    historical_price_and_change,
    parse_as_of,
    resolve_effective_date,
)
from .bottoming import BottomingVerdict, _make_sign, compute_bottoming
from .narrative import generate_narrative
from .signals import SignalResult, compute_all_signals

_LIGHT_LABELS = {"red": "偏弱", "yellow": "观察", "green": "确认"}


def build_signal_report(
    ticker: str,
    as_of: str | None = None,
    trend_window: int | None = DEFAULT_TREND_WINDOW,
) -> dict[str, Any]:
    """构建当前或严格 as-of 的筑底结构报告。"""
    get_klines, get_quotes = _data_fns()
    df = get_klines(ticker, period="1d", count=1260)
    historical = as_of is not None
    trend_window = clamp_trend_window(trend_window)

    requested_as_of: str | None = None
    if historical:
        as_of_date = parse_as_of(as_of)
        requested_as_of = as_of_date.strftime("%Y-%m-%d")
        effective_date = resolve_effective_date(df, as_of_date)
        if effective_date is None:
            raise AsOfOutOfRange(f"as_of={requested_as_of} 早于 {ticker} 可用历史首日")
        analysis_df = cutoff_daily(df, effective_date)
    else:
        analysis_df = df
        effective_date = _last_date(df)

    try:
        quotes = get_quotes([ticker])
        quote = quotes[0] if quotes else None
    except Exception:
        quote = None

    if historical:
        volume_profiles, volume_profile_meta, volume_profile = {}, {}, []
        volume_profile_mode = "unavailable_historical"
    else:
        try:
            volume_profiles, volume_profile_meta = _build_volume_profile_windows(ticker)
        except Exception:
            volume_profiles, volume_profile_meta = {}, {}
        volume_profile = volume_profiles.get("20d") or volume_profiles.get("3d") or []
        volume_profile_mode = "current_minute" if volume_profile else "unavailable"

    index_df = _load_index_df(get_klines, historical=historical, effective_date=effective_date)
    signals = compute_all_signals(analysis_df, volume_profile=volume_profile, index_df=index_df)
    bottoming = compute_bottoming(analysis_df, signals=signals)

    name = quote.name if quote and quote.name else ticker
    if historical:
        price, change_pct = historical_price_and_change(analysis_df)
    else:
        price = quote.price if quote else _last_close(df)
        change_pct = quote.change_pct if quote else None

    narrative = generate_narrative(ticker, name, signals, bottoming)
    bottoming_history = build_bottoming_history(
        df,
        effective_date=effective_date,
        window=trend_window,
        index_df=index_df,
    )
    report_context = build_report_context(
        df,
        mode="historical" if historical else "current",
        requested_as_of=requested_as_of,
        effective_date=effective_date,
        trend_window=trend_window,
        used_historical_cutoff=historical,
        volume_profile_mode=volume_profile_mode,
    )
    chart_data = {
        "klines": _records(analysis_df),
        "index_klines": _records(index_df[["date", "close"]])
        if index_df is not None and len(index_df) > 0 else [],
        "volume_profile": _volume_profile_records(volume_profile),
        "volume_profiles": {
            key: _volume_profile_records(profile)
            for key, profile in volume_profiles.items() if profile
        },
        "volume_profile_meta": volume_profile_meta,
    }
    return make_report_payload(
        ticker=ticker,
        name=name,
        price=price,
        change_pct=change_pct,
        signals=signals,
        bottoming=bottoming,
        narrative=narrative,
        chart_data=chart_data,
        report_context=report_context,
        bottoming_history=bottoming_history,
    )


def _data_fns():
    try:
        from pipeline.data import get_klines, get_quotes
    except ModuleNotFoundError:
        from data import get_klines, get_quotes
    return get_klines, get_quotes


def _load_index_df(get_klines, *, historical: bool, effective_date: str | None):
    try:
        if historical:
            index_df = get_klines("SPY", period="1d", count=1260)
            return cutoff_daily(index_df, effective_date) if effective_date else index_df
        return get_klines("SPY", period="1d", count=30)
    except Exception:
        return None


def build_report_context(
    df: pd.DataFrame,
    *,
    mode: str,
    requested_as_of: str | None,
    effective_date: str | None,
    trend_window: int,
    used_historical_cutoff: bool,
    volume_profile_mode: str,
) -> dict[str, Any]:
    forward_outcomes = None
    if used_historical_cutoff and effective_date is not None and df is not None and len(df):
        labels = [str(v).split()[0] for v in df["date"].tolist()]
        if effective_date in labels:
            pos = len(labels) - 1 - labels[::-1].index(effective_date)
            forward_outcomes = forward_outcome_labels(df["close"].astype(float).tolist(), pos)
    return {
        "mode": mode,
        "requested_as_of": requested_as_of,
        "effective_date": effective_date,
        "data_start_date": _first_date(df),
        "data_end_date": _last_date(df),
        "trend_window": trend_window,
        "used_historical_cutoff": used_historical_cutoff,
        "volume_profile_mode": volume_profile_mode,
        "forward_outcomes": forward_outcomes,
        "rules_version": "2",
    }


def build_demo_signal_report(ticker: str = "DEMO") -> dict[str, Any]:
    df = _demo_klines()
    signals = [
        SignalResult("vol_shrink", "缩量下跌", "left", 0.72, "green", (0.35, 0.70), 1,
                     "下跌量能持续收缩，抛压明显减轻。", {"scores": {"single": 0.7, "stage": 0.75}}),
        SignalResult("no_new_low", "跌不动", "left", 0.74, "green", (0.35, 0.70), 1,
                     "多次回踩但未有效跌破前低。", {"recent_low": 91.2, "prev_low": 90.8}),
        SignalResult("false_breakdown", "假破位收回", "left", 0.58, "yellow", (0.30, 0.60), 2,
                     "跌破支撑后较快收回。", {}),
        SignalResult("vol_contraction", "波动收敛", "left", 0.62, "yellow", (0.35, 0.70), 1,
                     "ATR 收敛至阶段低位。", {}),
        SignalResult("chip_concentration", "筹码集中", "left", 0.44, "yellow", (0.35, 0.70), 1,
                     "成交密集区靠近现价。", {}),
        SignalResult("market_env", "大盘环境", "left", 0.78, "green", (0.35, 0.70), 1,
                     "指数环境偏强。", {}),
    ]
    bottoming = _demo_bottoming_verdict()
    name = "筑底结构演示"
    effective_date = _last_date(df)
    return make_report_payload(
        ticker=ticker,
        name=name,
        price=float(df["close"].iloc[-1]),
        change_pct=1.86,
        signals=signals,
        bottoming=bottoming,
        narrative=generate_narrative(ticker, name, signals, bottoming),
        chart_data={"klines": _records(df), "index_klines": [], "volume_profile": []},
        report_context=build_report_context(
            df,
            mode="current",
            requested_as_of=None,
            effective_date=effective_date,
            trend_window=DEFAULT_TREND_WINDOW,
            used_historical_cutoff=False,
            volume_profile_mode="demo",
        ),
        bottoming_history=build_bottoming_history(
            df, effective_date=effective_date, window=DEFAULT_TREND_WINDOW
        ),
    )


def _demo_bottoming_verdict() -> BottomingVerdict:
    from .bottoming import _TIER_META, compute_cleanliness
    signs = [
        _make_sign("vol_dry_up", "缩量下跌", "跌的时候没人卖了", 0.72,
                   "下跌时明显缩量，抛压减轻。", []),
        _make_sign("false_break_recover", "假破位收回", "想跌却跌不动", 0.58,
                   "跌破支撑后两日内收回。", []),
        _make_sign("chip_stability", "筹码稳定", "洗盘洗干净了", 0.75,
                   "筹码峰没有下移，量能处于自身低位。", []),
    ]
    cleanliness = compute_cleanliness(signs)
    meta = _TIER_META["base_forming"]
    return BottomingVerdict(
        tier="base_forming",
        tier_label=meta["label"],
        icon=meta["icon"],
        action=meta["action"],
        next_observation="观察支撑区是否继续守住，以及三项筑底迹象能否维持",
        cleanliness=cleanliness,
        cleanliness_pct=int(round(cleanliness * 100)),
        signs=signs,
        regime="range",
    )


def make_report_payload(
    *,
    ticker: str,
    name: str,
    price: float | None,
    change_pct: float | None,
    signals: list[SignalResult],
    bottoming: BottomingVerdict,
    narrative: str,
    chart_data: dict[str, Any],
    report_context: dict[str, Any] | None = None,
    bottoming_history: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": 2,
        "ticker": ticker.upper(),
        "name": name,
        "price": _finite_or_none(price),
        "change_pct": _finite_or_none(change_pct),
        "analyzed_at": datetime.now().isoformat(timespec="seconds"),
        "conclusion": {
            "tier": bottoming.tier,
            "tier_label": bottoming.tier_label,
            "icon": bottoming.icon,
            "action": bottoming.action,
            "next_observation": bottoming.next_observation,
            "structure_strength": bottoming.cleanliness,
            "structure_strength_pct": bottoming.cleanliness_pct,
            "regime": bottoming.regime,
        },
        "bottoming": _bottoming_payload(bottoming),
        "signals": [_signal_payload(signal) for signal in signals],
        "narrative": narrative,
        "chart_data": chart_data,
        "report_context": report_context or _current_report_context(),
        "bottoming_history": bottoming_history or {"window": DEFAULT_TREND_WINDOW, "points": []},
        "disclaimer": "仅供研究复盘，不构成投资建议。",
    }


def _bottoming_payload(verdict: BottomingVerdict) -> dict[str, Any]:
    signs = []
    for sign in verdict.signs:
        payload = asdict(sign)
        payload["score_pct"] = int(round(sign.score * 100))
        signs.append(payload)
    return {
        "tier": verdict.tier,
        "tier_label": verdict.tier_label,
        "icon": verdict.icon,
        "action": verdict.action,
        "next_observation": verdict.next_observation,
        "cleanliness": verdict.cleanliness,
        "cleanliness_pct": verdict.cleanliness_pct,
        "cleanliness_label": "筑底结构强度",
        "cleanliness_caption": "结构强度不代表准确率、胜率、买点或上涨概率。",
        "regime": verdict.regime,
        "signs": signs,
    }


def _signal_payload(signal: SignalResult) -> dict[str, Any]:
    payload = asdict(signal)
    payload["confidence_pct"] = int(round(signal.confidence * 100))
    payload["weight_label"] = f"{signal.weight}x"
    payload["light_label"] = _LIGHT_LABELS.get(signal.light, signal.light)
    return payload


def _current_report_context() -> dict[str, Any]:
    return {
        "mode": "current",
        "requested_as_of": None,
        "effective_date": None,
        "data_start_date": None,
        "data_end_date": None,
        "trend_window": DEFAULT_TREND_WINDOW,
        "used_historical_cutoff": False,
        "volume_profile_mode": "unavailable",
        "forward_outcomes": None,
        "rules_version": "2",
    }


def _records(df: pd.DataFrame) -> list[dict[str, Any]]:
    return [_json_safe_record(record) for record in df.to_dict("records")]


def _volume_profile_records(profile: list) -> list[dict[str, Any]]:
    return [
        {"price_level": b.price_level, "volume": b.volume, "pct": b.pct}
        for b in profile
    ] if profile else []


def _build_volume_profile_windows(
    ticker: str,
    days_list: tuple[int, ...] = (3, 20, 60),
    num_bins: int = 30,
) -> tuple[dict[str, list], dict[str, dict[str, Any]]]:
    try:
        from pipeline.data import get_klines
        from pipeline.data.indicators import build_volume_profile
    except ModuleNotFoundError:
        from data import get_klines
        from data.indicators import build_volume_profile

    df = get_klines(ticker, period="5m", count=max(days_list) * 78)
    if len(df) == 0 or "date" not in df.columns:
        return {}, {}
    date_labels = df["date"].astype(str).str.split().str[0]
    unique_dates = list(dict.fromkeys(date_labels.tolist()))
    profiles: dict[str, list] = {}
    meta: dict[str, dict[str, Any]] = {}
    for days in days_list:
        selected_dates = unique_dates[-days:]
        if not selected_dates:
            continue
        window_df = df.loc[date_labels.isin(selected_dates)].copy()
        profile = build_volume_profile(window_df, num_bins=num_bins)
        if not profile:
            continue
        key = f"{days}d"
        profiles[key] = profile
        meta[key] = {
            "requested_days": days,
            "actual_days": len(selected_dates),
            "rows": int(len(window_df)),
            "start_date": selected_dates[0],
            "end_date": selected_dates[-1],
        }
    return profiles, meta


def _json_safe_record(record: dict[str, Any]) -> dict[str, Any]:
    return {str(key): _json_safe_value(value) for key, value in record.items()}


def _json_safe_value(value: Any) -> Any:
    if hasattr(value, "isoformat"):
        return value.isoformat()
    if isinstance(value, float):
        return _finite_or_none(value)
    if isinstance(value, dict):
        return _json_safe_record(value)
    if isinstance(value, list):
        return [_json_safe_value(v) for v in value]
    return value


def _finite_or_none(value: float | None) -> float | None:
    if value is None:
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _last_close(df: pd.DataFrame) -> float | None:
    return None if len(df) == 0 or "close" not in df else _finite_or_none(df["close"].iloc[-1])


def _last_date(df: pd.DataFrame | None) -> str | None:
    return None if df is None or len(df) == 0 or "date" not in df else str(df["date"].iloc[-1]).split()[0]


def _first_date(df: pd.DataFrame | None) -> str | None:
    return None if df is None or len(df) == 0 or "date" not in df else str(df["date"].iloc[0]).split()[0]


def _demo_klines() -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    base = 92.0
    for i, day in enumerate(pd.date_range("2026-01-19", periods=86, freq="B")):
        close = base + i * 0.11 + math.sin(i / 4.2) * 2.2
        if i > 58:
            close += (i - 58) * 0.18
        open_ = close - math.sin(i / 3.3) * 0.8
        rows.append({
            "date": day.strftime("%Y-%m-%d"),
            "open": round(open_, 2),
            "high": round(max(open_, close) + 1.1, 2),
            "low": round(min(open_, close) - 1.0, 2),
            "close": round(close, 2),
            "volume": int(4_600_000 + (math.sin(i / 5) + 1) * 900_000),
        })
    return pd.DataFrame(rows)
