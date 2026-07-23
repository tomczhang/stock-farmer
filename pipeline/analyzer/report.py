"""Structured signal report payloads for the React frontend."""
from __future__ import annotations

from dataclasses import asdict
from datetime import datetime
import math
from typing import Any

import pandas as pd

from .backtest import (
    DEFAULT_TREND_WINDOW,
    AsOfOutOfRange,
    build_right_trend,
    clamp_trend_window,
    cutoff_daily,
    forward_outcome_labels,
    historical_price_and_change,
    parse_as_of,
    resolve_effective_date,
)
from .narrative import generate_narrative
from .phase import PhaseResult, determine_phase
from .signals import SignalResult, compute_all_signals


_RIGHT_TIER_BREAK = 0.55

# 分层诊断阈值（结构强度百分比）。
_DIAGNOSIS_STRONG = 60
_DIAGNOSIS_WEAK = 40

_RIGHT_STATE_LABELS: dict[str, str] = {
    "default": "未触发",
    "warning-soft": "酝酿中",
    "warning": "临界",
    "success": "已触发",
}

_LIGHT_LABELS: dict[str, str] = {
    "red": "偏弱",
    "yellow": "观察",
    "green": "确认",
}


def resolve_right_state(confidence: float, thresholds: tuple[float, float]) -> str:
    """Map right-side confidence to the 4 UI states used by the React report."""
    red_max, yellow_max = thresholds
    if confidence >= yellow_max:
        return "success"
    if confidence < red_max:
        return "default"
    if confidence < _RIGHT_TIER_BREAK:
        return "warning-soft"
    return "warning"


def build_signal_report(
    ticker: str,
    as_of: str | None = None,
    trend_window: int | None = DEFAULT_TREND_WINDOW,
) -> dict[str, Any]:
    """Run the Python analysis chain and return a JSON-serializable report.

    当 `as_of` 为 None 时保持原有「当前分析」行为；提供 `as_of` 时进入历史复盘
    模式：按有效交易日截断日线、指数和价格，禁止任何未来数据进入信号计算。
    """
    get_klines, get_quotes = _data_fns()

    df = get_klines(ticker, period="1d", count=1260)

    historical = as_of is not None
    trend_window = clamp_trend_window(trend_window)

    # ---- 解析有效分析日期并截断日线 ----
    requested_as_of: str | None = None
    if historical:
        as_of_date = parse_as_of(as_of)
        requested_as_of = as_of_date.strftime("%Y-%m-%d")
        effective_date = resolve_effective_date(df, as_of_date)
        if effective_date is None:
            raise AsOfOutOfRange(
                f"as_of={requested_as_of} 早于 {ticker} 可用历史首日"
            )
        analysis_df = cutoff_daily(df, effective_date)
    else:
        analysis_df = df
        effective_date = _last_date(df)

    try:
        quotes = get_quotes([ticker])
        quote = quotes[0] if quotes else None
    except Exception:
        quote = None

    # ---- 成交密集区：历史模式无法保证分钟截断，降级为空 profile ----
    if historical:
        volume_profiles, volume_profile_meta = {}, {}
        volume_profile = []
        volume_profile_mode = "unavailable_historical"
    else:
        try:
            volume_profiles, volume_profile_meta = _build_volume_profile_windows(ticker)
        except Exception:
            volume_profiles, volume_profile_meta = {}, {}
        volume_profile = volume_profiles.get("20d") or volume_profiles.get("3d") or []
        volume_profile_mode = "current_minute" if volume_profile else "unavailable"

    # ---- 指数环境：历史模式拉长窗口后按有效日期截断 ----
    index_df = _load_index_df(get_klines, historical=historical, effective_date=effective_date)

    signals = compute_all_signals(
        analysis_df,
        volume_profile=volume_profile,
        index_df=index_df,
    )
    phase = determine_phase(signals, df=analysis_df)

    name = quote.name if quote and quote.name else ticker
    if historical:
        price, change_pct = historical_price_and_change(analysis_df)
    else:
        price = quote.price if quote else _last_close(df)
        change_pct = quote.change_pct if quote else None
    narrative = generate_narrative(ticker, name, signals, phase)

    right_trend = build_right_trend(
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
        if index_df is not None and len(index_df) > 0
        else [],
        "volume_profile": _volume_profile_records(volume_profile),
        "volume_profiles": {
            key: _volume_profile_records(profile)
            for key, profile in volume_profiles.items()
            if profile
        },
        "volume_profile_meta": volume_profile_meta,
    }

    return make_report_payload(
        ticker=ticker,
        name=name,
        price=price,
        change_pct=change_pct,
        signals=signals,
        phase=phase,
        narrative=narrative,
        chart_data=chart_data,
        report_context=report_context,
        right_trend=right_trend,
    )


