"""历史复盘（right-signal backtest）测试。

覆盖：as-of 解析、有效交易日解析、日线截断、历史价格、前瞻结果标签、
右侧趋势序列、以及 build_signal_report 的历史/当前模式行为。
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from analyzer import backtest
from analyzer.backtest import (
    AsOfOutOfRange,
    InvalidAsOfDate,
    build_right_trend,
    clamp_trend_window,
    cutoff_daily,
    forward_outcome_labels,
    historical_price_and_change,
    parse_as_of,
    resolve_effective_date,
)
from analyzer.phase import compute_trend_regime, determine_phase
from analyzer.signals import compute_all_signals, SignalResult
import analyzer.report as report_module
from analyzer.report import build_signal_report


def _make_df(n: int = 120, start: str = "2026-01-01") -> pd.DataFrame:
    np.random.seed(7)
    dates = pd.date_range(start, periods=n, freq="B").strftime("%Y-%m-%d")
    close = 100 + np.cumsum(np.random.randn(n) * 0.6)
    return pd.DataFrame({
        "date": dates,
        "open": close - np.random.rand(n) * 0.4,
        "high": close + np.abs(np.random.randn(n)) * 0.7,
        "low": close - np.abs(np.random.randn(n)) * 0.7,
        "close": close,
        "volume": (5_000_000 * (1 + np.random.rand(n) * 0.3)).astype(int),
    })


# ---------- as-of 解析 ----------

class TestParseAsOf:
    def test_valid(self):
        assert parse_as_of("2026-05-15").isoformat() == "2026-05-15"

    @pytest.mark.parametrize("bad", ["2026/05/15", "May 15", "20260515", "", "2026-13-40"])
    def test_invalid(self, bad):
        with pytest.raises(InvalidAsOfDate):
            parse_as_of(bad)


class TestResolveEffectiveDate:
    def test_trading_day(self):
        df = _make_df(40)
        target = df["date"].iloc[20]
        assert resolve_effective_date(df, parse_as_of(target)) == target

    def test_non_trading_day_uses_last_prior(self):
        df = _make_df(40)
        # 找一个周五，其后的周六/周日（非交易日）应回落到这个周五。
        friday = next(d for d in df["date"].tolist() if pd.Timestamp(d).weekday() == 4)
        saturday = (pd.Timestamp(friday) + pd.Timedelta(days=1)).strftime("%Y-%m-%d")
        sunday = (pd.Timestamp(friday) + pd.Timedelta(days=2)).strftime("%Y-%m-%d")
        assert resolve_effective_date(df, parse_as_of(saturday)) == friday
        assert resolve_effective_date(df, parse_as_of(sunday)) == friday

    def test_before_history_returns_none(self):
        df = _make_df(40)
        assert resolve_effective_date(df, parse_as_of("2000-01-01")) is None


class TestCutoffDaily:
    def test_excludes_future_rows(self):
        df = _make_df(50)
        eff = df["date"].iloc[30]
        cut = cutoff_daily(df, eff)
        assert len(cut) == 31
        assert (cut["date"].map(str) <= eff).all()


class TestHistoricalPrice:
    def test_uses_effective_close_and_prev(self):
        df = _make_df(10)
        eff = df["date"].iloc[5]
        cut = cutoff_daily(df, eff)
        price, change = historical_price_and_change(cut)
        assert price == pytest.approx(float(df["close"].iloc[5]))
        expected = (float(df["close"].iloc[5]) / float(df["close"].iloc[4]) - 1) * 100
        assert change == pytest.approx(expected)


class TestForwardOutcomeLabels:
    def test_full_horizons(self):
        closes = [100.0 + i for i in range(30)]
        labels = forward_outcome_labels(closes, 0)
        assert labels is not None
        assert labels["d5_pct"] == pytest.approx(5.0)
        assert labels["d10_pct"] == pytest.approx(10.0)
        assert labels["d20_pct"] == pytest.approx(20.0)
        assert labels["max_gain_20d_pct"] == pytest.approx(20.0)
        # 单调上涨时 20 日内最低=次日，回撤为正（仍上涨）。
        assert labels["max_drawdown_20d_pct"] == pytest.approx(1.0)

    def test_insufficient_future_rows_yield_null(self):
        closes = [100.0 + i for i in range(8)]  # idx0 后只有 7 个未来日
        labels = forward_outcome_labels(closes, 0)
        assert labels is not None
        assert labels["d5_pct"] == pytest.approx(5.0)
        assert labels["d10_pct"] is None
        assert labels["d20_pct"] is None
        assert labels["max_gain_20d_pct"] is None
        assert labels["max_drawdown_20d_pct"] is None

    def test_no_future_returns_none(self):
        closes = [100.0, 101.0]
        assert forward_outcome_labels(closes, 1) is None


class TestClampTrendWindow:
    def test_default_and_bounds(self):
        assert clamp_trend_window(None) == backtest.DEFAULT_TREND_WINDOW
        assert clamp_trend_window(0) == backtest.DEFAULT_TREND_WINDOW
        assert clamp_trend_window(-5) == backtest.DEFAULT_TREND_WINDOW
        assert clamp_trend_window(10) == 10
        assert clamp_trend_window(9999) == backtest.MAX_TREND_WINDOW


class TestBuildRightTrend:
    def test_length_order_and_fields(self):
        df = _make_df(120)
        eff = df["date"].iloc[-1]
        trend = build_right_trend(df, effective_date=eff, window=30)
        pts = trend["points"]
        assert trend["window"] == 30
        assert 0 < len(pts) <= 30
        dates = [p["date"] for p in pts]
        assert dates == sorted(dates)  # ascending
        required = {
            "date", "close", "normalized_close_pct", "score_pct",
            "right_score_pct", "phase", "right_confirmed_count",
            "right_total_count", "states", "forward_returns",
        }
        for p in pts:
            assert required.issubset(p.keys())
            assert 0 <= p["normalized_close_pct"] <= 100

    def test_tolerates_fewer_than_window(self):
        df = _make_df(45)  # 仅 45 行，扣除 MIN_SIGNAL_ROWS 后点数 < 60
        eff = df["date"].iloc[-1]
        trend = build_right_trend(df, effective_date=eff, window=60)
        assert len(trend["points"]) <= 60
        assert len(trend["points"]) > 0

    def test_forward_labels_do_not_affect_as_of_judgment(self):
        """趋势点（含未来数据的 df）算出的 phase/score 必须等于仅用截断数据的结果。"""
        df = _make_df(120)
        eff = df["date"].iloc[80]  # 81~119 行是“未来”
        trend = build_right_trend(df, effective_date=eff, window=5)
        last = trend["points"][-1]
        assert last["date"] == eff

        cut = cutoff_daily(df, eff)
        expected_phase = determine_phase(
            compute_all_signals(cut, volume_profile=[], index_df=None)
        )
        assert last["score_pct"] == expected_phase.strength_pct
        assert last["phase"] == expected_phase.phase
        # 该点仍有未来数据，前瞻标签应存在（至少 5 日）。
        assert last["forward_returns"] is not None
        assert last["forward_returns"]["d5_pct"] is not None


# ---------- 趋势 regime（B：区分"下跌无信号" vs "趋势中途"） ----------

def _trend_df(slope: float, n: int = 260) -> pd.DataFrame:
    dates = pd.date_range("2025-01-01", periods=n, freq="B").strftime("%Y-%m-%d")
    close = 100 + np.arange(n) * slope
    return pd.DataFrame({
        "date": dates, "open": close, "high": close + 1,
        "low": close - 1, "close": close, "volume": [5_000_000] * n,
    })


def _no_green_signals() -> list[SignalResult]:
    sigs = []
    for i in range(6):
        sigs.append(SignalResult(
            id=f"left_{i}", name=f"L{i}", category="left", confidence=0.1,
            light="red", thresholds=(0.35, 0.70), weight=1, description="", data={},
        ))
    for i in range(5):
        sigs.append(SignalResult(
            id=f"right_{i}", name=f"R{i}", category="right", confidence=0.1,
            light="red", thresholds=(0.35, 0.70), weight=1, description="", data={},
        ))
    return sigs


class TestTrendRegime:
    def test_uptrend_detected(self):
        assert compute_trend_regime(_trend_df(0.5)) == "uptrend"

    def test_downtrend_detected(self):
        assert compute_trend_regime(_trend_df(-0.5)) == "downtrend"

    def test_insufficient_data_unknown(self):
        assert compute_trend_regime(_trend_df(0.5, n=30)) == "unknown"

    def test_none_unknown(self):
        assert compute_trend_regime(None) == "unknown"


class TestRegimeOverride:
    def test_uptrend_with_no_signals_becomes_trend_running(self):
        """价格在上升趋势但反转信号全灭 → 不应再说"仍在下跌"。"""
        phase = determine_phase(_no_green_signals(), df=_trend_df(0.5))
        assert phase.regime == "uptrend"
        assert phase.phase == "趋势运行中"
        assert phase.icon == "📈"

    def test_downtrend_with_no_signals_stays_falling(self):
        phase = determine_phase(_no_green_signals(), df=_trend_df(-0.5))
        assert phase.phase == "仍在下跌"
        assert phase.regime == "downtrend"

    def test_no_df_keeps_backward_compatible_behavior(self):
        phase = determine_phase(_no_green_signals())
        assert phase.phase == "仍在下跌"
        assert phase.regime == "unknown"

    def test_narrative_not_calling_uptrend_a_downtrend(self):
        from analyzer.narrative import generate_narrative
        phase = determine_phase(_no_green_signals(), df=_trend_df(0.5))
        text = generate_narrative("AAPL", "苹果", _no_green_signals(), phase)
        assert "下跌趋势" not in text
        assert "上升趋势" in text


# ---------- build_signal_report 历史 / 当前模式 ----------

class _FakeQuote:
    def __init__(self, name, price, change_pct):
        self.name = name
        self.price = price
        self.change_pct = change_pct


@pytest.fixture
def patched_data(monkeypatch):
    df = _make_df(120)

    def fake_get_klines(ticker, period="1d", count=250, adjust="qfq"):
        return df.copy()

    def fake_get_quotes(tickers):
        return [_FakeQuote("测试名", 999.0, 12.34)]

    # 直接替换数据访问入口，避免依赖 sys.path 上 data / pipeline.data 的解析顺序。
    monkeypatch.setattr(report_module, "_data_fns", lambda: (fake_get_klines, fake_get_quotes))
    # 当前模式不依赖真实分钟数据。
    monkeypatch.setattr(report_module, "_build_volume_profile_windows", lambda *_a, **_k: ({}, {}))
    return df


class TestBuildSignalReportHistorical:
    def test_historical_metadata(self, patched_data):
        df = patched_data
        eff = df["date"].iloc[80]
        report = build_signal_report("TEST", as_of=eff)
        ctx = report["report_context"]
        assert ctx["mode"] == "historical"
        assert ctx["requested_as_of"] == eff
        assert ctx["effective_date"] == eff
        assert ctx["data_start_date"] == df["date"].iloc[0]
        assert ctx["data_end_date"] == df["date"].iloc[-1]
        assert ctx["used_historical_cutoff"] is True
        assert ctx["volume_profile_mode"] == "unavailable_historical"

    def test_historical_price_not_realtime_quote(self, patched_data):
        df = patched_data
        eff = df["date"].iloc[80]
        report = build_signal_report("TEST", as_of=eff)
        # 不能用实时 quote 的 999.0，应使用 effective_date 收盘价。
        assert report["price"] == pytest.approx(float(df["close"].iloc[80]))
        assert report["price"] != 999.0
        expected_change = (float(df["close"].iloc[80]) / float(df["close"].iloc[79]) - 1) * 100
        assert report["change_pct"] == pytest.approx(expected_change)

    def test_future_rows_excluded_from_signals(self, patched_data):
        df = patched_data
        eff = df["date"].iloc[80]
        report = build_signal_report("TEST", as_of=eff)
        cut = cutoff_daily(df, eff)
        index_cut = cutoff_daily(df, eff)  # 假数据中 SPY 与个股同源
        cut_signals = compute_all_signals(cut, volume_profile=[], index_df=index_cut)
        expected = determine_phase(cut_signals)
        assert report["confirmation"]["score_pct"] == expected.strength_pct
        # 结论区由筑底判读驱动，同样不得含未来数据。
        from analyzer.bottoming import compute_bottoming
        expected_verdict = compute_bottoming(cut, signals=cut_signals)
        assert report["conclusion"]["phase"] == expected_verdict.tier_label
        assert report["bottoming"]["tier"] == expected_verdict.tier
        assert report["bottoming"]["cleanliness_pct"] == expected_verdict.cleanliness_pct

    def test_out_of_range_raises(self, patched_data):
        with pytest.raises(AsOfOutOfRange):
            build_signal_report("TEST", as_of="2000-01-01")

    def test_malformed_raises(self, patched_data):
        with pytest.raises(InvalidAsOfDate):
            build_signal_report("TEST", as_of="2026/01/01")

    def test_forward_outcomes_in_context_when_enough_future(self, patched_data):
        df = patched_data
        eff = df["date"].iloc[80]  # 后续有 39 个交易日
        report = build_signal_report("TEST", as_of=eff)
        fwd = report["report_context"]["forward_outcomes"]
        assert fwd is not None
        assert fwd["d20_pct"] is not None
        assert fwd["max_gain_20d_pct"] is not None

    def test_forward_outcomes_null_when_insufficient(self, patched_data):
        df = patched_data
        eff = df["date"].iloc[-1]  # 最新交易日，无未来
        report = build_signal_report("TEST", as_of=eff)
        assert report["report_context"]["forward_outcomes"] is None


class TestPayloadExamples:
    """覆盖当前模式与历史模式的完整 payload 契约（可作为 API 示例）。"""

    _TOP_KEYS = {
        "ticker", "name", "price", "change_pct", "analyzed_at", "conclusion",
        "bottoming", "confirmation", "signals", "groups", "narrative", "chart_data",
        "report_context", "right_trend", "disclaimer",
    }

    def test_current_payload_contract(self, patched_data):
        import json
        report = build_signal_report("TEST")
        assert self._TOP_KEYS.issubset(report.keys())
        assert report["report_context"]["mode"] == "current"
        assert "points" in report["right_trend"]
        # 筑底判读区块：三迹象固定顺序 + 洗盘干净度结构强度语义
        bot = report["bottoming"]
        assert [s["id"] for s in bot["signs"]] == [
            "vol_dry_up", "false_break_recover", "chip_stability",
        ]
        assert bot["cleanliness_label"] == "洗盘干净度"
        assert "结构强度" in bot["cleanliness_caption"]
        for sign in bot["signs"]:
            assert sign["state"] in ("absent", "early", "clear")
            assert sign["state_label"] in ("未出现", "初现", "明显")
        # 整个 payload 必须可 JSON 序列化。
        json.dumps(report, ensure_ascii=False, default=str)

    def test_historical_payload_contract(self, patched_data):
        import json
        df = patched_data
        report = build_signal_report("TEST", as_of=df["date"].iloc[80], trend_window=30)
        assert self._TOP_KEYS.issubset(report.keys())
        ctx = report["report_context"]
        assert ctx["mode"] == "historical"
        assert ctx["trend_window"] == 30
        assert report["right_trend"]["window"] == 30
        json.dumps(report, ensure_ascii=False, default=str)


class TestBuildSignalReportCurrent:
    def test_current_mode_uses_quote_price(self, patched_data):
        report = build_signal_report("TEST")
        assert report["report_context"]["mode"] == "current"
        assert report["report_context"]["used_historical_cutoff"] is False
        assert report["price"] == pytest.approx(999.0)
        assert report["change_pct"] == pytest.approx(12.34)

    def test_score_semantics_present_without_forbidden_wording(self, patched_data):
        report = build_signal_report("TEST")
        conf = report["confirmation"]
        assert conf["score_label"] == "结构强度"
        assert conf["left"]["role_label"] == "左侧准备度"
        assert conf["right"]["role_label"] == "右侧触发度"
        assert conf["diagnosis"]
        for forbidden in ("准确率", "胜率", "上涨概率", "预测概率"):
            assert forbidden not in conf["diagnosis"]
            assert forbidden not in conf["score_label"]
