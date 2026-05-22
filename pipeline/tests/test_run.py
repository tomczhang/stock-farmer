"""run.py 单测：聚焦 live_snapshot 备份写入逻辑。

mock fetch_current_pe 和 D1 client，验证：
1. sanity check 调用 update_last_fetched 写 data_type='live_snapshot'
2. live_snapshot 的 JSON 字段齐全（snapshot_at / pe_ttm / current_price / eps_ttm / source）
3. 即使本地 pe_series 为空（无法做 PE 对比），也要写 live snapshot
"""
from __future__ import annotations

import json

import pytest

import run


class FakeClient:
    """伪 D1Client：record execute 调用、控制 query 返回。"""

    def __init__(self, pe_series_rows: list[dict] | None = None) -> None:
        self.executed: list[tuple[str, list]] = []
        self._pe_series_rows = pe_series_rows or []

    def execute(self, sql: str, params: list | None = None) -> dict:
        self.executed.append((sql, params or []))
        return {}

    def query(self, sql: str, params: list | None = None) -> list[dict]:
        # 仅 sanity check 用 query 读 pe_series 最新一行
        if "FROM pe_series" in sql:
            return list(self._pe_series_rows)
        return []


def _find_live_snapshot_call(client: FakeClient) -> tuple[str, list] | None:
    """从 execute 历史里找到写 live_snapshot 的那条 INSERT。"""
    for sql, params in client.executed:
        if "INSERT OR REPLACE INTO fetch_log" in sql and "live_snapshot" in params:
            return sql, params
    return None


def test_sanity_check_writes_live_snapshot_when_local_pe_present(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """正常路径：quote 拿到、本地 pe_series 有数据 → 写 live_snapshot + 比对 sanity。"""
    fake_quote = {
        "pe_ttm": 36.5,
        "pe_lyr": 40.0,
        "pe_forecast": 35.0,
        "current_price": 305.0,
        "eps_ttm": 8.36,
    }
    monkeypatch.setattr(run, "fetch_current_pe", lambda _t: fake_quote)

    client = FakeClient(pe_series_rows=[{"pe_ttm": 36.4}])
    run._sanity_check_xueqiu(client, "AAPL")

    call = _find_live_snapshot_call(client)
    assert call is not None, "expected an INSERT into fetch_log with live_snapshot"
    sql, params = call
    # params 顺序：[ticker, data_type, last_fetched_at, last_data_date, last_error, last_warning]
    assert params[0] == "AAPL"
    assert params[1] == "live_snapshot"
    # warning 字段是 JSON 字符串
    payload = json.loads(params[5])
    assert payload["pe_ttm"] == 36.5
    assert payload["current_price"] == 305.0
    assert payload["eps_ttm"] == 8.36
    assert payload["source"] == "xueqiu"
    assert "snapshot_at" in payload and payload["snapshot_at"].endswith("Z")


def test_sanity_check_writes_live_snapshot_even_when_local_pe_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """关键：本地 pe_series 空（首次回填还没跑完）也要写 live_snapshot 做备份。"""
    fake_quote = {
        "pe_ttm": 36.5,
        "current_price": 305.0,
        "eps_ttm": 8.36,
    }
    monkeypatch.setattr(run, "fetch_current_pe", lambda _t: fake_quote)

    client = FakeClient(pe_series_rows=[])  # 本地无 PE
    run._sanity_check_xueqiu(client, "AAPL")

    call = _find_live_snapshot_call(client)
    assert call is not None, "live_snapshot should be written even when local pe_series is empty"
    payload = json.loads(call[1][5])
    assert payload["pe_ttm"] == 36.5


def test_sanity_check_skips_snapshot_when_quote_fetch_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """fetch_current_pe 抛错时直接返回，不写 snapshot（没数据写也无意义）。"""
    def boom(_t):
        raise RuntimeError("xueqiu down")

    monkeypatch.setattr(run, "fetch_current_pe", boom)

    client = FakeClient()
    run._sanity_check_xueqiu(client, "AAPL")

    assert _find_live_snapshot_call(client) is None
    # 也不应该有任何 INSERT 进 fetch_log
    assert all(
        "INSERT OR REPLACE INTO fetch_log" not in sql for sql, _ in client.executed
    )


def test_live_snapshot_json_fields_complete(monkeypatch: pytest.MonkeyPatch) -> None:
    """显式校验 live_snapshot JSON 的全部字段，对齐 Workers 降级读取协议。"""
    fake_quote = {
        "pe_ttm": 28.1,
        "current_price": 142.3,
        "eps_ttm": 5.06,
    }
    monkeypatch.setattr(run, "fetch_current_pe", lambda _t: fake_quote)

    client = FakeClient(pe_series_rows=[])
    run._write_live_snapshot(client, "0700.HK", fake_quote)

    call = _find_live_snapshot_call(client)
    assert call is not None
    sql, params = call
    assert params[1] == "live_snapshot"
    # last_data_date 应是 ISO date
    assert params[3] is not None and len(params[3]) == 10  # YYYY-MM-DD
    payload = json.loads(params[5])
    assert set(payload.keys()) == {
        "snapshot_at",
        "pe_ttm",
        "current_price",
        "eps_ttm",
        "source",
    }
