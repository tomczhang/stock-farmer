"""multpl.com S&P 500 历史 PE-TTM 爬取（月度数据，1871 年至今）。

数据源：https://www.multpl.com/s-p-500-pe-ratio/table/by-month
- 月度粒度（每月 1 号；当月最新会标 † 表示 Estimate）
- 基于 Robert Shiller 数据集，业内公认的 S&P 500 估值标准
- 最新月份数据滞后 ~1-2 周

输出格式与雪球路径对齐：[{date, close_adj, pe_ttm}, ...]
- close_adj: 该月 S&P 500 价格（来自姊妹页 /s-p-500-historical-prices/）
- date 是月初日期 YYYY-MM-01；最新月份用 multpl 提供的具体日期
"""
from __future__ import annotations

import re
from datetime import date, datetime
from typing import Any

import requests

_PE_URL = "https://www.multpl.com/s-p-500-pe-ratio/table/by-month"
_PRICE_URL = "https://www.multpl.com/s-p-500-historical-prices/table/by-month"

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html",
}

# multpl 的表格行：<td>{date}</td><td>(中间可能有 abbr/&#x2002;) {value}</td>
# 数值可能带千位逗号 (S&P 500 价格 7,503.26)
_ROW_RE = re.compile(
    r"<td>([A-Z][a-z]{2}\s+\d{1,2},\s*\d{4})</td>\s*<td[^>]*>(?:.*?)([0-9]{1,3}(?:,[0-9]{3})*\.[0-9]+)\s*</td>",
    re.DOTALL,
)


def _parse_num(s: str) -> float:
    return float(s.replace(",", ""))


def _fetch_table(url: str, session: requests.Session | None = None) -> list[tuple[str, float]]:
    s = session or requests.Session()
    s.trust_env = False  # 防本地代理截断
    r = s.get(url, headers=_HEADERS, timeout=30)
    r.raise_for_status()
    rows = _ROW_RE.findall(r.text)
    out: list[tuple[str, float]] = []
    for date_str, val_str in rows:
        try:
            dt = datetime.strptime(date_str, "%b %d, %Y")
            out.append((dt.strftime("%Y-%m-%d"), _parse_num(val_str)))
        except (ValueError, TypeError):
            continue
    return out


def fetch_sp500_pe_history(
    *,
    since: date | None = None,
    session: requests.Session | None = None,
) -> list[dict]:
    """拉 S&P 500 月度 PE-TTM + 价格历史，合并为 [{date, close_adj, pe_ttm}]。

    `since`: 只返回 date > since 的行（增量拉取用）。

    返回按 date 升序；缺少价格数据的月份 close_adj=None；缺少 PE 的不输出。
    """
    sess = session or requests.Session()
    sess.trust_env = False

    pe_rows = _fetch_table(_PE_URL, sess)
    price_rows = _fetch_table(_PRICE_URL, sess)

    if not pe_rows:
        raise RuntimeError("multpl: no PE rows parsed (HTML structure may have changed)")

    # 价格按 date 索引
    price_by_date = dict(price_rows)

    # 价格表通常只到月初，PE 表会含最新非月初日期（如 2026-05-21 estimate）
    # 对最新非月初的 PE，价格用最近一个月的（前向填充）
    sorted_price_dates = sorted(price_by_date.keys())

    def _nearest_price(target: str) -> float | None:
        if target in price_by_date:
            return price_by_date[target]
        # 找 <= target 的最大价格日期
        candidates = [d for d in sorted_price_dates if d <= target]
        if not candidates:
            return None
        return price_by_date[candidates[-1]]

    out: list[dict] = []
    cutoff = since.isoformat() if isinstance(since, (date, datetime)) else (str(since) if since else None)
    for d, pe in pe_rows:
        if cutoff and d <= cutoff:
            continue
        out.append({
            "date": d,
            "close_adj": _nearest_price(d),
            "pe_ttm": pe,
        })
    out.sort(key=lambda r: r["date"])
    return out
