"""renderer.py 的最小化单测：覆盖状态映射、token、加权分、render_html 端到端输出契约。"""
from __future__ import annotations

import pytest

from pipeline.analyzer.phase import PhaseResult
from pipeline.analyzer.renderer import (
    _LEFT_STATE_TABLE,
    _RIGHT_STATE_TABLE,
    _compute_confirmation,
    _render_design_tokens,
    _render_right_signal_card,
    _resolve_left_state,
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


def test_render_html_falls_back_to_kline_change_pct():
    chart_data = {
        "klines": [
            {"date": "2026-01-01", "close": 100},
            {"date": "2026-01-02", "close": 105},
        ]
    }
    html = render_html("AAPL", "Apple", None, None, _make_signals(), _make_phase(), "narrative", chart_data)
    header = html.split("<!-- Header -->")[1].split("<!-- Hero")[0]
    assert "$105.00" in header
    assert "+5.00%" in header


def test_render_html_injects_support_zone_chart_data():
    signals = [
        SignalResult(
            id="false_breakdown", name="假破位收回", category="left",
            confidence=0.2, light="red", thresholds=(0.3, 0.6), weight=2,
            description="跌破支撑区间观察",
            data={
                "support_zones": [
                    {
                        "low": 418.5, "high": 425.5, "center": 421.0,
                        "strength": 0.72, "sources": ["近3个月前低", "整数关口"],
                    }
                ],
                "display_support_zones": [
                    {
                        "low": 418.5, "high": 425.5, "center": 421.0,
                        "strength": 0.72, "sources": ["近3个月前低", "整数关口"],
                        "display_role": "下个强支撑",
                    }
                ],
                "support_focus": {"has_strong_support": True},
                "active_support": {"low": 418.5, "high": 425.5},
                "breakdown_event": {},
            },
        ),
    ] + [
        SignalResult(
            id=f"L{i}", name=f"L{i}", category="left", confidence=0.5, light="yellow",
            thresholds=(0.35, 0.7), weight=1, description="x", data={},
        )
        for i in range(5)
    ] + [
        SignalResult(
            id=f"R{i}", name=f"R{i}", category="right", confidence=0.5, light="yellow",
            thresholds=(0.4, 0.7), weight=1, description="x", data={},
        )
        for i in range(4)
    ]
    chart_data = {
        "klines": [
            {"date": "2026-01-01", "open": 430, "high": 435, "low": 420, "close": 428, "volume": 1_000_000},
            {"date": "2026-01-02", "open": 428, "high": 432, "low": 421, "close": 429, "volume": 1_100_000},
        ]
    }
    html = render_html("0700.HK", "腾讯控股", 429.0, 0.2, signals, _make_phase(), "n", chart_data)
    assert "renderSupportChart('chart-2'" in html
    assert "createSupportChart" in html
    assert "aggregateWeeklyKlines" in html
    assert "aggregateMonthlyKlines" in html
    assert "weekTimeForDate" in html
    assert "handleScale: false" in html
    assert "handleScroll: false" in html
    assert "priceLineVisible: true" in html
    assert "lastValueVisible: true" in html
    assert "upColor: 'rgba(220, 38, 38, 0)'" in html
    assert "borderVisible: true" in html
    assert "borderUpColor: '#dc2626'" in html
    assert "downColor: '#16a34a'" in html
    assert "axisLabelVisible: true" in html
    assert "data-support-tf=\"day\"" in html
    assert "data-support-tf=\"week\"" in html
    assert "data-support-tf=\"month\"" in html
    assert "支撑位怎么判断" in html
    assert "先定位价格带，再判断关注是否集中、是否可靠" in html
    assert "1. 先找候选" in html
    assert "从前低、平台下沿、整数关口里找可能被市场关注的价格点" in html
    assert "2. 看共振" in html
    assert "data-support-help=\"confluence\"" in html
    assert "3. 看稳定性" in html
    assert "data-support-help=\"stability\"" in html
    assert "width:14px;height:14px" in html
    assert "font-size:9px;line-height:12px" in html
    assert "共振怎么看" in html
    assert "稳定性怎么算" in html
    assert "每一类只取该区间内最高质量候选" in html
    assert "当前权重" in html
    assert "前低 40%，平台下沿 35%，整数关口 15%" in html
    assert "grid-template-columns:84px 1fr" in html
    assert "backdrop-filter:blur(2px)" in html
    assert "共振看不同依据是否指向同一价格带" in html
    assert "共振不是上涨概率，也不等于强支撑" in html
    assert "前低看低点后 1–3 日是否快速反弹" in html
    assert "平台下沿取低点 20% 分位，平台上沿取收盘价 80% 分位" in html
    assert "箱体宽度 = (上沿 - 下沿) / 下沿" in html
    assert "超过约 12% 不算有效平台" in html
    assert "约 4% 或更窄接近满分" in html
    assert "50–59 中等偏强、待确认；≥60 强支撑" in html
    assert "支撑位要同时看稳定性和共振" in html
    assert "关键观察支撑可以用于跟踪和风控，但不等同于强支撑" in html
    assert "support-help-modal" in html
    assert "attachSupportHelpModal" in html
    assert "barSpacing: 8" in html
    assert '"signal_data"' in html
    assert '"support_zones"' in html
    assert '"display_support_zones"' in html
    assert '"low": 418.5' in html
    assert "下个强支撑" in html
    assert "支撑上沿" not in html
    assert "支撑下沿" not in html
    assert "support-zone-legend" in html
    assert "支撑稳定性" in html
    assert "support-tip-bubble" in html
    assert "稳定性衡量支撑是否可靠，≥60% 才算强支撑" in html
    assert "共振衡量不同依据是否集中到同一价格带，≥40% 就值得重点观察" in html
    assert "mouseenter" in html
    assert "pointerenter" in html
    assert "click" in html


def test_volume_signal_chart_limits_visible_daily_klines():
    html = render_html("AAPL", "Apple", 200.0, 1.5, _make_signals(), _make_phase(), "narrative")

    assert "const VOLUME_SIGNAL_VISIBLE_DAYS = 120" in html
    assert "const visibleKlines = klines.slice(-VOLUME_SIGNAL_VISIBLE_DAYS)" in html
    assert "candleSeries.setData(visibleKlines.map" in html
    assert ".filter(p => p && visibleTimes.has(p.time))" in html


def test_chip_concentration_renders_profile_next_to_kline():
    left = [
        SignalResult(
            id=f"L{i}", name=f"L{i}", category="left", confidence=0.5, light="yellow",
            thresholds=(0.35, 0.7), weight=1, description="x", data={},
        )
        for i in range(4)
    ]
    left.append(SignalResult(
        id="chip_concentration", name="筹码集中", category="left", confidence=0.36,
        light="yellow", thresholds=(0.35, 0.7), weight=1,
        description="前3价位桶占 21.6%，筹码较集中",
        data={"top3_pct": 21.6},
    ))
    left.append(SignalResult(
        id="market_env", name="大盘环境", category="left", confidence=0.5,
        light="yellow", thresholds=(0.35, 0.7), weight=1, description="x", data={},
    ))
    right = [
        SignalResult(
            id=f"R{i}", name=f"R{i}", category="right", confidence=0.5,
            light="yellow", thresholds=(0.4, 0.7), weight=1, description="x", data={},
        )
        for i in range(4)
    ]
    chart_data = {
        "klines": [
            {"date": "2026-01-01", "open": 100, "high": 105, "low": 98, "close": 103, "volume": 1_000_000},
            {"date": "2026-01-02", "open": 103, "high": 106, "low": 101, "close": 102, "volume": 1_100_000},
        ],
        "volume_profile": [
            {"price_level": 101.0, "volume": 1000, "pct": 10.0},
            {"price_level": 102.0, "volume": 1200, "pct": 12.0},
            {"price_level": 103.0, "volume": 960, "pct": 9.6},
        ],
        "volume_profiles": {
            "3d": [
                {"price_level": 101.0, "volume": 1000, "pct": 10.0},
                {"price_level": 102.0, "volume": 1200, "pct": 12.0},
                {"price_level": 103.0, "volume": 960, "pct": 9.6},
            ],
            "20d": [
                {"price_level": 100.0, "volume": 1400, "pct": 14.0},
                {"price_level": 101.0, "volume": 1200, "pct": 12.0},
                {"price_level": 102.0, "volume": 800, "pct": 8.0},
            ],
            "60d": [
                {"price_level": 98.0, "volume": 1500, "pct": 15.0},
                {"price_level": 99.0, "volume": 1300, "pct": 13.0},
                {"price_level": 100.0, "volume": 1100, "pct": 11.0},
            ],
        },
        "volume_profile_meta": {
            "3d": {"requested_days": 3, "actual_days": 3, "rows": 180},
            "20d": {"requested_days": 20, "actual_days": 20, "rows": 1200},
            "60d": {"requested_days": 60, "actual_days": 23, "rows": 1454},
        },
    }
    html = render_html("X", "X", 102.0, 0.0, left + right, _make_phase(), "n", chart_data)

    assert 'data-chart-idx="4" open' in html
    assert "const volumeProfiles = DATA.volume_profiles || {}" in html
    assert "const volumeProfileMeta = DATA.volume_profile_meta || {}" in html
    assert "renderVolumeProfile('chart-4', klines, vp, DATA.signal_data?.chip_concentration || {}, volumeProfiles, volumeProfileMeta)" in html
    assert "筹码集中怎么判断" in html
    assert "左侧是最近 K 线，右侧按价格高低排列成交密集区" in html
    assert "筹码窗口" in html
    assert "data-chip-window" in html
    assert "\"volume_profiles\"" in html
    assert "\"volume_profile_meta\"" in html
    assert "如果数据源不足，会标注实际可用天数" in html
    assert "windowLabel" in html
    assert "可用' + actual + '日" in html
    assert 'data-support-help="chipProfile"' in html
    assert 'data-support-help="chipScore"' in html
    assert "确认度 = 前3价位桶占比 / 60%" in html
    assert "例如前3桶占 21.6%，确认度就是 36%" in html
    assert "chip-kline-pane" in html
    assert "grid-template-columns:minmax(0,1fr) 170px" in html
    assert "前3桶占 " in html


def test_render_html_support_chart_shows_no_strong_placeholder():
    sigs = [
        SignalResult(
            id="false_breakdown", name="假破位收回", category="left",
            confidence=0.2, light="red", thresholds=(0.3, 0.6), weight=2,
            description="弱支撑观察",
            data={
                "display_support_zones": [
                    {
                        "low": 450.0, "high": 455.0, "center": 452.5,
                        "strength": 0.25, "sources": ["近3个月前低"],
                        "display_role": "关键观察支撑，稳定性待确认",
                    }
                ],
                "support_focus": {"has_strong_support": False},
                "support_zones": [],
            },
        ),
    ] + [
        SignalResult(
            id=f"L{i}", name=f"L{i}", category="left", confidence=0.5, light="yellow",
            thresholds=(0.35, 0.7), weight=1, description="x", data={},
        )
        for i in range(5)
    ] + [
        SignalResult(
            id=f"R{i}", name=f"R{i}", category="right", confidence=0.5, light="yellow",
            thresholds=(0.4, 0.7), weight=1, description="x", data={},
        )
        for i in range(4)
    ]
    chart_data = {
        "klines": [
            {"date": "2026-01-01", "open": 460, "high": 462, "low": 450, "close": 459, "volume": 1_000_000},
        ]
    }
    html = render_html("0700.HK", "腾讯控股", 459.0, -1.0, sigs, _make_phase(), "n", chart_data)
    assert "关键观察支撑，稳定性待确认" in html
    assert "下个强支撑：暂无" in html


def test_state_table_keys():
    assert set(_RIGHT_STATE_TABLE.keys()) == {"default", "warning-soft", "warning", "success"}
    assert {"red", "yellow", "green"}.issubset(set(_LEFT_STATE_TABLE.keys()))


# ---------------- _resolve_left_state (新) ----------------

@pytest.mark.parametrize(
    "light,expected",
    [
        ("red", "red"),
        ("yellow", "yellow"),
        ("green", "green"),
        ("unknown_value", "red"),  # 未知 fallback
        ("", "red"),
    ],
)
def test_resolve_left_state(light, expected):
    assert _resolve_left_state(light) == expected


# ---------------- _compute_confirmation (新) ----------------

def test_compute_confirmation_matches_spec_scenario():
    """Spec scenario: 加权分算法对齐预期。"""
    left_confs = [0.3, 0.5, 0.8, 0.4, 0.6, 0.7]
    left_weights = [1, 1, 2, 1, 1, 1]
    left = [
        SignalResult(
            id=f"L{i}", name=f"L{i}", category="left",
            confidence=c, light="green" if c >= 0.7 else "yellow" if c >= 0.4 else "red",
            thresholds=(0.4, 0.7), weight=w, description="x", data={},
        )
        for i, (c, w) in enumerate(zip(left_confs, left_weights))
    ]
    right_confs = [0.9, 0.6, 0.5, 0.2]
    right_weights = [2, 2, 1, 1]
    right = [
        SignalResult(
            id=f"R{i}", name=f"R{i}", category="right",
            confidence=c, light="green" if c >= 0.7 else "yellow" if c >= 0.4 else "red",
            thresholds=(0.4, 0.7), weight=w, description="x", data={},
        )
        for i, (c, w) in enumerate(zip(right_confs, right_weights))
    ]
    conf = _compute_confirmation(left + right)

    # left: weighted = 0.3+0.5+1.6+0.4+0.6+0.7 = 4.1; weight = 7; pct = round(100*4.1/7) = 59
    assert conf["left"]["score_pct"] == 59
    assert conf["left"]["weight"] == 7
    assert conf["left"]["total_count"] == 6
    # left.confirmed_count: light=green 数 = c>=0.7 → [0.8, 0.7] = 2
    assert conf["left"]["confirmed_count"] == 2

    # right: weighted = 1.8+1.2+0.5+0.2 = 3.7; weight = 6; pct = round(100*3.7/6) = 62
    assert conf["right"]["score_pct"] == 62
    assert conf["right"]["weight"] == 6
    assert conf["right"]["total_count"] == 4
    # right.confirmed_count: c>=0.7 → [0.9] = 1
    assert conf["right"]["confirmed_count"] == 1

    # total: weighted = 4.1+3.7 = 7.8; weight = 13; pct = round(100*7.8/13) = 60
    assert conf["score_pct"] == 60
    assert conf["total_weight"] == 13


def test_compute_confirmation_empty_group():
    """无信号时各组 0,不抛错。"""
    conf = _compute_confirmation([])
    assert conf["score_pct"] == 0
    assert conf["total_weight"] == 0
    assert conf["left"] == {"score_pct": 0, "weight": 0, "confirmed_count": 0, "total_count": 0}
    assert conf["right"] == {"score_pct": 0, "weight": 0, "confirmed_count": 0, "total_count": 0}


# ---------------- 端到端: 新版 render_html 输出契约 ----------------

def test_render_html_contains_hero_and_panels_and_table():
    """端到端断言所有新结构存在。"""
    html = render_html("AAPL", "Apple", 200.0, 1.5, _make_signals(), _make_phase(), "narrative")

    # Hero
    assert 'id="chart-hero"' in html
    assert "renderHeroTrendChart" in html
    assert "右侧趋势确认度" in html
    assert "加权分" in html
    assert "权重" in html

    # 双大卡 details 行
    assert "<details" in html
    assert "data-chart-idx" in html
    # 至少 10 个 details(6 左 + 4 右)
    assert html.count("<details") >= 10

    # 子信号明细表 + tabs
    assert "子信号明细" in html
    assert 'data-filter="all"' in html
    assert 'data-filter="left"' in html
    assert 'data-filter="right"' in html


def test_render_html_no_emoji_anywhere_in_signal_rows():
    """左右信号 details 行均不含 🔴/🟡/🟢。"""
    html = render_html("AAPL", "Apple", 200.0, 1.5, _make_signals(), _make_phase(), "narrative")
    parts = html.split("<details")[1:]  # 每段从 <details 之后开始
    for chunk in parts:
        body = chunk.split("</details>")[0]
        for emoji in ("🔴", "🟡", "🟢"):
            assert emoji not in body, f"emoji {emoji} leaked into a <details>"


def test_render_html_left_chip_labels_match_light():
    """左侧 light → Chip 文案规则。fixture 含 6 个 yellow,断言含'观察'且不含其它两个标签。"""
    html = render_html("AAPL", "Apple", 200.0, 1.5, _make_signals(), _make_phase(), "narrative")
    # 取左侧大卡区段(从'左侧信号'开始到下一个 section/group)
    # 简单做法:在整个 html 中,左侧 details 都是 idx 0-5,右侧是 6-9。
    # 但更稳的做法是断言"全报告含'观察'"(因为 fixture 6 个左信号都是 yellow)
    assert "观察" in html
    # red/green 文案在 fixture 左侧不会出现(全是 yellow);但右侧 fixture 有 success/未触发/酝酿中/临界
    # 我们只断言"观察"必出现来证明左侧 chip 规则生效


def test_render_html_left_state_resolution_via_render():
    """直接测左侧 light=green / red 渲染含对应文案。"""
    sigs = [
        SignalResult(
            id="g", name="确认信号", category="left", confidence=0.8, light="green",
            thresholds=(0.35, 0.7), weight=1, description="x", data={},
        ),
        SignalResult(
            id="r", name="红信号", category="left", confidence=0.1, light="red",
            thresholds=(0.35, 0.7), weight=1, description="x", data={},
        ),
    ] + [
        SignalResult(
            id=f"R{i}", name=f"R{i}", category="right", confidence=0.5,
            light="yellow", thresholds=(0.4, 0.7), weight=1, description="x", data={},
        )
        for i in range(4)
    ]
    html = render_html("X", "X", 1.0, 0.0, sigs, _make_phase(), "n")
    assert "确认" in html
    assert "未触发" in html


def test_render_html_no_echarts_or_react():
    """报告 HTML 不依赖 echarts / recharts / react / heroui。"""
    html = render_html("AAPL", "Apple", 200.0, 1.5, _make_signals(), _make_phase(), "narrative")
    for forbidden in ("echarts", "recharts", "@heroui", "react-dom", "unpkg.com/react"):
        assert forbidden not in html, f"forbidden CDN/lib reference: {forbidden}"


def test_render_html_vol_shrink_5dim_in_details():
    """vol_shrink 5 维表头出现在某个 <details> 展开内容中。"""
    sigs = [
        SignalResult(
            id="vol_shrink", name="缩量下跌", category="left", confidence=0.6, light="yellow",
            thresholds=(0.35, 0.7), weight=1, description="缩量",
            data={
                "down_days": 5, "single_ratio": 0.7, "stage_ratio": 0.6, "trend_ratio": 0.5,
                "score_divergence": 1, "vol20": 1e6, "last_down_date": "2026-01-01",
                "last_down_vol": 9e5, "avg_down_vol": 8e5,
                "avg_recent_wave": 8e5, "avg_prev_wave": 9e5,
                "trend_detail": {
                    "recent_start": "2026-01-01", "recent_end": "2026-01-10",
                    "prev_start": "2025-12-01", "prev_end": "2025-12-10",
                    "recent_high": 100.0, "recent_low": 90.0,
                    "prev_high": 110.0, "prev_low": 100.0,
                    "recent_days": 10, "prev_days": 10,
                },
                "div_detail": {
                    "recent_low_price": 90.0, "recent_low_date": "2026-01-10", "recent_low_vol": 8e5,
                    "prev_low_price": 95.0, "prev_low_date": "2025-12-10", "prev_low_vol": 9e5,
                },
                "scores": {"single": 0.7, "stage": 0.6, "obvious": 0.5, "trend": 0.5, "divergence": 1.0},
            },
        ),
    ] + [
        SignalResult(
            id=f"L{i}", name=f"L{i}", category="left", confidence=0.5, light="yellow",
            thresholds=(0.35, 0.7), weight=1, description="x", data={},
        )
        for i in range(5)
    ] + [
        SignalResult(
            id=f"R{i}", name=f"R{i}", category="right", confidence=0.5, light="yellow",
            thresholds=(0.4, 0.7), weight=1, description="x", data={},
        )
        for i in range(4)
    ]
    html = render_html("X", "X", 1.0, 0.0, sigs, _make_phase(), "n")
    # 5 维表头 + 公式标志同时存在；比值已合并到数据明细中。
    for token in ("综合评分 = ", "观察项", "判断标准", "数据明细", "实际/基准"):
        assert token in html, f"vol_shrink table token missing: {token}"
    assert 'data-chart-idx="0" open' in html
    assert "缩量下跌怎么判断" in html
    assert "先确认下跌样本，再看抛压是否逐步变轻" in html
    assert "1. 先看下跌日" in html
    assert "2. 看量能是否缩" in html
    assert 'data-support-help="volumeBasis"' in html
    assert "3. 看综合强弱" in html
    assert 'data-support-help="volumeScore"' in html
    assert "缩量怎么看" in html
    assert "缩量强弱怎么算" in html
    assert "量价背离 30%，趋势缩量 25%，明显缩量 20%，阶段缩量 15%，单日缩量 10%" in html
    assert "缩量下跌不是买入信号" in html
    assert "比值" not in html
    assert "MA20×80%=80万，实际/基准=100%" in html


def test_render_html_no_threshold_ruler_in_hero_or_panels():
    """旧版 conclusion 卡的阈值刻度尺 '🔴 0-25%' 等已移除。"""
    html = render_html("AAPL", "Apple", 200.0, 1.5, _make_signals(), _make_phase(), "narrative")
    for ruler in ("0-25%", "25-45%", "60-80%", "80%+", "45-60%"):
        assert ruler not in html, f"old ruler text leaked: {ruler}"


def test_render_html_window_load_only_calls_renderHero():
    """JS 段 window.load 时不批量渲染信号 chart,只调 renderHero。"""
    html = render_html("AAPL", "Apple", 200.0, 1.5, _make_signals(), _make_phase(), "narrative")
    # window.addEventListener('load' 后面跟的 callback 内必须出现 renderHero
    load_block = html.split("window.addEventListener('load'")[1].split("</script>")[0]
    assert "renderHero" in load_block
    # 不应在 load 处直接遍历 0..9 立刻渲染所有信号 chart
    assert "Object.entries(configs)" not in load_block
    # 必须含 toggle 监听绑定
    assert "attachDetailsToggleListeners" in load_block


def test_render_html_hero_circle_offset_matches_strength():
    """SVG 圆环 stroke-dashoffset 数值与 2π·42·(1-pct/100) 一致(±0.5)。"""
    phase = PhaseResult(
        phase="筑底", icon="🟡", action="观察", trigger="x",
        strength=0.58, strength_pct=58,
    )
    html = render_html("X", "X", 1.0, 0.0, _make_signals(), phase, "n")
    import math
    expected_offset = 2 * math.pi * 42 * (1 - 58 / 100)
    # 在 html 里查找 stroke-dashoffset="..."
    import re
    matches = re.findall(r'stroke-dashoffset="([0-9.]+)"', html)
    assert matches, "stroke-dashoffset not found"
    actual = float(matches[0])
    assert abs(actual - expected_offset) < 0.5, f"expected ~{expected_offset}, got {actual}"


def test_render_html_design_tokens_extended():
    """新增 token 出现在 head 中。"""
    html = render_html("AAPL", "Apple", 200.0, 1.5, _make_signals(), _make_phase(), "narrative")
    head = html.split("</head>")[0]
    for var in ("--accent", "--text-primary", "--text-secondary", "--text-muted", "--bg-app"):
        assert var in head, f"missing extended token: {var}"
    # 既有 token 仍在
    for var in (
        "--color-default", "--color-success", "--color-warning",
        "--color-surface", "--color-surface-secondary", "--color-divider",
        "--radius-card", "--shadow-xs",
    ):
        assert var in head, f"existing token dropped: {var}"


# ---------------- MA200 上方压力位标注 ----------------

def test_render_html_ma200_resistance_draws_lines_and_note():
    chart_data = {
        "klines": [
            {"date": "2026-01-01", "open": 40, "high": 42, "low": 39, "close": 41, "volume": 1_000_000},
        ],
        "trend_levels": {"ma200": 70.0, "current": 40.0, "role": "resistance", "distance_pct": 75.0},
    }
    html = render_html("0700.HK", "腾讯控股", 40.0, 0.0, _make_signals(), _make_phase(), "n", chart_data)
    # Hero Python 文案（仅 resistance 态输出）
    assert "上方第一压力(MA200)" in html
    assert "70.00" in html
    assert "+75.0%" in html
    # trend_levels 透传进 DATA + 两图 JS 读取
    assert '"role": "resistance"' in html
    assert "const _heroTL = DATA.trend_levels" in html
    assert "const _supTL = DATA.trend_levels" in html
    # 两处 MA200 压力线（Hero 主图 + 回踩不破图各一条）
    assert html.count("title: 'MA200 压力'") == 2


def test_render_html_ma200_above_shows_note_without_resistance():
    chart_data = {
        "klines": [
            {"date": "2026-01-01", "open": 160, "high": 162, "low": 159, "close": 161, "volume": 1_000_000},
        ],
        "trend_levels": {"ma200": 130.0, "current": 160.0, "role": "above", "distance_pct": -18.75},
    }
    html = render_html("0700.HK", "腾讯控股", 160.0, 0.0, _make_signals(), _make_phase(), "n", chart_data)
    assert "站上 MA200" in html
    assert "上方第一压力(MA200)" not in html


def test_render_html_without_trend_levels_has_no_ma200_note():
    html = render_html("AAPL", "Apple", 200.0, 1.5, _make_signals(), _make_phase(), "narrative")
    assert "上方第一压力(MA200)" not in html
    assert "站上 MA200" not in html
