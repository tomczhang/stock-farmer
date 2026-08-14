"""
回测：标普500(^GSPC)与纳指100(^NDX)近30年，日收盘价距"前高"回撤在各阈值以内的交易日占比。

前高口径（三种对照）：
  1. ATH  = 截至当日的历史最高收盘价（普通投资者的"创新高"口径）
  2. R3Y  = 滚动3年(756交易日)最高收盘价（"最近几年高点"的体感口径）
  3. R1Y  = 滚动1年(252交易日)最高收盘价（"今年以来高点"口径）

阈值：0%(恰好新高) / 3% / 5% / 10% / 20% 以内。
数据：Yahoo Finance v8 chart API 日收盘价指数（不含股息），失败时回退 Stooq CSV。
用法：python3 ath_proximity_backtest.py [--years 30]
"""
from __future__ import annotations

import io
import json
import ssl
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

# 公开行情数据，本机 CA 链不全（可能有代理 MITM），一次性脚本直接跳过验证
_SSL_CTX = ssl._create_unverified_context()

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}

YAHOO_SYMBOLS = {"标普500": "^GSPC", "纳指100": "^NDX"}
STOOQ_SYMBOLS = {"标普500": "^spx", "纳指100": "^ndx"}

THRESHOLDS = [0.0, 0.03, 0.05, 0.10, 0.20]
ROLL_WINDOWS = {"r3y": 756, "r1y": 252}  # ≈3年 / 1年交易日


def fetch_yahoo(symbol: str) -> list[tuple[date, float]]:
    # 注意：range=max&interval=1d 会被 Yahoo 静默降级成月线，必须用 period1/period2
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}"
        f"?period1=0&period2={int(time.time())}&interval=1d"
    )
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30, context=_SSL_CTX) as resp:
        data = json.load(resp)
    result = data["chart"]["result"][0]
    ts = result["timestamp"]
    closes = result["indicators"]["quote"][0]["close"]
    rows = []
    for t, c in zip(ts, closes):
        if c is None:
            continue
        rows.append((datetime.fromtimestamp(t, timezone.utc).date(), float(c)))
    return rows


def fetch_stooq(symbol: str) -> list[tuple[date, float]]:
    url = f"https://stooq.com/q/d/l/?s={urllib.parse.quote(symbol)}&i=d"
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30, context=_SSL_CTX) as resp:
        text = resp.read().decode("utf-8")
    rows = []
    for line in io.StringIO(text):
        parts = line.strip().split(",")
        if len(parts) < 5 or parts[0] == "Date":
            continue
        rows.append((date.fromisoformat(parts[0]), float(parts[4])))
    return rows


def load_prices(name: str) -> tuple[str, list[tuple[date, float]]]:
    try:
        rows = fetch_yahoo(YAHOO_SYMBOLS[name])
        if len(rows) > 1000:
            return f"yahoo:{YAHOO_SYMBOLS[name]}", rows
    except Exception as e:  # noqa: BLE001
        print(f"[warn] yahoo {name} 失败: {e}", file=sys.stderr)
    rows = fetch_stooq(STOOQ_SYMBOLS[name])
    return f"stooq:{STOOQ_SYMBOLS[name]}", rows


def analyze(rows: list[tuple[date, float]], since: date) -> dict:
    """rows 为全量历史（用来热身 ATH / 滚动窗口），统计只落在 since 之后。"""
    closes = [c for _, c in rows]
    dates = [d for d, _ in rows]

    # running ATH（含当日）
    ath = []
    cur = float("-inf")
    for c in closes:
        cur = max(cur, c)
        ath.append(cur)

    # 滚动窗口高点（含当日），用单调队列 O(n)
    from collections import deque

    def rolling_high(window: int) -> list[float]:
        out = []
        dq: deque[int] = deque()
        for i, c in enumerate(closes):
            while dq and closes[dq[-1]] <= c:
                dq.pop()
            dq.append(i)
            if dq[0] <= i - window:
                dq.popleft()
            out.append(closes[dq[0]])
        return out

    highs_by_key = {"ath": ath}
    for key, window in ROLL_WINDOWS.items():
        highs_by_key[key] = rolling_high(window)

    idx0 = next(i for i, d in enumerate(dates) if d >= since)
    n = len(dates) - idx0

    def pct_within(highs: list[float]) -> dict[float, float]:
        out = {}
        for th in THRESHOLDS:
            cnt = sum(
                1
                for i in range(idx0, len(dates))
                if (highs[i] - closes[i]) / highs[i] <= th + 1e-12
            )
            out[th] = cnt / n
        return out

    # 附带：区间内的最大回撤与新高日数
    dd_min = min((closes[i] / ath[i] - 1) for i in range(idx0, len(dates)))
    result = {
        "start": dates[idx0].isoformat(),
        "end": dates[-1].isoformat(),
        "days": n,
        "max_drawdown": dd_min,
    }
    for key, highs in highs_by_key.items():
        result[key] = pct_within(highs)
    return result


def main() -> None:
    years = 30
    if "--years" in sys.argv:
        years = int(sys.argv[sys.argv.index("--years") + 1])
    since = date.today() - timedelta(days=int(years * 365.25))

    for name in YAHOO_SYMBOLS:
        src, rows = load_prices(name)
        res = analyze(rows, since)
        print(f"\n=== {name}（{src}，{res['start']} .. {res['end']}，{res['days']} 个交易日）===")
        print(f"  区间最大回撤（相对ATH）: {res['max_drawdown']*100:.1f}%")
        header = "  {:<28}".format("阈值") + "".join(
            f"{'恰新高' if th == 0 else f'≤{th*100:.0f}%':>10}" for th in THRESHOLDS
        )
        print(header)
        for key, label in (
            ("ath", "距历史最高收盘价(ATH)"),
            ("r3y", "距滚动3年高点"),
            ("r1y", "距滚动1年高点"),
        ):
            line = f"  {label:<24}" + "".join(
                f"{res[key][th]*100:>9.1f}%" for th in THRESHOLDS
            )
            print(line)


if __name__ == "__main__":
    main()
