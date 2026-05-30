"""技术指标 + Volume Profile 测试。"""
from __future__ import annotations

import numpy as np
import pandas as pd

from data.indicators import build_volume_profile, compute_indicators


class TestComputeIndicators:
    def _make_df(self, n: int = 100) -> pd.DataFrame:
        np.random.seed(42)
        close = 100 + np.cumsum(np.random.randn(n) * 0.5)
        return pd.DataFrame({
            "date": pd.date_range("2026-01-01", periods=n).strftime("%Y-%m-%d"),
            "open": close - np.random.rand(n),
            "high": close + np.abs(np.random.randn(n)),
            "low": close - np.abs(np.random.randn(n)),
            "close": close,
            "volume": np.random.randint(1_000_000, 10_000_000, n),
        })

    def test_macd_columns_added(self):
        df = self._make_df()
        result = compute_indicators(df, ["macd"])
        assert "macd" in result.columns
        assert "macd_signal" in result.columns
        assert "macd_hist" in result.columns
        assert len(result) == len(df)

    def test_rsi_column_added(self):
        df = self._make_df()
        result = compute_indicators(df, ["rsi"])
        assert "rsi" in result.columns

    def test_bollinger_columns_added(self):
        df = self._make_df()
        result = compute_indicators(df, ["bollinger"])
        assert "bb_upper" in result.columns
        assert "bb_middle" in result.columns
        assert "bb_lower" in result.columns

    def test_multiple_indicators(self):
        df = self._make_df()
        result = compute_indicators(df, ["macd", "rsi", "atr", "ma"])
        assert "macd" in result.columns
        assert "rsi" in result.columns
        assert "atr" in result.columns
        assert "ma20" in result.columns

    def test_unknown_indicator_ignored(self):
        df = self._make_df()
        result = compute_indicators(df, ["nonexistent", "rsi"])
        assert "rsi" in result.columns
        assert "nonexistent" not in result.columns

    def test_obv_with_volume(self):
        df = self._make_df()
        result = compute_indicators(df, ["obv"])
        assert "obv" in result.columns


class TestVolumeProfile:
    def test_basic_profile(self):
        df = pd.DataFrame({
            "close": [100.0, 101.0, 102.0, 100.5, 101.5],
            "volume": [1000, 2000, 1500, 3000, 2500],
        })
        profile = build_volume_profile(df, num_bins=5)
        assert len(profile) == 5
        total_vol = sum(b.volume for b in profile)
        assert total_vol == 10000
        total_pct = sum(b.pct for b in profile)
        assert abs(total_pct - 100.0) < 0.1

    def test_empty_df_returns_empty(self):
        df = pd.DataFrame(columns=["close", "volume"])
        profile = build_volume_profile(df)
        assert profile == []

    def test_single_price_single_bin(self):
        df = pd.DataFrame({
            "close": [100.0, 100.0, 100.0],
            "volume": [1000, 2000, 3000],
        })
        profile = build_volume_profile(df, num_bins=10)
        assert len(profile) == 1
        assert profile[0].volume == 6000
        assert profile[0].pct == 100.0
