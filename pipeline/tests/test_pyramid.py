"""金字塔交易回测推演引擎测试。"""
from __future__ import annotations

import json
from types import SimpleNamespace

import numpy as np
import pandas as pd
import pytest

import analyzer.pyramid as pyramid
from analyzer.pyramid import (
    PyramidParams,
    _resistance_target,
    check_entry,
    run_pyramid_backtest,
)
from analyzer.signals import SignalResult

FORBIDDEN_WORDS = ("胜率", "准确率", "上涨概率")


def _df(oc_pairs: list[tuple[float, float]], start: str = "2026-01-01") -> pd.DataFrame:
    """按 (open, close) 序列构造日线，high/low 自动包络。"""
    dates = pd.date_range(start, periods=len(oc_pairs), freq="B").strftime("%Y-%m-%d")
    rows = []
    for (o, c), d in zip(oc_pairs, dates):
        rows.append({
            "date": d, "open": float(o),
            "high": float(max(o, c)) + 1.0, "low": float(min(o, c)) - 1.0,
            "close": float(c), "volume": 5_000_000,
        })
    return pd.DataFrame(rows)


def _fake_signals(support_low: float = 90.0) -> list[SignalResult]:
    def sig(sig_id, data):
        return SignalResult(
            id=sig_id, name=sig_id, category="left", confidence=0.7,
            light="green", thresholds=(0.35, 0.7), weight=1,
            description="", data=data,
        )
    return [
        sig("false_breakdown", {
            "active_support": {"low": support_low, "high": support_low + 2, "strength": 0.7},
        }),
        sig("no_new_low", {"prev_low": support_low}),
    ]


def _params(**overrides) -> PyramidParams:
    """测试用参数：固定预算 10 万，与可调的默认预算解耦。"""
    overrides.setdefault("budget", 100_000.0)
    return PyramidParams(**overrides)


def _patch_entry(monkeypatch, ok_dates: set[str], support_low: float = 90.0):
    def fake_check_entry(day_df, params=None):
        d = str(day_df["date"].iloc[-1]).split()[0]
        return {
            "ok": d in ok_dates,
            "mode": "bottoming",
            "tier": "base_forming", "tier_label": "筑底基本成立",
            "right_green": ["above_ma"], "cleanliness_pct": 70,
            "signals": _fake_signals(support_low),
        }
    monkeypatch.setattr(pyramid, "check_entry", fake_check_entry)


def _patch_target(monkeypatch, multiple: float = 1.2):
    monkeypatch.setattr(
        pyramid, "_resistance_target",
        lambda day_df, entry, params: {
            "price": round(entry * multiple, 4), "source": "technical", "basis": "test",
        },
    )


# ---------- 入场与成交 ----------

class TestEntry:
    def test_entry_fills_next_open(self, monkeypatch):
        df = _df([(100, 100), (100, 100), (101, 101), (101, 101)])
        _patch_entry(monkeypatch, {df["date"].iloc[0]})
        _patch_target(monkeypatch)
        result = run_pyramid_backtest(df, "AAPL", df["date"].iloc[0], params=_params())
        assert result["summary"]["entered"] is True
        buy = result["trades"][0]
        assert buy["action"] == "buy"
        assert buy["date"] == df["date"].iloc[1]  # 信号次日成交
        assert buy["price"] == pytest.approx(100.0)
        assert buy["shares"] == 200  # 10万预算 × 20% ÷ 100元
        assert result["entry"]["signal_date"] == df["date"].iloc[0]

    def test_not_entered(self, monkeypatch):
        df = _df([(100, 100)] * 6)
        _patch_entry(monkeypatch, set())
        result = run_pyramid_backtest(df, "AAPL", df["date"].iloc[0])
        assert result["summary"]["not_entered"] is True
        assert result["trades"] == []
        assert "未出现" in result["summary"]["reason"]

    def test_signal_on_last_day_is_pending(self, monkeypatch):
        df = _df([(100, 100)] * 4)
        _patch_entry(monkeypatch, {df["date"].iloc[-1]})
        _patch_target(monkeypatch)
        result = run_pyramid_backtest(df, "AAPL", df["date"].iloc[0])
        assert result["trades"] == []
        assert len(result["pending_orders"]) == 1
        assert "待执行" in result["summary"]["reason"]

    def test_hk_lot_rounding(self, monkeypatch):
        df = _df([(93, 93), (93, 93), (94, 94)])
        _patch_entry(monkeypatch, {df["date"].iloc[0]})
        _patch_target(monkeypatch)
        result = run_pyramid_backtest(df, "0700.HK", df["date"].iloc[0], params=_params())
        buy = result["trades"][0]
        # 20000/93 ≈ 215 股 → 按一手 100 股向下取整为 200
        assert buy["shares"] == 200


