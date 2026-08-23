"""新版筑底报告前端契约守护。"""
from __future__ import annotations

from pathlib import Path

WEB_SRC = Path(__file__).resolve().parents[2] / "web" / "src"
REPORT = WEB_SRC / "components" / "SignalTrendReport.tsx"
BOTTOMING = WEB_SRC / "components" / "BottomingVerdictPanel.tsx"
PYRAMID = WEB_SRC / "components" / "PyramidBacktestPanel.tsx"
TYPES = WEB_SRC / "types.ts"
API = WEB_SRC / "api.ts"
APP = WEB_SRC / "App.tsx"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_report_is_bottoming_only():
    src = _read(REPORT)
    assert "BottomingVerdictPanel" in src
    assert "筑底结构诊断" in src
    assert "bottoming_history" in src
    assert "下一项观察" in src
    for removed in ("right_trend", "confirmation.right", "groups.right", "right_state"):
        assert removed not in src


def test_report_has_historical_context_and_falsification_mirror():
    src = _read(REPORT)
    assert "report_context" in src
    assert "历史复盘" in src
    assert "有效交易日" in src
    assert "证伪镜" in src
    assert "暂无足够历史" in src


def test_types_expose_schema_v2_contract_without_removed_fields():
    src = _read(TYPES)
    for token in (
        "schema_version: 2", "BottomingHistory", "BottomingHistoryPoint",
        "bottoming_history", "next_observation", "structure_strength_pct",
    ):
        assert token in src
    for removed in ("RightTrend", "SignalRightState", "right_green", "strong_right"):
        assert removed not in src


def test_bottoming_panel_uses_observation_copy():
    src = _read(BOTTOMING)
    assert "筑底迹象判读" in src
    assert "cleanliness_label" in src
    assert "next_observation" in src
    assert "下一项观察" in src


def test_api_still_supports_historical_window():
    src = _read(API)
    assert "as_of" in src
    assert "trend_window" in src
    assert "asOf" in src


def test_app_product_copy_is_bottoming_focused():
    src = _read(APP)
    assert "筑底结构诊断" in src
    assert "筑底报告" in src
    assert 'type="date"' in src
    assert "回到当前" in src


def test_pyramid_is_manual_decision_discipline():
    src = _read(PYRAMID)
    assert "金字塔纪律推演" in src
    assert "手动选择决策日" in src
    assert "系统不判断买点" in src
    assert "停止买入红线" in src
    assert "逐笔账本" in src
    assert "assumptions" in src
    for removed in ("right_green", "strong_right", "右侧触发", "右侧失效"):
        assert removed not in src


def test_pyramid_api_and_types_remain_available():
    assert "getPyramidBacktest" in _read(API)
    src = _read(TYPES)
    for token in (
        "PyramidBacktestResponse", "PyramidTrade", "PyramidSummary",
        "negative_cost", "stop_buy_triggered", "decision_date",
    ):
        assert token in src
