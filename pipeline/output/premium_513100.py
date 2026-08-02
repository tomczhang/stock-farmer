"""513100 (国泰纳指100 QDII-ETF) 历史溢价率回测：场内收盘价 vs 单位净值。"""
import json
import re
import sys
from datetime import date

import requests
import urllib3

urllib3.disable_warnings()
UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}


def fetch_nav(code: str) -> dict[str, float]:
    """单位净值历史，来自 pingzhongdata（无需鉴权）。"""
    url = f"https://fund.eastmoney.com/pingzhongdata/{code}.js"
    txt = requests.get(url, headers=UA, timeout=30, verify=False).text
    m = re.search(r"Data_netWorthTrend\s*=\s*(\[.*?\]);", txt)
    if not m:
        raise RuntimeError("Data_netWorthTrend not found")
    rows = json.loads(m.group(1))
    out = {}
    for r in rows:
        d = date.fromtimestamp(r["x"] / 1000).isoformat()
        out[d] = float(r["y"])
    return out


def fetch_close(secid: str, beg: str = "20140101") -> dict[str, float]:
    """场内日线收盘价（不复权），东财 kline 接口。"""
    url = (
        "https://push2his.eastmoney.com/api/qt/stock/kline/get"
        f"?secid={secid}&fields1=f1,f2,f3&fields2=f51,f53"
        f"&klt=101&fqt=0&beg={beg}&end=20500101"
    )
    data = requests.get(url, headers=UA, timeout=30, verify=False).json()
    out = {}
    for line in data["data"]["klines"]:
        d, close = line.split(",")
        out[d] = float(close)
    return out


def main() -> None:
    nav = fetch_nav("513100")
    px = fetch_close("1.513100")
    days = sorted(set(nav) & set(px))
    if not days:
        print("no overlapping dates"); sys.exit(1)

    prem = [(d, px[d] / nav[d] - 1) for d in days]

    def stats(rows, label):
        n = len(rows)
        vals = sorted(p for _, p in rows)
        if not n:
            return
        pct = lambda q: vals[min(n - 1, int(q * n))] * 100
        below = sum(1 for _, p in rows if p <= 0.015)
        below1 = sum(1 for _, p in rows if p <= 0.01)
        neg = sum(1 for _, p in rows if p < 0)
        print(f"\n[{label}] 样本 {n} 天  区间 {rows[0][0]} ~ {rows[-1][0]}")
        print(f"  中位数 {pct(0.5):+.2f}%  P10 {pct(0.10):+.2f}%  P25 {pct(0.25):+.2f}%  "
              f"P75 {pct(0.75):+.2f}%  P90 {pct(0.90):+.2f}%  最大 {vals[-1]*100:+.2f}%  最小 {vals[0]*100:+.2f}%")
        print(f"  溢价<=1.5% 的天数: {below} ({below/n*100:.1f}%)   <=1% : {below1} ({below1/n*100:.1f}%)   折价(<0): {neg} ({neg/n*100:.1f}%)")

    stats(prem, "全期")
    for yr in range(2019, 2027):
        rows = [(d, p) for d, p in prem if d.startswith(str(yr))]
        if rows:
            stats(rows, str(yr))

    # 最近 90 个交易日逐日
    print("\n最近 20 个交易日溢价率:")
    for d, p in prem[-20:]:
        print(f"  {d}  {p*100:+.2f}%")

    # 每年 <=1.5% 的最近一次出现日期
    print("\n各年份最后一次溢价<=1.5% 的日期:")
    by_year: dict[str, str] = {}
    for d, p in prem:
        if p <= 0.015:
            by_year[d[:4]] = d
    for yr in sorted(by_year):
        print(f"  {yr}: {by_year[yr]}")


if __name__ == "__main__":
    main()
