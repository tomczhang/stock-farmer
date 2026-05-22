"""雪球 K 线 + 估值 history 接口。

为什么用雪球：
- 直接返回每日 PE-TTM（已经处理好 IFRS / Non-IFRS / 货币换算等口径问题）
- 港美股都支持，零密钥（只需 cookie）
- 与雪球 / 富途 / Bloomberg 等主流平台口径一致

替代了我们原本基于"价格 + EPS 自己拼 TTM"的复杂路径——那条路径在港股
（东财 YTD 累计 + RMB/HKD 货币错配）和美股老股拆股重述上都有坑。

接口：
- POST 一次 GET 到 xueqiu.com 拿 cookie
- GET stock.xueqiu.com/v5/stock/chart/kline.json
  params: symbol, begin (timestamp ms), period=day, type=before (前复权),
          count=负数表示往前 N 个交易日, indicator=kline,pe[,pb,ps]
  返回 columns + items 二维数组，含 close 和 pe 列
"""
from __future__ import annotations

import time
from datetime import date, datetime, timedelta, timezone
from typing import Any

import requests

from .ticker_normalize import market_of

# Xueqiu day-bar 的 timestamp 实际是"市场本地午夜" UTC：
#   HK 0700: ts = HKT 5/22 00:00 = UTC 5/21 16:00 → 对应 trading day 5/22 (HKT)
#   US AAPL: ts = EST 5/21 00:00 = UTC 5/21 04:00 → 对应 trading day 5/21 (EST)
# 把 timestamp 加 8 小时再取日期，HK / US 都能拿到正确的交易日。
_DATE_OFFSET = timedelta(hours=8)

_XUEQIU_INDEX = "https://xueqiu.com"
_XUEQIU_KLINE = "https://stock.xueqiu.com/v5/stock/chart/kline.json"
_XUEQIU_QUOTE = "https://stock.xueqiu.com/v5/stock/quote.json"


def _symbol_for_xueqiu(ticker: str) -> str:
    """ticker → 雪球 symbol。
    - 港股 0700.HK → 00700（5 位数字，无后缀）
    - 美股 AAPL → AAPL（原样）
    """
    if market_of(ticker) == "HK":
        # 提取数字部分，左补 0 到 5 位
        digits = ticker.upper().replace(".HK", "")
        return digits.lstrip("0").zfill(5)
    return ticker.upper()


class XueqiuSession:
    """封装 cookie 获取与请求重试。

    雪球的 K 线接口需要先访问首页拿到 `xq_a_token` / `device_id` 等 cookie。
    本类用模块级单例 + 懒加载，避免每次请求都重复获取。
    """

    def __init__(self) -> None:
        self._session: requests.Session | None = None

    def _ensure(self) -> requests.Session:
        if self._session is None:
            s = requests.Session()
            s.trust_env = False  # 避免被本地代理截断
            s.headers.update(
                {
                    "User-Agent": (
                        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/130.0.0.0 Safari/537.36"
                    ),
                    "Accept": "application/json, text/plain, */*",
                }
            )
            s.get(_XUEQIU_INDEX, timeout=15)  # 拿 cookie
            self._session = s
        return self._session

    def get(self, url: str, params: dict, referer: str | None = None) -> dict:
        s = self._ensure()
        headers = {"Referer": referer or _XUEQIU_INDEX}
        r = s.get(url, params=params, headers=headers, timeout=30)
        r.raise_for_status()
        return r.json()

    def reset(self) -> None:
        """cookie 失效时强制重新获取（外部按需调用）。"""
        self._session = None


_SESSION = XueqiuSession()


def _parse_kline_response(d: dict) -> list[dict]:
    """雪球 K 线响应 → [{date, close_adj, pe_ttm}, ...]"""
    if d.get("error_code") != 0:
        raise RuntimeError(f"xueqiu error: {d.get('error_description') or d}")
    data = d.get("data") or {}
    cols = data.get("column") or []
    items = data.get("item") or []
    if not cols or not items:
        return []
    idx_ts = cols.index("timestamp")
    idx_close = cols.index("close")
    idx_pe = cols.index("pe") if "pe" in cols else -1

    out: list[dict] = []
    for row in items:
        ts = row[idx_ts]
        close = row[idx_close]
        pe = row[idx_pe] if idx_pe >= 0 else None
        if close in (None, 0):
            continue
        try:
            close_f = float(close)
        except (TypeError, ValueError):
            continue
        try:
            pe_f = float(pe) if pe is not None else None
        except (TypeError, ValueError):
            pe_f = None
        bar_date = (
            datetime.fromtimestamp(ts / 1000, tz=timezone.utc) + _DATE_OFFSET
        ).strftime("%Y-%m-%d")
        out.append(
            {
                "date": bar_date,
                "close_adj": close_f,
                "pe_ttm": pe_f,
            }
        )
    # 按日期去重 + 升序
    by_date: dict[str, dict] = {}
    for r in out:
        by_date[r["date"]] = r
    return sorted(by_date.values(), key=lambda r: r["date"])


def fetch_pe_history(
    ticker: str,
    *,
    years: int = 10,
    since: date | None = None,
    session: XueqiuSession | None = None,
) -> list[dict]:
    """拉取一只股票的日度价格 + PE-TTM 历史。

    返回 `[{date, close_adj, pe_ttm}, ...]` 升序。

    `years` 用于估算 count（雪球用 `count=-N` 表示往前 N 个交易日，250/年）。
    `since` 给增量拉取用：只返回 since 之后的数据。
    """
    sess = session or _SESSION
    symbol = _symbol_for_xueqiu(ticker)
    now_ms = int(time.time() * 1000)
    count = -years * 260  # 留点余量
    d = sess.get(
        _XUEQIU_KLINE,
        {
            "symbol": symbol,
            "begin": now_ms,
            "period": "day",
            "type": "before",  # 前复权
            "count": str(count),
            "indicator": "kline,pe",
        },
        referer=f"{_XUEQIU_INDEX}/S/{symbol}",
    )
    rows = _parse_kline_response(d)
    if since is not None:
        cutoff = since.isoformat() if isinstance(since, (date, datetime)) else str(since)
        rows = [r for r in rows if r["date"] > cutoff]
    return rows


def fetch_current_pe(ticker: str, session: XueqiuSession | None = None) -> dict:
    """拉取当前 quote 含 pe_ttm / pe_lyr / pe_forecast，用于 sanity check。"""
    sess = session or _SESSION
    symbol = _symbol_for_xueqiu(ticker)
    d = sess.get(
        _XUEQIU_QUOTE,
        {"symbol": symbol, "extend": "detail"},
        referer=f"{_XUEQIU_INDEX}/S/{symbol}",
    )
    quote = ((d.get("data") or {}).get("quote")) or {}
    return {
        "pe_ttm": quote.get("pe_ttm"),
        "pe_lyr": quote.get("pe_lyr"),
        "pe_forecast": quote.get("pe_forecast"),
        "current_price": quote.get("current"),
        "eps_ttm": quote.get("eps"),
    }
