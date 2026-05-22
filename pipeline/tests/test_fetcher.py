"""Fetcher 层单测。

ticker_normalize 完全本地，无需 mock。
prices / eps 通过 monkeypatch 替换 `global_stock_data` 里被 import 进 fetcher 模块的函数引用。
"""
from __future__ import annotations

from datetime import date

import pytest

from fetcher import eps as eps_mod
from fetcher import prices as prices_mod
from fetcher.ticker_normalize import market_of, to_eastmoney, to_yahoo


# ---------------- ticker_normalize ----------------

@pytest.mark.parametrize(
    "raw, expected",
    [
        ("0700.HK", "0700.HK"),
        ("00700.HK", "0700.HK"),  # 5 位 -> 4 位
        ("700.HK", "0700.HK"),    # 3 位 -> 4 位
        ("9988.HK", "9988.HK"),
        ("09988.HK", "9988.HK"),
        ("0700.hk", "0700.HK"),   # 大小写不敏感
        ("AAPL", "AAPL"),
        ("BRK.B", "BRK.B"),       # 含点但非 .HK
        ("BABA", "BABA"),
    ],
)
def test_to_yahoo(raw: str, expected: str) -> None:
    assert to_yahoo(raw) == expected


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("0700.HK", "00700.HK"),
        ("00700.HK", "00700.HK"),
        ("700.HK", "00700.HK"),
        ("9988.HK", "09988.HK"),
        ("AAPL", "AAPL"),
    ],
)
def test_to_eastmoney(raw: str, expected: str) -> None:
    assert to_eastmoney(raw) == expected


@pytest.mark.parametrize(
    "ticker, market",
    [
        ("AAPL", "US"),
        ("BABA", "US"),
        ("BRK.B", "US"),
        ("0700.HK", "HK"),
        ("9988.HK", "HK"),
        ("0700.hk", "HK"),
    ],
)
def test_market_of(ticker: str, market: str) -> None:
    assert market_of(ticker) == market


# ---------------- prices ----------------

def _patch_chart(monkeypatch: pytest.MonkeyPatch, rows: list[dict], record: dict | None = None) -> None:
    """Patch prices_mod._fetch_yahoo_chart with a fake返回固定 rows。
    rows 已经是 {date, close_adj} 形式。可选 record 字典用于记录调用参数。"""
    def fake(symbol, range_, interval="1d"):
        if record is not None:
            record["symbol"] = symbol
            record["range"] = range_
            record["interval"] = interval
        return rows
    monkeypatch.setattr(prices_mod, "_fetch_yahoo_chart", fake)