def _data_fns():
    """返回 (get_klines, get_quotes)，兼容包内（pipeline.data）与测试根（data）两种导入。"""
    try:
        from pipeline.data import get_klines, get_quotes
    except ModuleNotFoundError:
        from data import get_klines, get_quotes
    return get_klines, get_quotes


def _load_index_df(get_klines, *, historical: bool, effective_date: str | None):
    """加载指数日线；历史模式拉长窗口并按有效日期截断，避免未来数据。"""
    try:
        if historical:
            index_df = get_klines("SPY", period="1d", count=1260)
            if effective_date is not None and index_df is not None:
                index_df = cutoff_daily(index_df, effective_date)
            return index_df
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
    """构建历史复盘 metadata，并在历史模式下附带 effective_date 的前瞻结果标签。"""
    forward_outcomes = None
    if used_historical_cutoff and effective_date is not None and df is not None and len(df):
        labels_list = [str(v).split()[0] if str(v) else str(v) for v in df["date"].tolist()]
        if effective_date in labels_list:
            pos = len(labels_list) - 1 - labels_list[::-1].index(effective_date)
            closes = df["close"].astype(float).tolist()
            forward_outcomes = forward_outcome_labels(closes, pos)

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
        "rules_version": "1",
    }


def build_demo_signal_report(ticker: str = "DEMO") -> dict[str, Any]:
    """Create a deterministic demo payload for local UI development."""
    df = _demo_klines()
    signals = [
        SignalResult(
            id="vol_shrink",
            name="缩量下跌",
            category="left",
            confidence=0.66,
            light="yellow",
            thresholds=(0.35, 0.70),
            weight=1,
            description="近10日下跌时量能明显低于20日均量，抛压开始减轻。",
            data={"scores": {"阶段缩量": 0.72, "量价背离": 0.45}},
        ),
        SignalResult(
            id="no_new_low",
            name="跌不动",
            category="left",
            confidence=0.74,
            light="green",
            thresholds=(0.35, 0.70),
            weight=1,
            description="价格多次回踩但没有有效跌破前低，卖方动能减弱。",
            data={"recent_low": 91.2, "prev_low": 90.8},
        ),
        SignalResult(
            id="false_breakdown",
            name="假破位收回",
            category="left",
            confidence=0.58,
            light="yellow",
            thresholds=(0.30, 0.60),
            weight=2,
            description="盘中跌破关键低点后收回，仍需后续阳线确认。",
            data={},
        ),
        SignalResult(
            id="vol_contraction",
            name="波动收敛",
            category="left",
            confidence=0.62,
            light="yellow",
            thresholds=(0.35, 0.70),
            weight=1,
            description="ATR 收敛至阶段低位，筹码换手趋于安静。",
            data={},
        ),
        SignalResult(
            id="chip_concentration",
            name="筹码集中",
            category="left",
            confidence=0.44,
            light="yellow",
            thresholds=(0.35, 0.70),
            weight=1,
            description="成交密集区靠近现价，但集中度尚未形成强支撑。",
            data={},
        ),
        SignalResult(
            id="market_env",
            name="大盘环境",
            category="left",
            confidence=0.78,
            light="green",
            thresholds=(0.35, 0.70),
            weight=1,
            description="指数站上短期均线，外部环境对反弹较友好。",
            data={},
        ),
        SignalResult(
            id="above_ma",
            name="站回均线",
            category="right",
            confidence=0.82,
            light="green",
            thresholds=(0.35, 0.70),
            weight=2,
            description="收盘站上 MA20，短期均线重新转强。",
            data={"ma20": 97.4},
        ),
        SignalResult(
            id="support_retest_hold",
            name="回踩不破",
            category="right",
            confidence=0.76,
            light="green",
            thresholds=(0.35, 0.70),
            weight=2,
            description="收回支撑后再次回踩，低点与收盘均守住支撑区间。",
            data={
                "active_support": {"low": 94.2, "high": 96.8, "strength": 0.72},
                "breakdown_event": {"break_date": "2026-04-08", "recover_date": "2026-04-10"},
                "retest_event": {"date": "2026-04-15", "low": 95.1, "close": 97.3},
            },
        ),
        SignalResult(
            id="volume_breakout",
            name="放量反包",
            category="right",
            confidence=0.61,
            light="yellow",
            thresholds=(0.35, 0.70),
            weight=2,
            description="出现放量阳线，但量能持续性仍需观察。",
            data={},
        ),
        SignalResult(
            id="macd_cross",
            name="MACD 金叉",
            category="right",
            confidence=0.47,
            light="yellow",
            thresholds=(0.35, 0.70),
            weight=1,
            description="DIF 接近 DEA，动能进入酝酿区。",
            data={},
        ),
        SignalResult(
            id="higher_low",
            name="低点抬升",
            category="right",
            confidence=0.24,
            light="red",
            thresholds=(0.35, 0.70),
            weight=1,
            description="最近低点尚未明显高于前低，结构确认不足。",
            data={},
        ),
    ]
    phase = determine_phase(signals, df=df)
    name = "右侧趋势演示"
    narrative = generate_narrative(ticker, name, signals, phase)
    effective_date = _last_date(df)
    right_trend = build_right_trend(df, effective_date=effective_date, window=DEFAULT_TREND_WINDOW)
    report_context = build_report_context(
        df,
        mode="current",
        requested_as_of=None,
        effective_date=effective_date,
        trend_window=DEFAULT_TREND_WINDOW,
        used_historical_cutoff=False,
        volume_profile_mode="demo",
    )
    return make_report_payload(
        ticker=ticker,
        name=name,
        price=float(df["close"].iloc[-1]),
        change_pct=1.86,
        signals=signals,
        phase=phase,
        narrative=narrative,
        chart_data={"klines": _records(df), "index_klines": [], "volume_profile": []},
        report_context=report_context,
        right_trend=right_trend,
    )


