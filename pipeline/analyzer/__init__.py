"""股票信号分析引擎 — 输入 ticker，输出 HTML 诊断报告。"""
from __future__ import annotations

from .signals import compute_all_signals
from .phase import determine_phase, compute_overall_strength
from .narrative import generate_narrative
from .renderer import render_html

__all__ = [
    "compute_all_signals",
    "determine_phase",
    "compute_overall_strength",
    "generate_narrative",
    "render_html",
]
