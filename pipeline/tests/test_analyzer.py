"""信号引擎 + 阶段判断 + 渲染测试。"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from analyzer.signals import (
    SignalResult,
    compute_all_signals,
    compute_ma200_levels,
    _calc_vol_shrink,
    _calc_above_ma,
    _calc_false_breakdown,
    _calc_support_retest_hold,
    _calc_macd_cross,
    _calc_higher_low,
    _add_swing_low_candidates,
    _select_active_support,
    _select_display_support_zones,
    _separate_support_zones,
    _to_light,
)
import analyzer.signals as signals_module
from analyzer.phase import determine_phase, compute_overall_strength
from analyzer.renderer import render_html


def _make_df(n: int = 60, trend: str = "flat") -> pd.DataFrame:
    np.random.seed(42)
    if trend == "down":
        close = 100 - np.arange(n) * 0.3 + np.random.randn(n) * 0.5
    elif trend == "up":
        close = 100 + np.arange(n) * 0.3 + np.random.randn(n) * 0.5
    else:
        close = 100 + np.random.randn(n) * 0.5

    vol_base = 5_000_000
    if trend == "down":
        volume = vol_base * (1 + np.random.rand(n) * 0.5)
        volume[-5:] = vol_base * 0.4  # shrink recent volume
    else:
        volume = vol_base * (1 + np.random.rand(n) * 0.3)

    return pd.DataFrame({
        "date": pd.date_range("2026-04-01", periods=n).strftime("%Y-%m-%d"),
        "open": close - np.random.rand(n) * 0.5,
        "high": close + np.abs(np.random.randn(n)) * 0.8,
        "low": close - np.abs(np.random.randn(n)) * 0.8,
        "close": close,
        "volume": volume.astype(int),
    })


class TestMA200Levels:
    def test_returns_none_when_under_200_rows(self):
        assert compute_ma200_levels(_make_df(199)) is None

    def test_resistance_when_price_below_ma200(self):
        df = _make_df(200, trend="down")
        result = compute_ma200_levels(df)
        assert result is not None
        assert result["role"] == "resistance"
        assert result["distance_pct"] > 0
        expected_ma = float(df["close"].astype(float).tail(200).mean())
        assert abs(result["ma200"] - expected_ma) < 0.01

    def test_above_when_price_above_ma200(self):
        result = compute_ma200_levels(_make_df(200, trend="up"))
        assert result is not None
        assert result["role"] == "above"

    def test_not_included_in_compute_all_signals(self):
        signals = compute_all_signals(_make_df(200))
        assert len(signals) == 11
        assert all("ma200" not in s.id for s in signals)


class TestSignals:
    def test_vol_shrink_with_low_volume(self):
        df = _make_df(60, trend="down")
        result = _calc_vol_shrink(df)
        assert result.id == "vol_shrink"
        assert result.confidence > 0.5
        assert result.light in ("yellow", "green")

    def test_vol_shrink_with_normal_volume(self):
        df = _make_df(60, trend="flat")
        result = _calc_vol_shrink(df)
        assert result.confidence < 0.5

    def test_above_ma_when_above(self):
        df = _make_df(60, trend="up")
        result = _calc_above_ma(df)
        assert result.confidence > 0

    def test_above_ma_when_below(self):
        df = _make_df(60, trend="down")
        result = _calc_above_ma(df)
        assert result.confidence == 0.0
        assert result.light == "red"

    def test_macd_cross(self):
        df = _make_df(60, trend="up")
        result = _calc_macd_cross(df)
        assert result.id == "macd_cross"
        assert 0.0 <= result.confidence <= 1.0

    def test_higher_low_in_uptrend(self):
        df = _make_df(60, trend="up")
        result = _calc_higher_low(df)
        assert result.confidence > 0

    def test_light_mapping(self):
        assert _to_light(0.1, (0.35, 0.70)) == "red"
        assert _to_light(0.5, (0.35, 0.70)) == "yellow"
        assert _to_light(0.8, (0.35, 0.70)) == "green"

    def test_compute_all_signals(self):
        df = _make_df(60)
        signals = compute_all_signals(df)
        assert len(signals) == 11
        assert all(isinstance(s, SignalResult) for s in signals)

    def test_swing_low_quality_discounts_delayed_low_volume_rebound(self):
        df = _make_df(25, trend="flat")
        df.loc[:, "open"] = 100.0
        df.loc[:, "high"] = 101.0
        df.loc[:, "low"] = 99.0
        df.loc[:, "close"] = 100.0
        df.loc[:, "volume"] = 1_000_000

        low_idx = 10
        df.loc[low_idx, ["open", "high", "low", "close", "volume"]] = [92.0, 92.5, 90.0, 91.0, 1_000_000]
        for j in range(low_idx + 1, low_idx + 6):
            df.loc[j, ["open", "high", "low", "close"]] = [91.0, 93.0, 90.5, 92.0]
        df.loc[low_idx + 6, "high"] = 106.0

        candidates: list[dict] = []
        _add_swing_low_candidates(candidates, df, 25, "测试前低")
        low_candidate = next(c for c in candidates if abs(float(c["price"]) - 90.0) < 1e-9)

        assert low_candidate["best_rebound_days"] == 6
        assert low_candidate["score"] < 0.45

    def test_swing_low_quality_rewards_fast_volume_rebound(self):
        df = _make_df(25, trend="flat")
        df.loc[:, "open"] = 100.0
        df.loc[:, "high"] = 101.0
        df.loc[:, "low"] = 99.0
        df.loc[:, "close"] = 100.0
        df.loc[:, "volume"] = 1_000_000

        low_idx = 10
        df.loc[low_idx, ["open", "high", "low", "close", "volume"]] = [92.0, 93.0, 90.0, 91.0, 2_500_000]
        df.loc[low_idx + 1, "high"] = 100.0
        for j in range(low_idx + 2, low_idx + 11):
            df.loc[j, ["open", "high", "low", "close"]] = [93.0, 94.0, 91.0, 93.5]

        candidates: list[dict] = []
        _add_swing_low_candidates(candidates, df, 25, "测试前低")
        low_candidate = next(c for c in candidates if abs(float(c["price"]) - 90.0) < 1e-9)

        assert low_candidate["best_rebound_days"] == 1
        assert low_candidate["score"] > 0.65

    def test_support_zones_do_not_overlap_after_separation(self):
        zones = [
            {"low": 432.87, "high": 465.33, "center": 449.68, "strength": 1.0},
            {"low": 414.67, "high": 438.61, "center": 423.37, "strength": 0.9},
        ]
        separated = _separate_support_zones(zones, current=459.0, atr=10.0)
        assert len(separated) == 2
        assert separated[0]["low"] == 432.87
        assert separated[1]["high"] < separated[0]["low"]

    def test_false_breakdown_ignores_weak_support(self, monkeypatch):
        df = _make_df(40, trend="flat")
        df.loc[:, "close"] = 110.0
        df.loc[:, "high"] = 112.0
        df.loc[:, "low"] = 108.0
        df.loc[:, "open"] = 109.0
        df.loc[len(df) - 3, "low"] = 99.0
        df.loc[len(df) - 2, "close"] = 106.0
        weak_zone = {
            "low": 100.0,
            "high": 105.0,
            "center": 102.5,
            "strength": 0.26,
            "sources": ["近3个月前低"],
        }

        monkeypatch.setattr(signals_module, "_calc_support_zones", lambda _: [weak_zone])
        result = _calc_false_breakdown(df)

        assert result.confidence == 0.0
        assert result.light == "red"
        assert result.data["breakdown_event"] == {}
        assert "未识别到稳定性 ≥60% 的强支撑" in result.description

    def test_false_breakdown_ignores_medium_support(self, monkeypatch):
        df = _make_df(40, trend="flat")
        df.loc[:, "close"] = 110.0
        df.loc[:, "high"] = 112.0
        df.loc[:, "low"] = 108.0
        df.loc[:, "open"] = 109.0
        df.loc[:, "volume"] = 5_000_000
        df.loc[len(df) - 4, "low"] = 99.0
        df.loc[len(df) - 3, "close"] = 108.0
        medium_zone = {
            "low": 100.0,
            "high": 105.0,
            "center": 102.5,
            "strength": 0.55,
            "sources": ["近3个月前低", "整数关口"],
            "kinds": ["前低", "整数关口"],
            "is_major_support": True,
        }

        monkeypatch.setattr(signals_module, "_calc_support_zones", lambda _: [medium_zone])
        result = _calc_false_breakdown(df)

        assert result.confidence == 0.0
        assert result.data["active_support"] == {}
        assert result.data["breakdown_event"] == {}
        assert "未识别到稳定性 ≥60% 的强支撑" in result.description

    def test_active_support_prefers_nearest_actionable_zone(self):
        zones = [
            {"low": 453.0, "high": 456.0, "center": 454.5, "strength": 0.26},
            {"low": 418.0, "high": 422.0, "center": 420.0, "strength": 0.51},
        ]

        active = _select_active_support(zones, current=459.0)

        assert active is not None
        assert active["center"] == 420.0

    def test_display_support_labels_major_medium_zone_as_watch_support(self):
        zones = [
            {
                "low": 453.0,
                "high": 456.0,
                "center": 454.5,
                "strength": 0.26,
                "is_major_support": False,
            },
            {
                "low": 418.0,
                "high": 422.0,
                "center": 420.0,
                "strength": 0.51,
                "is_major_support": True,
            },
        ]

        display, focus = _select_display_support_zones(zones, current=459.0)

        assert display[1]["display_role"] == "关键观察支撑，稳定性待确认"
        assert focus["has_strong_support"] is False
        assert focus["has_main_support"] is True

    def test_support_retest_hold_after_false_breakdown(self, monkeypatch):
        df = _make_df(40, trend="flat")
        df.loc[:, "close"] = 110.0
        df.loc[:, "high"] = 112.0
        df.loc[:, "low"] = 108.0
        df.loc[:, "open"] = 109.0
        df.loc[:, "volume"] = 5_000_000

        n = len(df)
        df.loc[n - 5, ["open", "high", "low", "close"]] = [104.0, 106.0, 99.0, 102.0]
        df.loc[n - 4, ["open", "high", "low", "close"]] = [103.0, 108.0, 103.0, 107.0]
        df.loc[n - 3, ["open", "high", "low", "close"]] = [109.0, 112.0, 107.0, 110.0]
        df.loc[n - 2, ["open", "high", "low", "close"]] = [106.0, 109.0, 104.0, 108.0]
        df.loc[n - 1, ["open", "high", "low", "close"]] = [110.0, 113.0, 109.0, 111.0]

        support_zone = {
            "low": 100.0,
            "high": 105.0,
            "center": 102.5,
            "strength": 0.72,
            "sources": ["近3个月前低"],
            "kinds": ["前低"],
        }

        monkeypatch.setattr(signals_module, "_calc_support_zones", lambda _: [support_zone])
        false_signal = _calc_false_breakdown(df)
        result = _calc_support_retest_hold(df, false_breakdown=false_signal)

        assert false_signal.data["breakdown_event"]["recover_date"] == df.loc[n - 4, "date"]
        assert result.id == "support_retest_hold"
        assert result.light == "green"
        assert result.data["retest_event"]["date"] == df.loc[n - 2, "date"]
        assert "回踩支撑区间" in result.description


class TestPhase:
    def _make_signals(self, left_greens: int, right_greens: int) -> list[SignalResult]:
        signals = []
        for i in range(6):
            light = "green" if i < left_greens else "red"
            signals.append(SignalResult(
                id=f"left_{i}", name=f"L{i}", category="left",
                confidence=0.8 if light == "green" else 0.1,
                light=light, thresholds=(0.35, 0.70), weight=1,
                description="", data={},
            ))
        for i in range(4):
            light = "green" if i < right_greens else "red"
            signals.append(SignalResult(
                id=f"right_{i}", name=f"R{i}", category="right",
                confidence=0.8 if light == "green" else 0.1,
                light=light, thresholds=(0.35, 0.70), weight=1,
                description="", data={},
            ))
        return signals

    def test_downtrend(self):
        phase = determine_phase(self._make_signals(0, 0))
        assert phase.phase == "仍在下跌"
        assert phase.icon == "🔴"

    def test_bottom_forming(self):
        phase = determine_phase(self._make_signals(4, 1))
        assert phase.phase == "底部基本成型"
        assert phase.icon == "🟡⭐"

    def test_right_confirmed(self):
        phase = determine_phase(self._make_signals(4, 3))
        assert phase.phase == "趋势已确立"
        assert phase.icon == "🟢🟢"

    def test_strength_calculation(self):
        signals = self._make_signals(5, 3)
        strength = compute_overall_strength(signals)
        assert 0.0 <= strength <= 1.0


class TestRenderer:
    def test_render_produces_html(self):
        from analyzer.phase import PhaseResult
        signals = []
        for i in range(6):
            signals.append(SignalResult(
                id=f"s{i}", name=f"信号{i}", category="left",
                confidence=0.6, light="yellow", thresholds=(0.35, 0.70), weight=1,
                description="测试描述", data={},
            ))
        for i in range(4):
            signals.append(SignalResult(
                id=f"r{i}", name=f"右侧{i}", category="right",
                confidence=0.3, light="red", thresholds=(0.35, 0.70), weight=1,
                description="测试描述", data={},
            ))
        phase = PhaseResult(
            phase="底部特征初现", icon="🟡", action="列入观察",
            trigger="等待突破", strength=0.45, strength_pct=45,
        )
        html = render_html("AAPL", "苹果", 312.06, -0.14, signals, phase, "测试综述。")
        assert "<!DOCTYPE html>" in html
        assert "AAPL" in html
        assert "信号0" in html
        assert "tailwindcss" in html
        assert "report-shell" in html