def make_report_payload(
    *,
    ticker: str,
    name: str,
    price: float | None,
    change_pct: float | None,
    signals: list[SignalResult],
    phase: PhaseResult,
    narrative: str,
    chart_data: dict[str, Any],
    report_context: dict[str, Any] | None = None,
    right_trend: dict[str, Any] | None = None,
) -> dict[str, Any]:
    left = [s for s in signals if s.category == "left"]
    right = [s for s in signals if s.category == "right"]

    left_summary = _group_summary(
        "left", "左侧信号", left,
        role_label="左侧准备度",
        role_desc="底部结构、抛压缓和、波动收敛等准备条件。",
    )
    right_summary = _group_summary(
        "right", "右侧信号", right,
        role_label="右侧触发度",
        role_desc="站均线、放量、回踩不破、动量与低点抬升等启动条件。",
    )
    total_weight = left_summary["weight"] + right_summary["weight"]

    return {
        "ticker": ticker.upper(),
        "name": name,
        "price": _finite_or_none(price),
        "change_pct": _finite_or_none(change_pct),
        "analyzed_at": datetime.now().isoformat(timespec="seconds"),
        "conclusion": asdict(phase),
        "confirmation": {
            "score": phase.strength,
            "score_pct": phase.strength_pct,
            "total_weight": total_weight,
            "formula": "右侧趋势确认度 = 左侧信号加权分 + 右侧信号加权分",
            "left": left_summary,
            "right": right_summary,
            "score_label": "结构强度",
            "score_caption": "总分代表当前结构 / 趋势确认强度，不代表准确率、胜率或上涨概率。",
            "diagnosis": _build_diagnosis(left_summary["score_pct"], right_summary["score_pct"]),
        },
        "signals": [_signal_payload(s) for s in signals],
        "groups": {
            "left": [_signal_payload(s) for s in left],
            "right": [_signal_payload(s) for s in right],
        },
        "narrative": narrative,
        "chart_data": chart_data,
        "report_context": report_context or _current_report_context(),
        "right_trend": right_trend or {"window": DEFAULT_TREND_WINDOW, "points": []},
        "disclaimer": "仅供研究复盘，不构成投资建议。",
    }


def _current_report_context() -> dict[str, Any]:
    """无历史上下文时（如 demo）的默认 current 元数据。"""
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
        "rules_version": "1",
    }