# ---------- 金字塔加仓 ----------

class TestPyramidAdds:
    def _run(self, monkeypatch, path, ticker="AAPL", params=None):
        df = _df(path)
        _patch_entry(monkeypatch, {df["date"].iloc[0]})
        _patch_target(monkeypatch, 1.2)  # 目标 = 入场价 × 1.2
        return run_pyramid_backtest(
            df, ticker, df["date"].iloc[0], params=params or _params()
        )

    def test_three_tiers_decreasing(self, monkeypatch):
        # 入场 100；+5% 档 105、+10% 档 110 依次触发
        path = [(100, 100), (100, 100), (100, 105.5), (105, 105.5),
                (105, 110.5), (110, 110.5), (110, 111)]
        result = self._run(monkeypatch, path)
        buys = [t for t in result["trades"] if t["action"] in ("buy", "add")]
        assert [t["action"] for t in buys] == ["buy", "add", "add"]
        shares = [t["shares"] for t in buys]
        assert shares[0] > shares[1] > shares[2]  # 越涨越买越少
        assert shares[0] == 200               # 20000 @ 100
        assert shares[1] == int(10000 / 105)  # 底仓资金 × 0.5
        assert shares[2] == int(6000 / 110)   # 底仓资金 × 0.3

    def test_gap_over_tiers_buys_once(self, monkeypatch):
        # 单日从 +3% 跳到 +12%，越过 105/110 两档 → 只按最高档买一次
        path = [(100, 100), (100, 103), (103, 112), (112, 112), (112, 112.5)]
        params = _params(trim_space_progress=5.0, trim_gain_pct=5.0)  # 隔离减仓
        result = self._run(monkeypatch, path, params=params)
        adds = [t for t in result["trades"] if t["action"] == "add"]
        assert len(adds) == 1
        assert adds[0]["tier"] == 2  # 最高未触发档
        # 越过的档位不补买：后续价格维持在档位价上方也不再有 add


# ---------- 停止买入红线 ----------

class TestStopBuyRedline:
    def test_redline_permanent_no_chase(self, monkeypatch):
        # 目标 120（空间 20），close 117 走完 85% ≥ 80% → 红线；
        # 随后回落到 105.5（档1价位上方）也绝不补买。
        path = [(100, 100), (100, 100), (100, 117), (117, 105.5),
                (105, 105.5), (105, 106)]
        df = _df(path)
        _patch_entry(monkeypatch, {df["date"].iloc[0]})
        _patch_target(monkeypatch, 1.2)
        params = _params(trim_space_progress=5.0, trim_gain_pct=5.0)  # 隔离减仓
        result = run_pyramid_backtest(df, "AAPL", df["date"].iloc[0], params=params)
        buys = [t for t in result["trades"] if t["action"] in ("buy", "add")]
        assert len(buys) == 1  # 只有底仓，无任何加仓
        stop_events = [e for e in result["events"] if e["type"] == "stop_buy"]
        assert len(stop_events) == 1
        assert stop_events[0]["voided_tiers"] == 2
        assert "绝不追高" in stop_events[0]["reason"]
        assert result["summary"]["stop_buy_triggered"] is True

    def test_redline_does_not_block_trim(self, monkeypatch):
        # 红线触发后继续上涨，倒金字塔减仓照常执行
        path = [(100, 100), (100, 100), (100, 117), (117, 118),
                (118, 124), (124, 125), (125, 131), (131, 131)]
        df = _df(path)
        _patch_entry(monkeypatch, {df["date"].iloc[0]})
        _patch_target(monkeypatch, 1.2)
        result = run_pyramid_backtest(df, "AAPL", df["date"].iloc[0], params=_params())
        assert result["summary"]["stop_buy_triggered"] is True
        trims = [t for t in result["trades"] if t["action"] == "trim"]
        assert len(trims) >= 1


