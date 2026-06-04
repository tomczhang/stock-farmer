"""Structured signal report payloads for the React frontend."""
from __future__ import annotations

from dataclasses import asdict
from datetime import datetime
import math
from typing import Any

import pandas as pd

from .narrative import generate_narrative
from .phase import PhaseResult, determine_phase
from .signals import SignalResult, compute_all_signals


_RIGHT_TIER_BREAK = 0.55

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


def build_signal_report(ticker: str) -> dict[str, Any]:
    """Run the Python analysis chain and return a JSON-serializable report."""
    from pipeline.data import get_klines, get_quotes, get_volume_profile

    df = get_klines(ticker, period="1d", count=120)

    try:
        quotes = get_quotes([ticker])
        quote = quotes[0] if quotes else None
    except Exception:
        quote = None

    try:
        volume_profile = get_volume_profile(ticker, days=3, num_bins=30)
    except Exception:
        volume_profile = []

    try:
        index_df = get_klines("SPY", period="1d", count=30)
    except Exception:
        index_df = None

    signals = compute_all_signals(
        df,
        volume_profile=volume_profile,
        index_df=index_df,
    )
    phase = determine_phase(signals)

    name = quote.name if quote and quote.name else ticker
    price = quote.price if quote else _last_close(df)
    change_pct = quote.change_pct if quote else None
    narrative = generate_narrative(ticker, name, signals, phase)

    chart_data = {
        "klines": _records(df),
        "index_klines": _records(index_df[["date", "close"]])
        if index_df is not None and len(index_df) > 0
        else [],
        "volume_profile": [
            {"price_level": b.price_level, "volume": b.volume, "pct": b.pct}
            for b in volume_profile
        ]
        if volume_profile
        else [],
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
    )


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
            description="收盘站上 MA20 且回踩未破，是当前最强右侧确认。",
            data={"ma20": 97.4},
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
    phase = determine_phase(signals)
    name = "右侧趋势演示"
    narrative = generate_narrative(ticker, name, signals, phase)
    return make_report_payload(
        ticker=ticker,
        name=name,
        price=float(df["close"].iloc[-1]),
        change_pct=1.86,
        signals=signals,
        phase=phase,
        narrative=narrative,
        chart_data={"klines": _records(df), "index_klines": [], "volume_profile": []},
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
) -> dict[str, Any]:
    left = [s for s in signals if s.category == "left"]
    right = [s for s in signals if s.category == "right"]

    left_summary = _group_summary("left", "左侧信号", left)
    right_summary = _group_summary("right", "右侧信号", right)
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
        },
        "signals": [_signal_payload(s) for s in signals],
        "groups": {
            "left": [_signal_payload(s) for s in left],
            "right": [_signal_payload(s) for s in right],
        },
        "narrative": narrative,
        "chart_data": chart_data,
        "disclaimer": "仅供研究复盘，不构成投资建议。",
    }


def _group_summary(key: str, label: str, signals: list[SignalResult]) -> dict[str, Any]:
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
