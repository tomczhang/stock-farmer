"""手动决策日金字塔纪律推演测试。"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from analyzer.pyramid import (
    PyramidParams,
    build_demo_pyramid_backtest,
    run_pyramid_backtest,
)


def _df(after: list[tuple[float, float]], history: int = 80) -> tuple[pd.DataFrame, str]:
    dates = pd.date_range("2025-01-02", periods=history + len(after), freq="B")
    x = np.arange(history, dtype=float)
    prior_close = 100 + np.sin(x / 5) * 0.5
    rows = [
        {
            "date": dates[i].strftime("%Y-%m-%d"),
            "open": float(prior_close[i]), "high": float(prior_close[i] + 1),
            "low": float(prior_close[i] - 1), "close": float(prior_close[i]),
            "volume": 5_000_000,
        }
        for i in range(history)
    ]
    for offset, (open_, close) in enumerate(after, start=history):
        rows.append({
            "date": dates[offset].strftime("%Y-%m-%d"),
            "open": open_, "high": max(open_, close) + 1,
            "low": min(open_, close) - 1, "close": close, "volume": 5_000_000,
        })
    decision = rows[history - 1]["date"]
    return pd.DataFrame(rows), decision


def test_manual_decision_buys_at_next_open():
    df, as_of = _df([(103.0, 103.0), (104.0, 104.0)])
    result = run_pyramid_backtest(df, "AAPL", as_of)
    buy = result["trades"][0]
    assert buy["action"] == "buy"
    assert buy["date"] == df["date"].iloc[80]
    assert buy["price"] == 103.0
    assert result["entry"]["mode"] == "manual"
    assert result["entry"]["decision_date"] == as_of


def test_decision_on_last_row_creates_pending_order():
    df, _ = _df([])
    as_of = df["date"].iloc[-1]
    result = run_pyramid_backtest(df, "AAPL", as_of)
    assert result["summary"]["entered"] is False
    assert result["pending_orders"][0]["action"] == "buy"
    assert "首仓待执行" in result["summary"]["reason"]


def test_manual_entry_does_not_require_bottoming_state():
    df, as_of = _df([(100.0, 100.0)])
    result = run_pyramid_backtest(df, "AAPL", as_of)
    assert result["summary"]["entered"] is True
    assert result["entry"]["bottoming_tier"] in {
        "still_falling", "early_signs", "base_forming", "base_ready", "trend_running",
    }
    assert result["assumptions"][0] == "as-of 由用户手动选择，系统不判断买点"


def test_hk_entry_rounds_down_to_board_lot():
    df, as_of = _df([(103.0, 103.0)])
    result = run_pyramid_backtest(
        df, "0700.HK", as_of,
        PyramidParams(budget=100_000, entry_fraction=0.2, hk_lot=100),
    )
    assert result["trades"][0]["shares"] % 100 == 0


def test_price_tier_adds_on_following_open():
    df, as_of = _df([
        (100.0, 100.0),  # 首仓成交
        (101.0, 106.0),  # 收盘越过 +5%，形成加仓单
        (107.0, 107.0),  # 加仓成交
    ])
    result = run_pyramid_backtest(df, "AAPL", as_of)
    trades = result["trades"]
    assert [trade["action"] for trade in trades[:2]] == ["buy", "add"]
    assert trades[1]["price"] == 107.0
    assert trades[1]["shares"] < trades[0]["shares"]


def test_support_break_has_priority_and_exits_next_open():
    df, as_of = _df([
        (100.0, 100.0),
        (95.0, 80.0),
        (78.0, 78.0),
    ])
    result = run_pyramid_backtest(df, "AAPL", as_of)
    assert result["summary"]["stop_loss_triggered"] is True
    assert result["trades"][-1]["action"] == "stop_loss"
    assert result["trades"][-1]["price"] == 78.0
    assert "支撑失效" in result["trades"][-1]["reason"]


def test_future_rows_do_not_change_decision_day_anchors():
    first, as_of = _df([(100.0, 100.0), (101.0, 101.0)])
    second = first.copy()
    second.loc[len(second)] = {
        "date": (pd.Timestamp(second["date"].iloc[-1]) + pd.offsets.BDay()).strftime("%Y-%m-%d"),
        "open": 500, "high": 510, "low": 490, "close": 505, "volume": 99_000_000,
    }
    a = run_pyramid_backtest(first, "AAPL", as_of)
    b = run_pyramid_backtest(second, "AAPL", as_of, PyramidParams(window=2))
    assert a["entry"]["support"] == b["entry"]["support"]
    assert a["entry"]["target"] == b["entry"]["target"]
    assert a["trades"][0] == b["trades"][0]


def test_payload_removes_removed_entry_fields_and_params():
    df, as_of = _df([(100.0, 100.0)])
    result = run_pyramid_backtest(df, "AAPL", as_of)
    assert result["schema_version"] == 2
    encoded = str(result)
    for removed in ("right_green", "strong_right", "right_trigger"):
        assert removed not in encoded


def test_demo_exercises_real_manual_flow():
    result = build_demo_pyramid_backtest()
    assert result["demo"] is True
    assert result["entry"]["mode"] == "manual"
    assert result["trades"][0]["action"] == "buy"
    assert result["summary"]["entered"] is True
