"""513100 波段回测：0溢价买入 -> >=10%溢价卖出（策略A不限期 / 策略B最多持有2年）。"""
import sys
import time
import types
from collections import Counter
from datetime import date
from pathlib import Path

import requests
import urllib3

urllib3.disable_warnings()
sys.path.insert(0, str(Path(__file__).parent))

# 本机 whistle 代理会把 push2his 接口搞挂，用绕过系统代理的会话 + 重试
_session = requests.Session()
_session.trust_env = False


def _get_retry(url, **kw):
    for attempt in range(5):
        try:
            r = _session.get(url, **kw)
            if r.status_code == 200:
                return r
        except requests.RequestException:
            pass
        time.sleep(2 + 3 * attempt)
    raise RuntimeError(f"fetch failed after retries: {url[:80]}")


import premium_513100 as _pm  # noqa: E402
import ret_513100_zero_premium as _rz  # noqa: E402

_patched = types.SimpleNamespace(get=_get_retry)
_pm.requests = _patched
_rz.requests = _patched
fetch_close, fetch_nav = _pm.fetch_close, _pm.fetch_nav
fetch_close_adj = _rz.fetch_close_adj


def yrs(a: str, b: str) -> float:
    return (date.fromisoformat(b) - date.fromisoformat(a)).days / 365.25


def main() -> None:
    cache = Path(__file__).parent / "swing_513100_east_cache.json"
    if cache.exists():
        import json
        d = json.loads(cache.read_text())
        nav, px, adj = d["nav"], d["px"], d["adj"]
        print(f"[缓存] {cache.name}")
    else:
        nav = fetch_nav("513100")
        px = fetch_close("1.513100", beg="20130101")
        adj = fetch_close_adj("1.513100")
        import json
        cache.write_text(json.dumps({"nav": nav, "px": px, "adj": adj}))
        print(f"[已缓存到] {cache.name}")
    days = sorted(set(nav) & set(px) & set(adj))
    prem = {d: px[d] / nav[d] - 1 for d in days}
    idx = {d: i for i, d in enumerate(days)}

    hi = [d for d in days if prem[d] >= 0.10]
    print(f"溢价>=10% 的交易日共 {len(hi)} 天，按年分布: {dict(Counter(d[:4] for d in hi))}")
    print(f"最早一次: {hi[0] if hi else '无'}")

    buys = [d for d in days if prem[d] <= 0.0]
    print(f"0溢价买点 {len(buys)} 个")

    # 策略A: 卖在此后第一个>=10%溢价日（不限期限）
    sold, unsold = [], 0
    for d in buys:
        s = next((x for x in days[idx[d] + 1:] if prem[x] >= 0.10), None)
        if s is None:
            unsold += 1
            continue
        h = yrs(d, s)
        sold.append((d, s, h, (adj[s] / adj[d]) ** (1 / h) - 1))
    print(f"\n[策略A] 等到>=10%溢价才卖: 成交 {len(sold)}，至今没等到 {unsold}")
    if sold:
        hs = sorted(x[2] for x in sold)
        rs = sorted(x[3] for x in sold)
        q = lambda a, p: a[min(len(a) - 1, int(p * len(a)))]
        print(f"  持有期: 中位 {q(hs,.5):.1f} 年, p10 {q(hs,.1):.1f}, p90 {q(hs,.9):.1f}, 最短 {hs[0]:.2f}, 最长 {hs[-1]:.1f}")
        print(f"  年化: 平均 {sum(rs)/len(rs)*100:.1f}%, 中位 {q(rs,.5)*100:.1f}%, p10 {q(rs,.1)*100:.1f}%, p90 {q(rs,.9)*100:.1f}%")
        within2 = sum(1 for x in sold if x[2] <= 2)
        print(f"  2年内等到10%溢价的买点: {within2}/{len(buys)}（{within2/len(buys)*100:.1f}%）")

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
        rs2.append((adj[s] / adj[d]) ** (1 / h) - 1)
    rs2.sort()
    q = lambda a, p: a[min(len(a) - 1, int(p * len(a)))]
    print(f"\n[策略B] 2年内>=10%溢价卖出，否则满2年强制卖: 样本 {len(rs2)}，强制到期卖 {forced}（{forced/len(rs2)*100:.0f}%）")
    print(f"  年化: 平均 {sum(rs2)/len(rs2)*100:.1f}%, 中位 {q(rs2,.5)*100:.1f}%, p10 {q(rs2,.1)*100:.1f}%, p90 {q(rs2,.9)*100:.1f}%")


if __name__ == "__main__":
    main()