# ---------- 倒金字塔减仓 ----------

class TestInversePyramidTrim:
    def test_trim_increasing_and_negative_cost(self, monkeypatch):
        # 入场 100 → 加满三档 → 触发减仓 → 三批卖出批量递增 → 底仓负成本
        path = [
            (100, 100),        # 信号日
            (100, 100),        # 建仓 2000 股
            (100, 105.5), (105, 105.5),   # 档1 触发 → 105 买 952 股
            (105, 110.5), (110, 110.5),   # 档2 触发 → 110 买 545 股
            (110, 112.5),      # ≥112 触发减仓，批1 due
            (112, 118.2),      # 卖批1 590 股；close 触发批2（118.125）
            (119, 124.5),      # 卖批2 983 股；close 触发批3（124.03）
            (125, 126), (126, 126),       # 卖批3 1573 股
        ]
        df = _df(path)
        _patch_entry(monkeypatch, {df["date"].iloc[0]})
        _patch_target(monkeypatch, 1.2)
        result = run_pyramid_backtest(df, "AAPL", df["date"].iloc[0], params=_params())

        trims = [t for t in result["trades"] if t["action"] == "trim"]
        assert len(trims) == 3
        qty = [t["shares"] for t in trims]
        assert qty[0] < qty[1] < qty[2]  # 30:50:80 批量递增

        summary = result["summary"]
        assert summary["recovered"] > summary["invested"]
        assert summary["negative_cost"] is True
        assert summary["net_cost"] < 0
        assert summary["shares"] > 0  # 留有底仓
        # 减仓启动事件存在
        assert any(e["type"] == "trim_start" for e in result["events"])


# ---------- 止损退出 ----------

class TestStopLoss:
    def test_break_support_liquidates(self, monkeypatch):
        # 支撑 90，收盘 85 有效跌破 → 次日开盘清仓，推演终止
        path = [(100, 100), (100, 100), (100, 85), (86, 86), (86, 87), (87, 88)]
        df = _df(path)
        _patch_entry(monkeypatch, {df["date"].iloc[0]}, support_low=90.0)
        _patch_target(monkeypatch, 1.2)
        result = run_pyramid_backtest(df, "AAPL", df["date"].iloc[0], params=_params())
        last = result["trades"][-1]
        assert last["action"] == "stop_loss"
        assert last["date"] == df["date"].iloc[3]  # 跌破次日成交
        assert last["price"] == pytest.approx(86.0)
        assert result["summary"]["shares"] == 0
        assert result["summary"]["stop_loss_triggered"] is True
        assert any(e["type"] == "stop_loss" for e in result["events"])
        # 止损后不再有任何交易
        assert all(t["date"] <= last["date"] for t in result["trades"])


# ---------- 防未来函数 ----------

class TestNoLookahead:
    def test_truncation_consistency(self, monkeypatch):
        path = [(100, 100), (100, 100), (100, 105.5), (105, 105.5),
                (105, 110.5), (110, 110.5), (110, 111), (111, 112)]
        df = _df(path)
        _patch_entry(monkeypatch, {df["date"].iloc[0]})
        _patch_target(monkeypatch, 1.2)
        params = _params(window=6)
        base = run_pyramid_backtest(df, "AAPL", df["date"].iloc[0], params=params)

        # 数据源追加窗口之外的未来行，窗口内交易序列必须不变
        extra = _df([(200, 200)] * 3, start="2026-02-02")
        df_more = pd.concat([df, extra], ignore_index=True)
        again = run_pyramid_backtest(df_more, "AAPL", df["date"].iloc[0], params=params)
        assert base["trades"] == again["trades"]
        assert base["events"] == again["events"]
        assert base["summary"] == again["summary"]


# ---------- payload 契约与文案红线 ----------

