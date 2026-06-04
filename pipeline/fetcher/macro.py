"""宏观指标抓取：VIX、信用利差、期限利差、标普趋势与均线斜率。

数据源：
- VIX / S&P 500 日线 → Yahoo Finance Chart v8（复用 prices.py 同款接口）
- 期限利差 (10Y-2Y)、高收益债利差 → FRED API（免费，需 API key）

环境变量：
- FRED_API_KEY: FRED API 密钥（必须）

输出格式统一为 [{date, value}, ...] 按日期升序。
"""
from __future__ import annotations

import os
from datetime import date, datetime
from typing import Any

import numpy as np
import requests

_YAHOO_CHART_URL = "https://query2.finance.yahoo.com/v8/finance/chart/{symbol}"
_YAHOO_CRUMB_URL = "https://query2.finance.yahoo.com/v1/test/getcrumb"
_YAHOO_CONSENT_URL = "https://finance.yahoo.com"
_YAHOO_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
    )
}

_FRED_URL = "https://api.stlouisfed.org/fred/series/observations"

# FRED series IDs
FRED_TERM_SPREAD = "T10Y2Y"  # 10年-2年期限利差
FRED_HY_SPREAD = "BAMLH0A0HYM2"  # ICE BofA 高收益债 OAS
FRED_VIX = "VIXCLS"  # CBOE VIX (FRED 镜像，日度)
FRED_SP500 = "SP500"  # S&P 500 日线 (FRED 镜像)


def _get_fred_api_key() -> str:
    key = os.getenv("FRED_API_KEY", "")
    if not key:
        raise RuntimeError(
            "FRED_API_KEY environment variable not set. "
            "Get a free key at https://fred.stlouisfed.org/docs/api/api_key.html"
        )
    return key


# ---------- Yahoo (带 session 防 429) ----------

class _YahooSession:
    """Yahoo Finance session，先拿 cookie + crumb 避免 429。"""

    def __init__(self) -> None:
        self._session: requests.Session | None = None
        self._crumb: str | None = None

    def _ensure(self) -> requests.Session:
        if self._session is None:
            s = requests.Session()
            s.headers.update(_YAHOO_HEADERS)
            # 访问首页拿 consent cookie
            s.get(_YAHOO_CONSENT_URL, timeout=10)
            # 拿 crumb
            r = s.get(_YAHOO_CRUMB_URL, timeout=10)
            if r.status_code == 200 and r.text.strip():
                self._crumb = r.text.strip()
            self._session = s
        return self._session

    @property
    def crumb(self) -> str | None:
        self._ensure()
        return self._crumb

    def get_chart(self, symbol: str, range_: str, interval: str = "1d") -> dict:
        s = self._ensure()
        params: dict[str, str] = {"interval": interval, "range": range_}
        if self._crumb:
            params["crumb"] = self._crumb
        r = s.get(
            _YAHOO_CHART_URL.format(symbol=symbol),
            params=params,
            timeout=15,
        )
        r.raise_for_status()
        return r.json()

    def reset(self) -> None:
        self._session = None
        self._crumb = None


_YAHOO_SESSION = _YahooSession()


def _fetch_yahoo_chart(symbol: str, range_: str, interval: str = "1d") -> list[dict]:
    """Yahoo chart v8 → [{date, close}, ...]"""
    payload = _YAHOO_SESSION.get_chart(symbol, range_=range_, interval=interval)
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
        out.append({
            "date": datetime.utcfromtimestamp(ts).strftime("%Y-%m-%d"),
            "close": close_f,
        })
    return out


# ---------- FRED 通用 ----------

def _fetch_fred_series(
    series_id: str,
    observation_start: str = "2015-01-01",
    observation_end: str | None = None,
) -> list[dict]:
    """FRED API → [{date, value}, ...]（过滤掉缺失值 '.'）"""
    params: dict[str, str] = {
        "series_id": series_id,
        "api_key": _get_fred_api_key(),
        "file_type": "json",
        "observation_start": observation_start,
    }
    if observation_end:
        params["observation_end"] = observation_end
    r = requests.get(_FRED_URL, params=params, timeout=15)
    r.raise_for_status()
    observations = r.json().get("observations") or []
    out: list[dict] = []
    for obs in observations:
        val = obs.get("value", ".")
        if val == "." or val is None:
            continue
        try:
            out.append({"date": obs["date"], "value": float(val)})
        except (TypeError, ValueError, KeyError):
            continue
    return out


