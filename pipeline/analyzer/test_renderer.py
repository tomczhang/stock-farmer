"""筑底静态报告与金字塔静态报告测试。"""
from __future__ import annotations

from pipeline.analyzer.pyramid import build_demo_pyramid_backtest
from pipeline.analyzer.pyramid_renderer import render_pyramid_html
from pipeline.analyzer.renderer import render_html
from pipeline.analyzer.report import _demo_bottoming_verdict, _demo_klines
from pipeline.analyzer.signals import SignalResult


def _signals() -> list[SignalResult]:
    return [
        SignalResult(
            id=f"evidence_{idx}", name=f"证据{idx}", category="left",
            confidence=0.5 + idx * 0.03, light="yellow", thresholds=(0.35, 0.70),
            weight=1, description="结构证据描述", data={},
        )
        for idx in range(6)
    ]


def _html(**overrides) -> str:
    kwargs = {
        "ticker": "AAPL",
        "name": "苹果",
        "price": 200.0,
        "change_pct": 1.2,
        "signals": _signals(),
        "narrative": "筑底结构综述。",
        "chart_data": {"klines": _demo_klines().to_dict("records")},
        "report_context": {"mode": "historical", "effective_date": "2026-04-30"},
        "bottoming_history": {
            "window": 1,
            "points": [{
                "date": "2026-04-30", "close": 200, "cleanliness_pct": 66,
                "normalized_close_pct": 50, "tier_label": "筑底基本成立",
            }],
        },
        "bottoming": _demo_bottoming_verdict(),
    }
    kwargs.update(overrides)
    return render_html(**kwargs)


def test_render_contains_bottoming_conclusion_and_evidence():
    html = _html()
    assert "<!doctype html>" in html
    assert "筑底结构诊断" in html
    assert "筑底基本成立" in html
    assert "筑底结构强度" in html
    assert "证据0" in html
    assert "筑底历史 · 证伪镜" in html


def test_render_omits_removed_system_copy():
    html = _html()
    for text in ("右侧信号", "右侧触发度", "站回均线", "MACD 金叉", "未触发 / 酝酿中"):
        assert text not in html


def test_render_includes_design_tokens_and_disclaimer():
    html = _html()
    assert "--color-success" in html
    assert "--color-surface" in html
    assert "仅供研究复盘，不构成投资建议" in html


def test_render_escapes_identity():
    html = _html(ticker="<BAD>", name="<script>alert(1)</script>")
    assert "&lt;BAD&gt;" in html
    assert "<script>alert(1)</script>" not in html


def test_pyramid_renderer_uses_manual_decision_copy():
    html = render_pyramid_html(build_demo_pyramid_backtest())
    assert "手动决策日" in html
    assert "系统不判断买点" in html
    assert "右侧触发" not in html
    assert "右侧失效" not in html
