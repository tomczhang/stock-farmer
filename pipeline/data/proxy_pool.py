"""代理 IP 池管理。

从 PROXY_PROVIDER_URL 获取代理列表，本地做健康检测和轮换。
未配置时降级为直连模式。
"""
from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass, field

import requests

from .types import PROXY_COOLDOWN_SECONDS, PROXY_FAILURE_THRESHOLD, PROXY_REFRESH_INTERVAL

_LOG = logging.getLogger(__name__)


@dataclass
class _ProxyState:
    address: str
    consecutive_failures: int = 0
    unhealthy_since: float | None = None

    @property
    def is_healthy(self) -> bool:
        if self.unhealthy_since is None:
            return True
        return (time.monotonic() - self.unhealthy_since) >= PROXY_COOLDOWN_SECONDS


class ProxyPool:
    def __init__(
        self,
        provider_url: str | None = None,
        refresh_interval: int = PROXY_REFRESH_INTERVAL,
    ) -> None:
        self._provider_url = provider_url or os.getenv("PROXY_PROVIDER_URL", "")
        self._refresh_interval = refresh_interval
        self._proxies: list[_ProxyState] = []
        self._index = 0
        self._last_refresh: float = 0

        if self._provider_url:
            self._refresh()
        else:
            _LOG.warning("No proxy provider configured, using direct connection")

    def _refresh(self) -> None:
        if not self._provider_url:
            return
        try:
            r = requests.get(self._provider_url, timeout=10)
            r.raise_for_status()
            lines = [line.strip() for line in r.text.strip().splitlines() if line.strip()]
            existing = {p.address for p in self._proxies}
            for addr in lines:
                if not addr.startswith("http"):
                    addr = f"http://{addr}"
                if addr not in existing:
                    self._proxies.append(_ProxyState(address=addr))
            self._last_refresh = time.monotonic()
            _LOG.info("Proxy pool refreshed: %d proxies", len(self._proxies))
        except Exception as e:
            _LOG.error("Failed to refresh proxy pool: %s", e)
            if not self._proxies:
                _LOG.warning("No proxies available, falling back to direct connection")

    def _maybe_refresh(self) -> None:
        if not self._provider_url:
            return
        if time.monotonic() - self._last_refresh >= self._refresh_interval:
            self._refresh()

    def get_proxy(self) -> str | None:
        self._maybe_refresh()
        if not self._proxies:
            return None

        checked = 0
        while checked < len(self._proxies):
            proxy = self._proxies[self._index % len(self._proxies)]
            self._index += 1
            checked += 1
            if proxy.is_healthy:
                return proxy.address

        return None

    def report_success(self, address: str) -> None:
        for p in self._proxies:
            if p.address == address:
                p.consecutive_failures = 0
                p.unhealthy_since = None
                return

    def report_failure(self, address: str) -> None:
        for p in self._proxies:
            if p.address == address:
                p.consecutive_failures += 1
                if p.consecutive_failures >= PROXY_FAILURE_THRESHOLD:
                    p.unhealthy_since = time.monotonic()
                    _LOG.warning("Proxy %s marked unhealthy after %d failures",
                                 address, p.consecutive_failures)
                return
