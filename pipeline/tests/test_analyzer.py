"""信号引擎 + 阶段判断 + 渲染测试。"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from analyzer.signals import (
    SignalResult,
    compute_all_signals,
    _calc_vol_shrink,
    _calc_above_ma,
    _calc_macd_cross,
    _calc_higher_low,
    _to_light,
)
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
        assert len(signals) == 10
        assert all(isinstance(s, SignalResult) for s in signals)


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
        assert "bg-[#0f1117]" in html
