"""Stub `global_stock_data` 模块，避免测试时去读 SKILL.md / 触发网络。"""
from __future__ import annotations

import sys
import types

if "global_stock_data" not in sys.modules:
    mod = types.ModuleType("global_stock_data")

    def _missing(*_a, **_kw):  # pragma: no cover
        raise RuntimeError(
            "global_stock_data stub: tests should monkeypatch this function explicitly"
        )

    mod.stock_kline_yahoo = _missing  # type: ignore[attr-defined]
    mod.key_indicators_eastmoney = _missing  # type: ignore[attr-defined]
    mod.key_statistics = _missing  # type: ignore[attr-defined]
    mod.pe_snapshot_eastmoney = _missing  # type: ignore[attr-defined]
    mod.sec_xbrl_facts = _missing  # type: ignore[attr-defined]
    sys.modules["global_stock_data"] = mod
