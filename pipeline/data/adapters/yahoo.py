"""Yahoo Finance adapter — K 线 fallback。

优先用 yfinance 库（更稳定，自动处理 cookie/crumb），
fallback 到直接调 chart v8 API。
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

import pandas as pd
import requests

from ..types import AdapterError, to_yahoo

_LOG = logging.getLogger(__name__)

_CHART_URL = "https://query2.finance.yahoo.com/v8/finance/chart/{symbol}"
_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
)

_PERIOD_TO_YAHOO_INTERVAL = {
    "1d": "1d", "1w": "1wk", "1mo": "1mo",
    "5m": "5m", "15m": "15m", "30m": "30m", "60m": "60m",
}

_COUNT_TO_RANGE = {
    "1d": {50: "3mo", 250: "1y", 1000: "5y", 9999: "max"},
    "1w": {52: "1y", 260: "5y", 9999: "max"},
    "1mo": {60: "5y", 9999: "max"},
    "5m": {100: "5d", 9999: "60d"},
    "15m": {100: "5d", 9999: "60d"},
    "30m": {100: "5d", 9999: "60d"},
    "60m": {100: "5d", 9999: "60d"},
}


def _estimate_range(period: str, count: int) -> str:
    thresholds = _COUNT_TO_RANGE.get(period, {9999: "max"})
    for limit, range_val in sorted(thresholds.items()):
        if count <= limit:
            return range_val
    return "max"


def fetch_klines(
    ticker: str,
    period: str = "1d",
    count: int = 250,
    adjust: str = "qfq",
    *,
    timeout: int = 15,
    proxy: str | None = None,
) -> pd.DataFrame:
    symbol = to_yahoo(ticker)
    interval = _PERIOD_TO_YAHOO_INTERVAL.get(period)
    if interval is None:
        raise AdapterError("yahoo", f"unsupported period: {period}")

    # Try yfinance first (more robust, handles auth automatically)
    try:
        return _fetch_via_yfinance(symbol, interval, count, period)
    except Exception as e:
        _LOG.debug("yfinance failed, falling back to chart API: %s", e)

    range_ = _estimate_range(period, count)
    headers = {"User-Agent": _UA}
    proxies = {"http": proxy, "https": proxy} if proxy else None

    try:
        r = requests.get(
            _CHART_URL.format(symbol=symbol),
            params={"interval": interval, "range": range_},
            headers=headers,
            proxies=proxies,
            timeout=timeout,
        )
        r.raise_for_status()
    except requests.RequestException as e:
        raise AdapterError("yahoo", str(e)) from e

    payload = r.json()
    result = (payload.get("chart") or {}).get("result") or []
    if not result:
        raise AdapterError("yahoo", f"no chart data for {symbol}")

    chart = result[0]
    timestamps = chart.get("timestamp") or []
    quote = ((chart.get("indicators") or {}).get("quote") or [{}])[0]
    opens = quote.get("open") or []
    highs = quote.get("high") or []
    lows = quote.get("low") or []
    closes = quote.get("close") or []
    volumes = quote.get("volume") or []

    is_intraday = period in ("5m", "15m", "30m", "60m")
    rows: list[dict[str, Any]] = []
    for i, ts in enumerate(timestamps):
        close = closes[i] if i < len(closes) else None
        if close is None:
            continue
        fmt = "%Y-%m-%d %H:%M" if is_intraday else "%Y-%m-%d"
        rows.append({
            "date": datetime.utcfromtimestamp(ts).strftime(fmt),
            "open": float(opens[i]) if i < len(opens) and opens[i] else 0,
            "high": float(highs[i]) if i < len(highs) and highs[i] else 0,
            "low": float(lows[i]) if i < len(lows) and lows[i] else 0,
            "close": float(close),
            "volume": int(volumes[i]) if i < len(volumes) and volumes[i] else 0,
        })

    df = pd.DataFrame(rows)
    if count and len(df) > count:
        df = df.tail(count).reset_index(drop=True)
    return df


def _fetch_via_yfinance(symbol: str, interval: str, count: int, period: str) -> pd.DataFrame:
    """Use yfinance library for more robust Yahoo access."""
    import yfinance as yf

    range_ = _estimate_range(period, count)
    tick = yf.Ticker(symbol)
    hist = tick.history(period=range_, interval=interval)

    if hist.empty:
        raise RuntimeError(f"yfinance returned empty for {symbol}")

    is_intraday = period in ("5m", "15m", "30m", "60m")
    fmt = "%Y-%m-%d %H:%M" if is_intraday else "%Y-%m-%d"

    df = pd.DataFrame({
        "date": hist.index.strftime(fmt),
        "open": hist["Open"].values,
        "high": hist["High"].values,
        "low": hist["Low"].values,
        "close": hist["Close"].values,
        "volume": hist["Volume"].values.astype(int),
    })

    if count and len(df) > count:
        df = df.tail(count).reset_index(drop=True)
    return df
