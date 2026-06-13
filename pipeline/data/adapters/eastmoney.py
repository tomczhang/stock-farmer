"""东财 push2 / push2his adapter。

push2  stock/get       → 单只实时行情（免费高频）
push2  ulist.np/get    → 批量实时行情（fltt=2 直接浮点）
push2his kline/get     → 多周期 K 线（高频需代理）
push2his fflow/daykline → 日级资金流
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

import json as _json
import ssl
import urllib.request
from urllib.parse import urlencode

import pandas as pd
import requests

from ..types import AdapterError, MoneyFlowDay, Quote, market_of

_PUSH2_QUOTE = "https://push2.eastmoney.com/api/qt/stock/get"
_PUSH2_BATCH = "https://push2.eastmoney.com/api/qt/ulist.np/get"
_PUSH2HIS_KLINE = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
_PUSH2HIS_FLOW = "https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get"

_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
)

_PERIOD_MAP = {
    "1d": 101, "1w": 102, "1mo": 103,
    "5m": 5, "15m": 15, "30m": 30, "60m": 60,
}

_FQT_MAP = {"qfq": 1, "hfq": 2, "none": 0}

# secid prefix: 105=NASDAQ, 106=NYSE, 107=US_ETF, 116=HK
_PREFIX_DEFAULT = 105

_SECID_OVERRIDES: dict[str, int] = {
    "SPY": 107, "QQQ": 107, "IWM": 107, "DIA": 107, "VOO": 107,
    "VTI": 107, "ARKK": 107, "XLF": 107, "XLE": 107, "GLD": 107,
    "BABA": 106, "JD": 106, "NIO": 106, "PDD": 106, "TME": 106,
    "BIDU": 106, "LI": 106, "ZTO": 106, "VIPS": 106,
}


def _to_secid(ticker: str) -> str:
    mkt = market_of(ticker)
    if mkt == "HK":
        digits = ticker.upper().replace(".HK", "").lstrip("0").zfill(5)
        return f"116.{digits}"
    code = ticker.upper()
    prefix = _SECID_OVERRIDES.get(code, _PREFIX_DEFAULT)
    return f"{prefix}.{code}"


def _session(proxy: str | None = None, timeout: int = 10) -> requests.Session:
    s = requests.Session()
    s.trust_env = False
    s.headers["User-Agent"] = _UA
    if proxy:
        s.proxies = {"http": proxy, "https": proxy}
    else:
        s.proxies = {"http": None, "https": None}
    return s


_SSL_CTX = ssl.create_default_context()


def _get_json(url: str, params: dict, timeout: int = 10) -> dict:
    """fallback — 先试 urllib，再试 curl。"""
    full_url = f"{url}?{urlencode(params)}"
    req = urllib.request.Request(full_url, headers={"User-Agent": _UA})
    try:
        with urllib.request.urlopen(req, context=_SSL_CTX, timeout=timeout) as resp:
            return _json.loads(resp.read())
    except Exception:
        pass
    # curl fallback
    import subprocess
    try:
        result = subprocess.run(
            ["curl", "-s", "--max-time", str(timeout), "-H", f"User-Agent: {_UA}", full_url],
            capture_output=True, text=True, timeout=timeout + 5,
        )
        if result.returncode == 0 and result.stdout.strip():
            return _json.loads(result.stdout)
    except Exception:
        pass
    raise AdapterError("eastmoney", f"all transports failed for {url}")


# ---------- 实时行情 ----------

def fetch_quotes(
    tickers: list[str],
    *,
    timeout: int = 10,
    proxy: str | None = None,
) -> list[Quote]:
    """批量实时行情（ulist.np/get + fltt=2）。"""
    if not tickers:
        return []
    secids = ",".join(_to_secid(t) for t in tickers)
    params = {
        "secids": secids,
        "fields": "f2,f3,f4,f5,f6,f7,f12,f13,f14,f15,f16,f17,f18",
        "fltt": 2,
    }
    try:
        s = _session(proxy, timeout)
        r = s.get(_PUSH2_BATCH, params=params, timeout=timeout)
        r.raise_for_status()
        resp_data = r.json()
    except requests.RequestException:
        resp_data = _get_json(_PUSH2_BATCH, params, timeout)

    data = resp_data.get("data")
    if not data:
        raise AdapterError("eastmoney", "empty response from ulist.np")

    diff = data.get("diff", [])
    if isinstance(diff, dict):
        diff = list(diff.values())

    ticker_map = {_to_secid(t).split(".")[-1]: t for t in tickers}

    out: list[Quote] = []
    for item in diff:
        code = item.get("f12", "")
        original_ticker = ticker_map.get(code, code)
        out.append(Quote(
            ticker=original_ticker,
            name=item.get("f14"),
            price=item.get("f2"),
            high=item.get("f15"),
            low=item.get("f16"),
            open=item.get("f17"),
            prev_close=item.get("f18"),
            volume=item.get("f5"),
            amount=item.get("f6"),
            change_pct=item.get("f3"),
            change_amount=item.get("f4"),
            turnover_rate=item.get("f7"),
        ))
    return out


# ---------- K 线 ----------

def fetch_klines(
    ticker: str,
    period: str = "1d",
    count: int = 250,
    adjust: str = "qfq",
    *,
    timeout: int = 10,
    proxy: str | None = None,
) -> pd.DataFrame:
    """多周期 K 线（push2his kline/get）。"""
    klt = _PERIOD_MAP.get(period)
    if klt is None:
        raise AdapterError("eastmoney", f"unsupported period: {period}")
    fqt = _FQT_MAP.get(adjust, 1)
    secid = _to_secid(ticker)

    params = {
        "secid": secid,
        "klt": klt,
        "fqt": fqt,
        "beg": "19000101",
        "end": "20500101",
        "fields1": "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
        "rtntype": "6",
    }

    try:
        s = _session(proxy, timeout)
        r = s.get(_PUSH2HIS_KLINE, params=params, timeout=timeout)
        r.raise_for_status()
        resp_data = r.json()
    except requests.RequestException:
        resp_data = _get_json(_PUSH2HIS_KLINE, params, timeout)

    data = resp_data.get("data", {})
    klines = data.get("klines", [])
    if not klines:
        raise AdapterError("eastmoney", f"no kline data for {ticker} period={period}")

    rows: list[dict[str, Any]] = []
    for line in klines:
        parts = line.split(",")
        if len(parts) < 6:
            continue
        rows.append({
            "date": parts[0],
            "open": float(parts[1]),
            "close": float(parts[2]),
            "high": float(parts[3]),
            "low": float(parts[4]),
            "volume": int(float(parts[5])),
            "amount": float(parts[6]) if len(parts) > 6 else None,
        })

    df = pd.DataFrame(rows)
    if not df.empty and "date" in df.columns:
        df = df.sort_values("date").reset_index(drop=True)
    if count and len(df) > count:
        df = df.tail(count).reset_index(drop=True)
    return df


# ---------- 资金流向 ----------

def fetch_money_flow(
    ticker: str,
    days: int = 30,
    *,
    timeout: int = 10,
    proxy: str | None = None,
) -> list[MoneyFlowDay]:
    secid = _to_secid(ticker)
    params = {
        "secid": secid,
        "fields1": "f1,f2,f3,f7",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65",
    }
    try:
        s = _session(proxy, timeout)
        r = s.get(_PUSH2HIS_FLOW, params=params, timeout=timeout)
        r.raise_for_status()
        resp_data = r.json()
    except requests.RequestException:
        resp_data = _get_json(_PUSH2HIS_FLOW, params, timeout)

    data = resp_data.get("data", {})
    klines = data.get("klines", [])
    out: list[MoneyFlowDay] = []
    for line in klines:
        parts = line.split(",")
        if len(parts) < 13:
            continue
        out.append(MoneyFlowDay(
            date=parts[0],
            main_net_inflow=float(parts[1]),
            small_net_inflow=float(parts[5]),
            medium_net_inflow=float(parts[3]),
            large_net_inflow=float(parts[7]),
            xlarge_net_inflow=float(parts[9]),
            main_net_pct=float(parts[2]),
            close=float(parts[11]) if parts[11] != "-" else None,
            change_pct=float(parts[12]) if parts[12] != "-" else None,
        ))

    if days and len(out) > days:
        out = out[-days:]
    return out
