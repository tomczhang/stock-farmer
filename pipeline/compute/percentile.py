"""滚动分位计算。

对每个交易日 t，计算 t 当天 PE 在 t 当天及之前过去 5 年 / 10 年 / 全历史窗口内的分位。

注意：
- 窗口内剔除 pe_ttm 为 None 的样本（亏损段或数据缺失）。
- 不足以计算的窗口（如 5y 窗口内只有 < 30 个交易日）→ 该窗口分位为 None。
  阈值取 30 是一个经验值：少于一个月数据时分位含义不强。
- 用 numpy `searchsorted` + 增量维护排序窗口；对外接口接受 today（默认 last date）但
  当前实现对每个 t 都计算分位，不仅是 today。
"""
from __future__ import annotations

from datetime import date, timedelta

import numpy as np

# 不足这个样本数的窗口，分位返回 None
_MIN_SAMPLES_PER_WINDOW = 30


def _percentile_rank(window: np.ndarray, value: float) -> float | None:
    """返回 value 在 window 中的分位（0-100，保留 2 位小数）。

    使用 "average rank" 口径：
      pct = (#strictly_less + #equal/2) / N * 100
    全部相同值时返回 50。
    """
    if window.size == 0:
        return None
    n = window.size
    # window 必须是已排序的；用 searchsorted 求位置
    left = np.searchsorted(window, value, side="left")
    right = np.searchsorted(window, value, side="right")
    rank = left + (right - left) / 2.0
    pct = rank / n * 100.0
    return round(float(pct), 2)


def _years_before(d: date, years: int) -> date:
    try:
        return d.replace(year=d.year - years)
    except ValueError:
        # 跨闰年 2/29 -> 2/28
        return d.replace(year=d.year - years, day=28)


def compute_percentiles(
    pe_series: list[dict], today: date | None = None
) -> list[dict]:
    """对每个交易日计算 5y / 10y / all 三个滚动分位。

    参数：
        pe_series: [{date, pe_ttm, is_loss}, ...]（按 date 升序）
        today:     未使用。保留参数是为了上层语义清晰。

    返回：
        [{date, pe_ttm, percentile_5y, percentile_10y, percentile_all, is_loss}, ...]
    """
    if not pe_series:
        return []

    # 解析日期 + 把 pe_ttm 取出
    dates_iso = [row["date"] for row in pe_series]
    dates: list[date] = [date.fromisoformat(d) for d in dates_iso]
    pes_raw = [row.get("pe_ttm") for row in pe_series]
    is_losses = [bool(row.get("is_loss")) for row in pe_series]

    # 有效（非 None）的样本，按日期升序记录 (date, pe)，并维护按 pe 排序的 numpy 数组
    valid_dates: list[date] = []
    valid_pes: list[float] = []
    for d, pe in zip(dates, pes_raw):
        if pe is None:
            continue
        valid_dates.append(d)
        valid_pes.append(float(pe))

    n_valid = len(valid_dates)
    # 把 valid_pes 按日期顺序累积；对每个 t 取窗口子区间 (lo_idx, hi_idx]，
    # 再 sort 一下做 percentile。子区间长度 ≤ 2500 量级（10 年 × 250 日），
    # 对每个交易日 sort 一次的总复杂度可接受（≈ N × W log W）。
    # 但为了避免 O(N²) 排序，按"已排序窗口 + 二分插入 / 删除"维护更佳。
    # 这里用更简单的 numpy 切片排序方案，10 年 × 250 数据量在毫秒级。

    valid_pes_arr = np.asarray(valid_pes, dtype=np.float64)
    # 用 numpy 把每个 t 的窗口边界二分得到 (lo_idx, hi_idx)
    # 注意 valid_dates 严格升序（同一天可能有多条，但 pe_series 主键是 date 不会重复）
    valid_dates_np = np.asarray([d.toordinal() for d in valid_dates], dtype=np.int64)

    out: list[dict] = []
    for i, d in enumerate(dates):
        d_ord = d.toordinal()
        pe = pes_raw[i]
        is_loss = is_losses[i]
        # 默认值
        row = {
            "date": dates_iso[i],
            "pe_ttm": pe,
            "percentile_5y": None,
            "percentile_10y": None,
            "percentile_all": None,
            "is_loss": is_loss,
        }
        if pe is None:
            out.append(row)
            continue

        # 上界：包含 t 当天，即 hi_idx = searchsorted(side='right', d_ord)
        hi_idx = int(np.searchsorted(valid_dates_np, d_ord, side="right"))

        # 5y / 10y / all 三个窗口的下界
        five_y_ord = _years_before(d, 5).toordinal()
        ten_y_ord = _years_before(d, 10).toordinal()
        lo5 = int(np.searchsorted(valid_dates_np, five_y_ord, side="left"))
        lo10 = int(np.searchsorted(valid_dates_np, ten_y_ord, side="left"))
        lo_all = 0

        for key, lo in (
            ("percentile_5y", lo5),
            ("percentile_10y", lo10),
            ("percentile_all", lo_all),
        ):
            n = hi_idx - lo
            if n < _MIN_SAMPLES_PER_WINDOW:
                row[key] = None
                continue
            window = np.sort(valid_pes_arr[lo:hi_idx])
            row[key] = _percentile_rank(window, float(pe))
        out.append(row)
    return out
