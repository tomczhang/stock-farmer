"""513100 零溢价日买入回测：自成立以来，在溢价率 <=阈值 的交易日买入，
持有到最新交易日，按买入年份分组统计平均年化收益率。

两种结算口径：
  1. 市价结算：终点用最新场内收盘价（含当前溢价，若当前高溢价则虚高）
  2. 去溢价结算：终点市价剔除当前溢价（假设卖出时溢价归零，保守/诚实口径）

收益用后复权收盘价计算（fqt=2），避免 2015 年份额拆分造成断层；
溢价率用不复权价 / 单位净值（两者在拆分日同步跳变，比值不受影响）。
"""
import sys
from datetime import date
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).parent))
from premium_513100 import UA, fetch_close, fetch_nav  # noqa: E402


def fetch_close_adj(secid: str, beg: str = "20130101") -> dict[str, float]:
    """后复权日线收盘价。"""
    url = (
        "https://push2his.eastmoney.com/api/qt/stock/kline/get"
        f"?secid={secid}&fields1=f1,f2,f3&fields2=f51,f53"
        f"&klt=101&fqt=2&beg={beg}&end=20500101"
    )
    data = requests.get(url, headers=UA, timeout=30, verify=False).json()
    return {l.split(",")[0]: float(l.split(",")[1]) for l in data["data"]["klines"]}


def main() -> None:
    nav = fetch_nav("513100")
    px = fetch_close("1.513100", beg="20130101")
    adj = fetch_close_adj("1.513100")
    days = sorted(set(nav) & set(px) & set(adj))
    end_d = days[-1]
    end_adj = adj[end_d]
    cur_prem = px[end_d] / nav[end_d] - 1
    end_adj_deprem = end_adj / (1 + cur_prem)
    print(f"数据区间 {days[0]} ~ {end_d}，共 {len(days)} 个重叠交易日")
    print(f"当前溢价率 {cur_prem*100:+.2f}%（终点去溢价即除以该系数）")

    for th, label in [(0.0, "严格0溢价(<=0%)"), (0.01, "近似0溢价(<=1%)")]:
        picks = [d for d in days if px[d] / nav[d] - 1 <= th]
        print(f"\n=== {label}：全期 {len(picks)} 个买点 ===")
        print("年份 | 买点数 | 平均年化(市价结算) | 平均年化(去溢价结算) | 平均持有(年)")
        by_year: dict[str, list] = {}
        for d in picks:
            by_year.setdefault(d[:4], []).append(d)
        for yr in sorted(by_year):
            rs_mkt, rs_dep, hs = [], [], []
            for d in by_year[yr]:
                yrs = (date.fromisoformat(end_d) - date.fromisoformat(d)).days / 365.25
                if yrs < 0.5:  # 持有期太短，年化无意义
                    continue
                buy = adj[d]
                rs_mkt.append((end_adj / buy) ** (1 / yrs) - 1)
                rs_dep.append((end_adj_deprem / buy) ** (1 / yrs) - 1)
                hs.append(yrs)
            if not rs_mkt:
                print(f"{yr} | {len(by_year[yr]):>4} | （持有期<0.5年，跳过年化） | |")
                continue
            n = len(rs_mkt)
            print(
                f"{yr} | {len(by_year[yr]):>4} | {sum(rs_mkt)/n*100:>13.1f}% "
                f"| {sum(rs_dep)/n*100:>15.1f}% | {sum(hs)/n:>8.1f}"
            )


if __name__ == "__main__":
    main()
