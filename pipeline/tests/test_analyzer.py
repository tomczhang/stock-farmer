"""保留的六项结构证据信号测试。"""
from __future__ import annotations

import numpy as np
import pandas as pd

import analyzer.signals as signals_module
from analyzer.signals import (
    SignalResult,
    _add_swing_low_candidates,
    _calc_false_breakdown,
    _calc_vol_shrink,
    _select_active_support,
    _select_display_support_zones,
    _separate_support_zones,
    _to_light,
    compute_all_signals,
)


def _make_df(n: int = 60, trend: str = "flat") -> pd.DataFrame:
    rng = np.random.default_rng(42)
    if trend == "down":
        close = 100 - np.arange(n) * 0.3 + rng.normal(0, 0.5, n)
    elif trend == "up":
        close = 100 + np.arange(n) * 0.3 + rng.normal(0, 0.5, n)
    else:
        close = 100 + rng.normal(0, 0.5, n)
    volume = 5_000_000 * (1 + rng.random(n) * 0.3)
    if trend == "down":
        volume[-5:] = 2_000_000
    return pd.DataFrame({
        "date": pd.date_range("2026-04-01", periods=n).strftime("%Y-%m-%d"),
        "open": close - rng.random(n) * 0.5,
        "high": close + np.abs(rng.normal(0, 0.8, n)),
        "low": close - np.abs(rng.normal(0, 0.8, n)),
        "close": close,
        "volume": volume.astype(int),
    })


def test_compute_all_signals_returns_only_six_left_evidence_signals():
    results = compute_all_signals(_make_df())
    assert [s.id for s in results] == [
        "vol_shrink", "no_new_low", "false_breakdown",
        "vol_contraction", "chip_concentration", "market_env",
    ]
    assert len(results) == 6
    assert all(isinstance(s, SignalResult) and s.category == "left" for s in results)


def test_removed_signal_calculators_are_absent():
    for name in (
        "_calc_above_ma", "_calc_support_retest_hold", "_calc_volume_breakout",
        "_calc_macd_cross", "_calc_higher_low",
    ):
        assert not hasattr(signals_module, name)


def test_vol_shrink_detects_reduced_selling_volume():
    result = _calc_vol_shrink(_make_df(trend="down"))
    assert result.confidence > 0.35
    assert result.light in {"yellow", "green"}


def test_light_mapping():
    assert _to_light(0.1, (0.35, 0.70)) == "red"
    assert _to_light(0.5, (0.35, 0.70)) == "yellow"
    assert _to_light(0.8, (0.35, 0.70)) == "green"


def test_swing_low_quality_rewards_fast_rebound():
    df = _make_df(25)
    df.loc[:, ["open", "high", "low", "close", "volume"]] = [100, 101, 99, 100, 1_000_000]
    idx = 10
    df.loc[idx, ["open", "high", "low", "close", "volume"]] = [92, 93, 90, 91, 2_500_000]
    df.loc[idx + 1, "high"] = 100
    candidates: list[dict] = []
    _add_swing_low_candidates(candidates, df, 25, "测试前低")
    candidate = next(c for c in candidates if abs(float(c["price"]) - 90) < 1e-9)
    assert candidate["best_rebound_days"] <= 2
    assert candidate["score"] > 0.55


def test_support_zones_do_not_overlap_after_separation():
    zones = [
        {"low": 432.87, "high": 465.33, "center": 449.68, "strength": 1.0},
        {"low": 414.67, "high": 438.61, "center": 423.37, "strength": 0.9},
    ]
    separated = _separate_support_zones(zones, current=459.0, atr=10.0)
    assert separated[1]["high"] < separated[0]["low"]


def test_active_support_prefers_nearest_actionable_zone():
    zones = [
        {"low": 453, "high": 456, "center": 454.5, "strength": 0.26},
        {"low": 418, "high": 422, "center": 420, "strength": 0.51},
    ]
    assert _select_active_support(zones, current=459)["center"] == 420


def test_display_support_marks_medium_zone_for_observation():
    zones = [
        {"low": 453, "high": 456, "center": 454.5, "strength": 0.26, "is_major_support": False},
        {"low": 418, "high": 422, "center": 420, "strength": 0.51, "is_major_support": True},
    ]
    display, focus = _select_display_support_zones(zones, current=459)
    assert display[1]["display_role"] == "关键观察支撑，稳定性待确认"
    assert focus["has_main_support"] is True


def test_false_breakdown_ignores_weak_support(monkeypatch):
    df = _make_df(40)
    weak = {"low": 100, "high": 105, "center": 102.5, "strength": 0.26, "sources": ["前低"]}
    monkeypatch.setattr(signals_module, "_calc_support_zones", lambda _: [weak])
    result = _calc_false_breakdown(df)
    assert result.confidence == 0
    assert result.data["breakdown_event"] == {}
