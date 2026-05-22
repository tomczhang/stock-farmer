"""Compute 层单测：TTM、PE、滚动分位。"""
from __future__ import annotations

from datetime import date, timedelta

import pytest

from compute.pe import compute_pe_series
from compute.percentile import compute_percentiles
from compute.ttm import build_ttm_eps


# ---------------- TTM ----------------

def _quarter(period_end: str, diluted=None, basic=None) -> dict:
    return {"period_end": period_end, "eps_basic": basic, "eps_diluted": diluted}


def test_ttm_steps_on_new_quarter():
    """跨财报日 TTM 出现台阶。"""
    eps = [
        _quarter("2023-03-31", diluted=1.0),
        _quarter("2023-06-30", diluted=1.1),
        _quarter("2023-09-30", diluted=1.2),
        _quarter("2023-12-31", diluted=1.3),  # 4 季齐：TTM=4.6
        _quarter("2024-03-31", diluted=1.5),  # 滚动：TTM=5.1
    ]
    price_dates = ["2023-12-30", "2023-12-31", "2024-01-02", "2024-03-31", "2024-04-01"]
    out = build_ttm_eps(eps, price_dates)
    # 2023-12-30：只看到 3 季 → None
    assert out[0]["ttm_eps"] is None and out[0]["is_loss"] is False
    # 2023-12-31：4 季 = 1.0+1.1+1.2+1.3 = 4.6
    assert out[1]["ttm_eps"] == pytest.approx(4.6)
    # 2024-01-02：与 2023-12-31 相同窗口
    assert out[2]["ttm_eps"] == pytest.approx(4.6)
    # 2024-03-31：新财报到位，滚动窗 1.1+1.2+1.3+1.5 = 5.1
    assert out[3]["ttm_eps"] == pytest.approx(5.1)
    assert out[4]["ttm_eps"] == pytest.approx(5.1)
    assert all(not r["is_loss"] for r in out[1:])


def test_ttm_fewer_than_4_quarters():
    eps = [
        _quarter("2023-03-31", diluted=1.0),
        _quarter("2023-06-30", diluted=1.0),
        _quarter("2023-09-30", diluted=1.0),
    ]
    out = build_ttm_eps(eps, ["2023-12-30"])
    assert out[0]["ttm_eps"] is None
    assert out[0]["is_loss"] is False


def test_ttm_loss_period():
    """一个季度负 EPS，TTM 仍可能为负 → is_loss=True。"""
    eps = [
        _quarter("2023-03-31", diluted=-2.0),
        _quarter("2023-06-30", diluted=0.1),
        _quarter("2023-09-30", diluted=0.1),
        _quarter("2023-12-31", diluted=0.1),
    ]
    out = build_ttm_eps(eps, ["2023-12-31"])
    assert out[0]["ttm_eps"] == pytest.approx(-1.7)
    assert out[0]["is_loss"] is True


def test_ttm_diluted_priority_with_basic_fallback():
    eps = [
        _quarter("2023-03-31", diluted=None, basic=1.0),
        _quarter("2023-06-30", diluted=1.0),
        _quarter("2023-09-30", diluted=1.0),
        _quarter("2023-12-31", diluted=1.0),
    ]
    out = build_ttm_eps(eps, ["2023-12-31"])
    assert out[0]["ttm_eps"] == pytest.approx(4.0)


def test_ttm_both_none_yields_none_ttm():
    eps = [
        _quarter("2023-03-31", diluted=None, basic=None),
        _quarter("2023-06-30", diluted=1.0),
        _quarter("2023-09-30", diluted=1.0),
        _quarter("2023-12-31", diluted=1.0),
    ]
    out = build_ttm_eps(eps, ["2023-12-31"])
    assert out[0]["ttm_eps"] is None
    assert out[0]["is_loss"] is False


# ---------------- PE ----------------

def test_compute_pe_series_basic():
    prices = [
        {"date": "2024-01-02", "close_adj": 100.0},
        {"date": "2024-01-03", "close_adj": 110.0},
    ]
    ttm = [
        {"date": "2024-01-02", "ttm_eps": 5.0, "is_loss": False},
        {"date": "2024-01-03", "ttm_eps": 5.0, "is_loss": False},
    ]
    out = compute_pe_series(prices, ttm)
    assert out[0]["pe_ttm"] == pytest.approx(20.0)
    assert out[1]["pe_ttm"] == pytest.approx(22.0)
    assert all(not r["is_loss"] for r in out)