def _build_diagnosis(left_pct: int, right_pct: int) -> str:
    """根据左侧准备度与右侧触发度给出分层诊断，避免总分被读成上涨概率。"""
    strong, weak = _DIAGNOSIS_STRONG, _DIAGNOSIS_WEAK
    if left_pct >= strong and right_pct < weak:
        return "左侧准备充分，但右侧触发不足，结构已就位、确认未完成，继续观察右侧触发位。"
    if right_pct >= strong and left_pct < weak:
        return "右侧强触发，但左侧筑底不足，属于强启动待回踩确认，需后续走势跟进确认。"
    if left_pct >= strong and right_pct >= strong:
        return "左侧准备度与右侧触发度同时较强，趋势结构较完整。"
    if left_pct >= strong:
        return "左侧准备度较强，右侧触发度中等，关注右侧触发是否进一步走强。"
    if right_pct >= strong:
        return "右侧触发度较强，左侧准备度中等，关注底部结构是否补强。"
    return "左右两侧均处于偏弱区间，结构强度有限，继续等待更多信号。"


def _group_summary(
    key: str,
    label: str,
    signals: list[SignalResult],
    *,
    role_label: str = "",
    role_desc: str = "",
) -> dict[str, Any]:
    weight = sum(s.weight for s in signals)
    weighted_score = (
        sum(s.confidence * s.weight for s in signals) / weight if weight else 0.0
    )
    return {
        "key": key,
        "label": label,
        "score": weighted_score,
        "score_pct": int(round(weighted_score * 100)),
        "weight": weight,
        "confirmed_count": sum(1 for s in signals if s.light == "green"),
        "total_count": len(signals),
        "role_label": role_label,
        "role_desc": role_desc,
    }


def _signal_payload(signal: SignalResult) -> dict[str, Any]:
    payload = asdict(signal)
    payload["confidence_pct"] = int(round(signal.confidence * 100))
    payload["weight_label"] = f"{signal.weight}x"
    payload["light_label"] = _LIGHT_LABELS.get(signal.light, signal.light)
    if signal.category == "right":
        state = resolve_right_state(signal.confidence, signal.thresholds)
        payload["right_state"] = {
            "key": state,
            "label": _RIGHT_STATE_LABELS[state],
        }
    else:
        payload["right_state"] = None
    return payload


def _records(df: pd.DataFrame) -> list[dict[str, Any]]:
    records = df.to_dict("records")
    return [_json_safe_record(record) for record in records]


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
    """一次拉取最长分钟 K，再按交易日切分成多个成交密集区窗口。"""
    from pipeline.data import get_klines
    from pipeline.data.indicators import build_volume_profile

    bars_per_day = 78
    max_days = max(days_list)
    df = get_klines(ticker, period="5m", count=max_days * bars_per_day)
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
        v = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(v):
        return None
    return v


def _last_close(df: pd.DataFrame) -> float | None:
    if len(df) == 0 or "close" not in df:
        return None
    return _finite_or_none(df["close"].iloc[-1])


def _last_date(df: pd.DataFrame | None) -> str | None:
    if df is None or len(df) == 0 or "date" not in df:
        return None
    return str(df["date"].iloc[-1]).split()[0]


def _first_date(df: pd.DataFrame | None) -> str | None:
    if df is None or len(df) == 0 or "date" not in df:
        return None
    return str(df["date"].iloc[0]).split()[0]


def _demo_klines() -> pd.DataFrame:
    rows: list[dict[str, Any]] = []
    base = 92.0
    for i, day in enumerate(pd.date_range("2026-01-19", periods=86, freq="B")):
        drift = i * 0.11
        wave = math.sin(i / 4.2) * 2.2
        close = base + drift + wave
        if i > 58:
            close += (i - 58) * 0.18
        open_ = close - math.sin(i / 3.3) * 0.8
        high = max(open_, close) + 0.9 + abs(math.sin(i / 5)) * 0.7
        low = min(open_, close) - 0.8 - abs(math.cos(i / 6)) * 0.6
        volume = int(4_600_000 + (math.sin(i / 5) + 1) * 900_000)
        if i in (61, 68, 75):
            volume = int(volume * 1.8)
        rows.append(
            {
                "date": day.strftime("%Y-%m-%d"),
                "open": round(open_, 2),
                "high": round(high, 2),
                "low": round(low, 2),
                "close": round(close, 2),
                "volume": volume,
            }
        )
    return pd.DataFrame(rows)
