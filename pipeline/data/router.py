"""数据源路由与降级。

按数据类型查优先级链，依次尝试 adapter，失败自动 fallback。
含数据源健康追踪和总超时控制。
"""
from __future__ import annotations

import logging
import time
from typing import Any, Callable, TypeVar

from .types import (
    ADAPTER_TIMEOUT,
    HEALTH_COOLDOWN_SECONDS,
    HEALTH_FAILURE_THRESHOLD,
    ROUTER_TOTAL_TIMEOUT,
    SOURCE_PRIORITY,
    AdapterError,
    DataSourceError,
)

_LOG = logging.getLogger(__name__)
T = TypeVar("T")


class _SourceHealth:
    def __init__(self) -> None:
        self.consecutive_failures = 0
        self.unhealthy_since: float | None = None

    @property
    def is_healthy(self) -> bool:
        if self.unhealthy_since is None:
            return True
        return (time.monotonic() - self.unhealthy_since) >= HEALTH_COOLDOWN_SECONDS

    def record_success(self) -> None:
        self.consecutive_failures = 0
        self.unhealthy_since = None

    def record_failure(self) -> None:
        self.consecutive_failures += 1
        if self.consecutive_failures >= HEALTH_FAILURE_THRESHOLD:
            self.unhealthy_since = time.monotonic()


class DataRouter:
    def __init__(self) -> None:
        self._health: dict[str, _SourceHealth] = {}

    def _get_health(self, source: str) -> _SourceHealth:
        if source not in self._health:
            self._health[source] = _SourceHealth()
        return self._health[source]

    def route(
        self,
        data_type: str,
        adapters: dict[str, Callable[..., T]],
        **kwargs: Any,
    ) -> T:
        """按优先级链尝试各 adapter，返回第一个成功的结果。

        Args:
            data_type: SOURCE_PRIORITY 中的 key (e.g. "quote", "kline_daily")
            adapters: {source_name: callable} 映射
            **kwargs: 传递给每个 adapter callable 的参数
        """
        chain = SOURCE_PRIORITY.get(data_type, [])
        if not chain:
            raise DataSourceError(data_type, [
                AdapterError("router", f"no priority chain for data_type={data_type}")
            ])

        errors: list[AdapterError] = []
        t0 = time.monotonic()

        for source in chain:
            if source not in adapters:
                continue

            health = self._get_health(source)
            if not health.is_healthy:
                _LOG.debug("Skipping unhealthy source %s for %s", source, data_type)
                continue

            elapsed = time.monotonic() - t0
            if elapsed >= ROUTER_TOTAL_TIMEOUT:
                errors.append(AdapterError("router", "total timeout exceeded"))
                break

            remaining = ROUTER_TOTAL_TIMEOUT - elapsed
            timeout = min(ADAPTER_TIMEOUT, remaining)
            try:
                result = adapters[source](timeout=timeout, **kwargs)
                health.record_success()
                return result
            except (AdapterError, Exception) as e:
                err = e if isinstance(e, AdapterError) else AdapterError(source, str(e))
                errors.append(err)
                health.record_failure()
                _LOG.warning("Source %s failed for %s: %s", source, data_type, err)

        raise DataSourceError(data_type, errors)
