"""单元测试：fetcher.multpl

不发真实 HTTP；用 monkeypatch 替换 _fetch_table。
"""
from __future__ import annotations

from datetime import date

import pytest

from fetcher import multpl


def test_parse_num_handles_thousand_separator():
    assert multpl._parse_num("1,234.56") == 1234.56
    assert multpl._parse_num("7,503.26") == 7503.26
    assert multpl._parse_num("11.10") == 11.10


def test_row_regex_matches_estimate_and_normal():
    """multpl 表格行：含 abbr 估算标记 / &#x2002; 缩进 / 千位逗号。"""
    html = """
    <tr><td>May 21, 2026</td><td><abbr title="Estimate">†</abbr> 32.06</td></tr>
    <tr><td>May 1, 2026</td><td>&#x2002; 7,355.05</td></tr>
    """
    rows = multpl._ROW_RE.findall(html)
    assert ("May 21, 2026", "32.06") in rows
    assert ("May 1, 2026", "7,355.05") in rows


def test_fetch_sp500_pe_history_merges_pe_and_price(monkeypatch: pytest.MonkeyPatch):
    """主入口：拼合 PE + 价格表，得 [{date, close_adj, pe_ttm}, ...] 升序。"""

    def fake_fetch_table(url, session=None):
        if "pe-ratio" in url:
            return [("2024-01-01", 25.0), ("2024-02-01", 26.0), ("2024-03-01", 27.0)]
        if "historical-prices" in url:
            return [("2024-01-01", 5000.0), ("2024-02-01", 5100.0), ("2024-03-01", 5200.0)]
        return []

    monkeypatch.setattr(multpl, "_fetch_table", fake_fetch_table)
    rows = multpl.fetch_sp500_pe_history()
    assert rows == [
        {"date": "2024-01-01", "close_adj": 5000.0, "pe_ttm": 25.0},
        {"date": "2024-02-01", "close_adj": 5100.0, "pe_ttm": 26.0},
        {"date": "2024-03-01", "close_adj": 5200.0, "pe_ttm": 27.0},
    ]


def test_fetch_sp500_pe_history_uses_nearest_price_when_pe_date_off_month(
    monkeypatch: pytest.MonkeyPatch,
):
    """月初没价格、PE 表多出最新一天（带 † estimate）→ 用前一个月的价格 fill。"""

    def fake_fetch_table(url, session=None):
        if "pe-ratio" in url:
            return [
                ("2026-05-01", 31.42),
                ("2026-05-21", 32.06),  # estimate 行，价格表没有这一天
            ]
        if "historical-prices" in url:
            return [
                ("2026-04-01", 6957.01),
                ("2026-05-01", 7355.05),
            ]
        return []

    monkeypatch.setattr(multpl, "_fetch_table", fake_fetch_table)
    rows = multpl.fetch_sp500_pe_history()
    # 5/21 用 5/1 的价格前向填充
    assert rows[-1]["date"] == "2026-05-21"
    assert rows[-1]["close_adj"] == 7355.05


def test_fetch_sp500_pe_history_filters_since(monkeypatch: pytest.MonkeyPatch):
    def fake_fetch_table(url, session=None):
        if "pe-ratio" in url:
            return [("2024-01-01", 25.0), ("2024-02-01", 26.0), ("2024-03-01", 27.0)]
        if "historical-prices" in url:
            return [("2024-01-01", 5000.0), ("2024-02-01", 5100.0), ("2024-03-01", 5200.0)]
        return []

    monkeypatch.setattr(multpl, "_fetch_table", fake_fetch_table)
    rows = multpl.fetch_sp500_pe_history(since=date(2024, 1, 1))
    # since 是严格大于
    assert [r["date"] for r in rows] == ["2024-02-01", "2024-03-01"]


def test_fetch_sp500_pe_history_handles_missing_price(monkeypatch: pytest.MonkeyPatch):
    """早期月份可能缺价格（1871 年 PE 有但价格表不一定回溯那么早）。"""

    def fake_fetch_table(url, session=None):
        if "pe-ratio" in url:
            return [("1871-01-01", 11.1), ("2024-01-01", 25.0)]
        if "historical-prices" in url:
            return [("2024-01-01", 5000.0)]
        return []

    monkeypatch.setattr(multpl, "_fetch_table", fake_fetch_table)
    rows = multpl.fetch_sp500_pe_history()
    assert rows[0] == {"date": "1871-01-01", "close_adj": None, "pe_ttm": 11.1}
    assert rows[1] == {"date": "2024-01-01", "close_adj": 5000.0, "pe_ttm": 25.0}


def test_fetch_sp500_pe_history_raises_on_empty(monkeypatch: pytest.MonkeyPatch):
    """multpl HTML 结构变更导致解析不到任何行 → 抛 RuntimeError。"""
    monkeypatch.setattr(multpl, "_fetch_table", lambda url, session=None: [])
    with pytest.raises(RuntimeError, match="multpl: no PE rows"):
        multpl.fetch_sp500_pe_history()


def test_market_of_recognizes_index():
    """ticker_normalize 应该把 SPX 识别为 INDEX。"""
    from fetcher.ticker_normalize import market_of
    assert market_of("SPX") == "INDEX"
    assert market_of("spx") == "INDEX"
    assert market_of("NDX") == "INDEX"
    assert market_of("AAPL") == "US"
    assert market_of("0700.HK") == "HK"
