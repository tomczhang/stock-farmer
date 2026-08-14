"""
验证"高位续涨后的大跌是否跌破进场位"：
  对近30年每个"创新高日"（在该日进场/开始等待），找其后第一次 ≥20% 回撤
  （日收盘口径）的最终底部，统计底部仍高于进场价的比例。

同时输出每次大跌的"时钟拨回"信息：底部相当于回到多久之前的价格水平。

数据复用 ath_proximity_backtest.py 的抓取逻辑。
用法：python3 ath_wait_vs_crash.py [--years 30]
"""
from __future__ import annotations

import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from ath_proximity_backtest import YAHOO_SYMBOLS, load_prices  # noqa: E402

CRASH_TH = 0.20  # 大跌定义：距运行高点回撤 ≥20%


def find_episodes(dates: list[date], closes: list[float]) -> list[dict]:
    """扫描全部历史，返回所有 ≥20% 回撤 episode：
    peak(此轮运行高点) -> cross(首次触及-20%) -> trough(底部，直到价格收复peak为止)。"""
    episodes = []
    peak_i = 0
    i = 1
    n = len(closes)
    while i < n:
        if closes[i] >= closes[peak_i]:
            peak_i = i
            i += 1
            continue
        if (closes[peak_i] - closes[i]) / closes[peak_i] >= CRASH_TH:
            cross_i = i
            trough_i = i
            j = i
            while j < n and closes[j] < closes[peak_i]:
                if closes[j] < closes[trough_i]:
                    trough_i = j
                j += 1
            # 时钟拨回：底部之前、peak之前最后一个收盘价 <= trough 的日期
            rewind_i = None
            for k in range(peak_i, -1, -1):
                if closes[k] <= closes[trough_i]:
                    rewind_i = k
                    break
            episodes.append(
                {
                    "peak_i": peak_i,
                    "cross_i": cross_i,
                    "trough_i": trough_i,
                    "recover_i": j if j < n else None,
                    "rewind_i": rewind_i,
                }
            )
            # 跳到收复点继续找下一轮
            if j >= n:
                break
            peak_i = j
            i = j + 1
        else:
            i += 1
    return episodes


def main() -> None:
    years = 30
    if "--years" in sys.argv:
        years = int(sys.argv[sys.argv.index("--years") + 1])
    since = date.today() - timedelta(days=int(years * 365.25))

    for name in YAHOO_SYMBOLS:
        src, rows = load_prices(name)
        dates = [d for d, _ in rows]
        closes = [c for _, c in rows]
        episodes = find_episodes(dates, closes)

        print(f"\n=== {name}（{src}）近{years}年 ≥20% 大跌清单 ===")
        recent = [
            ep for ep in episodes if dates[ep["trough_i"]] >= since
        ]
        for ep in recent:
            pk, tr, rw = ep["peak_i"], ep["trough_i"], ep["rewind_i"]
            dd = closes[tr] / closes[pk] - 1
            rewind_str = (
                f"回到 {dates[rw]}（拨回 {(dates[tr] - dates[rw]).days / 365.25:.1f} 年）"
                if rw is not None
                else "回到有数据以来最低（拨回全部历史）"
            )
            rec = dates[ep["recover_i"]] if ep["recover_i"] else "尚未收复"
            print(
                f"  峰 {dates[pk]} {closes[pk]:>9.0f} -> 底 {dates[tr]} {closes[tr]:>9.0f}"
                f"（{dd*100:.0f}%），{rewind_str}，收复于 {rec}"
            )

        # 每个创新高日进场，看下一次大跌底部是否仍高于进场价
        ath = float("-inf")
        total = broke = no_crash = 0
        margins = []  # 底部相对进场价的涨跌幅
        for i, c in enumerate(closes):
            is_high = c >= ath
            ath = max(ath, c)
            if not is_high or dates[i] < since:
                continue
            nxt = next((ep for ep in episodes if ep["peak_i"] >= i), None)
            if nxt is None:
                no_crash += 1
                continue
            total += 1
            trough_c = closes[nxt["trough_i"]]
            margins.append(trough_c / c - 1)
            if trough_c < c:
                broke += 1
        margins.sort()
        med = margins[len(margins) // 2] if margins else float("nan")
        print(f"  创新高日进场样本: {total}（另有 {no_crash} 日之后再无≥20%大跌，无法判定）")
        if total:
            print(
                f"  下一次大跌底部跌破进场价的比例: {broke/total*100:.1f}%"
                f"（守住比例 {100-broke/total*100:.1f}%）"
            )
            print(f"  底部相对进场价的中位数: {med*100:+.1f}%，最差: {margins[0]*100:+.1f}%，最好: {margins[-1]*100:+.1f}%")


if __name__ == "__main__":
    main()
