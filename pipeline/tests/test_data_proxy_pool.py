"""代理池测试（轮换、健康标记、冷却恢复）。"""
from __future__ import annotations

import time
from unittest.mock import patch

from data.proxy_pool import ProxyPool


class TestProxyPool:
    def test_no_provider_returns_none(self):
        pool = ProxyPool(provider_url="")
        assert pool.get_proxy() is None

    def test_rotation(self):
        pool = ProxyPool(provider_url="")
        # Manually inject proxies
        from data.proxy_pool import _ProxyState
        pool._proxies = [
            _ProxyState(address="http://a:1"),
            _ProxyState(address="http://b:2"),
            _ProxyState(address="http://c:3"),
        ]
        results = [pool.get_proxy() for _ in range(6)]
        assert results == [
            "http://a:1", "http://b:2", "http://c:3",
            "http://a:1", "http://b:2", "http://c:3",
        ]

    def test_unhealthy_proxy_skipped(self):
        pool = ProxyPool(provider_url="")
        from data.proxy_pool import _ProxyState
        pool._proxies = [
            _ProxyState(address="http://a:1"),
            _ProxyState(address="http://b:2"),
        ]
        # Mark b as unhealthy
        for _ in range(3):
            pool.report_failure("http://b:2")

        results = [pool.get_proxy() for _ in range(3)]
        assert all(r == "http://a:1" for r in results)

    def test_success_resets_failure_count(self):
        pool = ProxyPool(provider_url="")
        from data.proxy_pool import _ProxyState
        pool._proxies = [_ProxyState(address="http://a:1")]

        pool.report_failure("http://a:1")
        pool.report_failure("http://a:1")
        pool.report_success("http://a:1")

        assert pool._proxies[0].consecutive_failures == 0
        assert pool.get_proxy() == "http://a:1"

    def test_cooldown_recovery(self):
        pool = ProxyPool(provider_url="")
        from data.proxy_pool import _ProxyState
        pool._proxies = [_ProxyState(address="http://a:1")]

        for _ in range(3):
            pool.report_failure("http://a:1")
        assert pool.get_proxy() is None  # unhealthy

        # Simulate cooldown elapsed
        pool._proxies[0].unhealthy_since = time.monotonic() - 200
        assert pool.get_proxy() == "http://a:1"

    def test_all_unhealthy_returns_none(self):
        pool = ProxyPool(provider_url="")
        from data.proxy_pool import _ProxyState
        pool._proxies = [
            _ProxyState(address="http://a:1"),
            _ProxyState(address="http://b:2"),
        ]
        for addr in ["http://a:1", "http://b:2"]:
            for _ in range(3):
                pool.report_failure(addr)
        assert pool.get_proxy() is None
