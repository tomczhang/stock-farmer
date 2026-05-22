"""美股 EPS 数据：SEC EDGAR XBRL。

为什么不用 `global-stock-data` 里的 `sec_xbrl_facts`：
该函数丢掉了 `start` 字段，我们需要它来区分单季度（end-start ≈ 90 天）和
YTD 累计（end-start ≈ 180/270 天）。所以本模块直接调 SEC API。

SEC 接口约束：
- 必须带 User-Agent 标识身份（否则 403）
- 速率限制 10 req/s（我们一只股票才 2 个请求，远远不会触发）
- ticker→CIK 映射文件：https://www.sec.gov/files/company_tickers.json
- 单公司 facts: https://data.sec.gov/api/xbrl/companyfacts/CIK{10位补零}.json

EPS 单季度推导：
- 10-Q 单季度: end-start ∈ [85, 95] 天 → 直接是 Q1/Q2/Q3 单季 EPS
- 10-K 全年: end-start ∈ [360, 370] 天 → 全年 EPS
- Q4 不会单独出现在 10-Q，需要推导：Q4 = Annual_FY - (Q1 + Q2 + Q3)_FY
"""
from __future__ import annotations

import os
from datetime import date
from typing import Any

import requests

# SEC EDGAR 强制要求 User-Agent 标识"组织 + 联系邮箱"格式，可通过环境变量覆盖
_USER_AGENT = os.getenv("SEC_USER_AGENT", "stock-farmer dev contact@example.com")
_HEADERS = {
    "User-Agent": _USER_AGENT,
    "Accept": "application/json",
    "Accept-Encoding": "gzip, deflate",
    "Host": "data.sec.gov",  # 部分 SEC 端点需要明确 Host 头
}


def _headers_for(url: str) -> dict[str, str]:
    """Host 头要按目标域名设置，否则部分边缘节点返回 403。"""
    if "www.sec.gov" in url:
        return {**_HEADERS, "Host": "www.sec.gov"}
    return _HEADERS

_TICKER_MAP_URL = "https://www.sec.gov/files/company_tickers.json"
_COMPANY_FACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json"

# 模块级缓存：第一次调用时拉一次 ticker→CIK 全表，后续 lookup 走内存
_TICKER_TO_CIK: dict[str, str] | None = None


def _load_ticker_map(session: requests.Session | None = None) -> dict[str, str]:
    """加载 SEC 全市场 ticker→CIK 映射（约 10000 家美股公司）。"""
    s = session or requests.Session()
    r = s.get(_TICKER_MAP_URL, headers=_headers_for(_TICKER_MAP_URL), timeout=30)
    r.raise_for_status()
    data = r.json()
    return {
        v["ticker"].upper(): str(v["cik_str"]).zfill(10)
        for v in data.values()
    }


def get_cik(ticker: str, session: requests.Session | None = None) -> str | None:
    """ticker → 10 位补零 CIK；未在 SEC 注册则返回 None（如 ADR、退市股）。"""
    global _TICKER_TO_CIK
    if _TICKER_TO_CIK is None:
        _TICKER_TO_CIK = _load_ticker_map(session)
    return _TICKER_TO_CIK.get(ticker.upper())


def _fetch_company_facts(cik: str, session: requests.Session | None = None) -> dict:
    s = session or requests.Session()
    url = _COMPANY_FACTS_URL.format(cik=cik)
    r = s.get(url, headers=_headers_for(url), timeout=30)
    r.raise_for_status()
    return r.json()


def _is_single_quarter(entry: dict) -> bool:
    """end-start ∈ [85, 100] 天视为单季度。

    上界 100 是为了覆盖偶发的"长季度"——美股财年用 52/53 周制，每 5-6 年会出现
    一个 97-98 天的 Q1（AAPL FY2023 Q1 = 2022-09-25 → 2022-12-31 = 97 天）。
    半年 YTD 最短 181 天，所以 100 仍能安全排除 YTD。
    """
    s, e = entry.get("start"), entry.get("end")
    if not (s and e):
        return False
    try:
        days = (date.fromisoformat(e) - date.fromisoformat(s)).days
    except ValueError:
        return False
    return 85 <= days <= 100


def _is_full_year(entry: dict) -> bool:
    """end-start ≈ 365 天且 form='10-K' 即视为全年。"""
    if entry.get("form") != "10-K":
        return False
    s, e = entry.get("start"), entry.get("end")
    if not (s and e):
        return False
    try:
        days = (date.fromisoformat(e) - date.fromisoformat(s)).days
    except ValueError:
        return False
    return 350 <= days <= 380


def _dedupe_keep_latest_filed(entries: list[dict]) -> list[dict]:
    """同一 end 日期会被多次 restated，保留 filed 最新的那条。"""
    by_end: dict[str, dict] = {}
    for e in entries:
        end = e.get("end")
        if not end:
            continue
        prev = by_end.get(end)
        if prev is None or (e.get("filed") or "") > (prev.get("filed") or ""):
            by_end[end] = e
    return list(by_end.values())


