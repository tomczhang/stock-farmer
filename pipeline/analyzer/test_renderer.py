"""renderer.py 的最小化单测：覆盖 4 态映射 + render_html 输出契约。"""
from __future__ import annotations

import pytest

from pipeline.analyzer.phase import PhaseResult
from pipeline.analyzer.renderer import (
    _RIGHT_STATE_TABLE,
    _render_design_tokens,
    _render_right_signal_card,
    _resolve_right_state,
    render_html,
)
from pipeline.analyzer.signals import SignalResult


# ---------------- 4 态映射 ----------------

@pytest.mark.parametrize(
    "confidence,thresholds,expected",
    [
        (0.20, (0.4, 0.7), "default"),       # < red_max
        (0.45, (0.4, 0.7), "warning-soft"),  # [red_max, 0.55)
        (0.60, (0.4, 0.7), "warning"),       # [0.55, yellow_max)
        (0.82, (0.4, 0.7), "success"),       # >= yellow_max
        (0.40, (0.4, 0.7), "warning-soft"),  # 边界：等于 red_max
        (0.70, (0.4, 0.7), "success"),       # 边界：等于 yellow_max
        (0.55, (0.4, 0.7), "warning"),       # 边界：等于 break
    ],
)
def test_resolve_right_state(confidence, thresholds, expected):
    assert _resolve_right_state(confidence, thresholds) == expected


# ---------------- token 注入 ----------------

def test_design_tokens_block_contains_required_vars():
    css = _render_design_tokens()
    required = [
        "--color-default", "--color-default-100",
        "--color-success", "--color-success-100",
        "--color-warning", "--color-warning-100",
        "--color-danger", "--color-danger-100",
        "--color-surface", "--color-surface-secondary",
        "--color-divider", "--radius-card", "--shadow-xs",
    ]
    for var in required:
        assert var in css, f"missing token: {var}"
    assert css.startswith("<style>") and css.rstrip().endswith("</style>")


# ---------------- 右侧卡片视觉契约 ----------------

def _make_right_signal(confidence: float, name: str = "站回均线") -> SignalResult:
    return SignalResult(
        id="above_ma",
        name=name,
        category="right",
        confidence=confidence,
        light="green" if confidence >= 0.7 else "yellow" if confidence >= 0.4 else "red",
        thresholds=(0.4, 0.7),
        weight=1,
        description="价格站上 MA20，3 日内未跌破。",
        data={},
    )


def test_right_card_success_uses_secondary_surface():
    html = _render_right_signal_card(_make_right_signal(0.82), chart_idx=6)
    assert "已触发" in html
    assert "var(--color-success)" in html
    assert "var(--color-surface-secondary)" in html


def test_right_card_default_uses_main_surface():
    html = _render_right_signal_card(_make_right_signal(0.20), chart_idx=6)
    assert "未触发" in html
    assert "var(--color-success)" not in html
    assert "var(--color-warning)" not in html
    assert "var(--color-surface)" in html
    assert "var(--color-surface-secondary)" not in html


def test_right_card_warning_soft_label():
    html = _render_right_signal_card(_make_right_signal(0.45), chart_idx=6)
    assert "酝酿中" in html
    assert "临界" not in html


def test_right_card_warning_label():
    html = _render_right_signal_card(_make_right_signal(0.60), chart_idx=6)
    assert "临界" in html
    assert "酝酿中" not in html


def test_right_card_no_emoji_state():
    for c in (0.20, 0.45, 0.60, 0.82):
        html = _render_right_signal_card(_make_right_signal(c), chart_idx=6)
        for emoji in ("🔴", "🟡", "🟢"):
            assert emoji not in html, f"emoji {emoji} leaked into right card at confidence={c}"


def test_right_card_no_threshold_ruler():
    html = _render_right_signal_card(_make_right_signal(0.50), chart_idx=6)
    assert "0-25%" not in html
    assert "80%+" not in html


# ---------------- render_html 端到端 ----------------

def _make_phase() -> PhaseResult:
    return PhaseResult(
        phase="筑底",
        icon="🟡",
        action="观察等待",
        trigger="尚未出现确认信号",
        strength=0.5,
        strength_pct=50,
    )


def _make_signals() -> list[SignalResult]:
    left = [
        SignalResult(
            id=f"left_{i}", name=f"左信号{i}", category="left",
            confidence=0.5, light="yellow", thresholds=(0.35, 0.7),
            weight=1, description="x", data={},
        )
        for i in range(6)
    ]
    right_confidences = [0.20, 0.45, 0.60, 0.85]
    right = [
        SignalResult(
            id=f"right_{i}", name=f"右信号{i}", category="right",
            confidence=c,
            light="green" if c >= 0.7 else "yellow" if c >= 0.4 else "red",
            thresholds=(0.4, 0.7), weight=1, description="x", data={},
        )
        for i, c in enumerate(right_confidences)
    ]
    return left + right


def test_render_html_injects_tokens_in_head():
    html = render_html("AAPL", "Apple", 200.0, 1.5, _make_signals(), _make_phase(), "narrative")
    head = html.split("</head>")[0]
    # tokens block 必须出现在 <head> 内
    assert "--color-success" in head
    assert "--color-surface" in head


def test_render_html_footer_has_4_state_legend():
    html = render_html("AAPL", "Apple", 200.0, 1.5, _make_signals(), _make_phase(), "narrative")
    footer = html.split("<footer")[1].split("</footer>")[0]
    for word in ("未触发", "酝酿中", "临界", "已触发"):
        assert word in footer, f"footer missing 4-state word: {word}"


def test_render_html_left_keeps_emoji_right_drops_it():
    html = render_html("AAPL", "Apple", 200.0, 1.5, _make_signals(), _make_phase(), "narrative")
    # 左侧区段
    left_section = html.split("左侧信号 · 底部特征")[1].split("右侧信号 · 趋势确认")[0]
    assert any(e in left_section for e in ("🔴", "🟡", "🟢")), "left section should keep emoji indicators"
    # 右侧区段（截到 footer 之前）
    right_section = html.split("右侧信号 · 趋势确认")[1].split("<footer")[0]
    for emoji in ("🔴", "🟡", "🟢"):
        assert emoji not in right_section, f"emoji {emoji} leaked into right section"


def test_render_html_right_uses_no_surface_secondary_for_left():
    html = render_html("AAPL", "Apple", 200.0, 1.5, _make_signals(), _make_phase(), "narrative")
    left_section = html.split("左侧信号 · 底部特征")[1].split("右侧信号 · 趋势确认")[0]
    assert "var(--color-surface-secondary)" not in left_section


def test_state_table_keys():
    assert set(_RIGHT_STATE_TABLE.keys()) == {"default", "warning-soft", "warning", "success"}
