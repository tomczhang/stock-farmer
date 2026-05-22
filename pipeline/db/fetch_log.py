"""fetch_log 表的读写。

行结构：(ticker, data_type, last_fetched_at, last_data_date, last_error, last_warning)
data_type ∈ {'prices', 'eps', 'pe_series', 'full_refresh'}
"""
from __future__ import annotations

from datetime import datetime, timezone

from .d1_client import D1Client


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def get_last_fetched(client: D1Client, ticker: str, data_type: str) -> dict | None:
    sql = (
        "SELECT ticker, data_type, last_fetched_at, last_data_date, "
        "last_error, last_warning FROM fetch_log "
        "WHERE ticker = ? AND data_type = ?"
    )
    rows = client.query(sql, [ticker, data_type])
    if not rows:
        return None
    return rows[0]


def update_last_fetched(
    client: D1Client,
    ticker: str,
    data_type: str,
    last_data_date: str | None = None,
    error: str | None = None,
    warning: str | None = None,
) -> None:
    """upsert 一条 fetch_log。"""
    sql = (
        "INSERT OR REPLACE INTO fetch_log "
        "(ticker, data_type, last_fetched_at, last_data_date, last_error, last_warning) "
        "VALUES (?, ?, ?, ?, ?, ?)"
    )
    client.execute(
        sql,
        [ticker, data_type, _now_iso(), last_data_date, error, warning],
    )


def get_last_full_refresh(client: D1Client, ticker: str) -> datetime | None:
    """读 fetch_log[data_type='full_refresh'] 的 last_fetched_at，解析为 UTC datetime。"""
    row = get_last_fetched(client, ticker, "full_refresh")
    if not row:
        return None
    ts = row.get("last_fetched_at")
    if not ts:
        return None
    try:
        # 兼容带 Z / 不带 Z 的 ISO 8601
        s = str(ts).replace("Z", "+00:00")
        return datetime.fromisoformat(s)
    except ValueError:
        return None


def mark_full_refresh(client: D1Client, ticker: str) -> None:
    update_last_fetched(client, ticker, "full_refresh", last_data_date=None)
