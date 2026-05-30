"""stock-farmer 统一数据访问层。

调用方只需：
    from data import get_quotes, get_klines, get_indicators

内部屏蔽数据源选择、代理 IP、限流重试等复杂度。
"""
from __future__ import annotations

from functools import lru_cache
from typing import Any

import pandas as pd

from .adapters import eastmoney, sina, xueqiu, yahoo
from .indicators import build_volume_profile, compute_indicators
from .proxy_pool import ProxyPool
from .router import DataRouter
from .types import (
    AdapterError,
    DataSourceError,
    MoneyFlowDay,
    Quote,
    VolumeProfileBin,
    normalize_ticker,
)


@lru_cache(maxsize=1)
def _router() -> DataRouter:
    return DataRouter()


@lru_cache(maxsize=1)
def _proxy_pool() -> ProxyPool:
    return ProxyPool()


# ---------- 实时行情 ----------

def get_quotes(tickers: list[str]) -> list[Quote]:
    """批量获取最新实时行情。"""
    normalized = [normalize_ticker(t) for t in tickers]
    return _router().route(
        "quote",
        {
            "eastmoney": lambda timeout, **_: eastmoney.fetch_quotes(normalized, timeout=timeout),
            "sina": lambda timeout, **_: sina.fetch_quotes(normalized, timeout=timeout),
        },
    )


# ---------- K 线 ----------

def get_klines(
    ticker: str,
    period: str = "1d",
    count: int = 250,
    adjust: str = "qfq",
) -> pd.DataFrame:
    """获取 K 线数据（自动选择数据源 + fallback）。"""
    t = normalize_ticker(ticker)
    is_minute = period in ("5m", "15m", "30m", "60m")
    data_type = "kline_minute" if is_minute else "kline_daily"

    proxy = _proxy_pool().get_proxy() if is_minute else None

    adapters: dict[str, Any] = {}
    if data_type == "kline_minute":
        adapters["eastmoney"] = lambda timeout, **_: eastmoney.fetch_klines(
            t, period=period, count=count, adjust=adjust, timeout=timeout, proxy=proxy,
        )
    else:
        adapters["eastmoney"] = lambda timeout, **_: eastmoney.fetch_klines(
            t, period=period, count=count, adjust=adjust, timeout=timeout,
        )
        adapters["yahoo"] = lambda timeout, **_: yahoo.fetch_klines(
            t, period=period, count=count, adjust=adjust, timeout=timeout,
        )
        adapters["sina"] = lambda timeout, **_: sina.fetch_klines(
            t, period=period, count=count, adjust=adjust, timeout=timeout,
        )

    try:
        result = _router().route(data_type, adapters)
        if proxy:
            _proxy_pool().report_success(proxy)
        return result
    except DataSourceError:
        if proxy:
            _proxy_pool().report_failure(proxy)
        raise


# ---------- 技术指标 ----------

def get_indicators(
    ticker: str,
    indicators: list[str],
    period: str = "1d",
    count: int = 250,
) -> pd.DataFrame:
    """获取 K 线 + 技术指标（自动拉 K 线 → 计算指标）。"""
    df = get_klines(ticker, period=period, count=count)
    return compute_indicators(df, indicators)


# ---------- 资金流向 ----------

def get_money_flow(ticker: str, days: int = 30) -> list[MoneyFlowDay]:
    """获取日级资金流向。"""
    t = normalize_ticker(ticker)
    return _router().route(
        "money_flow",
        {
            "eastmoney": lambda timeout, **_: eastmoney.fetch_money_flow(t, days=days, timeout=timeout),
        },
    )


# ---------- Volume Profile ----------

def get_volume_profile(
    ticker: str,
    days: int = 1,
    num_bins: int = 30,
) -> list[VolumeProfileBin]:
    """构建 Volume Profile（基于分钟 K 线分桶）。"""
    bars_per_day = 78  # US market: 6.5h * 12 bars/h (5m)
    count = days * bars_per_day
    df = get_klines(ticker, period="5m", count=count)
    return build_volume_profile(df, num_bins=num_bins)


# ---------- PE-TTM ----------

def get_pe_ttm(ticker: str) -> float | None:
    """获取当前 PE-TTM。"""
    t = normalize_ticker(ticker)
    return _router().route(
        "pe_ttm",
        {
            "xueqiu": lambda timeout, **_: xueqiu.fetch_pe_ttm(t, timeout=timeout),
        },
    )


__all__ = [
    "get_quotes",
    "get_klines",
    "get_indicators",
    "get_money_flow",
    "get_volume_profile",
    "get_pe_ttm",
    "Quote",
    "MoneyFlowDay",
    "VolumeProfileBin",
    "AdapterError",
    "DataSourceError",
]