# ---------- 公开接口 ----------

def fetch_vix(
    range_: str = "10y",
    observation_start: str = "2015-01-01",
) -> list[dict]:
    """拉取 VIX 日线。

    优先用 Yahoo（更实时），Yahoo 失败则 fallback 到 FRED (VIXCLS)。
    返回 [{date, value}, ...]，value 为 VIX 收盘值。
    """
    try:
        rows = _fetch_yahoo_chart("^VIX", range_=range_)
        if rows:
            return [{"date": r["date"], "value": r["close"]} for r in rows]
    except Exception:
        pass
    # fallback: FRED VIXCLS
    return _fetch_fred_series(FRED_VIX, observation_start=observation_start)


def fetch_sp500(
    range_: str = "2y",
    observation_start: str = "2024-01-01",
) -> list[dict]:
    """拉取 S&P 500 日线。

    优先用 Yahoo（更实时），失败则 fallback 到 FRED (SP500)。
    返回 [{date, close}, ...]。
    """
    try:
        rows = _fetch_yahoo_chart("^GSPC", range_=range_)
        if rows:
            return rows
    except Exception:
        pass
    # fallback: FRED SP500
    fred_rows = _fetch_fred_series(FRED_SP500, observation_start=observation_start)
    return [{"date": r["date"], "close": r["value"]} for r in fred_rows]


def fetch_term_spread(observation_start: str = "2015-01-01") -> list[dict]:
    """拉取 10Y-2Y 期限利差（FRED T10Y2Y）。

    返回 [{date, value}, ...]，value 单位为百分点。
    """
    return _fetch_fred_series(FRED_TERM_SPREAD, observation_start=observation_start)


def fetch_hy_spread(observation_start: str = "2015-01-01") -> list[dict]:
    """拉取高收益债利差（FRED BAMLH0A0HYM2, ICE BofA HY OAS）。

    返回 [{date, value}, ...]，value 单位为百分点。
    """
    return _fetch_fred_series(FRED_HY_SPREAD, observation_start=observation_start)


# ---------- 计算型指标 ----------

def calc_moving_average(prices: list[dict], period: int = 200) -> list[dict]:
    """计算收盘价的简单移动平均线。

    输入 [{date, close}, ...]（升序），返回 [{date, close, ma}, ...]。
    前 period-1 根的 ma 为 None。
    """
    closes = [p["close"] for p in prices]
    n = len(closes)
    out: list[dict] = []
    for i in range(n):
        ma = None
        if i >= period - 1:
            ma = sum(closes[i - period + 1 : i + 1]) / period
        out.append({"date": prices[i]["date"], "close": closes[i], "ma": ma})
    return out


def calc_ma_slope(prices: list[dict], ma_period: int = 200, lookback: int = 20) -> float | None:
    """计算均线最近 lookback 天的斜率（归一化为年化百分比）。

    返回值含义：正数=均线上行，负数=均线下行。
    例如返回 12.5 表示均线以年化 12.5% 的速率上升。
    数据不足时返回 None。
    """
    ma_data = calc_moving_average(prices, period=ma_period)
    ma_values = [r["ma"] for r in ma_data if r["ma"] is not None]
    if len(ma_values) < lookback:
        return None
    recent = np.array(ma_values[-lookback:])
    x = np.arange(lookback, dtype=np.float64)
    slope = float(np.polyfit(x, recent, 1)[0])
    # 归一化：日斜率 → 年化百分比
    base = recent[0] if recent[0] != 0 else 1.0
    annual_pct = (slope / base) * 252 * 100
    return round(annual_pct, 2)


