"""雪球 adapter — PE-TTM quote。"""
from __future__ import annotations

import requests

from ..types import AdapterError, market_of

_XUEQIU_HOME = "https://xueqiu.com"
_XUEQIU_QUOTE = "https://stock.xueqiu.com/v5/stock/quote.json"

_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
)


class _CookieHolder:
    """Module-level cookie cache for Xueqiu."""

    def __init__(self) -> None:
        self._session: requests.Session | None = None

    def get_session(self) -> requests.Session:
        if self._session is None:
            s = requests.Session()
            s.trust_env = False
            s.headers.update({
                "User-Agent": _UA,
                "Accept": "application/json, text/plain, */*",
            })
            s.get(_XUEQIU_HOME, timeout=15)
            self._session = s
        return self._session

    def reset(self) -> None:
        self._session = None


_COOKIE = _CookieHolder()


def _to_xueqiu_symbol(ticker: str) -> str:
    mkt = market_of(ticker)
    if mkt == "HK":
        digits = ticker.upper().replace(".HK", "").lstrip("0").zfill(5)
        return digits
    return ticker.upper()


def fetch_pe_ttm(ticker: str, *, timeout: int = 10) -> float | None:
    """返回当前 PE-TTM，亏损时返回 None。"""
    symbol = _to_xueqiu_symbol(ticker)

    def _attempt() -> float | None:
        s = _COOKIE.get_session()
        r = s.get(
            _XUEQIU_QUOTE,
            params={"symbol": symbol, "extend": "detail"},
            headers={"Referer": f"{_XUEQIU_HOME}/S/{symbol}"},
            timeout=timeout,
        )
        if r.status_code in (401, 403):
            raise AdapterError("xueqiu", f"auth failed: HTTP {r.status_code}", r.status_code)
        r.raise_for_status()
        data = r.json()
        if data.get("error_code", 0) != 0:
            raise AdapterError("xueqiu", f"error_code={data.get('error_code')}")
        quote = (data.get("data") or {}).get("quote") or {}
        pe = quote.get("pe_ttm")
        if pe is None or (isinstance(pe, (int, float)) and pe <= 0):
            return None
        return float(pe)

    try:
        return _attempt()
    except AdapterError:
        _COOKIE.reset()
        try:
            return _attempt()
        except requests.RequestException as e:
            raise AdapterError("xueqiu", str(e)) from e
