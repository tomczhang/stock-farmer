"""季度 EPS 抓取。

数据源策略（design.md 决策 2 + 13.3 补丁）：
- 港股：东财 `key_indicators_eastmoney`，含 `BASIC_EPS` / `DILUTED_EPS`
- 美股：SEC EDGAR XBRL（详见 `sec_facts.py`），因为东财对美股返回的是 YTD 累计而不是单季度

字段缺失时保留为 None（不要填 0，否则会污染 TTM 求和）。
"""
from __future__ import annotations

from typing import Any

from global_stock_data import key_indicators_eastmoney  # type: ignore

from . import sec_facts
from .ticker_normalize import market_of, to_eastmoney


def _to_float_or_none(v: Any) -> float | None:
    if v is None:
        return None
    if isinstance(v, str) and not v.strip():
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _normalize_period(report_date: Any) -> str | None:
    """REPORT_DATE 可能是 'YYYY-MM-DD HH:MM:SS' / 'YYYY-MM-DD'，统一为 YYYY-MM-DD。"""
    if report_date is None:
        return None
    s = str(report_date).strip()
    if not s:
        return None
    return s.split(" ", 1)[0][:10]


def _candidate_secucodes(ticker: str) -> list[str]:
    """返回该 ticker 在东财上可能用的 secucode 候选列表，按尝试顺序。

    - 港股：单一候选 `00700.HK`
    - 美股：先 NASDAQ (`AAPL.O`) 后 NYSE (`AAPL.N`)，因为科技股居多
    """
    if market_of(ticker) == "HK":
        return [to_eastmoney(ticker)]
    raw = ticker.upper()
    if raw.endswith(".O") or raw.endswith(".N"):
        return [raw]
    return [f"{raw}.O", f"{raw}.N"]


def _ytd_to_single_quarter(rows: list[dict]) -> list[dict]:
    """东财港股的 EPS 是 YTD 累计（REPORT_TYPE='2025/Q1','Q6','Q9','FY'），
    需要按 fiscal year 内的累计差分还原为单季度。

    输入 rows 必须含 `report_type`（已归一化为 'Q1' | 'Q6' | 'Q9' | 'FY'）、
    `fiscal_year` (int)、`period_end` (str)、`eps_basic`、`eps_diluted`、`notice_date`。

    输出 [{period_end, eps_basic, eps_diluted}, ...]，每条都是真正的单季度，按 period_end 升序。
    """
    # 按财年分组，每年最多 4 个 quarter
    by_year: dict[int, dict[str, dict]] = {}
    for r in rows:
        by_year.setdefault(r["fiscal_year"], {})[r["report_type"]] = r

    _ORDER = ["Q1", "Q6", "Q9", "FY"]   # 累计长度 3/6/9/12 月

    def _diff(a: float | None, b: float | None) -> float | None:
        if a is None or b is None:
            return None
        return round(a - b, 4)

    out: list[dict] = []
    for fy, by_type in by_year.items():
        # 按累计长度排序拿到的 cumulative 值
        cum_basic = {t: by_type.get(t, {}).get("eps_basic") for t in _ORDER}
        cum_diluted = {t: by_type.get(t, {}).get("eps_diluted") for t in _ORDER}
        pe = {t: by_type.get(t, {}).get("period_end") for t in _ORDER}
        # 单季差分
        single: list[tuple[str, str, float | None, float | None]] = []
        # Q1 直接是单季
        if pe["Q1"]:
            single.append(("Q1", pe["Q1"], cum_basic["Q1"], cum_diluted["Q1"]))
        # Q2 = Q6 - Q1
        if pe["Q6"]:
            single.append(("Q2", pe["Q6"], _diff(cum_basic["Q6"], cum_basic["Q1"]),
                           _diff(cum_diluted["Q6"], cum_diluted["Q1"])))
        # Q3 = Q9 - Q6
        if pe["Q9"]:
            single.append(("Q3", pe["Q9"], _diff(cum_basic["Q9"], cum_basic["Q6"]),
                           _diff(cum_diluted["Q9"], cum_diluted["Q6"])))
        # Q4 = FY - Q9
        if pe["FY"]:
            single.append(("Q4", pe["FY"], _diff(cum_basic["FY"], cum_basic["Q9"]),
                           _diff(cum_diluted["FY"], cum_diluted["Q9"])))
        for _, p_end, b, d in single:
            out.append({"period_end": p_end, "eps_basic": b, "eps_diluted": d})
    out.sort(key=lambda r: r["period_end"])
    return out


def _normalize_report_type(raw: Any) -> tuple[str | None, int | None]:
    """东财 REPORT_TYPE 形如 '2025/Q1' / '2025/Q6' / '2025/Q9' / '2025/FY'，
    返回 (report_type, fiscal_year)。无法解析则返回 (None, None)。"""
    if raw is None:
        return None, None
    s = str(raw).strip()
    if "/" not in s:
        return None, None
    fy_str, rt = s.split("/", 1)
    try:
        fy = int(fy_str)
    except ValueError:
        return None, None
    rt = rt.strip().upper()
    if rt not in ("Q1", "Q6", "Q9", "FY"):
        return None, None
    return rt, fy


def fetch_quarterly_eps(ticker: str, page_size: int = 40) -> list[dict]:
    """抓取季度 EPS。

    返回 `[{period_end, eps_basic, eps_diluted}, ...]`，按 period_end **升序**，字段缺失保留 None。

    路由：
    - 港股 → 东财 + YTD→单季差分（REPORT_TYPE 标识 Q1/Q6/Q9/FY 是 3/6/9/12 月累计）
    - 美股 → SEC EDGAR XBRL（直接单季度，详见 sec_facts.py）

    `page_size` 仅对港股东财路径生效；SEC 路径返回所有可得历史。
    """
    if market_of(ticker) == "US":
        return sec_facts.fetch_quarterly_eps_sec(ticker)

    raw: list[dict] = []
    for secucode in _candidate_secucodes(ticker):
        raw = key_indicators_eastmoney(secucode, page_size=page_size) or []
        if raw:
            break

    # 第一步：解析为带有 REPORT_TYPE 的中间形态
    parsed: list[dict] = []
    seen: set[tuple[int, str]] = set()
    for item in raw:
        period_end = _normalize_period(item.get("REPORT_DATE"))
        report_type, fiscal_year = _normalize_report_type(item.get("REPORT_TYPE"))
        if not (period_end and report_type and fiscal_year is not None):
            continue
        key = (fiscal_year, report_type)
        if key in seen:
            continue
        seen.add(key)
        parsed.append(
            {
                "period_end": period_end,
                "report_type": report_type,
                "fiscal_year": fiscal_year,
                "eps_basic": _to_float_or_none(item.get("BASIC_EPS")),
                "eps_diluted": _to_float_or_none(item.get("DILUTED_EPS")),
                "notice_date": str(item.get("NOTICE_DATE") or ""),
            }
        )
    # 第二步：YTD 差分 → 单季
    return _ytd_to_single_quarter(parsed)
