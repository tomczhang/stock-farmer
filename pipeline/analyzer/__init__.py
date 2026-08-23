"""筑底结构分析引擎。"""
from __future__ import annotations

from .bottoming import compute_bottoming
from .narrative import generate_narrative
from .renderer import render_html
from .signals import compute_all_signals

__all__ = [
    "compute_all_signals",
    "compute_bottoming",
    "generate_narrative",
    "render_html",
]