class TestPayloadContract:
    def test_top_keys_and_json(self, monkeypatch):
        df = _df([(100, 100), (100, 100), (100, 106), (106, 106)])
        _patch_entry(monkeypatch, {df["date"].iloc[0]})
        _patch_target(monkeypatch)
        result = run_pyramid_backtest(df, "AAPL", df["date"].iloc[0])
        for key in (
            "ticker", "as_of", "effective_date", "window", "params", "entry",
            "trades", "events", "pending_orders", "ledger_series", "summary",
            "verdict_context", "chart_data", "assumptions", "disclaimer",
        ):
            assert key in result, key
        assert result["entry"]["target"]["source"] in ("technical", "fallback")
        assert result["entry"]["support"]["price"] > 0
        assert len(result["ledger_series"]) > 0
        json.dumps(result, ensure_ascii=False)  # 无 default 兜底，必须原生可序列化

    def test_copy_red_lines(self, monkeypatch):
        df = _df([(100, 100), (100, 100), (100, 106), (106, 106)])
        _patch_entry(monkeypatch, {df["date"].iloc[0]})
        _patch_target(monkeypatch)
        result = run_pyramid_backtest(df, "AAPL", df["date"].iloc[0])
        text = json.dumps(result, ensure_ascii=False)
        for word in FORBIDDEN_WORDS:
            assert word not in text
        assert "历史模拟" in result["disclaimer"]
        assert any("次一交易日开盘价" in a for a in result["assumptions"])


# ---------- 入场判定契约 ----------

class TestCheckEntry:
    def _patch_chain(
        self, monkeypatch, tier: str, right_light: str,
        n_right: int = 1, fb_score: float = 0.0,
    ):
        rights = [
            SignalResult(
                id=sig_id, name=sig_id, category="right", confidence=0.8,
                light=right_light, thresholds=(0.35, 0.7), weight=1,
                description="", data={},
            )
            for sig_id in (
                "above_ma", "support_retest_hold", "macd_cross",
                "volume_breakout", "higher_low",
            )[:n_right]
        ]
        monkeypatch.setattr(pyramid, "compute_all_signals", lambda df: rights)
        monkeypatch.setattr(
            pyramid, "compute_bottoming",
            lambda df, signals=None: SimpleNamespace(
                tier=tier, tier_label=tier, cleanliness_pct=50,
                signs=[SimpleNamespace(id="false_break_recover", score=fb_score)],
            ),
        )

    def test_ok_requires_tier_and_right_green(self, monkeypatch):
        df = _df([(100, 100)] * 3)
        self._patch_chain(monkeypatch, "base_forming", "green")
        result = check_entry(df)
        assert result["ok"] is True
        assert result["mode"] == "bottoming"

    def test_tier_too_low_rejected(self, monkeypatch):
        df = _df([(100, 100)] * 3)
        self._patch_chain(monkeypatch, "early_signs", "green")
        assert check_entry(df)["ok"] is False

    def test_no_right_green_rejected(self, monkeypatch):
        df = _df([(100, 100)] * 3)
        self._patch_chain(monkeypatch, "base_ready", "yellow")
        assert check_entry(df)["ok"] is False

    def test_strong_right_channel_triggers(self, monkeypatch):
        # 筑底仅初现，但右侧 3 绿灯 + 假破位收回初现 → strong_right
        df = _df([(100, 100)] * 3)
        self._patch_chain(monkeypatch, "early_signs", "green", n_right=3, fb_score=0.5)
        result = check_entry(df)
        assert result["ok"] is True
        assert result["mode"] == "strong_right"
        assert len(result["right_green_all"]) == 3

    def test_strong_right_disabled(self, monkeypatch):
        df = _df([(100, 100)] * 3)
        self._patch_chain(monkeypatch, "early_signs", "green", n_right=3, fb_score=0.5)
        params = PyramidParams(strong_right_enabled=False)
        assert check_entry(df, params)["ok"] is False

    def test_strong_right_requires_false_break_recover(self, monkeypatch):
        # 纯动量追涨被排除：绿灯够但假破位收回不足初现
        df = _df([(100, 100)] * 3)
        self._patch_chain(monkeypatch, "early_signs", "green", n_right=4, fb_score=0.2)
        assert check_entry(df)["ok"] is False

    def test_strong_right_not_in_uptrend(self, monkeypatch):
        df = _df([(100, 100)] * 3)
        self._patch_chain(monkeypatch, "trend_running", "green", n_right=4, fb_score=0.6)
        assert check_entry(df)["ok"] is False


