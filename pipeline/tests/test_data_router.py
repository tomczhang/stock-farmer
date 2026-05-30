"""Router failover 逻辑测试。"""
from __future__ import annotations

import pytest

from data.router import DataRouter
from data.types import AdapterError, DataSourceError, SOURCE_PRIORITY


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
