"""朋友版 100W 宽指建仓方案回测。

对比三种买入方式（50/50 SPX/NDX，$1M）：
  A. 一次性买入
  B. 12 个月等额定投
  C. 本计划：30% 首笔 + 70% 分 12 期，双锚阶梯加速（-10/-17/-25 → 投剩余 25%/40%/100%）

方法：1996 起每个月作为起点滚动模拟，持有 5 年，统计年化收益与最大回撤。
口径：价格指数（不含股息，三方案同口径公平比较）；闲置现金按 0% 计息（保守）。
输出：friend_plan_backtest.html（ECharts 图表报告）
"""
from __future__ import annotations

import datetime as dt
import json
import math
from pathlib import Path

import requests
import urllib3

urllib3.disable_warnings()
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}
OUT = Path(__file__).resolve().parent

TOTAL = 1_000_000.0          # 每侧 50 万
HOLD_DAYS = 252 * 5          # 5 年窗口
TIERS = [(-0.10, 0.25), (-0.17, 0.40), (-0.25, 1.00)]


def fetch_daily(sym: str) -> tuple[list[str], list[float]]:
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}"
           f"?interval=1d&period1=631152000&period2=9999999999")
    r = requests.get(url, headers=UA, timeout=60, verify=False).json()
    res = r["chart"]["result"][0]
    ts = res["timestamp"]
    closes = res["indicators"]["quote"][0]["close"]
    dates, px = [], []
    for t, c in zip(ts, closes):
        if c is None:
            continue
        dates.append(dt.date.fromtimestamp(t).isoformat())
        px.append(float(c))
    return dates, px


def align(a: tuple, b: tuple) -> tuple[list[str], list[float], list[float]]:
    da, pa = a
    db, pb = b
    ma, mb = dict(zip(da, pa)), dict(zip(db, pb))
    common = sorted(set(da) & set(db))
    return common, [ma[d] for d in common], [mb[d] for d in common]


def running_ath(px: list[float]) -> list[float]:
    ath, out = -1.0, []
    for p in px:
        ath = max(ath, p)
        out.append(ath)
    return out


def month_starts(dates: list[str]) -> list[int]:
    idx = [0]
    for i in range(1, len(dates)):
        if dates[i][:7] != dates[i - 1][:7]:
            idx.append(i)
    return idx


def sim_side(px, ath, i0, buys_monthly, t0_frac, use_ladder, side_total):
    """单侧模拟，返回窗口内每日市值序列（shares*px + cash）。"""
    end = i0 + HOLD_DAYS
    cash, shares = side_total, 0.0
    # 月度买入日（含 i0）：i0 及其后 12 个月首日
    ms = [i for i in _MONTH_STARTS if i0 < i <= end]
    sched = ms[:12]
    n_inst = len(buys_monthly)
    values = []
    used: set[int] = set()
    pending: float | None = None  # 次日执行的阶梯买入金额
    inst_ptr = 0
    if t0_frac > 0:
        amt = min(cash, side_total * t0_frac)
        shares += amt / px[i0]
        cash -= amt
    for i in range(i0, end):
        if i > i0:
            if pending:
                amt = min(cash, pending)
                shares += amt / px[i]
                cash -= amt
                pending = None
            if inst_ptr < len(sched) and i == sched[inst_ptr] and inst_ptr < n_inst:
                amt = min(cash, buys_monthly[inst_ptr])
                if inst_ptr == n_inst - 1:      # 最后一期兜底投完
                    amt = cash
                shares += amt / px[i]
                cash -= amt
                inst_ptr += 1
        if use_ladder and cash > 1e-6:
            if px[i] >= ath[i] - 1e-9:          # 新高 → 档位重置
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
    return values


def run_strategy(kind, i0):
    half = TOTAL / 2
    if kind == "lump":
        args = dict(buys_monthly=[], t0_frac=1.0, use_ladder=False)
    elif kind == "dca12":
        args = dict(buys_monthly=[half / 12] * 12, t0_frac=0.0, use_ladder=False)
    else:  # plan
        args = dict(buys_monthly=[half * 0.7 / 12] * 12, t0_frac=0.3, use_ladder=True)
    v1 = sim_side(_SPX, _SPX_ATH, i0, side_total=half, **args)
    v2 = sim_side(_NDX, _NDX_ATH, i0, side_total=half, **args)
    return [a + b for a, b in zip(v1, v2)]


