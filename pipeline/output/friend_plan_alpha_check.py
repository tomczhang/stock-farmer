"""检验朋友版方案与"波动率驱动最优α"原则的矛盾，并对比两种阶梯锚：

α 原则：VOO（低波动）最优 α=100% 应一次性打满；QQQM（高波动）α≈60% 可分批。

锚的问题：原实现用"全历史 ATH"（含入场前）做回撤锚，纳指 2000 年泡沫顶直到
2016 年才收复，导致 2008/2009/2013 三个历史起点入场即触发 -25% 档、分批退化为
准一次性。本脚本同时跑"入场日起算 ATH"锚，回答阶梯在真实分批状态下的价值。

运行：.venv/bin/python pipeline/output/friend_plan_alpha_check.py
"""
from __future__ import annotations

import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent
sys.path.insert(0, str(OUT))
from friend_plan_backtest import align, fetch_daily, month_starts, running_ath  # noqa: E402
from friend_plan_report_v2 import TOTAL, analyze, sim_side  # noqa: E402

LUMP = dict(t0_frac=1.0, n_inst=0, use_ladder=False)
PLAN = dict(t0_frac=0.3, n_inst=12, use_ladder=True)

# (名称, VOO侧配置, QQQM侧配置, 锚模式) 锚：hist=全历史ATH  entry=入场日起算ATH
COMBOS = [
    ("全一次性", LUMP, LUMP, "hist"),
    ("原计划(两侧分批·史锚)", PLAN, PLAN, "hist"),
    ("原计划(两侧分批·入场锚)", PLAN, PLAN, "entry"),
    ("α版(VOO打满·史锚)", LUMP, PLAN, "hist"),
    ("α版(VOO打满·入场锚)", LUMP, PLAN, "entry"),
]
STARTS = ("2000-03-01", "2008-09-01", "2009-03-01", "2013-05-01", "2014-10-01")


def entry_ath(px: list[float], i0: int) -> list[float]:
    """入场日起算的运行高点（i0 之前的位置不被 sim_side 读取，置 0）。"""
    ath = [0.0] * len(px)
    mx = 0.0
    for i in range(i0, len(px)):
        mx = max(mx, px[i])
        ath[i] = mx
    return ath


def run_mix(i0: int, horizon: int, ctx: dict, voo_cfg: dict, ndx_cfg: dict, anchor: str) -> list[float]:
    half = TOTAL / 2
    if anchor == "entry":
        spx_ath = entry_ath(ctx["spx"], i0)
        ndx_ath = entry_ath(ctx["ndx"], i0)
    else:
        spx_ath, ndx_ath = ctx["spx_ath"], ctx["ndx_ath"]
    v1, _ = sim_side(ctx["spx"], spx_ath, ctx["ms"], i0, horizon, half, **voo_cfg)
    v2, _ = sim_side(ctx["ndx"], ndx_ath, ctx["ms"], i0, horizon, half, **ndx_cfg)
    return [a + b for a, b in zip(v1, v2)]


def main() -> None:
    dates, spx, ndx = align(fetch_daily("^GSPC"), fetch_daily("^NDX"))
    ctx = dict(spx=spx, ndx=ndx, spx_ath=running_ath(spx),
               ndx_ath=running_ath(ndx), ms=month_starts(dates))

    def idx_of(day: str) -> int:
        return next(i for i in ctx["ms"] if dates[i] >= day)

    for day in STARTS:
        i0 = idx_of(day)
        print(f"\n=== 起点 {dates[i0]} ===")
        for name, vc, nc, anchor in COMBOS:
            vals = run_mix(i0, len(dates), ctx, vc, nc, anchor)
            s = analyze(vals, dates, i0)
            pb = s["payback_from_start_years"]
            print(f"  {name:22s} 10y={s['v10'] / 1e4:8.1f}万  至今={s['vend'] / 1e4:9.1f}万  "
                  f"MDD={s['mdd'] * 100:6.1f}%  回本={'--' if pb is None else f'{pb}年'}")


if __name__ == "__main__":
    main()
