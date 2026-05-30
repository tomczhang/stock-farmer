"""技术指标计算（封装 ta 库）+ Volume Profile。"""
from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd
import ta

from .types import VolumeProfileBin

# 指标名 → ta 函数映射
_INDICATOR_MAP: dict[str, list[tuple[str, Any]]] = {
    "macd": [
        ("macd", lambda c: ta.trend.macd(c)),
        ("macd_signal", lambda c: ta.trend.macd_signal(c)),
        ("macd_hist", lambda c: ta.trend.macd_diff(c)),
    ],
    "rsi": [
        ("rsi", lambda c: ta.momentum.rsi(c)),
    ],
    "kdj": [
        ("stoch_k", None),  # needs h/l, handled in compute loop
        ("stoch_d", None),
    ],
    "bollinger": [
        ("bb_upper", lambda c: ta.volatility.bollinger_hband(c)),
        ("bb_middle", lambda c: ta.volatility.bollinger_mavg(c)),
        ("bb_lower", lambda c: ta.volatility.bollinger_lband(c)),
    ],
    "atr": [
        ("atr", None),  # needs h/l, handled in compute loop
    ],
    "ma": [
        ("ma5", lambda c: ta.trend.sma_indicator(c, window=5)),
        ("ma10", lambda c: ta.trend.sma_indicator(c, window=10)),
        ("ma20", lambda c: ta.trend.sma_indicator(c, window=20)),
        ("ma60", lambda c: ta.trend.sma_indicator(c, window=60)),
    ],
    "ema": [
        ("ema12", lambda c: ta.trend.ema_indicator(c, window=12)),
        ("ema26", lambda c: ta.trend.ema_indicator(c, window=26)),
    ],
    "obv": [
        ("obv", None),  # needs volume, handled separately
    ],
    "mfi": [
        ("mfi", None),  # needs high/low/close/volume
    ],
    "cci": [
        ("cci", None),  # needs h/l, handled in compute loop
    ],
}


def compute_indicators(df: pd.DataFrame, indicator_names: list[str]) -> pd.DataFrame:
    """在 OHLCV DataFrame 上计算指定的技术指标，追加为新列。

    df 必须包含 close 列；high/low/volume 可选（部分指标需要）。
    返回带有新列的 DataFrame 副本。
    """
    result = df.copy()
    close = result["close"]
    high = result.get("high", close)
    low = result.get("low", close)
    volume = result.get("volume")

    for name in indicator_names:
        entries = _INDICATOR_MAP.get(name)
        if entries is None:
            continue
        for col_name, fn in entries:
            if col_name == "obv" and volume is not None:
                result[col_name] = ta.volume.on_balance_volume(close, volume)
            elif col_name == "mfi" and volume is not None:
                result[col_name] = ta.volume.money_flow_index(high, low, close, volume)
            elif col_name == "atr":
                result[col_name] = ta.volatility.average_true_range(high, low, close)
            elif col_name == "cci":
                result[col_name] = ta.trend.cci(high, low, close)
            elif col_name == "stoch_k":
                result[col_name] = ta.momentum.stoch(high, low, close)
            elif col_name == "stoch_d":
                result[col_name] = ta.momentum.stoch_signal(high, low, close)
            elif fn is not None:
                result[col_name] = fn(close)
    return result


def build_volume_profile(
    df: pd.DataFrame,
    num_bins: int = 30,
) -> list[VolumeProfileBin]:
    """从分钟级 OHLCV DataFrame 构建 Volume Profile。

    使用每根 K 线的收盘价作为成交价位，成交量累加到对应桶。
    """
    if df.empty or "close" not in df.columns or "volume" not in df.columns:
        return []

    closes = df["close"].values
    volumes = df["volume"].values

    price_min = float(np.nanmin(closes))
    price_max = float(np.nanmax(closes))

    if price_min == price_max:
        return [VolumeProfileBin(price_level=price_min, volume=int(np.sum(volumes)), pct=100.0)]

    bin_edges = np.linspace(price_min, price_max, num_bins + 1)
    bin_volumes = np.zeros(num_bins, dtype=np.int64)

    for close, vol in zip(closes, volumes):
        if np.isnan(close) or vol is None or vol == 0:
            continue
        idx = int((close - price_min) / (price_max - price_min) * (num_bins - 1))
        idx = max(0, min(idx, num_bins - 1))
        bin_volumes[idx] += int(vol)

    total = int(np.sum(bin_volumes))
    if total == 0:
        total = 1

    result: list[VolumeProfileBin] = []
    for i in range(num_bins):
        center = (bin_edges[i] + bin_edges[i + 1]) / 2
        result.append(VolumeProfileBin(
            price_level=round(float(center), 4),
            volume=int(bin_volumes[i]),
            pct=round(float(bin_volumes[i]) / total * 100, 2),
        ))
    return result
