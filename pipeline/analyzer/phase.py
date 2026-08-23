"""价格趋势背景判断。

当前报告的唯一主结论来自 ``bottoming.BottomingVerdict``；本模块只保留
与筑底框架适用性有关的
MA50/MA200 趋势背景。
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def compute_trend_regime(df: pd.DataFrame | None) -> str:
    """从价格结构判断趋势背景，独立于筑底证据信号。

    - uptrend：收盘 > MA200 且 MA50 > MA200 且 MA50 上行；
    - downtrend：收盘 < MA200 且 MA50 < MA200 且 MA50 下行；
    - 数据不足 200 根时退化为 MA50 与其斜率；
    - 其余为 range / unknown。
    """
    if df is None or len(df) < 60 or "close" not in df:
        return "unknown"
    closes = df["close"].astype(float).values
    n = len(closes)
    last = float(closes[-1])

    def _ma(window: int) -> float | None:
        return float(np.mean(closes[-window:])) if n >= window else None

    ma50 = _ma(50)
    ma200 = _ma(200)
    ma50_prev = float(np.mean(closes[-70:-20])) if n >= 70 else None

    if ma200 is None:
        if ma50 is not None and ma50_prev is not None:
            if last > ma50 and ma50 > ma50_prev:
                return "uptrend"
            if last < ma50 and ma50 < ma50_prev:
                return "downtrend"
        return "range"

    rising = ma50_prev is not None and ma50 > ma50_prev
    falling = ma50_prev is not None and ma50 < ma50_prev
    if last > ma200 and ma50 > ma200 and rising:
        return "uptrend"
    if last < ma200 and ma50 < ma200 and falling:
        return "downtrend"
    return "range"