def detect_trend_reversal(
    prices: list[dict],
    short_ma: int = 50,
    long_ma: int = 200,
) -> dict:
    """检测标普趋势反转信号（MA50/MA200 金叉死叉 + 价格与 MA200 的关系）。

    返回：
    {
        "signal": "golden_cross" | "death_cross" | "reclaim_ma200" | "break_ma200" | "none",
        "date": 最近一次信号发生日期,
        "price_vs_ma200": "above" | "below",
        "ma50_vs_ma200": "above" | "below",
        "description": 中文描述,
    }
    """
    if len(prices) < long_ma + 2:
        return {
            "signal": "none",
            "date": None,
            "price_vs_ma200": None,
            "ma50_vs_ma200": None,
            "description": "数据不足，无法判断趋势",
        }

    closes = [p["close"] for p in prices]
    n = len(closes)

    def _sma(idx: int, period: int) -> float:
        return sum(closes[idx - period + 1 : idx + 1]) / period

    # 计算最近两天的 MA50 和 MA200
    ma50_today = _sma(n - 1, short_ma)
    ma50_yest = _sma(n - 2, short_ma)
    ma200_today = _sma(n - 1, long_ma)
    ma200_yest = _sma(n - 2, long_ma)
    price_today = closes[-1]
    price_yest = closes[-2]

    last_date = prices[-1]["date"]
    price_vs = "above" if price_today > ma200_today else "below"
    ma50_vs = "above" if ma50_today > ma200_today else "below"

    # 金叉：MA50 从下方穿越 MA200
    if ma50_yest <= ma200_yest and ma50_today > ma200_today:
        signal = "golden_cross"
        desc = f"MA50 上穿 MA200（金叉），趋势转多"
    # 死叉：MA50 从上方跌破 MA200
    elif ma50_yest >= ma200_yest and ma50_today < ma200_today:
        signal = "death_cross"
        desc = f"MA50 下穿 MA200（死叉），趋势转空"
    # 价格重新站上 MA200
    elif price_yest <= ma200_yest and price_today > ma200_today:
        signal = "reclaim_ma200"
        desc = f"价格重新站上 MA200，短期企稳"
    # 价格跌破 MA200
    elif price_yest >= ma200_yest and price_today < ma200_today:
        signal = "break_ma200"
        desc = f"价格跌破 MA200，短期转弱"
    else:
        signal = "none"
        desc = f"无新信号。价格{'在' if price_vs == 'above' else '低于'} MA200 {'上方' if price_vs == 'above' else ''}，MA50 {'在' if ma50_vs == 'above' else '低于'} MA200 {'上方' if ma50_vs == 'above' else ''}"

    return {
        "signal": signal,
        "date": last_date,
        "price_vs_ma200": price_vs,
        "ma50_vs_ma200": ma50_vs,
        "description": desc,
    }


def fetch_macro_snapshot(sp500_range: str = "2y") -> dict:
    """一次性拉取所有宏观指标，返回当前快照。

    返回：
    {
        "vix": {latest_date, value},
        "term_spread": {latest_date, value},
        "hy_spread": {latest_date, value},
        "sp500_trend": {signal, description, ...},
        "ma200_slope": float (年化百分比),
        "fetched_at": ISO timestamp,
    }
    """
    vix_data = fetch_vix(range_="3mo")
    term_data = fetch_term_spread(observation_start="2024-01-01")
    hy_data = fetch_hy_spread(observation_start="2024-01-01")
    sp500_data = fetch_sp500(range_=sp500_range)

    snapshot: dict[str, Any] = {
        "fetched_at": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
    }

    if vix_data:
        latest = vix_data[-1]
        snapshot["vix"] = {"date": latest["date"], "value": latest["value"]}
    else:
        snapshot["vix"] = None

    if term_data:
        latest = term_data[-1]
        snapshot["term_spread"] = {"date": latest["date"], "value": latest["value"]}
    else:
        snapshot["term_spread"] = None

    if hy_data:
        latest = hy_data[-1]
        snapshot["hy_spread"] = {"date": latest["date"], "value": latest["value"]}
    else:
        snapshot["hy_spread"] = None

    if sp500_data:
        snapshot["sp500_trend"] = detect_trend_reversal(sp500_data)
        snapshot["ma200_slope"] = calc_ma_slope(sp500_data, ma_period=200, lookback=20)
    else:
        snapshot["sp500_trend"] = None
        snapshot["ma200_slope"] = None

    return snapshot
