"""入场标准实验室：逐日预计算判定快照，供控制器界面动态过滤。

把每个交易日的「筑底档位 + 全部右侧信号灯色 + 洗盘干净度」一次性
算好打包成 JSON，前端调整入场节点（档位门槛 / 认可触发 / 灯色 /
绿灯数量 / 干净度下限）时只做客户端过滤，无需重算。

防未来函数：每日快照只用该日及之前的数据（截断窗口）。
语义红线：干净度 / 确认度均为结构强度，不代表胜率或概率。
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

import pandas as pd

from .bottoming import _TIER_META, compute_bottoming
from .pyramid import ENTRY_TIERS, RIGHT_TRIGGER_IDS
from .signals import compute_all_signals

# 快照窗口：覆盖信号最长回看（近250日量能分位 / MA200），再留余量
SNAPSHOT_TAIL = 330
# 预热期：不足一年历史的日子不进入扫描（信号可信度不足）
DEFAULT_WARMUP = 250

DISCLAIMER = "历史快照仅供研究复盘，干净度为结构强度语义，不构成投资建议。"


def scan_entry_snapshots(
    df: pd.DataFrame,
    warmup: int = DEFAULT_WARMUP,
    tail: int = SNAPSHOT_TAIL,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """逐日截断计算判定快照。

    返回 (days, right_signal_meta)：
    - days: [{date, close, tier, cleanliness_pct, rights: {id: {light, confidence}}}]
    - right_signal_meta: [{id, name, weight}]（按 compute_all_signals 输出顺序）
    """
    labels = [str(v).split()[0] for v in df["date"].tolist()]
    closes = df["close"].astype(float).values
    days: list[dict[str, Any]] = []
    right_meta: list[dict[str, Any]] = []
    for i in range(warmup, len(df)):
        day_df = df.iloc[max(0, i - tail + 1):i + 1]
        signals = compute_all_signals(day_df)
        verdict = compute_bottoming(day_df, signals=signals)
        rights = {
            s.id: {"light": s.light, "confidence": round(float(s.confidence), 3)}
            for s in signals if s.category == "right"
        }
        if not right_meta:
            right_meta = [
                {"id": s.id, "name": s.name, "weight": s.weight}
                for s in signals if s.category == "right"
            ]
        days.append({
            "date": labels[i],
            "close": round(float(closes[i]), 4),
            "tier": verdict.tier,
            "cleanliness_pct": verdict.cleanliness_pct,
            "rights": rights,
        })
    return days, right_meta


def build_entry_scan(
    ticker: str,
    count: int = 1260,
    warmup: int = DEFAULT_WARMUP,
) -> dict[str, Any]:
    """拉取日线并生成入场标准实验室数据包（server 入口）。"""
    try:
        from pipeline.data import get_klines
    except ModuleNotFoundError:  # pragma: no cover - 测试根导入
        from data import get_klines

    df = get_klines(ticker, period="1d", count=count)
    if df is None or len(df) == 0:
        raise ValueError(f"{ticker} 无可用日线数据")
    if len(df) <= warmup:
        raise ValueError(
            f"{ticker} 历史仅 {len(df)} 个交易日，不足预热期 {warmup} 日，无法扫描"
        )

    days, right_meta = scan_entry_snapshots(df, warmup=warmup)
    klines = [
        {
            "date": str(row["date"]).split()[0],
            "open": float(row["open"] or 0),
            "high": float(row["high"] or 0),
            "low": float(row["low"] or 0),
            "close": float(row["close"] or 0),
        }
        for row in df.iloc[warmup:].to_dict("records")
    ]
    tier_meta = [
        {"id": tier_id, "label": meta["label"], "icon": meta["icon"]}
        for tier_id, meta in _TIER_META.items()
    ]
    return {
        "ticker": ticker.upper(),
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "range": {
            "start": days[0]["date"] if days else None,
            "end": days[-1]["date"] if days else None,
            "scanned_days": len(days),
            "warmup": warmup,
        },
        "meta": {
            "tiers": tier_meta,
            "right_signals": right_meta,
            # 生产默认入场规则：档位 ≥ 基本成立 且 认可触发中至少 1 个绿灯
            "default_rule": {
                "tiers": list(ENTRY_TIERS),
                "triggers": list(RIGHT_TRIGGER_IDS),
                "min_green": 1,
                "accept_yellow": False,
            },
        },
        "days": days,
        "klines": klines,
        "disclaimer": DISCLAIMER,
    }
