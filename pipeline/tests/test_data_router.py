"""Router failover 逻辑测试。"""
from __future__ import annotations

import pytest
import pandas as pd

import data
from data.router import DataRouter
from data.types import AdapterError, DataSourceError, SOURCE_PRIORITY


def _minute_df(days: int) -> pd.DataFrame:
    rows = []
    for day in range(days):
        date = f"2026-01-{day + 1:02d}"
        rows.append({
            "date": f"{date} 09:35",
            "open": 100.0,
            "high": 101.0,
            "low": 99.0,
            "close": 100.5,
            "volume": 1000,
        })
    return pd.DataFrame(rows)


class TestDataRouter:
    def test_first_source_succeeds(self):
        router = DataRouter()
        result = router.route(
            "quote",
            {
                "eastmoney": lambda timeout, **_: ["quote_from_em"],
                "sina": lambda timeout, **_: ["quote_from_sina"],
            },
        )
        assert result == ["quote_from_em"]

    def test_fallback_on_failure(self):
        router = DataRouter()
        result = router.route(
            "quote",
            {
                "eastmoney": lambda timeout, **_: (_ for _ in ()).throw(
                    AdapterError("eastmoney", "timeout")),
                "sina": lambda timeout, **_: ["quote_from_sina"],
            },
        )
        assert result == ["quote_from_sina"]

    def test_all_fail_raises_data_source_error(self):
        router = DataRouter()
        with pytest.raises(DataSourceError, match="quote"):
            router.route(
                "quote",
                {
                    "eastmoney": lambda timeout, **_: (_ for _ in ()).throw(
                        AdapterError("eastmoney", "fail")),
                    "sina": lambda timeout, **_: (_ for _ in ()).throw(
                        AdapterError("sina", "fail")),
                },
            )

    def test_unhealthy_source_skipped(self):
        router = DataRouter()
        call_count = {"em": 0}

        def em_fail(timeout, **_):
            call_count["em"] += 1
            raise AdapterError("eastmoney", "fail")

        # Fail 3 times to mark unhealthy
        for _ in range(3):
            try:
                router.route("quote", {
                    "eastmoney": em_fail,
                    "sina": lambda timeout, **_: ["sina"],
                })
            except DataSourceError:
                pass

        call_count["em"] = 0
        result = router.route("quote", {
            "eastmoney": em_fail,
            "sina": lambda timeout, **_: ["sina_after_skip"],
        })
        assert result == ["sina_after_skip"]
        assert call_count["em"] == 0  # eastmoney was skipped

    def test_minute_priority_includes_yahoo_fallback(self):
        assert SOURCE_PRIORITY["kline_minute"] == ["eastmoney", "xueqiu", "yahoo"]

    def test_get_klines_minute_falls_back_when_window_too_short(self, monkeypatch):
        calls = {"em": 0, "xq": 0, "yahoo": 0}

        monkeypatch.setattr(data, "_router", lambda: DataRouter())

        class ProxyPool:
            def get_proxy(self):
                return None

            def report_success(self, proxy):
                pass

            def report_failure(self, proxy):
                pass

        monkeypatch.setattr(data, "_proxy_pool", lambda: ProxyPool())

        def em_fetch(*args, **kwargs):
            calls["em"] += 1
            return _minute_df(22)

        def xq_fetch(*args, **kwargs):
            calls["xq"] += 1
            return _minute_df(22)

        def yahoo_fetch(*args, **kwargs):
            calls["yahoo"] += 1
            return _minute_df(60)

        monkeypatch.setattr(data.eastmoney, "fetch_klines", em_fetch)
        monkeypatch.setattr(data.xueqiu, "fetch_klines", xq_fetch)
        monkeypatch.setattr(data.yahoo, "fetch_klines", yahoo_fetch)

        df = data.get_klines("0700.HK", period="5m", count=4680)

        assert len({value.split()[0] for value in df["date"]}) == 60
        assert calls == {"em": 1, "xq": 1, "yahoo": 1}

    def test_get_klines_minute_returns_best_short_window_when_yahoo_fails(self, monkeypatch):
        monkeypatch.setattr(data, "_router", lambda: DataRouter())

        class ProxyPool:
            def get_proxy(self):
                return None

            def report_success(self, proxy):
                pass

            def report_failure(self, proxy):
                pass

        monkeypatch.setattr(data, "_proxy_pool", lambda: ProxyPool())
        monkeypatch.setattr(data.eastmoney, "fetch_klines", lambda *args, **kwargs: _minute_df(22))
        monkeypatch.setattr(data.xueqiu, "fetch_klines", lambda *args, **kwargs: _minute_df(20))
        monkeypatch.setattr(
            data.yahoo,
            "fetch_klines",
            lambda *args, **kwargs: (_ for _ in ()).throw(AdapterError("yahoo", "rate limited")),
        )

        df = data.get_klines("0700.HK", period="5m", count=4680)

        assert len({value.split()[0] for value in df["date"]}) == 22
