"""513100 波段回测 v2：0溢价买入 -> >=10%溢价卖出。

数据源（绕开被限流的东财 push2his）：
  - 场内价：腾讯 fqkline 后复权(hfq)，按 2 年分页拿全历史
  - 净值：东财 pingzhongdata（单位净值，可用）
  - 原始价还原：用单位净值序列检测拆分日/比例，hfq / 拆分因子 = 原始价；
    用新浪最近 1023 天原始收盘价做交叉校验
数据缓存到 swing_513100_cache.json，避免重复请求。
"""
import json
import sys
import time
from collections import Counter
from datetime import date
from pathlib import Path

import requests
import urllib3

urllib3.disable_warnings()
sys.path.insert(0, str(Path(__file__).parent))

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}
CACHE = Path(__file__).parent / "swing_513100_cache.json"

_session = requests.Session()
_session.trust_env = False


def _get(url):
    for attempt in range(4):
        try:
            r = _session.get(url, headers=UA, timeout=30, verify=False)
            if r.status_code == 200:
                return r
        except requests.RequestException:
            pass
        time.sleep(2 + 2 * attempt)
    raise RuntimeError(f"fetch failed: {url[:80]}")


def fetch_hfq_tencent() -> dict[str, float]:
    """后复权收盘价，2年一段分页。"""
    out = {}
    spans = [(f"{y}-01-01", f"{y+1}-12-31") for y in range(2013, 2027, 2)]
    for beg, end in spans:
        url = ("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
               f"?param=sh513100,day,{beg},{end},640,hfq")
        d = _get(url).json()
        if d.get("code") != 0 or not d.get("data"):
            continue
        dd = d["data"]["sh513100"]
        key = next((k for k in dd if k.endswith("day")), None)
        if not key:
            continue
        for row in dd[key]:
            out[row[0]] = float(row[2])
    return out


def fetch_nav_eastmoney() -> dict[str, float]:
    import re
    url = "https://fund.eastmoney.com/pingzhongdata/513100.js"
    txt = _get(url).text
    m = re.search(r"Data_netWorthTrend\s*=\s*(\[.*?\]);", txt)
    rows = json.loads(m.group(1))
    return {date.fromtimestamp(r["x"] / 1000).isoformat(): float(r["y"]) for r in rows}


def fetch_raw_sina() -> dict[str, float]:
    url = ("https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData"
           "?symbol=sh513100&scale=240&ma=no&datalen=1023")
    rows = _get(url).json()
    return {r["day"]: float(r["close"]) for r in rows}


def load_data():
    if CACHE.exists():
        d = json.loads(CACHE.read_text())
        return d["hfq"], d["nav"], d["sina"]
    hfq = fetch_hfq_tencent()
    nav = fetch_nav_eastmoney()
    sina = fetch_raw_sina()
    CACHE.write_text(json.dumps({"hfq": hfq, "nav": nav, "sina": sina}))
    return hfq, nav, sina


def yrs(a: str, b: str) -> float:
    return (date.fromisoformat(b) - date.fromisoformat(a)).days / 365.25


def main() -> None:
    hfq, nav, sina = load_data()
    days = sorted(set(hfq) & set(nav))
    print(f"hfq {len(hfq)} 天, nav {len(nav)} 天, 重叠 {len(days)} 天 ({days[0]} ~ {days[-1]})")

    # 1) 用净值检测拆分：单位净值单日比值超出美股正常波动(比值<0.7或>1.4)视为拆分
    splits = []
    for i in range(1, len(days)):
        r = nav[days[i]] / nav[days[i - 1]]
        if r < 0.7 or r > 1.4:
            splits.append((days[i], r))
    print("检测到的拆分事件:", [(d, f"净值比 {r:.3f}") for d, r in splits])

    # 2) hfq/raw 因子：拆分后因子=1/净值比 累乘；拆分前=1
    factor = {}
    f = 1.0
    si = 0
    for d in days:
        while si < len(splits) and d >= splits[si][0]:
            f /= splits[si][1]
            si += 1
        factor[d] = f
    raw = {d: hfq[d] / factor[d] for d in days}

    # 3) 用新浪最近段校验 raw
    common = sorted(set(raw) & set(sina))[-200:]
    errs = [abs(raw[d] / sina[d] - 1) for d in common]
    print(f"raw 还原 vs 新浪实价 校验(最近{len(common)}天): 最大偏差 {max(errs)*100:.2f}%")

    prem = {d: raw[d] / nav[d] - 1 for d in days}
    idx = {d: i for i, d in enumerate(days)}

    hi = [d for d in days if prem[d] >= 0.10]
    print(f"\n溢价>=10% 的交易日 {len(hi)} 天，按年: {dict(Counter(d[:4] for d in hi))}")
    print(f"最早一次: {hi[0] if hi else '无'}")
    buys = [d for d in days if prem[d] <= 0.0]
    print(f"0溢价买点 {len(buys)} 个，按年: {dict(Counter(d[:4] for d in buys))}")

    q = lambda a, p: a[min(len(a) - 1, int(p * len(a)))]

    # 策略A: 卖在此后第一个>=10%溢价日
    sold, unsold = [], 0
    for d in buys:
        s = next((x for x in days[idx[d] + 1:] if prem[x] >= 0.10), None)
        if s is None:
            unsold += 1
            continue
        h = yrs(d, s)
        sold.append((d, s, h, (hfq[s] / hfq[d]) ** (1 / h) - 1))
    print(f"\n[策略A] 等到>=10%溢价才卖: 成交 {len(sold)}，没等到 {unsold}")
    if sold:
        hs = sorted(x[2] for x in sold)
        rs = sorted(x[3] for x in sold)
        print(f"  持有期: 中位 {q(hs,.5):.1f} 年, p10 {q(hs,.1):.1f}, p90 {q(hs,.9):.1f}, 最短 {hs[0]:.2f}, 最长 {hs[-1]:.1f}")
        print(f"  年化: 平均 {sum(rs)/len(rs)*100:.1f}%, 中位 {q(rs,.5)*100:.1f}%, p10 {q(rs,.1)*100:.1f}%, p90 {q(rs,.9)*100:.1f}%")
        w2 = sum(1 for x in sold if x[2] <= 2)
        print(f"  2年内等到10%溢价的买点: {w2}/{len(buys)}（{w2/len(buys)*100:.1f}%）")

    # 策略B: 2年内>=10%溢价卖出，否则满2年强制市价卖出
    rs2, forced = [], 0
    for d in buys:
        if yrs(d, days[-1]) < 2:
            continue
        s = next((x for x in days[idx[d] + 1:] if prem[x] >= 0.10 and yrs(d, x) <= 2), None)
        if s is None:
            s = next(x for x in days[idx[d] + 1:] if yrs(d, x) >= 2)
            forced += 1
        h = yrs(d, s)
        rs2.append((hfq[s] / hfq[d]) ** (1 / h) - 1)
    rs2.sort()
    print(f"\n[策略B] 2年内>=10%溢价卖出，否则满2年强制卖: 样本 {len(rs2)}，强制到期 {forced}（{forced/len(rs2)*100:.0f}%）")
    print(f"  年化: 平均 {sum(rs2)/len(rs2)*100:.1f}%, 中位 {q(rs2,.5)*100:.1f}%, p10 {q(rs2,.1)*100:.1f}%, p90 {q(rs2,.9)*100:.1f}%")


if __name__ == "__main__":
    main()
