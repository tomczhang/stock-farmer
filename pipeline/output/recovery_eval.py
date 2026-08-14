"""检验：'30% 现金垫 + 深跌阶梯部署 + 新高回补' 能否缩短大熊市的回本时间。

标的：50/50 标普+纳指100 月度再平衡混合指数（复用 build_blend），现金年化 3%。
策略（都从 1996-01 起持续运行，逐月再平衡到目标现金比例）：
  EQ100  : 永远 100% 股票
  STATIC : 永远 70/30（经典恒定比例，再平衡本身就会低买高卖）
  PLAN   : 目标现金 30%；指数自 ATH 回撤 <=-25% 降到 20%、<=-40% 降到 10%（各档
           每轮一次），指数创新高后目标回到 30%（用户方案：阶梯部署 + 新高回补）
  PLAN+CF: PLAN 基础上，回撤 <=-25% 期间每月额外注入外部现金流
           （月注入 = 危机前净值的 0.5%，模拟'大跌加现金流'）

指标：每轮大熊市（指数见顶月）各策略净值回到危机前水平所需月数、期间最深回撤。
运行：.venv/bin/python pipeline/output/recovery_eval.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import pipeline.output.dca_smart_backtest as bt  # noqa: E402

RF = 1.03 ** (1 / 12) - 1
CF_RATE = 0.005  # PLAN+CF：危机月注入 = 危机前净值 * 0.5%


def simulate(closes: list[float], kind: str, fires: list | None = None) -> tuple[list[float], list[float]]:
    """返回 (净值序列, 累计外部注入序列)。逐月再平衡到目标现金比例。

    PLAN3Y: 锚改为滚动 36 月高点；dd<=-25%/-40% 降现金目标到 20%/10%；
    dd 收窄到 -10% 以内时每月回补 2pp 直到 30%，同时重置档位。
    """
    n = len(closes)
    ath = closes[0]
    tier_used: set[int] = set()
    cash_target = 0.0 if kind == "EQ100" else 0.30
    eq_v, cash_v = 1.0 - cash_target, cash_target
    navs = [1.0]
    injected = [0.0]
    crisis_base = 1.0
    for i in range(1, n):
        r = closes[i] / closes[i - 1] - 1
        eq_v *= 1 + r
        cash_v *= 1 + RF
        if closes[i] > ath:
            ath = closes[i]
            tier_used.clear()
            if kind in ("PLAN", "PLAN+CF"):
                cash_target = 0.30
            crisis_base = eq_v + cash_v
        dd = closes[i] / ath - 1
        if kind in ("PLAN3Y", "PLAN3T", "PLAN3T0", "PLAN6", "PLAN6B"):
            tiers = ([(-0.25, 0.20), (-0.40, 0.10)] if kind == "PLAN3Y"
                     else [(-0.20, 0.25), (-0.30, 0.17), (-0.45, 0.10)] if kind == "PLAN3T"
                     else [(-0.20, 0.25), (-0.30, 0.17), (-0.45, 0.0)] if kind == "PLAN3T0"
                     else [(-0.15, 0.27), (-0.20, 0.23), (-0.26, 0.18),
                           (-0.33, 0.12), (-0.40, 0.06), (-0.50, 0.0)] if kind == "PLAN6"
                     else [(-0.20, 0.27), (-0.27, 0.23), (-0.34, 0.18),
                           (-0.41, 0.12), (-0.48, 0.06), (-0.55, 0.0)])
            hi36 = max(closes[max(0, i - 35):i + 1])
            dd36 = closes[i] / hi36 - 1
            if dd36 > -0.10:
                tier_used.clear()
                cash_target = min(0.30, cash_target + 0.02)
            for k, (th, tgt) in enumerate(tiers):
                if dd36 <= th and k not in tier_used:
                    tier_used.add(k)
                    cash_target = min(cash_target, tgt)
                    if fires is not None:
                        fires.append((i, k))
        if kind in ("PLAN", "PLAN+CF"):
            for k, (th, tgt) in enumerate([(-0.25, 0.20), (-0.40, 0.10)]):
                if dd <= th and k not in tier_used:
                    tier_used.add(k)
                    cash_target = tgt
        inj = 0.0
        if kind == "PLAN+CF" and dd <= -0.25:
            inj = crisis_base * CF_RATE
            cash_v += inj
        total = eq_v + cash_v
        # 再平衡到目标现金比例
        cash_v = total * cash_target
        eq_v = total - cash_v
        navs.append(total)
        injected.append(injected[-1] + inj)
    return navs, injected


def main() -> None:
    rows = bt.build_blend()
    dates = [r["date"] for r in rows]
    closes = [r["close_adj"] for r in rows]
    first = next(i for i, d in enumerate(dates) if d >= "1996-01-01")
    dates, closes = dates[first:], [c for c in closes[first:]]

    kinds = ["EQ100", "STATIC", "PLAN3T0", "PLAN6", "PLAN6B", "PLAN+CF"]
    results = {k: simulate(closes, k) for k in kinds}

    for variant in ("PLAN6", "PLAN6B"):
        fires: list = []
        simulate(closes, variant, fires)
        tier_names = (["-15%", "-20%", "-26%", "-33%", "-40%", "-50%"] if variant == "PLAN6"
                      else ["-20%", "-27%", "-34%", "-41%", "-48%", "-55%"])
        print(f"{variant} 各层历史触发:")
        by_tier: dict[int, list[str]] = {}
        for i, k in fires:
            by_tier.setdefault(k, []).append(dates[i][:7])
        for k in range(6):
            print(f"  第{k + 1}层 跌超{tier_names[k][1:]}: {', '.join(by_tier.get(k, ['从未触发']))}")
        print()

    peaks = ["2000-03", "2007-10", "2021-12"]
    print(f"数据 {dates[0]}..{dates[-1]}；回本 = 净值(扣除外部注入)回到危机前水平\n")
    for pk in peaks:
        i_p = next(i for i, d in enumerate(dates) if d[:7] >= pk)
        print(f"=== 危机前高点 {dates[i_p][:7]} ===")
        for k in kinds:
            navs, inj = results[k]
            v_p, inj_p = navs[i_p], inj[i_p]
            rec = None
            trough = 0.0
            for j in range(i_p + 1, len(navs)):
                adj = navs[j] - (inj[j] - inj_p)  # 扣掉危机后注入的本金，只看市场回本
                trough = min(trough, adj / v_p - 1)
                if adj >= v_p:
                    rec = j - i_p
                    break
            rec_s = f"{rec} 个月（{dates[i_p + rec][:7]}）" if rec else "样本内未回本"
            print(f"  {k:8s} 最深 {trough:6.0%}   回本 {rec_s}")
        print()

    n_years = (len(closes) - 1) / 12
    print("--- 全期 CAGR（1996 起，PLAN+CF 剔除注入影响不精确，不列） ---")
    for k in kinds[:4]:
        navs, _ = results[k]
        print(f"  {k:8s} {navs[-1] ** (1 / n_years) - 1:.2%}")


if __name__ == "__main__":
    main()
