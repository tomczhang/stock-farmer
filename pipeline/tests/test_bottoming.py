"""筑底三迹象判读引擎测试。"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from analyzer.bottoming import (
    BottomingSign,
    CHIP_MIN_BARS,
    FALSE_BREAKDOWN_WEIGHT,
    NO_NEW_LOW_WEIGHT,
    _make_sign,
    _resolve_tier,
    build_chip_stability_sign,
    build_false_break_recover_sign,
    build_vol_dry_up_sign,
    compute_bottoming,
    compute_cleanliness,
)
from analyzer.signals import SignalResult, compute_all_signals

FORBIDDEN_WORDS = ("胜率", "概率", "准确率", "必涨")


def _sig(sig_id: str, conf: float, data: dict | None = None, desc: str = "") -> SignalResult:
    return SignalResult(
        id=sig_id, name=sig_id, category="left",
        confidence=conf, light="red", thresholds=(0.35, 0.70), weight=1,
        description=desc, data=data or {},
    )


def _make_df(
    n: int = 120,
    price: float = 100.0,
    vol: float = 5_000_000,
    start: str = "2026-01-01",
) -> pd.DataFrame:
    rng = np.random.default_rng(11)
    dates = pd.date_range(start, periods=n, freq="B").strftime("%Y-%m-%d")
    close = price + rng.normal(0, 0.5, n)
    return pd.DataFrame({
        "date": dates,
        "open": close - 0.2,
        "high": close + 0.8,
        "low": close - 0.8,
        "close": close,
        "volume": np.full(n, vol),
    })


# ---------- 迹象一：缩量下跌 ----------

class TestVolDryUpSign:
    def test_clear_state(self):
        scores = {"single": 0.8, "stage": 0.7, "obvious": 0.6, "trend": 0.9, "divergence": 0.5}
        sign = build_vol_dry_up_sign(_sig("vol_shrink", 0.82, {"scores": scores}))
        assert sign.id == "vol_dry_up"
        assert sign.state == "clear"
        assert sign.state_label == "明显"
        assert "抛压明显减轻" in sign.description
        assert "5/5 项" in sign.description
        assert len(sign.dimensions) == 5

    def test_absent_state_no_shrink_claim(self):
        scores = {"single": 0.0, "stage": 0.0, "obvious": 0.0, "trend": 0.0, "divergence": 0.0}
        sign = build_vol_dry_up_sign(_sig("vol_shrink", 0.05, {"scores": scores}))
        assert sign.state == "absent"
        assert "明显" not in sign.description.split("（")[0]
        assert "谈不上缩量下跌" in sign.description

    def test_insufficient_data(self):
        sign = build_vol_dry_up_sign(_sig("vol_shrink", 0.0, {}))
        assert sign.state == "absent"
        assert "数据不足" in sign.description


# ---------- 迹象二：假破位收回 ----------

class TestFalseBreakRecoverSign:
    def test_recover_event_detected(self):
        fb = _sig("false_breakdown", 0.8, {
            "active_support": {"low": 90.0, "high": 92.0, "strength": 0.7},
            "breakdown_event": {
                "break_date": "2026-03-02", "recover_date": "2026-03-04", "recover_days": 2,
            },
        })
        nn = _sig("no_new_low", 0.9)
        sign = build_false_break_recover_sign(fb, nn)
        expected = 0.8 * FALSE_BREAKDOWN_WEIGHT + 0.9 * NO_NEW_LOW_WEIGHT
        assert sign.score == pytest.approx(expected)
        assert sign.state == "clear"
        assert "假破位" in sign.description
        assert "跌不动" in sign.description

    def test_true_breakdown_not_misjudged(self):
        # 真破位：有支撑但无收回事件，且仍在创新低 → 未出现
        fb = _sig("false_breakdown", 0.0, {
            "active_support": {"low": 90.0, "high": 92.0, "strength": 0.7},
            "breakdown_event": {},
        })
        nn = _sig("no_new_low", 0.1)
        sign = build_false_break_recover_sign(fb, nn)
        assert sign.state == "absent"
        assert "仍在向下破位" in sign.description

    def test_no_new_low_only_is_distinguished(self):
        # 无假破位事件但跌不动成立 → 描述必须如实区分
        fb = _sig("false_breakdown", 0.0, {
            "active_support": {"low": 90.0, "high": 92.0, "strength": 0.7},
            "breakdown_event": {},
        })
        nn = _sig("no_new_low", 1.0)
        sign = build_false_break_recover_sign(fb, nn)
        assert sign.state == "early"
        assert "没有出现破位后收回" in sign.description
        assert "跌不动" in sign.description

    def test_no_stable_support(self):
        fb = _sig("false_breakdown", 0.0, {"active_support": {}, "breakdown_event": {}})
        nn = _sig("no_new_low", 0.2)
        sign = build_false_break_recover_sign(fb, nn)
        assert "未识别到可靠支撑" in sign.description


# ---------- 迹象三：筹码稳定 ----------

class TestChipStabilitySign:
    def test_insufficient_data(self):
        sign = build_chip_stability_sign(_make_df(n=CHIP_MIN_BARS - 1))
        assert sign.state == "absent"
        assert "数据不足" in sign.description

    def test_stable_peak_low_turnover_is_clear(self):
        # 价格全程横盘（筹码峰不动），近期量能显著萎缩 → 明显
        df = _make_df(n=250)
        df.loc[df.index[-25:], "volume"] = 1_500_000
        sign = build_chip_stability_sign(df)
        peak_dim = sign.dimensions[0]
        turnover_dim = sign.dimensions[1]
        assert peak_dim["score"] >= 0.9
        assert turnover_dim["score"] >= 0.9
        assert sign.state == "clear"
        assert "套牢盘没有割肉" in sign.description
        assert "自身" in turnover_dim["detail"]  # 相对自身历史口径

    def test_peak_moved_down_scores_zero(self):
        # 前 30 日密集成交在 110，近 30 日密集成交在 90 → 筹码峰下移归零
        df = _make_df(n=120, price=110.0)
        idx = df.index[-30:]
        df.loc[idx, ["open", "high", "low", "close"]] = [89.8, 90.8, 89.2, 90.0]
        df.loc[idx, "volume"] = 8_000_000
        sign = build_chip_stability_sign(df)
        peak_dim = sign.dimensions[0]
        assert peak_dim["score"] == 0.0
        assert "下移" in sign.description

    def test_daily_only_no_minute_dependency(self):
        # 仅日线 OHLCV 即可完整计算（无分钟数据、无流通股本字段）
        df = _make_df(n=120)
        sign = build_chip_stability_sign(df)
        assert sign.id == "chip_stability"
        assert len(sign.dimensions) == 2


# ---------- 聚合判读 ----------

def _sign_with(sign_id: str, score: float) -> BottomingSign:
    return _make_sign(sign_id, sign_id, sign_id, score, "desc", [])


class TestResolveTier:
    def test_zero_clear_is_still_falling(self):
        signs = [_sign_with("vol_dry_up", 0.1), _sign_with("false_break_recover", 0.2),
                 _sign_with("chip_stability", 0.1)]
        assert _resolve_tier(signs) == "still_falling"

    def test_one_clear_is_early_signs(self):
        signs = [_sign_with("vol_dry_up", 0.8), _sign_with("false_break_recover", 0.2),
                 _sign_with("chip_stability", 0.1)]
        assert _resolve_tier(signs) == "early_signs"

    def test_two_early_is_early_signs(self):
        signs = [_sign_with("vol_dry_up", 0.5), _sign_with("false_break_recover", 0.5),
                 _sign_with("chip_stability", 0.1)]
        assert _resolve_tier(signs) == "early_signs"

    def test_two_clear_is_base_forming(self):
        signs = [_sign_with("vol_dry_up", 0.8), _sign_with("false_break_recover", 0.9),
                 _sign_with("chip_stability", 0.3)]
        assert _resolve_tier(signs) == "base_forming"

    def test_three_clear_is_base_ready(self):
        signs = [_sign_with("vol_dry_up", 0.8), _sign_with("false_break_recover", 0.9),
                 _sign_with("chip_stability", 0.75)]
        assert _resolve_tier(signs) == "base_ready"


class TestCleanliness:
    def test_weighted_formula(self):
        signs = [
            _sign_with("vol_dry_up", 0.4),
            _sign_with("false_break_recover", 0.8),
            _sign_with("chip_stability", 0.6),
        ]
        # (0.4 + 2*0.8 + 0.6) / 4 = 0.65
        assert compute_cleanliness(signs) == pytest.approx(0.65)


class TestComputeBottoming:
    def test_verdict_structure_and_sign_order(self):
        df = _make_df(n=120)
        verdict = compute_bottoming(df)
        assert [s.id for s in verdict.signs] == [
            "vol_dry_up", "false_break_recover", "chip_stability",
        ]
        assert verdict.tier in (
            "still_falling", "early_signs", "base_forming", "base_ready", "trend_running",
        )
        assert 0.0 <= verdict.cleanliness <= 1.0
        assert verdict.cleanliness_pct == int(round(verdict.cleanliness * 100))
        assert verdict.next_trigger

    def test_reuses_precomputed_signals(self):
        df = _make_df(n=120)
        signals = compute_all_signals(df)
        verdict_a = compute_bottoming(df, signals=signals)
        verdict_b = compute_bottoming(df)
        assert verdict_a.tier == verdict_b.tier
        assert verdict_a.cleanliness == pytest.approx(verdict_b.cleanliness)

    def test_uptrend_overrides_still_falling(self):
        n = 260
        dates = pd.date_range("2025-01-01", periods=n, freq="B").strftime("%Y-%m-%d")
        close = np.linspace(50, 150, n)
        df = pd.DataFrame({
            "date": dates,
            "open": close - 0.3,
            "high": close + 0.6,
            "low": close - 0.6,
            "close": close,
            "volume": np.full(n, 5_000_000),
        })
        verdict = compute_bottoming(df)
        assert verdict.regime == "uptrend"
        assert verdict.tier == "trend_running"
        assert verdict.tier_label == "趋势运行中"
        assert "仍在下跌" not in verdict.tier_label

    def test_still_falling_action(self):
        # 放量下跌、持续创新低 → 仍在下跌，不碰
        n = 120
        dates = pd.date_range("2026-01-01", periods=n, freq="B").strftime("%Y-%m-%d")
        close = 100 - np.arange(n) * 0.8
        df = pd.DataFrame({
            "date": dates,
            "open": close + 0.5,
            "high": close + 1.0,
            "low": close - 1.0,
            "close": close,
            "volume": np.linspace(5_000_000, 12_000_000, n),  # 越跌越放量
        })
        verdict = compute_bottoming(df)
        assert verdict.tier == "still_falling"
        assert "不碰" in verdict.action

    def test_as_of_truncation_consistency(self):
        # 追加未来数据不影响截断日之前的判读（防未来函数）
        df = _make_df(n=200)
        truncated = df.iloc[:150].reset_index(drop=True)
        verdict_before = compute_bottoming(truncated)
        # 全量数据存在的情况下，对同样的截断窗口再算一遍
        verdict_after = compute_bottoming(df.iloc[:150].reset_index(drop=True))
        assert verdict_before.tier == verdict_after.tier
        assert verdict_before.cleanliness == pytest.approx(verdict_after.cleanliness)
        for a, b in zip(verdict_before.signs, verdict_after.signs):
            assert a.score == pytest.approx(b.score)

    def test_copy_red_lines(self):
        # 文案红线：所有档位与迹象描述不得出现胜率/概率/准确率
        from analyzer.bottoming import _TIER_META

        for meta in _TIER_META.values():
            for text in meta.values():
                for word in FORBIDDEN_WORDS:
                    assert word not in text
        df = _make_df(n=120)
        verdict = compute_bottoming(df)
        texts = [verdict.action, verdict.next_trigger, verdict.tier_label]
        texts += [s.description for s in verdict.signs]
        for text in texts:
            for word in FORBIDDEN_WORDS:
                assert word not in text
