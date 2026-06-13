"""新浪财经 adapter — 美股实时行情 + 日K。"""
from __future__ import annotations

import json
import re
from typing import Any

import pandas as pd
import requests

from ..types import AdapterError, Quote, market_of

_HQ_URL = "https://hq.sinajs.cn/list={codes}"
_KLINE_URL = "https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var/US_MinKService.getDailyK"

_HEADERS = {"Referer": "https://finance.sina.com.cn/"}

_JSONP_RE = re.compile(r"\((\[.+\])\)", re.DOTALL)


def _sina_code(ticker: str) -> str:
    """ticker → 新浪行情代码。"""
    mkt = market_of(ticker)
    if mkt == "HK":
        digits = ticker.upper().replace(".HK", "").lstrip("0").zfill(5)
        return f"rt_hk{digits}"
    return f"gb_{ticker.lower()}"


def fetch_quotes(
    tickers: list[str],
    *,
    timeout: int = 10,
    proxy: str | None = None,
) -> list[Quote]:
    if not tickers:
        return []
    codes = ",".join(_sina_code(t) for t in tickers)
    proxies = {"http": proxy, "https": proxy} if proxy else None
    try:
        r = requests.get(
            _HQ_URL.format(codes=codes),
            headers=_HEADERS,
            proxies=proxies,
            timeout=timeout,
        )
        r.raise_for_status()
    except requests.RequestException as e:
        raise AdapterError("sina", str(e)) from e

    text = r.text
    out: list[Quote] = []
    for i, ticker in enumerate(tickers):
        pattern = f'hq_str_{_sina_code(ticker)}="'
        start = text.find(pattern)
        if start < 0:
            out.append(Quote(ticker=ticker))
            continue
        start += len(pattern)
        end = text.find('"', start)
        if end < 0:
            out.append(Quote(ticker=ticker))
            continue
        fields = text[start:end].split(",")
        if len(fields) < 4:
            out.append(Quote(ticker=ticker))
            continue

        mkt = market_of(ticker)
        if mkt == "US" and len(fields) >= 27:
            out.append(Quote(
                ticker=ticker,
                name=fields[0],
                price=_f(fields[1]),
                change_pct=_f(fields[2]),
                timestamp=fields[3] if len(fields) > 3 else None,
                change_amount=_f(fields[4]) if len(fields) > 4 else None,
                open=_f(fields[5]) if len(fields) > 5 else None,
                high=_f(fields[6]) if len(fields) > 6 else None,
                low=_f(fields[7]) if len(fields) > 7 else None,
                prev_close=_f(fields[26]) if len(fields) > 26 else None,
                volume=_i(fields[10]) if len(fields) > 10 else None,
            ))
        elif mkt == "HK" and len(fields) >= 19:
            out.append(Quote(
                ticker=ticker,
                name=fields[1] or fields[0],
                price=_f(fields[6]),
                open=_f(fields[2]),
                high=_f(fields[4]),
                low=_f(fields[5]),
                prev_close=_f(fields[3]),
                volume=_i(fields[12]),
                amount=_f(fields[11]),
                change_pct=_f(fields[8]),
                change_amount=_f(fields[7]),
                timestamp=f"{fields[17]} {fields[18]}",
            ))
        else:
            out.append(Quote(
                ticker=ticker,
                name=fields[0] if fields else None,
                price=_f(fields[6]) if len(fields) > 6 else None,
            ))
    return out


def fetch_klines(
    ticker: str,
    period: str = "1d",
    count: int = 250,
    adjust: str = "qfq",
    *,
    timeout: int = 15,
    proxy: str | None = None,
) -> pd.DataFrame:
    """新浪美股日K（仅支持美股日K）。"""
    if period != "1d":
        raise AdapterError("sina", f"only 1d period supported, got {period}")
    mkt = market_of(ticker)
    if mkt != "US":
        raise AdapterError("sina", f"sina kline only supports US stocks, got {ticker}")

    proxies = {"http": proxy, "https": proxy} if proxy else None
    try:
        r = requests.get(
            _KLINE_URL,
            params={"symbol": ticker.upper(), "num": count},
            headers=_HEADERS,
            proxies=proxies,
            timeout=timeout,
        )
        r.raise_for_status()
    except requests.RequestException as e:
        raise AdapterError("sina", str(e)) from e

    m = _JSONP_RE.search(r.text)
    if not m:
        raise AdapterError("sina", "failed to parse JSONP response")

    items = json.loads(m.group(1))
    rows: list[dict[str, Any]] = []
    for item in items:
        rows.append({
            "date": item.get("d"),
            "open": float(item.get("o", 0)),
            "high": float(item.get("h", 0)),
            "low": float(item.get("l", 0)),
            "close": float(item.get("c", 0)),
            "volume": int(item.get("v", 0)),
        })

    df = pd.DataFrame(rows)
    if count and len(df) > count:
        df = df.tail(count).reset_index(drop=True)
    return df


def _f(s: str | None) -> float | None:
    if s is None or s == "" or s == "-":
        return None
    try:
        return float(s)
    except (ValueError, TypeError):
        return None


def _i(s: str | None) -> int | None:
    if s is None or s == "" or s == "-":
        return None
    try:
        return int(float(s))
    except (ValueError, TypeError):
        return None
