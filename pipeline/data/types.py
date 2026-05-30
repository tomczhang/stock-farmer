from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Literal


# ---------- Exceptions ----------

class AdapterError(RuntimeError):
    """单个数据源 adapter 调用失败。"""

    def __init__(self, source: str, message: str, status_code: int | None = None) -> None:
        self.source = source
        self.status_code = status_code
        super().__init__(f"[{source}] {message}")


class DataSourceError(RuntimeError):
    """所有数据源均失败。"""

    def __init__(self, data_type: str, errors: list[AdapterError]) -> None:
        self.data_type = data_type
        self.errors = errors
        sources = ", ".join(e.source for e in errors)
        super().__init__(f"All sources failed for {data_type}: {sources}")


# ---------- Data classes ----------

@dataclass
class Quote:
    ticker: str
    name: str | None = None
    price: float | None = None
    open: float | None = None
    high: float | None = None
    low: float | None = None
    prev_close: float | None = None
    volume: int | None = None
    amount: float | None = None
    change_pct: float | None = None
    change_amount: float | None = None
    turnover_rate: float | None = None
    timestamp: str | None = None


@dataclass
class MoneyFlowDay:
    date: str
    main_net_inflow: float | None = None
    large_net_inflow: float | None = None
    xlarge_net_inflow: float | None = None
    medium_net_inflow: float | None = None
    small_net_inflow: float | None = None
    main_net_pct: float | None = None
    close: float | None = None
    change_pct: float | None = None


@dataclass
class VolumeProfileBin:
    price_level: float
    volume: int
    pct: float


# ---------- Ticker normalization ----------

_HK_RE = re.compile(r"^0*(\d{1,5})\.HK$", re.IGNORECASE)

Market = Literal["US", "HK", "INDEX"]

_INDEX_TICKERS = frozenset({"SPX", "NDX", "DJI"})


def market_of(ticker: str) -> Market:
    if not ticker:
        raise ValueError("ticker must be a non-empty string")
    if ticker.upper() in _INDEX_TICKERS:
        return "INDEX"
    if ticker.upper().endswith(".HK"):
        return "HK"
    return "US"


def _hk_digits(ticker: str) -> str | None:
    m = _HK_RE.match(ticker)
    if not m:
        return None
    return m.group(1).lstrip("0") or "0"


def to_yahoo(ticker: str) -> str:
    digits = _hk_digits(ticker)
    if digits is None:
        return ticker
    return f"{digits.zfill(4)}.HK"


def to_eastmoney_secid(ticker: str) -> str:
    """ticker → 东财 push2 secid (e.g. '105.AAPL', '116.00700')."""
    mkt = market_of(ticker)
    if mkt == "HK":
        digits = _hk_digits(ticker) or ""
        return f"116.{digits.zfill(5)}"
    code = ticker.upper()
    prefix = SECID_PREFIX.get(code, SECID_PREFIX_DEFAULT)
    return f"{prefix}.{code}"


def normalize_ticker(ticker: str) -> str:
    """统一外部格式：AAPL (US) / 0700.HK (HK)。"""
    digits = _hk_digits(ticker)
    if digits is not None:
        return f"{digits.zfill(4)}.HK"
    return ticker.upper()


# ---------- Constants ----------

SECID_PREFIX: dict[str, int] = {}
SECID_PREFIX_DEFAULT = 105  # NASDAQ; NYSE=106, ETF=107

ADAPTER_TIMEOUT = 10  # seconds per adapter request
ROUTER_TOTAL_TIMEOUT = 30  # seconds across all fallback attempts

HEALTH_FAILURE_THRESHOLD = 3  # consecutive failures → unhealthy
HEALTH_COOLDOWN_SECONDS = 60  # seconds before retrying unhealthy source

PROXY_FAILURE_THRESHOLD = 3
PROXY_COOLDOWN_SECONDS = 120
PROXY_REFRESH_INTERVAL = 300  # 5 minutes

SOURCE_PRIORITY: dict[str, list[str]] = {
    "quote": ["eastmoney", "sina"],
    "kline_daily": ["eastmoney", "yahoo", "sina"],
    "kline_minute": ["eastmoney"],
    "pe_ttm": ["xueqiu"],
    "money_flow": ["eastmoney"],
}
