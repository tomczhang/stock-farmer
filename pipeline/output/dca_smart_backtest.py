"""一次性回测脚本（不进 pipeline 包）：纯定投 vs 50% 资金"聪明定投"。

数据：multpl.com S&P 500 月度价格 + PE-TTM（1871 至今），复用 pipeline.fetcher.multpl。
注意：价格指数不含股息，对囤现金策略略偏"仁慈"（少扣了等待期的股息）。

策略（每月工资投入 1000 美元，现金储备不计息）：
  A. 纯定投：每月全额买入。
  B. 回撤加码：每月投 50%、存 50%；指数自历史高点回撤 ≤-20% 时动用储备的一半，
     ≤-30% 时动用全部；每次创新高后重置触发器（每轮熊市各触发一次）。
  C. PE 分位加码：每月投 50%、存 50%；当月 PE-TTM 处于自身过去 10 年分位 <30% 时，
     当月全额买入并动用全部储备。

输出：若干起始年份至今的期末财富对比 + 全部 20 年滚动窗口的胜率统计。
运行：.venv/bin/python pipeline/output/dca_smart_backtest.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from pipeline.fetcher.multpl import fetch_sp500_pe_history  # noqa: E402

CACHE = Path(__file__).with_name("multpl_cache.json")
MONTHLY = 1000.0
PE_WINDOW = 120  # 10 年
PE_PCT_TRIGGER = 0.30
CASH_RATE_MONTHLY = 0.0  # 现金储备月利率（敏感性测试用，main 里可覆盖）


def load_data() -> list[dict]:
    if CACHE.exists():
        return json.loads(CACHE.read_text())
    rows = fetch_sp500_pe_history()
    rows = [r for r in rows if r["close_adj"] is not None]
    CACHE.write_text(json.dumps(rows))
    return rows


def pe_percentile(pes: list[float], i: int) -> float | None:
    """过去 PE_WINDOW 个月（不含当月）中低于当月 PE 的占比；无 PE 数据返回 None。"""
    if i < PE_WINDOW or pes[i] is None:
        return None
    window = pes[i - PE_WINDOW:i]
    if any(p is None for p in window):
        return None
    cur = pes[i]
    return sum(1 for p in window if p < cur) / len(window)


def load_stooq(symbol: str) -> list[dict]:
    """月线价格（优先 yfinance，拆分复权、不含股息），格式对齐 multpl 输出；pe_ttm=None。"""
    cache = Path(__file__).with_name(f"prices_{symbol.replace('^', '').replace('.', '_')}.json")
    if cache.exists():
        return json.loads(cache.read_text())
    import yfinance as yf
    hist = yf.download(symbol, period="max", interval="1mo", progress=False,
                       auto_adjust=False, threads=False)
    if hist.empty:
        raise RuntimeError(f"yfinance: no rows for {symbol}")
    import pandas as pd
    if isinstance(hist.columns, pd.MultiIndex):
        hist.columns = hist.columns.get_level_values(0)
    rows = [
        {"date": idx.strftime("%Y-%m-%d"), "close_adj": float(c), "pe_ttm": None}
        for idx, c in hist["Close"].items() if c == c  # 过滤 NaN
    ]
    cache.write_text(json.dumps(rows))
    return rows


def run_strategies(rows: list[dict], start_i: int, end_i: int, pes: list[float]) -> dict[str, float]:
    """返回三种策略在 [start_i, end_i] 区间的期末总财富（持仓市值 + 现金）。"""
    closes = [r["close_adj"] for r in rows]

    # A. 纯定投
    shares_a = 0.0
    # B. 回撤加码
    shares_b, cash_b = 0.0, 0.0
    ath, fired20, fired30 = 0.0, False, False
    # C. PE 分位加码
    shares_c, cash_c = 0.0, 0.0

    for i in range(start_i, end_i + 1):
        px = closes[i]

        # A
        shares_a += MONTHLY / px

        # B
        cash_b *= 1 + CASH_RATE_MONTHLY
        shares_b += (MONTHLY / 2) / px
        cash_b += MONTHLY / 2
        if px > ath:
            ath, fired20, fired30 = px, False, False
        dd = px / ath - 1.0
        if dd <= -0.30 and not fired30:
            shares_b += cash_b / px
            cash_b = 0.0
            fired30 = fired20 = True
        elif dd <= -0.20 and not fired20:
            shares_b += (cash_b / 2) / px
            cash_b /= 2
            fired20 = True

        # C
        cash_c *= 1 + CASH_RATE_MONTHLY
        pct = pe_percentile(pes, i)
        if pct is not None and pct < PE_PCT_TRIGGER:
            shares_c += (MONTHLY + cash_c) / px
            cash_c = 0.0
        else:
            shares_c += (MONTHLY / 2) / px
            cash_c += MONTHLY / 2

    final_px = closes[end_i]
    return {
        "A_pure_dca": shares_a * final_px,
        "B_drawdown": shares_b * final_px + cash_b,
        "C_pe_pct": shares_c * final_px + cash_c,
    }


def run_lumpsum(
    closes: list[float],
    peaks: list[float],
    pes: list[float],
    si: int,
    *,
    horizon: int,
    init_frac: float,
    months: int,
    smart: bool,
    capital: float = 1_000_000.0,
) -> float:
    """一次性资金建仓：首月投 init_frac，余下 months 个月内投完，返回 si+horizon 时的财富。

    smart=True 时：若当月 PE 十年分位 <30% 或 自历史高点回撤 ≤-20%，一次性投入全部剩余；
    否则每月投 剩余/剩余月数（等额）；第 months 月末强制投完（不永久囤现金）。
    """
    shares = 0.0
    cash = capital
    amt0 = capital * init_frac
    shares += amt0 / closes[si]
    cash -= amt0
    for m in range(1, months + 1):
        if cash <= 1e-9:
            break
        i = si + m
        cash *= 1 + CASH_RATE_MONTHLY
        px = closes[i]
        pct = pe_percentile(pes, i)
        dd = px / peaks[i] - 1.0
        trigger = (pct is not None and pct < PE_PCT_TRIGGER) or dd <= -0.20
        if (smart and trigger) or m == months:
            amt = cash
        else:
            amt = cash / (months - m + 1)
        shares += amt / px
        cash -= amt
    return shares * closes[si + horizon] + cash


def main_lumpsum(rows: list[dict], pes: list[float], since: str = "1900-01-01") -> None:
    closes = [r["close_adj"] for r in rows]
    dates = [r["date"] for r in rows]
    peaks: list[float] = []
    mx = 0.0
    for c in closes:
        mx = max(mx, c)
        peaks.append(mx)

    horizon = 60  # 评估点：建仓开始后 5 年
    strategies = [
        ("一次性全投 LS", dict(init_frac=1.0, months=0, smart=False)),
        ("0%+12月普通", dict(init_frac=0.0, months=12, smart=False)),
        ("30%+12月普通", dict(init_frac=0.3, months=12, smart=False)),
        ("30%+12月聪明", dict(init_frac=0.3, months=12, smart=True)),
        ("50%+12月普通", dict(init_frac=0.5, months=12, smart=False)),
        ("50%+12月聪明", dict(init_frac=0.5, months=12, smart=True)),
        ("30%+24月聪明", dict(init_frac=0.3, months=24, smart=True)),
    ]

    first = next(i for i, d in enumerate(dates) if d >= since)
    starts = list(range(first, len(rows) - horizon))
    # 按起点估值分组：高估起点（PE 十年分位 ≥70%，类似当下）
    expensive = [si for si in starts if (p := pe_percentile(pes, si)) is not None and p >= 0.70]
    print(f"窗口：建仓后 {horizon // 12} 年评估；起点 {len(starts)} 个（{dates[first]} 起），其中高估起点（PE分位≥70%）{len(expensive)} 个\n")

    def report(subset: list[int], label: str) -> None:
        base = {si: run_lumpsum(closes, peaks, pes, si, horizon=horizon, init_frac=1.0, months=0, smart=False)
                for si in subset}
        print(f"--- {label} ---")
        print(f"{'策略':<14}{'胜率vsLS':>10}{'中位比':>8}{'p10':>8}{'p90':>8}")
        for name, kw in strategies[1:]:
            ratios = sorted(
                run_lumpsum(closes, peaks, pes, si, horizon=horizon, **kw) / base[si] for si in subset
            )
            n = len(ratios)
            win = sum(r > 1 for r in ratios) / n
            print(f"{name:<14}{win:>10.1%}{ratios[n // 2]:>8.3f}{ratios[n // 10]:>8.3f}{ratios[9 * n // 10]:>8.3f}")
        print()

    report(starts, f"全部起点（{since[:4]} 年起逐月）")
    if expensive:
        report(expensive, "仅高估起点（PE 十年分位 ≥70%，对应当下环境）")


def build_blend(w_spx: float = 0.5) -> list[dict]:
    """50/50 标普+纳指100 混合指数（月度再平衡）；pe_ttm 沿用标普 PE。"""
    spx = load_data()
    ndx = load_stooq("^ndx")
    ndx_by_m = {r["date"][:7]: r["close_adj"] for r in ndx}
    rows: list[dict] = []
    prev_s = prev_n = None
    level = 100.0
    for r in spx:
        m = r["date"][:7]
        if m not in ndx_by_m:
            continue
        s, n = r["close_adj"], ndx_by_m[m]
        if prev_s is not None:
            level *= 1 + w_spx * (s / prev_s - 1) + (1 - w_spx) * (n / prev_n - 1)
        rows.append({"date": r["date"], "close_adj": level, "pe_ttm": r["pe_ttm"]})
        prev_s, prev_n = s, n
    return rows


def main() -> None:
    global CASH_RATE_MONTHLY
    if "--cash-rate" in sys.argv:
        annual = float(sys.argv[sys.argv.index("--cash-rate") + 1])
        CASH_RATE_MONTHLY = (1 + annual) ** (1 / 12) - 1
        print(f"[现金储备按年化 {annual:.1%} 计息]")
    if "--blend" in sys.argv:
        rows = build_blend()
        print(f"[50/50 标普+纳指100 月度再平衡，{rows[0]['date']}..{rows[-1]['date']}，PE触发=标普PE分位]")
    elif "--symbol" in sys.argv:
        symbol = sys.argv[sys.argv.index("--symbol") + 1]
        rows = load_stooq(symbol)
        print(f"[数据源 yahoo:{symbol}，{rows[0]['date']}..{rows[-1]['date']}，无 PE，聪明触发=仅回撤]")
    else:
        rows = load_data()
    if "--lumpsum" in sys.argv:
        since = "1900-01-01"
        if "--since" in sys.argv:
            since = sys.argv[sys.argv.index("--since") + 1] + "-01-01"
        pes = [r["pe_ttm"] for r in rows]
        main_lumpsum(rows, pes, since=since)
        return
    dates = [r["date"] for r in rows]
    pes = [r["pe_ttm"] for r in rows]
    last_i = len(rows) - 1
    print(f"数据: {dates[0]} .. {dates[-1]}，共 {len(rows)} 个月\n")

    # 1) 各起始年份至今
    print("=== 各起始年份定投至今（期末财富，美元；投入=1000/月） ===")
    print(f"{'起始':<8}{'月数':>5}{'纯定投A':>14}{'回撤B':>14}{'PE分位C':>14}{'B/A':>8}{'C/A':>8}")
    for year in (1970, 1980, 1990, 1995, 2000, 2005, 2010, 2015, 2020):
        start = f"{year}-01-01"
        try:
            si = next(i for i, d in enumerate(dates) if d >= start)
        except StopIteration:
            continue
        res = run_strategies(rows, si, last_i, pes)
        a, b, c = res["A_pure_dca"], res["B_drawdown"], res["C_pe_pct"]
        n = last_i - si + 1
        print(f"{year:<8}{n:>5}{a:>14,.0f}{b:>14,.0f}{c:>14,.0f}{b / a:>8.3f}{c / a:>8.3f}")

    # 2) 20 年滚动窗口胜率（起点自 1900 年起逐月滚动）
    print("\n=== 20 年滚动窗口（逐月起点，1900 年起） ===")
    horizon = 240
    first = next(i for i, d in enumerate(dates) if d >= "1900-01-01")
    wins_b, wins_c, ratios_b, ratios_c = 0, 0, [], []
    n_win = 0
    for si in range(first, last_i - horizon + 1):
        res = run_strategies(rows, si, si + horizon - 1, pes)
        a, b, c = res["A_pure_dca"], res["B_drawdown"], res["C_pe_pct"]
        wins_b += b > a
        wins_c += c > a
        ratios_b.append(b / a)
        ratios_c.append(c / a)
        n_win += 1
    ratios_b.sort()
    ratios_c.sort()
    med = lambda xs: xs[len(xs) // 2]  # noqa: E731
    print(f"窗口数: {n_win}")
    print(f"B 回撤加码 跑赢纯定投: {wins_b / n_win:.1%}  中位 B/A={med(ratios_b):.3f}  "
          f"最差={ratios_b[0]:.3f}  最好={ratios_b[-1]:.3f}")
    print(f"C PE分位  跑赢纯定投: {wins_c / n_win:.1%}  中位 C/A={med(ratios_c):.3f}  "
          f"最差={ratios_c[0]:.3f}  最好={ratios_c[-1]:.3f}")


if __name__ == "__main__":
    main()
