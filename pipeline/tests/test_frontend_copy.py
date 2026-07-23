"""前端文案契约守护（无 JS 测试运行器时的轻量保障）。

确保历史复盘 UI 的关键文案与字段存在，并且总分语义层把分数表达为
「结构强度」、显式区分左侧准备度 / 右侧触发度，符合 spec 的分层解释要求。
"""
from __future__ import annotations

from pathlib import Path

import pytest

WEB_SRC = Path(__file__).resolve().parents[2] / "web" / "src"
REPORT = WEB_SRC / "components" / "SignalTrendReport.tsx"
TYPES = WEB_SRC / "types.ts"
API = WEB_SRC / "api.ts"
APP = WEB_SRC / "App.tsx"


def _read(path: Path) -> str:
    if not path.exists():  # pragma: no cover - 路径漂移保护
        pytest.skip(f"missing {path}")
    return path.read_text(encoding="utf-8")


def test_report_component_shows_structure_strength_and_layered_scores():
    src = _read(REPORT)
    # 总分表达为结构强度，并展示左右分层与诊断。
    assert "score_label" in src
    assert "score_caption" in src
    assert "diagnosis" in src
    assert "role_label" in src
    assert "role_desc" in src


def test_report_component_has_historical_context_and_mirror():
    src = _read(REPORT)
    assert "report_context" in src
    assert "历史复盘" in src
    assert "有效交易日" in src
    # 趋势图用证伪 / 复盘 / 校准语义，而非预测 / 胜率 / 收益。
    assert "证伪" in src or "复盘" in src or "校准" in src
    assert "right_trend" in src
    # 空状态。
    assert "暂无足够历史" in src


def test_report_component_shows_trend_fit_applicability():
    """React 报告须展示趋势状态 + 本工具适用性，且不再有冗余"当前分析"条。"""
    src = _read(REPORT)
    assert "TrendFitBanner" in src
    assert "本工具适用性" in src
    assert "上升趋势中途" in src
    assert "conclusion.regime" in src
    # 旧的冗余"当前分析"上下文条已移除。
    assert "使用最新可用交易日数据" not in src


def test_types_expose_new_contract_fields():
    src = _read(TYPES)
    for token in (
        "ReportContext", "RightTrend", "RightTrendPoint",
        "ForwardOutcomeLabels", "report_context", "right_trend", "regime",
    ):
        assert token in src, token


def test_api_supports_as_of_and_trend_window():
    src = _read(API)
    assert "as_of" in src
    assert "trend_window" in src
    assert "asOf" in src


def test_app_has_date_control_and_clear_action():
    src = _read(APP)
    assert 'type="date"' in src
    assert "回到当前" in src  # clear-date action
