"""朋友版 100W 宽指方案报告 v2。

按用户要求重做：
1) 同一起点对比：2000-03（互联网泡沫前夕）跑 20 年；辅以 2009-03 底部起点（防踏空验证）
2) 指标换成新手友好：10 年/20 年资金总额、最大回撤、回本时间（回到 100 万本金）
3) 显性展示 VOO:QQQM = 5:5；新增建仓进度（仓位%）折线对比
4) 浅色主题

2026-08 修订（波动率驱动最优 α 原则）：本计划的 VOO 侧改为 T0 一次性打满
（低波动资产 α=100%），30%+12期+阶梯只作用于 QQQM 侧；阶梯从"双锚"退化为
单锚（只看纳指回撤）。对比回测见 friend_plan_alpha_check.py。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent
sys.path.insert(0, str(OUT))
from friend_plan_backtest import align, fetch_daily, month_starts, running_ath  # noqa: E402

TOTAL = 1_000_000.0
TIERS = [(-0.10, 0.25), (-0.17, 0.40), (-0.25, 1.00)]
NAMES = {"lump": "一次性买入", "dca12": "12个月定投", "plan": "本计划(VOO一次性+纳指30%+定投+阶梯)"}
KINDS = ["lump", "dca12", "plan"]


def sim_side(px, ath, ms_all, i0, horizon, side_total, t0_frac, n_inst, use_ladder):
    end = min(i0 + horizon, len(px))
    sched = [i for i in ms_all if i > i0][:n_inst]
    monthly = side_total * (1 - t0_frac) / n_inst if n_inst else 0.0
    cash, shares, spent = side_total, 0.0, 0.0
    used: set[int] = set()
    pending = None
    inst_ptr = 0
    if t0_frac > 0:
        amt = min(cash, side_total * t0_frac)
        shares += amt / px[i0]
        cash -= amt
        spent += amt
    values, deployed = [], []
    for i in range(i0, end):
        if i > i0:
            if pending:
                amt = min(cash, pending)
                shares += amt / px[i]
                cash -= amt
                spent += amt
                pending = None
            if inst_ptr < len(sched) and i == sched[inst_ptr]:
                amt = cash if inst_ptr == n_inst - 1 else min(cash, monthly)
                shares += amt / px[i]
                cash -= amt
                spent += amt
                inst_ptr += 1
        if use_ladder and cash > 1e-6:
            if px[i] >= ath[i] - 1e-9:
                used.clear()
            dd = px[i] / ath[i] - 1
            add = 0.0
            for k, (th, frac) in enumerate(TIERS):
                if dd <= th and k not in used:
                    used.add(k)
                    add += (cash - add) * frac
            if add > 0:
                pending = add
        values.append(shares * px[i] + cash)
        deployed.append(spent)
    return values, deployed


def run(kind, i0, horizon, ctx):
    half = TOTAL / 2
    lump = dict(t0_frac=1.0, n_inst=0, use_ladder=False)
    dca = dict(t0_frac=0.0, n_inst=12, use_ladder=False)
    stage = dict(t0_frac=0.3, n_inst=12, use_ladder=True)
    # plan：VOO 侧一次性打满（α=100%），QQQM 侧 30%+12期+阶梯（α≈60% 的分批腿）
    spx_cfg, ndx_cfg = {"lump": (lump, lump), "dca12": (dca, dca), "plan": (lump, stage)}[kind]
    v1, d1 = sim_side(ctx["spx"], ctx["spx_ath"], ctx["ms"], i0, horizon, half, **spx_cfg)
    v2, d2 = sim_side(ctx["ndx"], ctx["ndx_ath"], ctx["ms"], i0, horizon, half, **ndx_cfg)
    return [a + b for a, b in zip(v1, v2)], [a + b for a, b in zip(d1, d2)]


def analyze(values, dates, i0):
    """10y/20y/至今总额、最大回撤(含谷底日)、回本时间(谷底后首次回到100万)。"""
    n = len(values)
    v10 = values[min(2519, n - 1)]
    v20 = values[min(5039, n - 1)]
    vend = values[n - 1]
    peak, mdd, trough_i, run_peak_i, peak_i = -1.0, 0.0, 0, 0, 0
    for i, v in enumerate(values):
        if v > peak:
            peak, run_peak_i = v, i
        dd = v / peak - 1
        if dd < mdd:
            mdd, trough_i, peak_i = dd, i, run_peak_i
    payback_i = next((i for i in range(trough_i, n) if values[i] >= TOTAL), None)
    # 统一口径：全局最低点后首次回到 100 万本金
    vmin_i = min(range(n), key=lambda i: values[i])
    hurt = values[vmin_i] < TOTAL * 0.999
    rec_i = next((i for i in range(vmin_i, n) if values[i] >= TOTAL), None) if hurt else None
    return {
        "v10": v10, "v20": v20, "vend": vend, "end_date": dates[i0 + n - 1],
        "mdd": mdd,
        "hurt": hurt,
        "recover_years": None if rec_i is None else round(rec_i / 252, 1),
        "recover_date": None if rec_i is None else dates[i0 + rec_i],
        "trough_date": dates[i0 + trough_i],
        "payback_years": None if payback_i is None else round((payback_i - trough_i) / 252, 1),
        "payback_date": None if payback_i is None else dates[i0 + payback_i],
        "payback_from_start_years": None if payback_i is None else round(payback_i / 252, 1),
    }


def main():
    print("fetching ...")
    dates, spx, ndx = align(fetch_daily("^GSPC"), fetch_daily("^NDX"))
    ctx = dict(spx=spx, ndx=ndx, spx_ath=running_ath(spx),
               ndx_ath=running_ath(ndx), ms=month_starts(dates))

    def idx_of(day):  # 该日期当月首个交易日
        return next(i for i in ctx["ms"] if dates[i] >= day)

    out = {}
    # ---- 主场景：2000-03 泡沫前夕，一路跑到最新数据 ----
    i0 = idx_of("2000-03-01")
    horizon = len(dates)  # 至数据末尾（2026-07）
    main_case = {"start": dates[i0], "stats": {}, "curves": {}, "deploy": {}, "dd_curves": {}}
    for k in KINDS:
        vals, dep = run(k, i0, horizon, ctx)
        main_case["stats"][k] = analyze(vals, dates, i0)
        ds = dates[i0:i0 + len(vals)]
        main_case["curves"][k] = [[ds[i], round(vals[i] / 1e4, 1)] for i in range(0, len(vals), 5)]
        # 建仓进度：前 30 个月
        lim = min(252 * 30 // 12 * 12 + 40, len(dep))  # ~630天
        lim = min(650, len(dep))
        main_case["deploy"][k] = [[ds[i], round(dep[i] / TOTAL * 100, 1)] for i in range(0, lim, 3)]
        peak = -1.0
        ddc = []
        for i in range(0, len(vals), 5):
            peak = max(peak, max(vals[max(0, i - 4):i + 1]))
            ddc.append([ds[i], round((vals[i] / peak - 1) * 100, 1)])
        main_case["dd_curves"][k] = ddc
    out["main"] = main_case

    # ---- 反面场景：2009-03 熊市底部，至今 ----
    i1 = idx_of("2009-03-01")
    sub = {"start": dates[i1], "stats": {}, "curves": {}}
    for k in KINDS:
        vals, _ = run(k, i1, len(dates), ctx)
        ds = dates[i1:i1 + len(vals)]
        sub["stats"][k] = analyze(vals, dates, i1)
        sub["curves"][k] = [[ds[i], round(vals[i] / 1e4, 1)] for i in range(0, len(vals), 5)]
    out["sub"] = sub

    # ---- 半山腰场景：2008-09 雷曼月入场（已跌约-20%，后面还要再跌到 2009-03 才见底）----
    i2 = idx_of("2008-09-01")
    mid = {"start": dates[i2], "stats": {}, "curves": {}, "deploy": {}}
    for k in KINDS:
        vals, dep = run(k, i2, len(dates), ctx)
        ds = dates[i2:i2 + len(vals)]
        mid["stats"][k] = analyze(vals, dates, i2)
        mid["curves"][k] = [[ds[i], round(vals[i] / 1e4, 1)] for i in range(0, len(vals), 5)]
        lim = min(650, len(dep))
        mid["deploy"][k] = [[ds[i], round(dep[i] / TOTAL * 100, 1)] for i in range(0, lim, 3)]
    out["mid"] = mid

    # ---- 高位续涨场景：2013-05 刚创历史新高（看着贵，但牛市还在半山腰）----
    i3 = idx_of("2013-05-01")
    bull = {"start": dates[i3], "stats": {}, "curves": {}, "deploy": {}}
    for k in KINDS:
        vals, dep = run(k, i3, len(dates), ctx)
        ds = dates[i3:i3 + len(vals)]
        bull["stats"][k] = analyze(vals, dates, i3)
        bull["curves"][k] = [[ds[i], round(vals[i] / 1e4, 1)] for i in range(0, len(vals), 5)]
        lim = min(650, len(dep))
        bull["deploy"][k] = [[ds[i], round(dep[i] / TOTAL * 100, 1)] for i in range(0, lim, 3)]
    out["bull"] = bull

    # ---- 平凡日子场景：2014-10 距高点仅 -3%，无泡沫无熊市的普通秋天（参考基准）----
    i4 = idx_of("2014-10-01")
    norm = {"start": dates[i4], "stats": {}, "curves": {}, "deploy": {}}
    for k in KINDS:
        vals, dep = run(k, i4, len(dates), ctx)
        ds = dates[i4:i4 + len(vals)]
        norm["stats"][k] = analyze(vals, dates, i4)
        norm["curves"][k] = [[ds[i], round(vals[i] / 1e4, 1)] for i in range(0, len(vals), 5)]
        lim = min(650, len(dep))
        norm["deploy"][k] = [[ds[i], round(dep[i] / TOTAL * 100, 1)] for i in range(0, lim, 3)]
    out["norm"] = norm
    out["meta"] = {"data_end": dates[-1]}

    (OUT / "friend_plan_report_v2.json").write_text(json.dumps(out, ensure_ascii=False))
    for k in KINDS:
        s = main_case["stats"][k]
        print(f"[2000-03] {k:6s} 10y={s['v10']/1e4:7.1f}万  20y={s['v20']/1e4:7.1f}万  至今={s['vend']/1e4:7.1f}万  "
              f"MDD={s['mdd']*100:6.1f}% 谷底={s['trough_date']}  "
              f"回本={s['payback_from_start_years']}年 ({s['payback_date']})")
    for k in KINDS:
        s = sub["stats"][k]
        print(f"[2009-03] {k:6s} 10y={s['v10']/1e4:7.1f}万  至今={s['vend']/1e4:7.1f}万  MDD={s['mdd']*100:6.1f}%  "
              f"谷底={s['trough_date']}  回本={s['payback_years']}年")
    for k in KINDS:
        s = mid["stats"][k]
        print(f"[2008-09] {k:6s} 10y={s['v10']/1e4:7.1f}万  至今={s['vend']/1e4:7.1f}万  MDD={s['mdd']*100:6.1f}%  "
              f"谷底={s['trough_date']}  回本={s['payback_from_start_years']}年")
    for k in KINDS:
        s = bull["stats"][k]
        print(f"[2013-05] {k:6s} 10y={s['v10']/1e4:7.1f}万  至今={s['vend']/1e4:7.1f}万  MDD={s['mdd']*100:6.1f}%  "
              f"谷底={s['trough_date']}  hurt={s['hurt']} 回本={s['recover_years']}年")
    for k in KINDS:
        s = norm["stats"][k]
        print(f"[2014-10] {k:6s} 10y={s['v10']/1e4:7.1f}万  至今={s['vend']/1e4:7.1f}万  MDD={s['mdd']*100:6.1f}%  "
              f"谷底={s['trough_date']}  hurt={s['hurt']} 回本={s['recover_years']}年")


if __name__ == "__main__":
    main()
