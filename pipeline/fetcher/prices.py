"""价格抓取。

直接调 Yahoo Finance chart v8 API（不通过 skill 的 `stock_kline_yahoo`，因为该函数
存在 bug：构造了 params 字典但没传给 requests.get，导致 interval / range 被忽略，
Yahoo 默认只返回 1-2 天的 intraday 数据）。

Yahoo 返回的 `close` 已经是复权后（adjusted）的值，直接当作 `close_adj` 入库
（参考 design.md 决策 3、决策 6）。
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Any

import requests

from .ticker_normalize import to_yahoo

_YAHOO_CHART_URL = "https://query2.finance.yahoo.com/v8/finance/chart/{symbol}"
_YAHOO_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
    )
}


def _fetch_yahoo_chart(symbol: str, range_: str, interval: str = "1d") -> list[dict]:
    """直接调 Yahoo chart v8 拿 OHLCV 时间序列。"""
    r = requests.get(
        _YAHOO_CHART_URL.format(symbol=symbol),
        params={"interval": interval, "range": range_},
        headers=_YAHOO_HEADERS,
        timeout=15,
    )
    r.raise_for_status()
    payload = r.json()
    result = (payload.get("chart") or {}).get("result") or []
    if not result:
        return []
    chart = result[0]
    timestamps = chart.get("timestamp") or []
    quote = ((chart.get("indicators") or {}).get("quote") or [{}])[0]
    closes = quote.get("close") or []
    out: list[dict] = []
    for ts, close in zip(timestamps, closes):
        if close is None:
            continue
        try:
            close_f = float(close)
        except (TypeError, ValueError):
            continue
        if close_f <= 0:
            continue
        out.append(
            {
                "date": datetime.utcfromtimestamp(ts).strftime("%Y-%m-%d"),
                "close_adj": close_f,
            }
        )
    return out


def fetch_full_history(ticker: str) -> list[dict]:
    """全量抓取一只票的全部日 K 历史（用于首次拉取与每月对齐）。

    返回 `[{date, close_adj}, ...]`，按日期升序、按 date 去重（保留最后一条）。
    """
    symbol = to_yahoo(ticker)
    rows = _fetch_yahoo_chart(symbol, range_="max", interval="1d")
    # 去重 + 排序
    by_date: dict[str, dict] = {}
    for r in rows:
        by_date[r["date"]] = r
    return sorted(by_date.values(), key=lambda r: r["date"])


def fetch_incremental(ticker: str, since: date) -> list[dict]:
    """增量抓取：拉最近 3 个月，过滤掉 ≤ since 的日期。

    Yahoo `range_="3mo"` 覆盖最近 ~63 个交易日，足够覆盖任意 since（pipeline 至少每天跑一次）。
    """
    symbol = to_yahoo(ticker)
    rows = _fetch_yahoo_chart(symbol, range_="3mo", interval="1d")
    cutoff = since.isoformat() if isinstance(since, (date, datetime)) else str(since)
    by_date: dict[str, dict] = {}
    for r in rows:
        if r["date"] <= cutoff:
            continue
        by_date[r["date"]] = r
    return sorted(by_date.values(), key=lambda r: r["date"])
