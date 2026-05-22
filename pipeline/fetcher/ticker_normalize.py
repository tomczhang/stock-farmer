"""Ticker 代码归一化。

设计决策见 `openspec/changes/add-pe-percentile-viewer/design.md` 决策 10 之 2：
对外 / 存储 / Yahoo 调用统一用 4 位前缀的 `0700.HK`；调用东财时补成 5 位 `00700.HK`。
"""
from __future__ import annotations

import re
from typing import Literal

# 4 位 / 5 位 前缀的港股代码都能匹配；group(1) 是去掉前导 0 之外的数字部分。
_HK_RE = re.compile(r"^0*(\d{1,5})\.HK$", re.IGNORECASE)

# 指数 ticker（market='INDEX'，走 multpl 等指数源，不走雪球）
_INDEX_TICKERS = {"SPX", "NDX", "DJI"}


def market_of(ticker: str) -> Literal["US", "HK", "INDEX"]:
    """根据 ticker 后缀判断市场。
    - INDEX 列表 → INDEX
    - `*.HK` → HK
    - 其余 → US
    """
    if not ticker:
        raise ValueError("ticker must be a non-empty string")
    if ticker.upper() in _INDEX_TICKERS:
        return "INDEX"
    if ticker.upper().endswith(".HK"):
        return "HK"
    return "US"


def _hk_digits(ticker: str) -> str | None:
    """提取港股代码的纯数字部分（去掉前导 0），非港股返回 None。"""
    m = _HK_RE.match(ticker)
    if not m:
        return None
    digits = m.group(1)
    # 去掉前导 0 但保留至少 1 位
    return digits.lstrip("0") or "0"


def to_yahoo(ticker: str) -> str:
    """归一化为 Yahoo / 存储用的格式。

    - 港股：4 位前缀 (`0700.HK`、`9988.HK`)；不足 4 位左补 0；超过 4 位也保留 4 位前缀（取后 4 位会破坏代码，按原样保留至少 4 位）。
    - 美股：原样返回。
    """
    digits = _hk_digits(ticker)
    if digits is None:
        return ticker
    if len(digits) < 4:
        digits = digits.zfill(4)
    return f"{digits}.HK"


def to_eastmoney(ticker: str) -> str:
    """归一化为东财 secucode 格式。

    - 港股：5 位前缀 (`00700.HK`)；不足 5 位左补 0。
    - 美股：原样返回（东财对美股需 `AAPL.O` / `BABA.N` 后缀，但 MVP 不在此处处理）。
    """
    digits = _hk_digits(ticker)
    if digits is None:
        return ticker
    return f"{digits.zfill(5)}.HK"
