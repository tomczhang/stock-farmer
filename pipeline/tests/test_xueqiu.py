"""单元测试：fetcher.xueqiu

不发真实 HTTP；用 monkeypatch 注入 fake response。
"""
from __future__ import annotations

from datetime import date

import pytest

from fetcher import xueqiu


def test_symbol_for_xueqiu_hk():
    """港股：0700.HK / 00700.HK / 700.HK → 00700。"""
    assert xueqiu._symbol_for_xueqiu("0700.HK") == "00700"
    assert xueqiu._symbol_for_xueqiu("00700.HK") == "00700"
    assert xueqiu._symbol_for_xueqiu("700.HK") == "00700"
    assert xueqiu._symbol_for_xueqiu("9988.HK") == "09988"


def test_symbol_for_xueqiu_us():
    """美股：原样保留（雪球用 ticker 直接查）。"""
    assert xueqiu._symbol_for_xueqiu("AAPL") == "AAPL"
    assert xueqiu._symbol_for_xueqiu("aapl") == "AAPL"
    assert xueqiu._symbol_for_xueqiu("BRK.B") == "BRK.B"


def test_parse_kline_response_basic():
    """正常响应：columns + items → [{date, close_adj, pe_ttm}, ...] 升序。"""
    fake = {
        "error_code": 0,
        "data": {
            "column": ["timestamp", "open", "close", "pe", "pb"],
            "item": [
                # 2024-01-02
                [1704153600000, 100.0, 101.5, 25.3, 5.1],
                # 2024-01-03
                [1704240000000, 101.5, 102.0, 25.5, 5.2],
            ],
        },
    }
    out = xueqiu._parse_kline_response(fake)
    assert out == [
        {"date": "2024-01-02", "close_adj": 101.5, "pe_ttm": 25.3},
        {"date": "2024-01-03", "close_adj": 102.0, "pe_ttm": 25.5},
    ]


def test_parse_kline_response_handles_null_pe():
    """部分日期 pe 为 None（如停牌或数据缺失），保留为 None。"""
    fake = {
        "error_code": 0,
        "data": {
            "column": ["timestamp", "close", "pe"],
            "item": [
                [1704153600000, 100.0, None],
                [1704240000000, 101.0, 25.0],
            ],
        },
    }
    out = xueqiu._parse_kline_response(fake)
    assert out[0]["pe_ttm"] is None
    assert out[1]["pe_ttm"] == 25.0


def test_parse_kline_response_filters_invalid_close():
    """close=0 或 None 的行整体跳过。"""
    fake = {
        "error_code": 0,
        "data": {
            "column": ["timestamp", "close", "pe"],
            "item": [
                [1704153600000, 0, 25.0],
                [1704240000000, None, 25.0],
                [1704326400000, 100.0, 25.0],
            ],
        },
    }
    out = xueqiu._parse_kline_response(fake)
    assert len(out) == 1
    assert out[0]["close_adj"] == 100.0


def test_parse_kline_response_dedupes():
    """重复日期保留最后一条。"""
    fake = {
        "error_code": 0,
        "data": {
            "column": ["timestamp", "close", "pe"],
            "item": [
                [1704153600000, 100.0, 25.0],
                [1704153600000, 101.5, 26.0],  # 同一日，后写入覆盖
            ],
        },
    }
    out = xueqiu._parse_kline_response(fake)
    assert out == [{"date": "2024-01-02", "close_adj": 101.5, "pe_ttm": 26.0}]


def test_parse_kline_response_handles_error_code():
    fake = {"error_code": 1, "error_description": "no data"}
    with pytest.raises(RuntimeError, match="xueqiu error"):
        xueqiu._parse_kline_response(fake)


def test_parse_kline_response_handles_no_pe_column():
    """请求时若没 indicator=pe，pe 列不存在，pe_ttm 全部为 None。"""
    fake = {
        "error_code": 0,
        "data": {
            "column": ["timestamp", "close"],
            "item": [[1704153600000, 100.0]],
        },
    }
    out = xueqiu._parse_kline_response(fake)
    assert out[0]["pe_ttm"] is None


def test_fetch_pe_history_filters_since(monkeypatch: pytest.MonkeyPatch):
    """传 since 参数时，只返回严格大于 since 的日期。"""
    fake_resp = {
        "error_code": 0,
        "data": {
            "column": ["timestamp", "close", "pe"],
            "item": [
                [1704153600000, 100.0, 25.0],  # 2024-01-02
                [1704240000000, 101.0, 25.5],  # 2024-01-03
                [1704326400000, 102.0, 26.0],  # 2024-01-04
            ],
        },
    }

    class FakeSession:
        def get(self, url, params, referer=None):
            return fake_resp

    rows = xueqiu.fetch_pe_history("AAPL", since=date(2024, 1, 2), session=FakeSession())
    assert [r["date"] for r in rows] == ["2024-01-03", "2024-01-04"]


def test_fetch_pe_history_passes_symbol_and_count(monkeypatch: pytest.MonkeyPatch):
    """验证 HK ticker 被转 5 位无后缀；years 影响 count。"""
    captured = {}

    class FakeSession:
        def get(self, url, params, referer=None):
            captured["url"] = url
            captured["params"] = params
            captured["referer"] = referer
            return {"error_code": 0, "data": {"column": ["timestamp", "close", "pe"], "item": []}}

    xueqiu.fetch_pe_history("0700.HK", years=5, session=FakeSession())
    assert captured["params"]["symbol"] == "00700"
    assert captured["params"]["count"] == "-1300"  # 5 × 260
    assert captured["params"]["indicator"] == "kline,pe"
    assert captured["params"]["type"] == "before"  # 前复权
    assert "00700" in captured["referer"]


def test_fetch_current_pe_normal(monkeypatch: pytest.MonkeyPatch):
    fake_resp = {
        "data": {
            "quote": {
                "pe_ttm": 36.54,
                "pe_lyr": 39.99,
                "pe_forecast": 35.0,
                "current": 304.99,
                "eps": 8.34,
                "other_field": "ignored",
            }
        }
    }

    class FakeSession:
        def get(self, url, params, referer=None):
            return fake_resp

    out = xueqiu.fetch_current_pe("AAPL", session=FakeSession())
    assert out == {
        "pe_ttm": 36.54,
        "pe_lyr": 39.99,
        "pe_forecast": 35.0,
        "current_price": 304.99,
        "eps_ttm": 8.34,
    }
