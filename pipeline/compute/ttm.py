"""TTM EPS 拼接。

把"季度 EPS 列表 + 交易日列表"组合成"每个交易日对应一个 TTM EPS"。
TTM = 最近 4 个已发布季度 EPS 的总和（design.md 决策 3）。

实现细节：
- 季度数据按 period_end 升序输入。
- diluted 优先；若该季度 diluted 为 None，则用 basic；都为 None 则该季度贡献 None。
- 一旦 4 个季度中有任一是 None → ttm_eps = None。
- 不足 4 个季度 → ttm_eps = None, is_loss = False（数据未知，不是亏损）。
- ttm_eps ≤ 0 → is_loss = True。ttm_eps 保留实际负值（写库由上层决定要不要存 NULL）。
"""
from __future__ import annotations

from bisect import bisect_right


def _pick_eps(q: dict) -> float | None:
    """diluted 优先；若 None 则用 basic；都 None 返回 None。"""
    d = q.get("eps_diluted")
    if d is not None:
        return d
    return q.get("eps_basic")


def build_ttm_eps(eps_quarterly: list[dict], price_dates: list[str]) -> list[dict]:
    """对每个交易日，取 period_end ≤ t 的最近 4 个季度求和。

    参数：
        eps_quarterly: [{period_end: 'YYYY-MM-DD', eps_basic, eps_diluted}, ...]，按 period_end 升序。
        price_dates:   ['YYYY-MM-DD', ...]，按升序。

    返回：
        [{date, ttm_eps, is_loss}, ...]，每个交易日一条。
    """
    # 提取已排序的 period_end 列表，便于 bisect
    periods = [q["period_end"] for q in eps_quarterly]

    out: list[dict] = []
    for t in price_dates:
        # 找出 period_end ≤ t 的全部季度数量
        n = bisect_right(periods, t)
        if n < 4:
            out.append({"date": t, "ttm_eps": None, "is_loss": False})
            continue
        last4 = eps_quarterly[n - 4 : n]
        values = [_pick_eps(q) for q in last4]
        if any(v is None for v in values):
            out.append({"date": t, "ttm_eps": None, "is_loss": False})
            continue
        ttm = sum(values)  # type: ignore[arg-type]
        is_loss = ttm <= 0
        out.append({"date": t, "ttm_eps": ttm, "is_loss": is_loss})
    return out
