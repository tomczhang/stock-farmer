"""雪球 adapter — K线 + 行情 + PE-TTM。

雪球在海外 IP 上也能访问（东财不行），作为核心 fallback 数据源。
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import pandas as pd
import requests

from ..types import AdapterError, Quote, market_of

_LOG = logging.getLogger(__name__)

_XUEQIU_HOME = "https://xueqiu.com"
_XUEQIU_KLINE = "https://stock.xueqiu.com/v5/stock/chart/kline.json"
_XUEQIU_QUOTE = "https://stock.xueqiu.com/v5/stock/quote.json"
_DATE_OFFSET = timedelta(hours=8)

_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
)


class _CookieHolder:
    def __init__(self) -> None:
        self._session: requests.Session | None = None

    def get_session(self) -> requests.Session:
        if self._session is None:
            s = requests.Session()
            s.trust_env = False
            s.headers.update({
                "User-Agent": _UA,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            })
            r = s.get(_XUEQIU_HOME, timeout=15)
            _LOG.info("xueqiu cookie fetch: status=%d cookies=%d", r.status_code, len(s.cookies))
            s.headers["Accept"] = "application/json, text/plain, */*"
            self._session = s
        return self._session

    def reset(self) -> None:
        self._session = None


_COOKIE = _CookieHolder()


def _to_symbol(ticker: str) -> str:
    mkt = market_of(ticker)
    if mkt == "HK":
        digits = ticker.upper().replace(".HK", "").lstrip("0").zfill(5)
        return digits
    return ticker.upper()


def _request(url: str, params: dict, symbol: str, timeout: int = 10) -> dict:
    def _attempt() -> dict:
        s = _COOKIE.get_session()
        r = s.get(
            url, params=params,
            headers={"Referer": f"{_XUEQIU_HOME}/S/{symbol}"},
            timeout=timeout,
        )
        if r.status_code in (400, 401, 403):
            raise AdapterError("xueqiu", f"HTTP {r.status_code}", r.status_code)
        r.raise_for_status()
        data = r.json()
        if data.get("error_code", 0) != 0:
            raise AdapterError("xueqiu", f"error_code={data.get('error_code')}")
        return data

    try:
        return _attempt()
    except (AdapterError, requests.RequestException):
        _COOKIE.reset()
        try:
            return _attempt()
        except requests.RequestException as e:
            raise AdapterError("xueqiu", str(e)) from e


# ---------- K 线 ----------

_PERIOD_MAP = {
    "1d": "day", "1w": "week", "1mo": "month",
    "5m": "5m", "15m": "15m", "30m": "30m", "60m": "60m",
}


def fetch_klines(
    ticker: str,
    period: str = "1d",
    count: int = 250,
    adjust: str = "qfq",
    *,
    timeout: int = 15,
    proxy: str | None = None,
) -> pd.DataFrame:
    symbol = _to_symbol(ticker)
    xq_period = _PERIOD_MAP.get(period)
    if xq_period is None:
        raise AdapterError("xueqiu", f"unsupported period: {period}")

    data = _request(_XUEQIU_KLINE, {
        "symbol": symbol,
        "begin": str(int(time.time() * 1000)),
        "period": xq_period,
        "type": "before",
        "count": str(-count),
        "indicator": "kline",
    }, symbol, timeout)

    items = (data.get("data") or {}).get("item") or []
    cols = (data.get("data") or {}).get("column") or []
    if not items:
        raise AdapterError("xueqiu", f"no kline data for {ticker}")

    idx_ts = cols.index("timestamp") if "timestamp" in cols else 0
    idx_vol = cols.index("volume") if "volume" in cols else 1
    idx_open = cols.index("open") if "open" in cols else 2
    idx_high = cols.index("high") if "high" in cols else 3
    idx_low = cols.index("low") if "low" in cols else 4
    idx_close = cols.index("close") if "close" in cols else 5

    is_intraday = period in ("5m", "15m", "30m", "60m")
    rows: list[dict[str, Any]] = []
    for row in items:
        ts = row[idx_ts]
        close = row[idx_close]
        if close is None:
            continue
        dt = datetime.fromtimestamp(ts / 1000, tz=timezone.utc) + _DATE_OFFSET
        fmt = "%Y-%m-%d %H:%M" if is_intraday else "%Y-%m-%d"
        rows.append({
            "date": dt.strftime(fmt),
            "open": float(row[idx_open]) if row[idx_open] is not None else 0,
            "high": float(row[idx_high]) if row[idx_high] is not None else 0,
            "low": float(row[idx_low]) if row[idx_low] is not None else 0,
            "close": float(close),
            "volume": int(row[idx_vol]) if row[idx_vol] is not None else 0,
        })

    return pd.DataFrame(rows)


# ---------- 行情 ----------

def fetch_quotes(
    tickers: list[str],
    *,
    timeout: int = 10,
    proxy: str | None = None,
) -> list[Quote]:
    out: list[Quote] = []
    for ticker in tickers:
        symbol = _to_symbol(ticker)
        try:
            data = _request(_XUEQIU_QUOTE, {
                "symbol": symbol, "extend": "detail"
            }, symbol, timeout)
            q = (data.get("data") or {}).get("quote") or {}
            out.append(Quote(
                ticker=ticker,
                name=q.get("name"),
                price=q.get("current"),
                open=q.get("open"),
                high=q.get("high"),
                low=q.get("low"),
                prev_close=q.get("last_close"),
                volume=q.get("volume"),
                amount=q.get("amount"),
                change_pct=q.get("percent"),
                change_amount=q.get("chg"),
                turnover_rate=q.get("turnover_rate"),
            ))
        except Exception:
            out.append(Quote(ticker=ticker))
    if out and all(q.price is None and q.name is None for q in out):
        raise AdapterError("xueqiu", "no quote data")
    return out


# ---------- PE-TTM ----------

def fetch_pe_ttm(ticker: str, *, timeout: int = 10) -> float | None:
    symbol = _to_symbol(ticker)
    data = _request(_XUEQIU_QUOTE, {
        "symbol": symbol, "extend": "detail"
    }, symbol, timeout)
    quote = (data.get("data") or {}).get("quote") or {}
    pe = quote.get("pe_ttm")
    if pe is None or (isinstance(pe, (int, float)) and pe <= 0):
        return None
    return float(pe)
