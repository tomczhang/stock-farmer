"""日度 PE 计算。

PE_ttm(t) = close_adj(t) / TTM_EPS(t)（design.md 决策 3）。
亏损段（is_loss 或 ttm_eps ≤ 0）→ pe_ttm = None。
"""
from __future__ import annotations


def compute_pe_series(prices: list[dict], ttm_series: list[dict]) -> list[dict]:
    """按 date 对齐合并 prices 与 ttm_series，输出日度 PE 序列。

    参数：
        prices:     [{date, close_adj}, ...]（升序）
        ttm_series: [{date, ttm_eps, is_loss}, ...]（升序）

    返回：
        [{date, pe_ttm, is_loss}, ...]，按 prices 的日期序列；缺少 ttm 的日期 pe_ttm = None, is_loss = False。
    """
    ttm_index = {row["date"]: row for row in ttm_series}
    out: list[dict] = []
    for p in prices:
        t = p["date"]
        close = p.get("close_adj")
        tr = ttm_index.get(t)
        if tr is None:
            out.append({"date": t, "pe_ttm": None, "is_loss": False})
            continue
        is_loss = bool(tr.get("is_loss"))
        ttm = tr.get("ttm_eps")
        if is_loss or ttm is None or ttm == 0 or close in (None, 0, 0.0):
            out.append({"date": t, "pe_ttm": None, "is_loss": is_loss})
            continue
        pe = round(float(close) / float(ttm), 4)
        out.append({"date": t, "pe_ttm": pe, "is_loss": False})
    return out