def _extract_eps_series(facts: dict, metric_name: str) -> dict[str, list[dict]]:
    """提取一个 EPS metric 的单季度 + 全年序列。返回 {"single_q": [...], "annual": [...]}"""
    us_gaap = (facts.get("facts") or {}).get("us-gaap") or {}
    metric = us_gaap.get(metric_name) or {}
    units = metric.get("units") or {}
    # EPS 单位都是 "USD/shares"
    entries = units.get("USD/shares") or []

    single_q = _dedupe_keep_latest_filed(
        [e for e in entries if e.get("form") == "10-Q" and _is_single_quarter(e)]
    )
    annual = _dedupe_keep_latest_filed(
        [e for e in entries if _is_full_year(e)]
    )
    single_q.sort(key=lambda e: e["end"])
    annual.sort(key=lambda e: e["end"])
    return {"single_q": single_q, "annual": annual}


def _derive_q4_from_annual(
    single_q: list[dict], annual: list[dict]
) -> list[dict]:
    """对每个 10-K 全年值，推导 Q4 单季 = Annual - (Q1+Q2+Q3) 同财年。

    匹配方法：用全年的 `start`/`end` 日期范围圈定 Q1/Q2/Q3，不依赖 `fy` 字段
    （`fy` 在 SEC XBRL 里指的是**填报 10-K 时所处的财政年度**，不是该数据点本身
    所属的财年；同一 period_end 可能被多个 fy 引用为"当期 / 比较期"）。

    若该财年缺少完整 Q1/Q2/Q3，则跳过。
    """
    derived_q4: list[dict] = []
    for ann in annual:
        a_start, a_end = ann.get("start"), ann.get("end")
        if not (a_start and a_end):
            continue
        # 该财年内的所有单季度（start ≥ 财年开始 且 end ≤ 财年结束）
        quarters_in_year = [
            q for q in single_q
            if q.get("start") and q.get("end")
            and q["start"] >= a_start and q["end"] <= a_end
        ]
        # 按 end 去重 (同一日期可能被不同 10-Q 重述，保留 filed 最新的)
        quarters_in_year = _dedupe_keep_latest_filed(quarters_in_year)
        if len(quarters_in_year) < 3:
            continue  # 缺数据，跳过
        # 严格取最早的 3 个（Q1/Q2/Q3，Q4 是我们要推导的）
        first_three = sorted(quarters_in_year, key=lambda e: e["end"])[:3]
        q4_val = ann["val"] - sum(q["val"] for q in first_three)
        derived_q4.append(
            {
                "end": ann["end"],
                # 浮点减法误差大，统一保留 4 位小数（覆盖 EPS 实际精度）
                "val": round(q4_val, 4),
                "form": "DERIVED",
                "filed": ann.get("filed"),
                "fy": ann.get("fy"),
                "fp": "Q4",
            }
        )
    return derived_q4


def _merge_to_quarterly(
    diluted: dict[str, list[dict]],
    basic: dict[str, list[dict]],
) -> list[dict]:
    """把 diluted + basic 的单季度 + 推导 Q4 合并为 [{period_end, eps_basic, eps_diluted}]，升序。"""
    diluted_all = diluted["single_q"] + _derive_q4_from_annual(
        diluted["single_q"], diluted["annual"]
    )
    basic_all = basic["single_q"] + _derive_q4_from_annual(
        basic["single_q"], basic["annual"]
    )

    by_end: dict[str, dict] = {}
    for e in diluted_all:
        by_end.setdefault(e["end"], {"period_end": e["end"]})["eps_diluted"] = e["val"]
    for e in basic_all:
        by_end.setdefault(e["end"], {"period_end": e["end"]})["eps_basic"] = e["val"]

    rows = list(by_end.values())
    for r in rows:
        r.setdefault("eps_basic", None)
        r.setdefault("eps_diluted", None)
    rows.sort(key=lambda r: r["period_end"])
    return rows


def fetch_quarterly_eps_sec(
    ticker: str, session: requests.Session | None = None
) -> list[dict]:
    """主入口：拿一只美股的真正单季度 EPS（含 Q4 推导）。

    返回 [{period_end, eps_basic, eps_diluted}, ...] 升序。
    若 ticker 不在 SEC 数据库（如 ADR / 仅 OTC），返回空列表。
    """
    cik = get_cik(ticker, session=session)
    if cik is None:
        return []
    facts = _fetch_company_facts(cik, session=session)
    diluted = _extract_eps_series(facts, "EarningsPerShareDiluted")
    basic = _extract_eps_series(facts, "EarningsPerShareBasic")
    return _merge_to_quarterly(diluted, basic)