def test_compute_pe_series_loss_period():
    prices = [{"date": "2024-01-02", "close_adj": 100.0}]
    ttm = [{"date": "2024-01-02", "ttm_eps": -2.0, "is_loss": True}]
    out = compute_pe_series(prices, ttm)
    assert out[0]["pe_ttm"] is None
    assert out[0]["is_loss"] is True


def test_compute_pe_series_missing_ttm():
    prices = [{"date": "2024-01-02", "close_adj": 100.0}]
    ttm: list[dict] = []
    out = compute_pe_series(prices, ttm)
    assert out[0]["pe_ttm"] is None
    assert out[0]["is_loss"] is False


def test_compute_pe_series_zero_ttm():
    prices = [{"date": "2024-01-02", "close_adj": 100.0}]
    ttm = [{"date": "2024-01-02", "ttm_eps": 0, "is_loss": False}]
    out = compute_pe_series(prices, ttm)
    assert out[0]["pe_ttm"] is None


# ---------------- 分位 ----------------

def _make_pe_series(n: int, base: date = date(2020, 1, 1), pe_value=10.0) -> list[dict]:
    return [
        {
            "date": (base + timedelta(days=i)).isoformat(),
            "pe_ttm": pe_value,
            "is_loss": False,
        }
        for i in range(n)
    ]


def test_percentile_constant_values_returns_50():
    """所有 PE 值相同，分位应为 50.0。"""
    pe = _make_pe_series(40, pe_value=10.0)
    out = compute_percentiles(pe)
    # 取最后一天
    last = out[-1]
    assert last["percentile_all"] == pytest.approx(50.0)


def test_percentile_window_too_short_returns_none():
    """窗口内只有 5 个样本，所有窗口分位都应为 None。"""
    pe = _make_pe_series(5, pe_value=10.0)
    out = compute_percentiles(pe)
    last = out[-1]
    assert last["percentile_all"] is None
    assert last["percentile_5y"] is None
    assert last["percentile_10y"] is None


def test_percentile_ascending_pe_last_is_top():
    """PE 单调递增，最后一天应处于最高分位。"""
    pe = [
        {
            "date": (date(2020, 1, 1) + timedelta(days=i)).isoformat(),
            "pe_ttm": float(i),
            "is_loss": False,
        }
        for i in range(100)
    ]
    out = compute_percentiles(pe)
    last = out[-1]
    # 最大值在 N 个样本中分位 = (N-1 + 1/2) / N * 100
    expected = round((99 + 0.5) / 100 * 100, 2)
    assert last["percentile_all"] == pytest.approx(expected)


def test_percentile_excludes_loss_samples_from_window():
    """亏损日 pe=None，不影响其他天的分位计算。"""
    pe = [
        {
            "date": (date(2020, 1, 1) + timedelta(days=i)).isoformat(),
            "pe_ttm": (None if i % 5 == 0 else float(i)),
            "is_loss": (i % 5 == 0),
        }
        for i in range(100)
    ]
    out = compute_percentiles(pe)
    # 亏损日应是 None
    assert out[0]["percentile_all"] is None
    # 非亏损日有值
    nonzero = [r for r in out if r["pe_ttm"] is not None][-1]
    assert nonzero["percentile_all"] is not None


def test_percentile_5y_window_correctness():
    """精确控制 5 年窗口边界。"""
    # 7 年的数据，全部用相同 pe → 5y/10y/all 在最后一天都应是 50
    pe = []
    for i in range(7 * 252):  # 约 7 年的交易日
        pe.append(
            {
                "date": (date(2017, 1, 1) + timedelta(days=i)).isoformat(),
                "pe_ttm": 15.0,
                "is_loss": False,
            }
        )
    out = compute_percentiles(pe)
    last = out[-1]
    assert last["percentile_5y"] == pytest.approx(50.0)
    assert last["percentile_10y"] == pytest.approx(50.0)
    assert last["percentile_all"] == pytest.approx(50.0)


def test_percentile_empty_input():
    assert compute_percentiles([]) == []
