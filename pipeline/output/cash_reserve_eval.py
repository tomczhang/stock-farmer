"""专项评估：'30% 现金仓位等 -25% 回撤再入场' 规则（用户组合方案的 C 部件）。

标的：50/50 标普+纳指100 月度再平衡混合指数（复用 dca_smart_backtest.build_blend）。
现金按年化 3% 计息；月末观察回撤（相对混合净值历史高点）。

现金桶策略（各自独立、初始 1.0）：
  NOW    : 第 0 月直接投入（对照）
  KEEP   : 全程持现金（对照）
  P25    : 等首次 dd<=-25% 全仓投入；不触发则一直等（用户方案，无死线）
  LADDER : dd<=-25% 投一半，dd<=-40% 投剩余（阶梯版）

输出：5 年窗口的期末财富对比 + 触发统计（触发率 / 等待月数 / 触发价 vs 起点价）。
运行：.venv/bin/python pipeline/output/cash_reserve_eval.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import pipeline.output.dca_smart_backtest as bt  # noqa: E402

bt.CASH_RATE_MONTHLY = 1.03 ** (1 / 12) - 1
HORIZON = 60


def simulate(closes: list[float], peaks: list[float], si: int, tiers: list[tuple[float, float]]) -> tuple[float, int | None]:
    """现金桶按 tiers [(阈值, 投入剩余现金比例)] 部署，返回 (期末财富, 首次触发等待月数)。"""
    cash, shares = 1.0, 0.0
    used: set[int] = set()
    first_fire: int | None = None
    for m in range(1, HORIZON + 1):
        i = si + m
        cash *= 1 + bt.CASH_RATE_MONTHLY
        px = closes[i]
        if px >= peaks[i] - 1e-9:
            used.clear()
        dd = px / peaks[i] - 1.0
        for k, (th, frac) in enumerate(tiers):
            if dd <= th and k not in used and cash > 1e-12:
                used.add(k)
                amt = cash * frac
                shares += amt / px
                cash -= amt
                if first_fire is None:
                    first_fire = m
    return shares * closes[si + HORIZON] + cash, first_fire


def main() -> None:
    rows = bt.build_blend()
    closes = [r["close_adj"] for r in rows]
    dates = [r["date"] for r in rows]
    peaks: list[float] = []
    mx = 0.0
    for c in closes:
        mx = max(mx, c)
        peaks.append(mx)

    first = next(i for i, d in enumerate(dates) if d >= "1996-01-01")
    starts = list(range(first, len(rows) - HORIZON))
    print(f"混合指数 {dates[first]}..{dates[-1]}，5 年窗口 {len(starts)} 个\n")

    r_keep = 1.03 ** 5
    stats = {"P25": [], "LADDER": []}
    fires, waits, cheaper = 0, [], 0
    for si in starts:
        now = closes[si + HORIZON] / closes[si]
        p25, fire = simulate(closes, peaks, si, [(-0.25, 1.0)])
        lad, _ = simulate(closes, peaks, si, [(-0.25, 0.5), (-0.40, 1.0)])
        stats["P25"].append((p25 / now, p25 / r_keep))
        stats["LADDER"].append((lad / now, lad / r_keep))
        if fire is not None:
            fires += 1
            waits.append(fire)
            # 触发月价格是否真的低于窗口起点价格
            i_fire = si + fire
            cheaper += closes[i_fire] < closes[si]

    for name, pairs in stats.items():
        vs_now = sorted(p[0] for p in pairs)
        vs_keep = sorted(p[1] for p in pairs)
        n = len(pairs)
        print(f"{name:6s} vs 立即投入: 胜率 {sum(r > 1 for r in vs_now) / n:.1%}  "
              f"中位 {vs_now[n // 2]:.3f}  p10 {vs_now[n // 10]:.3f}  p90 {vs_now[9 * n // 10]:.3f}")
        print(f"{'':6s} vs 持有现金: 胜率 {sum(r > 1 for r in vs_keep) / n:.1%}  "
              f"中位 {vs_keep[n // 2]:.3f}")
    waits.sort()
    print(f"\nP25 触发统计: {fires}/{len(starts)} 个窗口内触发（{fires / len(starts):.0%}）"
          f"  中位等待 {waits[len(waits) // 2]} 个月" if waits else "从未触发")
    print(f"触发时价格低于窗口起点价格的比例: {cheaper}/{fires}（{cheaper / fires:.0%}）")


if __name__ == "__main__":
    main()