class TestStrongRightPosition:
    def test_half_position_and_ledger_labels(self, monkeypatch):
        df = _df([(100, 100), (100, 100), (101, 101)])

        def fake_entry(day_df):
            d = str(day_df["date"].iloc[-1]).split()[0]
            return {
                "ok": d == df["date"].iloc[0], "mode": "strong_right",
                "tier": "early_signs", "tier_label": "筑底迹象初现",
                "right_green": ["above_ma"],
                "right_green_all": ["above_ma", "macd_cross", "support_retest_hold"],
                "cleanliness_pct": 40, "signals": _fake_signals(),
            }

        monkeypatch.setattr(
            pyramid, "_resistance_target",
            lambda day_df, entry, params: {"price": entry * 1.2, "source": "technical", "basis": "t"},
        )
        result = run_pyramid_backtest(
            df, "AAPL", df["date"].iloc[0],
            params=_params(), entry_checker=fake_entry,
        )
        buy = result["trades"][0]
        assert buy["shares"] == 100  # 10万 × 20% × 50% ÷ 100元 = 100 股
        assert "小仓" in buy["reason"]
        assert result["entry"]["mode"] == "strong_right"
        assert result["entry"]["mode_label"] == "强右侧通道（小仓）"

    def _strong_entry(self, df, support_low: float):
        first = df["date"].iloc[0]

        def fake_entry(day_df):
            d = str(day_df["date"].iloc[-1]).split()[0]
            return {
                "ok": d == first, "mode": "strong_right",
                "tier": "early_signs", "tier_label": "筑底迹象初现",
                "right_green": ["above_ma"],
                "right_green_all": ["above_ma", "macd_cross", "support_retest_hold"],
                "cleanliness_pct": 40, "signals": _fake_signals(support_low),
            }

        return fake_entry

    def test_tight_stop_when_support_far(self, monkeypatch):
        # 支撑 80（距入场 100 达 20% > 8%）→ 止损上收到 93；
        # 收盘 85 未破原始支撑 80（含缓冲），但破紧止损 93 → 清仓
        df = _df([(100, 100), (100, 100), (100, 85), (86, 86), (86, 87)])
        monkeypatch.setattr(
            pyramid, "_resistance_target",
            lambda day_df, entry, params: {"price": entry * 1.2, "source": "technical", "basis": "t"},
        )
        result = run_pyramid_backtest(
            df, "AAPL", df["date"].iloc[0],
            params=_params(), entry_checker=self._strong_entry(df, support_low=80.0),
        )
        support = result["entry"]["support"]
        assert support["source"] == "strong_right_tight"
        assert support["price"] == pytest.approx(93.0)
        assert support["raw_price"] == pytest.approx(80.0)  # 原始支撑保留供核对
        assert result["summary"]["stop_loss_triggered"] is True
        last = result["trades"][-1]
        assert last["action"] == "stop_loss"
        assert last["price"] == pytest.approx(86.0)  # 次日开盘清仓

    def test_no_tight_stop_when_support_near(self, monkeypatch):
        # 支撑 95（距入场 5% < 8%）→ 不启用紧止损，沿用原支撑
        df = _df([(100, 100), (100, 100), (100, 101)])
        monkeypatch.setattr(
            pyramid, "_resistance_target",
            lambda day_df, entry, params: {"price": entry * 1.2, "source": "technical", "basis": "t"},
        )
        result = run_pyramid_backtest(
            df, "AAPL", df["date"].iloc[0],
            params=_params(), entry_checker=self._strong_entry(df, support_low=95.0),
        )
        assert result["entry"]["support"]["source"] == "active_support"
        assert result["entry"]["support"]["price"] == pytest.approx(95.0)

    def test_bottoming_mode_keeps_raw_support(self, monkeypatch):
        # 标准筑底路径：支撑 90（距入场 10% > 8%）也不上收
        df = _df([(100, 100), (100, 100), (100, 101)])
        _patch_entry(monkeypatch, {df["date"].iloc[0]}, support_low=90.0)
        _patch_target(monkeypatch, 1.2)
        result = run_pyramid_backtest(df, "AAPL", df["date"].iloc[0], params=_params())
        assert result["entry"]["support"]["price"] == pytest.approx(90.0)
        assert result["entry"]["support"]["source"] == "active_support"