def metrics(values):
    end_v = values[-1]
    cagr = (end_v / TOTAL) ** (1 / 5) - 1
    peak, mdd = -1.0, 0.0
    for v in values:
        peak = max(peak, v)
        mdd = min(mdd, v / peak - 1)
    return cagr, mdd


def main():
    global _SPX, _NDX, _SPX_ATH, _NDX_ATH, _MONTH_STARTS, _DATES
    print("fetching ^GSPC / ^NDX ...")
    dates, spx, ndx = align(fetch_daily("^GSPC"), fetch_daily("^NDX"))
    _DATES, _SPX, _NDX = dates, spx, ndx
    _SPX_ATH, _NDX_ATH = running_ath(spx), running_ath(ndx)
    _MONTH_STARTS = month_starts(dates)

    starts = [i for i in _MONTH_STARTS
              if dates[i] >= "1996-01-01" and i + HOLD_DAYS <= len(dates)]
    print(f"rolling starts: {len(starts)}  ({dates[starts[0]]} ~ {dates[starts[-1]]})")

    kinds = ["lump", "dca12", "plan"]
    rows = []
    curves_cache = {}
    for i0 in starts:
        rec = {"start": dates[i0]}
        for k in kinds:
            vals = run_strategy(k, i0)
            cagr, mdd = metrics(vals)
            rec[k] = {"cagr": cagr, "mdd": mdd}
            curves_cache[(dates[i0], k)] = vals
        rows.append(rec)

    summary = {}
    for k in kinds:
        cagrs = [r[k]["cagr"] for r in rows]
        mdds = [r[k]["mdd"] for r in rows]
        wi = min(range(len(rows)), key=lambda i: rows[i][k]["cagr"])
        bi = max(range(len(rows)), key=lambda i: rows[i][k]["cagr"])
        summary[k] = {
            "mean_cagr": sum(cagrs) / len(cagrs),
            "worst_cagr": cagrs[wi], "worst_start": rows[wi]["start"],
            "best_cagr": cagrs[bi], "best_start": rows[bi]["start"],
            "mean_mdd": sum(mdds) / len(mdds),
            "worst_mdd": min(mdds),
            "worst_mdd_start": rows[min(range(len(rows)), key=lambda i: rows[i][k]["mdd"])]["start"],
            "win_vs_lump": (sum(1 for r in rows if r[k]["cagr"] >= r["lump"]["cagr"]) / len(rows)
                            if k != "lump" else None),
        }

    # 展示两条代表性起点曲线：一次性买入最差起点 & 最好起点
    worst_start = summary["lump"]["worst_start"]
    best_start = summary["lump"]["best_start"]

    def curve(start, k):
        vals = curves_cache[(start, k)]
        i0 = next(i for i in starts if dates[i] == start)
        ds = dates[i0:i0 + HOLD_DAYS]
        return [[ds[i], round(vals[i] / 10000, 1)] for i in range(0, len(vals), 5)]

    payload = {
        "rows": [{"start": r["start"],
                  **{k: {"cagr": round(r[k]["cagr"] * 100, 2),
                         "mdd": round(r[k]["mdd"] * 100, 2)} for k in kinds}}
                 for r in rows],
        "summary": {k: {kk: (round(vv * 100, 2) if isinstance(vv, float) else vv)
                        for kk, vv in s.items()} for k, s in summary.items()},
        "worst_case": {"start": worst_start,
                       "curves": {k: curve(worst_start, k) for k in kinds}},
        "best_case": {"start": best_start,
                      "curves": {k: curve(best_start, k) for k in kinds}},
        "meta": {"data_range": f"{dates[starts[0]]} ~ {dates[-1]}",
                 "n_starts": len(starts)},
    }
    (OUT / "friend_plan_backtest.json").write_text(
        json.dumps(payload, ensure_ascii=False))
    print("summary:")
    for k in kinds:
        s = summary[k]
        print(f"  {k:6s} meanCAGR {s['mean_cagr']*100:6.2f}%  "
              f"worst {s['worst_cagr']*100:6.2f}% ({s['worst_start']})  "
              f"best {s['best_cagr']*100:6.2f}% ({s['best_start']})  "
              f"meanMDD {s['mean_mdd']*100:6.2f}%  worstMDD {s['worst_mdd']*100:6.2f}%")


if __name__ == "__main__":
    main()
