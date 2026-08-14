"""
全收益口径的"立即全投 vs 等大跌"回测：
  组合：100% QQQ / 50-50 QQQ+SPY(日再平衡) / 100% SPY（VOO 替身，同为标普500）
  价格：Yahoo adjclose（含股息再投资）
  现金：年化4%复利
  策略：
    - 立即全投：起点日全仓买入组合，持有到终点
    - 硬等：空仓吃4%利息，组合从运行峰值回撤达-20%（收盘）当日全仓买入；等不到则持币到终点
    - 半仓：50%立即买入，50%按硬等规则执行
  起点日：分析窗口内组合全收益指数的每个"创新高日"
  输出：各策略终值/立即全投终值 的 p10/中位/p90、跑输占比、触发统计
用法：python3 wait_vs_lumpsum_tr.py
"""
from __future__ import annotations

import json
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from ath_proximity_backtest import _SSL_CTX, UA  # noqa: E402

CASH_RATE = 1.04
CRASH_TH = 0.20


def fetch_adjclose(symbol: str) -> dict[date, float]:
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}"
        f"?period1=0&period2={int(time.time())}&interval=1d&events=div%2Csplit"
    )
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30, context=_SSL_CTX) as resp:
        data = json.load(resp)
    result = data["chart"]["result"][0]
    ts = result["timestamp"]
    adj = result["indicators"]["adjclose"][0]["adjclose"]
    out = {}
    for t, c in zip(ts, adj):
        if c is None:
            continue
        out[datetime.fromtimestamp(t, timezone.utc).date()] = float(c)
    return out


def build_series() -> dict[str, tuple[list[date], list[float]]]:
    qqq = fetch_adjclose("QQQ")
    spy = fetch_adjclose("SPY")
    common = sorted(set(qqq) & set(spy))
    q = [qqq[d] for d in common]
    s = [spy[d] for d in common]
    # 50/50 日再平衡全收益指数
    blend = [100.0]
    for i in range(1, len(common)):
        r = 0.5 * (q[i] / q[i - 1] - 1) + 0.5 * (s[i] / s[i - 1] - 1)
        blend.append(blend[-1] * (1 + r))
    return {
        "100% QQQ": (common, q),
        "50% QQQ + 50% VOO(SPY)": (common, blend),
        "100% VOO(SPY)": (common, s),
    }


def analyze(dates: list[date], closes: list[float]) -> dict:
    n = len(closes)
    end_p, end_d = closes[-1], dates[-1]

    # 运行峰值与 -20% 触发日（每个 i 之后的第一个触发日，逆向预计算）
    peak = 0.0
    dd_hit = []  # 该日是否处于回撤≥20%状态
    for c in closes:
        peak = max(peak, c)
        dd_hit.append((peak - c) / peak >= CRASH_TH)
    # next_trigger[i] = 从 i 日（含）往后，首个"从 i 日起重新计峰"回撤≥20%的日子
    # 注意：等待者的峰值应从开始等待那天起算他见过的最高价（他等待期间组合继续涨会抬高峰值）
    # 这里逐 i 扫描是 O(n^2)，创新高日只有几百个，可接受

    ath = 0.0
    entries = []
    for i, c in enumerate(closes):
        if c >= ath:
            entries.append(i)
        ath = max(ath, c)

    trig_of = {}
    for i in entries:
        pk = closes[i]
        trig = None
        for j in range(i + 1, n):
            pk = max(pk, closes[j])
            if (pk - closes[j]) / pk >= CRASH_TH:
                trig = j
                break
        trig_of[i] = trig

    stats = {
        "entries": len(entries),
        "never": sum(1 for i in entries if trig_of[i] is None),
    }
    trig_higher = trig_higher_adj = 0
    waits, full, half = [], [], []
    for i in entries:
        c = closes[i]
        buy_now = end_p / c
        j = trig_of[i]
        if j is None:
            yrs = (end_d - dates[i]).days / 365.25
            cash_g = CASH_RATE**yrs
            full.append(cash_g / buy_now)
            half.append((0.5 * buy_now + 0.5 * cash_g) / buy_now)
            continue
        trig_p = closes[j]
        wait = (dates[j] - dates[i]).days / 365.25
        waits.append(wait)
        cash_g = CASH_RATE**wait
        if trig_p > c:
            trig_higher += 1
        if trig_p / cash_g > c:
            trig_higher_adj += 1
        full.append(cash_g * end_p / trig_p / buy_now)
        half.append((0.5 * buy_now + 0.5 * cash_g * end_p / trig_p) / buy_now)
    triggered = len(entries) - stats["never"]
    waits.sort()
    full.sort()
    half.sort()

    def q(a, p):
        return a[int(p * (len(a) - 1))]

    stats.update(
        triggered=triggered,
        trig_higher=trig_higher / triggered,
        trig_higher_adj=trig_higher_adj / triggered,
        wait_med=q(waits, 0.5),
        wait_p90=q(waits, 0.9),
        full=(q(full, 0.1), q(full, 0.5), q(full, 0.9), sum(r < 1 for r in full) / len(full)),
        half=(q(half, 0.1), q(half, 0.5), q(half, 0.9), sum(r < 1 for r in half) / len(half)),
        start=dates[0].isoformat(),
        end=end_d.isoformat(),
    )
    return stats


def main() -> None:
    for name, (dates, closes) in build_series().items():
        st = analyze(dates, closes)
        print(f"\n=== {name}（全收益，{st['start']} .. {st['end']}）===")
        print(f"  创新高日样本 {st['entries']}，其中等到-20%触发 {st['triggered']}，没等到 {st['never']}")
        print(f"  触发价高于起点价: 名义 {st['trig_higher']*100:.1f}% | 扣除4%利息后 {st['trig_higher_adj']*100:.1f}%")
        print(f"  等待时长: 中位 {st['wait_med']:.1f} 年，p90 {st['wait_p90']:.1f} 年")
        for key, label in (("full", "硬等/立即全投"), ("half", "半仓+半等/立即全投")):
            p10, med, p90, lose = st[key]
            print(f"  [{label}] p10 {p10:.2f} 中位 {med:.2f} p90 {p90:.2f}，跑输占比 {lose*100:.0f}%")


if __name__ == "__main__":
    main()
