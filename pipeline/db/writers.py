"""业务写表（idempotent upsert，design.md 决策 8）。

所有写入都用 INSERT OR REPLACE，幂等。
按 500 行一个 chunk 调 D1Client.batch（避免单 chunk SQL 太大）。
"""
from __future__ import annotations

from typing import Iterable

from .d1_client import D1Client

_BATCH_ROWS = 500


def _chunks(seq: list, n: int) -> Iterable[list]:
    for i in range(0, len(seq), n):
        yield seq[i : i + n]


def upsert_prices(client: D1Client, ticker: str, rows: list[dict]) -> int:
    """写入 prices 表。rows: [{date, close_adj}, ...]"""
    if not rows:
        return 0
    sql = "INSERT OR REPLACE INTO prices (ticker, date, close_adj) VALUES (?, ?, ?)"
    written = 0
    for batch in _chunks(rows, _BATCH_ROWS):
        statements = [
            {"sql": sql, "params": [ticker, r["date"], r["close_adj"]]} for r in batch
        ]
        client.batch(statements)
        written += len(batch)
    return written


def upsert_eps_quarterly(client: D1Client, ticker: str, rows: list[dict]) -> int:
    """写入 eps_quarterly 表。rows: [{period_end, eps_basic, eps_diluted, fetched_at?}, ...]"""
    if not rows:
        return 0
    sql = (
        "INSERT OR REPLACE INTO eps_quarterly "
        "(ticker, period_end, eps_basic, eps_diluted, fetched_at) "
        "VALUES (?, ?, ?, ?, ?)"
    )
    written = 0
    for batch in _chunks(rows, _BATCH_ROWS):
        statements = [
            {
                "sql": sql,
                "params": [
                    ticker,
                    r["period_end"],
                    r.get("eps_basic"),
                    r.get("eps_diluted"),
                    r.get("fetched_at"),
                ],
            }
            for r in batch
        ]
        client.batch(statements)
        written += len(batch)
    return written


def upsert_pe_series(client: D1Client, ticker: str, rows: list[dict]) -> int:
    """写入 pe_series。亏损段（is_loss=True 或 pe_ttm=None）的 pe_ttm 一律存 NULL。"""
    if not rows:
        return 0
    sql = (
        "INSERT OR REPLACE INTO pe_series "
        "(ticker, date, pe_ttm, percentile_5y, percentile_10y, percentile_all, is_loss) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    written = 0
    for batch in _chunks(rows, _BATCH_ROWS):
        statements = []
        for r in batch:
            is_loss = bool(r.get("is_loss"))
            pe_ttm = r.get("pe_ttm")
            # 亏损 / 无效情况下 pe 与所有 percentile 都写 NULL（决策 5）
            if is_loss or pe_ttm is None:
                pe_ttm = None
                p5 = p10 = pall = None
            else:
                p5 = r.get("percentile_5y")
                p10 = r.get("percentile_10y")
                pall = r.get("percentile_all")
            statements.append(
                {
                    "sql": sql,
                    "params": [
                        ticker,
                        r["date"],
                        pe_ttm,
                        p5,
                        p10,
                        pall,
                        1 if is_loss else 0,
                    ],
                }
            )
        client.batch(statements)
        written += len(batch)
    return written


# ---------- 读 ----------

def load_prices(client: D1Client, ticker: str) -> list[dict]:
    """读取该 ticker 的全部价格行，按 date 升序。"""
    sql = "SELECT date, close_adj FROM prices WHERE ticker = ? ORDER BY date ASC"
    return [
        {"date": r["date"], "close_adj": float(r["close_adj"])}
        for r in client.query(sql, [ticker])
    ]


def load_eps_quarterly(client: D1Client, ticker: str) -> list[dict]:
    """读取该 ticker 的全部季度 EPS 行，按 period_end 升序。"""
    sql = (
        "SELECT period_end, eps_basic, eps_diluted FROM eps_quarterly "
        "WHERE ticker = ? ORDER BY period_end ASC"
    )
    rows = client.query(sql, [ticker])
    out: list[dict] = []
    for r in rows:
        out.append(
            {
                "period_end": r["period_end"],
                "eps_basic": r.get("eps_basic"),
                "eps_diluted": r.get("eps_diluted"),
            }
        )
    return out


def load_watchlist(client: D1Client, market: str | None = None) -> list[dict]:
    """读 watchlist。market=None 全量；否则按 market 过滤。"""
    if market:
        sql = "SELECT ticker, market FROM watchlist WHERE market = ? ORDER BY ticker"
        rows = client.query(sql, [market.upper()])
    else:
        sql = "SELECT ticker, market FROM watchlist ORDER BY ticker"
        rows = client.query(sql)
    return [{"ticker": r["ticker"], "market": r["market"]} for r in rows]
