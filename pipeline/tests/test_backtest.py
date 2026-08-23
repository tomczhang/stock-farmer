"""筑底历史复盘与新版报告契约测试。"""
from __future__ import annotations

from datetime import date
from types import SimpleNamespace

import numpy as np
import pandas as pd
import pytest

from analyzer.backtest import (
    AsOfOutOfRange,
    InvalidAsOfDate,
    build_bottoming_history,
    cutoff_daily,
    forward_outcome_labels,
    historical_price_and_change,
    parse_as_of,
    resolve_effective_date,
)
from analyzer.report import build_demo_signal_report, build_signal_report
import analyzer.report as report_module


def _df(n: int = 120) -> pd.DataFrame:
    x = np.arange(n, dtype=float)
    close = 100 - x * 0.08 + np.sin(x / 5) * 2
    return pd.DataFrame({
        "date": pd.date_range("2025-01-02", periods=n, freq="B").strftime("%Y-%m-%d"),
        "open": close - 0.3,
        "high": close + 1,
        "low": close - 1,
        "close": close,
        "volume": (5_000_000 - x * 8_000).astype(int),
    })


def test_parse_as_of_and_invalid_format():
    assert parse_as_of("2025-01-02") == date(2025, 1, 2)
    with pytest.raises(InvalidAsOfDate):
        parse_as_of("2025/01/02")


def test_resolve_non_trading_day_to_previous_session():
    df = _df(10)
    saturday = pd.Timestamp(df["date"].iloc[-1]) + pd.Timedelta(days=1)
    assert resolve_effective_date(df, saturday.date()) == df["date"].iloc[-1]


def test_cutoff_and_historical_price():
    df = _df(10)
    effective = df["date"].iloc[5]
    cut = cutoff_daily(df, effective)
    assert len(cut) == 6
    price, change = historical_price_and_change(cut)
    assert price == pytest.approx(float(df["close"].iloc[5]))
    assert change is not None


def test_forward_labels_are_descriptive():
    labels = forward_outcome_labels([100 + i for i in range(30)], 0)
    assert labels["d5_pct"] == pytest.approx(5)
    assert labels["d20_pct"] == pytest.approx(20)


def test_bottoming_history_has_no_removed_metrics():
    df = _df()
    history = build_bottoming_history(df, effective_date=df["date"].iloc[-1], window=30)
    assert history["points"]
    point = history["points"][-1]
    assert {"tier", "cleanliness_pct", "sign_states", "sign_scores_pct"} <= point.keys()
    assert not any("right" in key for key in point)


def test_bottoming_history_point_is_stable_when_future_rows_append():
    df = _df(100)
    effective = df["date"].iloc[79]
    before = build_bottoming_history(df.iloc[:80], effective_date=effective, window=1)
    after = build_bottoming_history(df, effective_date=effective, window=1)
    comparable = ("date", "tier", "cleanliness_pct", "sign_states", "sign_scores_pct")
    assert {k: before["points"][0][k] for k in comparable} == {
        k: after["points"][0][k] for k in comparable
    }


def test_demo_report_is_schema_v2_and_bottoming_only():
    payload = build_demo_signal_report()
    assert payload["schema_version"] == 2
    assert payload["report_context"]["rules_version"] == "2"
    assert len(payload["signals"]) == 6
    assert all(signal["category"] == "left" for signal in payload["signals"])
    for removed in ("confirmation", "groups", "right_trend"):
        assert removed not in payload
    assert "bottoming_history" in payload


def test_historical_report_uses_cutoff_price_not_realtime_quote(monkeypatch):
    df = _df(90)
    effective = df["date"].iloc[70]

    def get_klines(ticker, **kwargs):
        return df.copy()

    quote = SimpleNamespace(name="测试公司", price=9999.0, change_pct=88.0)
    monkeypatch.setattr(report_module, "_data_fns", lambda: (get_klines, lambda _: [quote]))
    payload = build_signal_report("TEST", as_of=effective, trend_window=5)
    assert payload["price"] == pytest.approx(float(df["close"].iloc[70]))
    assert payload["report_context"]["effective_date"] == effective
    assert payload["report_context"]["used_historical_cutoff"] is True


def test_historical_report_rejects_date_before_history(monkeypatch):
    df = _df(40)
    monkeypatch.setattr(report_module, "_data_fns", lambda: (lambda *a, **k: df.copy(), lambda _: []))
    with pytest.raises(AsOfOutOfRange):
        build_signal_report("TEST", as_of="2000-01-01")


def test_report_does_not_aggregate_left_evidence_into_confirmation(monkeypatch):
    df = _df(90)
    monkeypatch.setattr(report_module, "_data_fns", lambda: (lambda *a, **k: df.copy(), lambda _: []))
    payload = build_signal_report("TEST", trend_window=5)
    assert "confirmation" not in payload
    assert payload["conclusion"]["structure_strength_pct"] == payload["bottoming"]["cleanliness_pct"]
