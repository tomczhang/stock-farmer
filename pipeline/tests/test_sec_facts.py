"""单元测试：fetcher.sec_facts

不发真实 HTTP；用 monkeypatch 注入 fake company facts JSON。
"""
from __future__ import annotations

import pytest

from fetcher import sec_facts


@pytest.fixture(autouse=True)
def _reset_cache():
    """每个测试前清空 ticker→CIK 缓存，避免相互污染。"""
    sec_facts._TICKER_TO_CIK = None
    yield
    sec_facts._TICKER_TO_CIK = None


def test_get_cik_lookup(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        sec_facts,
        "_load_ticker_map",
        lambda session=None: {"AAPL": "0000320193", "MSFT": "0000789019"},
    )
    assert sec_facts.get_cik("AAPL") == "0000320193"
    assert sec_facts.get_cik("aapl") == "0000320193"  # 大小写不敏感
    assert sec_facts.get_cik("NONEXISTENT") is None


def test_is_single_quarter_boundary():
    """90 天和 97 天都算单季，半年 (181) 不算。"""
    assert sec_facts._is_single_quarter({"start": "2024-01-01", "end": "2024-04-01"})  # 91 天
    assert sec_facts._is_single_quarter({"start": "2022-09-25", "end": "2022-12-31"})  # 97 天
    assert not sec_facts._is_single_quarter({"start": "2024-01-01", "end": "2024-07-01"})  # 182 天
    assert not sec_facts._is_single_quarter({"start": None, "end": "2024-04-01"})


def test_is_full_year():
    assert sec_facts._is_full_year(
        {"form": "10-K", "start": "2023-10-01", "end": "2024-09-29"}
    )  # 364 天
    assert not sec_facts._is_full_year(
        {"form": "10-Q", "start": "2023-10-01", "end": "2024-09-29"}
    )  # 不是 10-K
    assert not sec_facts._is_full_year(
        {"form": "10-K", "start": "2023-10-01", "end": "2024-04-01"}
    )  # 半年


def test_dedupe_keep_latest_filed():
    entries = [
        {"end": "2024-03-30", "val": 1.50, "filed": "2024-05-01"},
        {"end": "2024-03-30", "val": 1.53, "filed": "2025-05-01"},  # 重述
        {"end": "2024-06-29", "val": 1.40, "filed": "2024-08-01"},
    ]
    result = sec_facts._dedupe_keep_latest_filed(entries)
    by_end = {e["end"]: e["val"] for e in result}
    assert by_end == {"2024-03-30": 1.53, "2024-06-29": 1.40}


def test_derive_q4_from_annual():
    """端到端：用 start/end 范围匹配 Q1/Q2/Q3，Q4 = Annual - 求和。"""
    single_q = [
        {"start": "2023-10-01", "end": "2023-12-30", "val": 2.18, "filed": "2024-01-30"},  # Q1 FY24
        {"start": "2023-12-31", "end": "2024-03-30", "val": 1.53, "filed": "2024-05-01"},  # Q2 FY24
        {"start": "2024-03-31", "end": "2024-06-29", "val": 1.40, "filed": "2024-08-01"},  # Q3 FY24
        {"start": "2024-09-29", "end": "2024-12-28", "val": 2.40, "filed": "2025-01-30"},  # Q1 FY25
    ]
    annual = [
        {"start": "2023-10-01", "end": "2024-09-28", "val": 6.08, "filed": "2024-11-01", "fy": 2024},
    ]
    derived = sec_facts._derive_q4_from_annual(single_q, annual)
    assert len(derived) == 1
    q4 = derived[0]
    assert q4["end"] == "2024-09-28"
    assert q4["fp"] == "Q4"
    # 6.08 - (2.18 + 1.53 + 1.40) = 0.97
    assert abs(q4["val"] - 0.97) < 0.005


def test_derive_q4_skips_when_insufficient_quarters():
    """财年内单季度不足 3 个时跳过 Q4 推导。"""
    single_q = [
        {"start": "2023-10-01", "end": "2023-12-30", "val": 2.18, "filed": "2024-01-30"},
        {"start": "2023-12-31", "end": "2024-03-30", "val": 1.53, "filed": "2024-05-01"},
        # 缺 Q3
    ]
    annual = [
        {"start": "2023-10-01", "end": "2024-09-28", "val": 6.08, "filed": "2024-11-01", "fy": 2024},
    ]
    assert sec_facts._derive_q4_from_annual(single_q, annual) == []


def test_extract_eps_series_picks_correct_unit_and_form():
    """从 companyfacts JSON 里提取 EPS：只保留 10-Q 的单季 + 10-K 的全年。"""
    fake_facts = {
        "facts": {
            "us-gaap": {
                "EarningsPerShareDiluted": {
                    "units": {
                        "USD/shares": [
                            # 单季度 10-Q
                            {"start": "2024-01-01", "end": "2024-04-01", "val": 1.5,
                             "form": "10-Q", "filed": "2024-05-01"},
                            # YTD 10-Q（应被滤掉）
                            {"start": "2024-01-01", "end": "2024-07-01", "val": 3.1,
                             "form": "10-Q", "filed": "2024-08-01"},
                            # 全年 10-K
                            {"start": "2024-01-01", "end": "2024-12-31", "val": 6.0,
                             "form": "10-K", "filed": "2025-02-01"},
                            # 非 10-K/10-Q（应被滤掉）
                            {"start": "2024-01-01", "end": "2024-04-01", "val": 99,
                             "form": "8-K", "filed": "2024-05-15"},
                        ]
                    }
                }
            }
        }
    }
    out = sec_facts._extract_eps_series(fake_facts, "EarningsPerShareDiluted")
    assert len(out["single_q"]) == 1
    assert out["single_q"][0]["val"] == 1.5
    assert len(out["annual"]) == 1
    assert out["annual"][0]["val"] == 6.0


def test_extract_eps_series_handles_missing_metric():
    fake_facts = {"facts": {"us-gaap": {}}}
    out = sec_facts._extract_eps_series(fake_facts, "EarningsPerShareDiluted")
    assert out == {"single_q": [], "annual": []}


def test_merge_to_quarterly():
    """合并 diluted + basic + 推导 Q4 → 单一升序列表。"""
    diluted = {
        "single_q": [
            {"start": "2023-10-01", "end": "2023-12-30", "val": 2.18, "filed": "2024-01-30"},
        ],
        "annual": [],
    }
    basic = {
        "single_q": [
            {"start": "2023-10-01", "end": "2023-12-30", "val": 2.19, "filed": "2024-01-30"},
        ],
        "annual": [],
    }
    rows = sec_facts._merge_to_quarterly(diluted, basic)
    assert rows == [
        {"period_end": "2023-12-30", "eps_basic": 2.19, "eps_diluted": 2.18},
    ]


def test_merge_handles_partial_metrics():
    """只有 diluted、没有 basic 也能正常输出。"""
    diluted = {
        "single_q": [
            {"start": "2023-10-01", "end": "2023-12-30", "val": 2.18, "filed": "2024-01-30"},
        ],
        "annual": [],
    }
    basic = {"single_q": [], "annual": []}
    rows = sec_facts._merge_to_quarterly(diluted, basic)
    assert rows == [
        {"period_end": "2023-12-30", "eps_basic": None, "eps_diluted": 2.18},
    ]


def test_fetch_quarterly_eps_sec_returns_empty_when_ticker_unknown(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sec_facts, "_load_ticker_map", lambda session=None: {})
    assert sec_facts.fetch_quarterly_eps_sec("NONEXISTENT") == []