# ---------- 目标价识别 ----------

class TestResistanceTarget:
    def test_technical_target_from_prior_high(self):
        # 前段在 115 平台密集震荡，后段跌到 100 → 目标应识别在 115 附近
        n1, n2 = 30, 30
        rows = []
        dates = pd.date_range("2026-01-01", periods=n1 + n2, freq="B").strftime("%Y-%m-%d")
        rng = np.random.default_rng(5)
        for i in range(n1):
            c = 115 + rng.normal(0, 0.4)
            rows.append({"date": dates[i], "open": c - 0.2, "high": c + 0.6,
                         "low": c - 0.6, "close": c, "volume": 8_000_000})
        for i in range(n2):
            c = 100 + rng.normal(0, 0.4)
            rows.append({"date": dates[n1 + i], "open": c - 0.2, "high": c + 0.6,
                         "low": c - 0.6, "close": c, "volume": 5_000_000})
        df = pd.DataFrame(rows)
        target = _resistance_target(df, 100.0, PyramidParams())
        assert target["source"] == "technical"
        assert 110 <= target["price"] <= 120

    def test_fallback_when_at_high(self):
        # 一路新高，入场价上方无压力 → 回退 +20%
        n = 80
        dates = pd.date_range("2026-01-01", periods=n, freq="B").strftime("%Y-%m-%d")
        close = np.linspace(80, 120, n)
        df = pd.DataFrame({
            "date": dates, "open": close - 0.3, "high": close + 0.5,
            "low": close - 0.5, "close": close, "volume": np.full(n, 5_000_000),
        })
        target = _resistance_target(df, 120.0, PyramidParams())
        assert target["source"] == "fallback"
        assert target["price"] == pytest.approx(144.0)


# ---------- demo 与 HTML 渲染 ----------

class TestDemoAndRenderer:
    def test_demo_full_script(self):
        from analyzer.pyramid import build_demo_pyramid_backtest

        payload = build_demo_pyramid_backtest()
        assert payload["demo"] is True
        actions = [t["action"] for t in payload["trades"]]
        assert actions.count("buy") == 1
        assert actions.count("add") == 2
        assert actions.count("trim") >= 2
        assert any(e["type"] == "stop_buy" for e in payload["events"])
        assert payload["summary"]["trim_started"] is True
        json.dumps(payload, ensure_ascii=False)

    def test_render_html_report(self):
        from analyzer.pyramid import build_demo_pyramid_backtest
        from analyzer.pyramid_renderer import render_pyramid_html

        payload = build_demo_pyramid_backtest()
        html = render_pyramid_html(payload)
        # 结论横幅 / 账本 / 纪律事件 / 假设与免责同屏
        assert "金字塔回测结论" in html
        assert "逐笔账本" in html
        assert "纪律事件" in html
        assert "执行假设" in html
        assert "历史模拟" in html
        assert "次一交易日开盘价" in html
        # 图表数据与价格线
        assert "createPriceLine" in html
        assert "setMarkers" in html
        assert "停止买入红线" in html
        # 文案红线
        for word in FORBIDDEN_WORDS:
            assert word not in html

    def test_render_not_entered(self, monkeypatch):
        from analyzer.pyramid_renderer import render_pyramid_html

        df = _df([(100, 100)] * 5)
        _patch_entry(monkeypatch, set())
        payload = run_pyramid_backtest(df, "AAPL", df["date"].iloc[0])
        html = render_pyramid_html(payload)
        assert "未出现" in html
        assert "无交易记录" in html