def test_fetch_full_history_normal(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: dict = {}
    _patch_chart(
        monkeypatch,
        [
            {"date": "2024-01-02", "close_adj": 150.5},
            {"date": "2024-01-03", "close_adj": 151.0},
        ],
        record=calls,
    )
    rows = prices_mod.fetch_full_history("0700.HK")
    assert calls["symbol"] == "0700.HK"
    assert calls["range"] == "max"
    assert calls["interval"] == "1d"
    assert rows == [
        {"date": "2024-01-02", "close_adj": 150.5},
        {"date": "2024-01-03", "close_adj": 151.0},
    ]


def test_fetch_full_history_dedupes(monkeypatch: pytest.MonkeyPatch) -> None:
    """同一日期重复行（_fetch_yahoo_chart 通常不会出，但 fetch_full_history 自带去重）。"""
    _patch_chart(
        monkeypatch,
        [
            {"date": "2024-01-02", "close_adj": 100.0},
            {"date": "2024-01-02", "close_adj": 101.0},
            {"date": "2024-01-03", "close_adj": 50.0},
        ],
    )
    rows = prices_mod.fetch_full_history("AAPL")
    assert rows == [
        {"date": "2024-01-02", "close_adj": 101.0},  # 后写入覆盖前者
        {"date": "2024-01-03", "close_adj": 50.0},
    ]


def test_fetch_full_history_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_chart(monkeypatch, [])
    assert prices_mod.fetch_full_history("AAPL") == []


def test_fetch_incremental_filters_old_dates(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_chart(
        monkeypatch,
        [
            {"date": "2024-01-02", "close_adj": 1.0},
            {"date": "2024-01-03", "close_adj": 2.0},
            {"date": "2024-01-04", "close_adj": 3.0},
        ],
    )
    rows = prices_mod.fetch_incremental("AAPL", since=date(2024, 1, 3))
    assert rows == [{"date": "2024-01-04", "close_adj": 3.0}]


def test_fetch_incremental_normalizes_hk_ticker(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict = {}
    _patch_chart(monkeypatch, [], record=seen)
    prices_mod.fetch_incremental("00700.HK", since=date(2024, 1, 1))
    assert seen["symbol"] == "0700.HK"
    assert seen["range"] == "3mo"


def test_fetch_yahoo_chart_real_api() -> None:
    """对 Yahoo chart v8 的契约测试：确保 range/interval 参数实际生效（非 mock）。

    跳过条件：网络不可达；正常情况下应拿到 ≥ 2000 根（10y * 250 交易日）。
    """
    import pytest as _pytest
    try:
        rows = prices_mod._fetch_yahoo_chart("AAPL", range_="10y", interval="1d")
    except Exception as e:
        _pytest.skip(f"network unavailable: {e}")
    if len(rows) < 1500:
        _pytest.fail(f"Yahoo returned only {len(rows)} bars — params likely not honored")
    assert seen["range"] == "3mo"


# ---------------- eps ----------------

def test_fetch_quarterly_eps_normal(monkeypatch: pytest.MonkeyPatch) -> None:
    """模拟东财港股全年 4 期累计数据，验证 YTD→单季差分。

    构造：FY2024 全年 EPS=4.00，9M=3.00, H1=2.00, Q1=1.00 → 单季均为 1.00。
    """
    seen = {}

    def fake(secucode: str, page_size: int = 4) -> list[dict]:
        seen["secucode"] = secucode
        seen["page_size"] = page_size
        # 倒序返回
        return [
            {"REPORT_DATE": "2024-12-31 00:00:00", "REPORT_TYPE": "2024/FY",
             "BASIC_EPS": "4.00", "DILUTED_EPS": "3.80"},
            {"REPORT_DATE": "2024-09-30", "REPORT_TYPE": "2024/Q9",
             "BASIC_EPS": 3.00, "DILUTED_EPS": 2.85},
            {"REPORT_DATE": "2024-06-30", "REPORT_TYPE": "2024/Q6",
             "BASIC_EPS": 2.00, "DILUTED_EPS": 1.90},
            {"REPORT_DATE": "2024-03-31", "REPORT_TYPE": "2024/Q1",
             "BASIC_EPS": 1.00, "DILUTED_EPS": 0.95},
        ]

    monkeypatch.setattr(eps_mod, "key_indicators_eastmoney", fake)
    rows = eps_mod.fetch_quarterly_eps("0700.HK", page_size=20)
    assert seen == {"secucode": "00700.HK", "page_size": 20}
    # 升序，4 个单季度
    assert [r["period_end"] for r in rows] == ["2024-03-31", "2024-06-30", "2024-09-30", "2024-12-31"]
    # 单季都是 1.00
    for r in rows:
        assert r["eps_basic"] == 1.0
        assert r["eps_diluted"] == 0.95


def test_fetch_quarterly_eps_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(eps_mod, "key_indicators_eastmoney", lambda *a, **k: [])
    assert eps_mod.fetch_quarterly_eps("0700.HK") == []


def test_fetch_quarterly_eps_none_response(monkeypatch: pytest.MonkeyPatch) -> None:
    """东财在 5xx / 业务异常时可能返回 None。"""
    monkeypatch.setattr(eps_mod, "key_indicators_eastmoney", lambda *a, **k: None)
    assert eps_mod.fetch_quarterly_eps("0700.HK") == []


def test_fetch_quarterly_eps_handles_missing_fields(monkeypatch: pytest.MonkeyPatch) -> None:
    """字段缺失：BASIC_EPS 空字符串 / None；REPORT_DATE 缺失整行扔掉；同 (fy, type) 去重。"""
    monkeypatch.setattr(
        eps_mod,
        "key_indicators_eastmoney",
        lambda *a, **k: [
            {"REPORT_DATE": "2024-03-31", "REPORT_TYPE": "2024/Q1",
             "BASIC_EPS": "", "DILUTED_EPS": None},
            {"REPORT_DATE": None, "REPORT_TYPE": "2024/Q1",
             "BASIC_EPS": 1, "DILUTED_EPS": 1},  # 无 REPORT_DATE 整行丢
            {"REPORT_DATE": "2024-03-31", "REPORT_TYPE": "2024/Q1",
             "BASIC_EPS": "abc", "DILUTED_EPS": "1.1"},  # (2024, Q1) 重复，去重
        ],
    )
    # 用港股 ticker 触发东财路径；美股自 13.3 起走 SEC（见 test_sec_facts.py）
    rows = eps_mod.fetch_quarterly_eps("0700.HK")
    # Q1 直接是单季，且 basic 空字符串 → None
    assert rows == [{"period_end": "2024-03-31", "eps_basic": None, "eps_diluted": None}]


def test_fetch_quarterly_eps_invalid_string(monkeypatch: pytest.MonkeyPatch) -> None:
    """非法数字字符串 → None。"""
    monkeypatch.setattr(
        eps_mod,
        "key_indicators_eastmoney",
        lambda *a, **k: [
            {"REPORT_DATE": "2024-03-31", "REPORT_TYPE": "2024/Q1",
             "BASIC_EPS": "not-a-number", "DILUTED_EPS": 2.0},
        ],
    )
    rows = eps_mod.fetch_quarterly_eps("0700.HK")
    assert rows == [{"period_end": "2024-03-31", "eps_basic": None, "eps_diluted": 2.0}]


def test_fetch_quarterly_eps_partial_year(monkeypatch: pytest.MonkeyPatch) -> None:
    """财年内只有 Q1+Q6 (没到 Q9/FY) → 输出 Q1 + Q2 (差分)，不输出尚未发布的 Q3/Q4。"""
    monkeypatch.setattr(
        eps_mod,
        "key_indicators_eastmoney",
        lambda *a, **k: [
            {"REPORT_DATE": "2025-06-30", "REPORT_TYPE": "2025/Q6",
             "BASIC_EPS": 3.0, "DILUTED_EPS": 2.9},
            {"REPORT_DATE": "2025-03-31", "REPORT_TYPE": "2025/Q1",
             "BASIC_EPS": 1.2, "DILUTED_EPS": 1.1},
        ],
    )
    rows = eps_mod.fetch_quarterly_eps("0700.HK")
    assert rows == [
        {"period_end": "2025-03-31", "eps_basic": 1.2, "eps_diluted": 1.1},
        {"period_end": "2025-06-30", "eps_basic": 1.8, "eps_diluted": 1.8},  # 3.0 - 1.2 / 2.9 - 1.1
    ]
