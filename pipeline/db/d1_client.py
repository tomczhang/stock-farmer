"""Cloudflare D1 REST API 客户端。

环境变量：
- CLOUDFLARE_API_TOKEN
- CLOUDFLARE_ACCOUNT_ID
- D1_DATABASE_ID
- D1_DRY_RUN=1  # 打印 SQL 不执行，便于本地开发

D1 query API 文档：
https://developers.cloudflare.com/api/operations/cloudflare-d1-query-database
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any

import requests

_LOG = logging.getLogger(__name__)

# 单次 HTTPS 请求里所有 SQL 字符串拼起来的最大长度（保守值）。
# D1 单请求限制 ~1MB 但还要给 params/headers/JSON overhead 留位置。
_MAX_BATCH_SQL_BYTES = 100 * 1024


class D1Error(RuntimeError):
    """D1 调用失败统一抛这个异常。"""


class D1Client:
    def __init__(
        self,
        account_id: str | None = None,
        database_id: str | None = None,
        api_token: str | None = None,
        dry_run: bool | None = None,
        session: requests.Session | None = None,
    ) -> None:
        self.account_id = account_id or os.getenv("CLOUDFLARE_ACCOUNT_ID", "")
        self.database_id = database_id or os.getenv("D1_DATABASE_ID", "")
        self.api_token = api_token or os.getenv("CLOUDFLARE_API_TOKEN", "")
        if dry_run is None:
            dry_run = os.getenv("D1_DRY_RUN", "").strip() in ("1", "true", "True", "yes")
        self.dry_run = dry_run
        self._session = session or requests.Session()

        if not self.dry_run and not (self.account_id and self.database_id and self.api_token):
            raise D1Error(
                "D1Client missing credentials: set CLOUDFLARE_API_TOKEN, "
                "CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID or enable D1_DRY_RUN=1"
            )

    # ---------- HTTP ----------

    @property
    def _url(self) -> str:
        return (
            f"https://api.cloudflare.com/client/v4/accounts/{self.account_id}"
            f"/d1/database/{self.database_id}/query"
        )

    @property
    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_token}",
            "Content-Type": "application/json",
        }

    def _post(self, payload: dict | list) -> Any:
        if self.dry_run:
            _LOG.info("[D1 dry-run] %s", json.dumps(payload, ensure_ascii=False)[:500])
            return []
        try:
            r = self._session.post(
                self._url,
                headers=self._headers,
                data=json.dumps(payload),
                timeout=60,
            )
        except requests.RequestException as e:
            raise D1Error(f"D1 HTTP error: {e}") from e
        if not r.ok:
            raise D1Error(f"D1 HTTP {r.status_code}: {r.text[:500]}")
        body = r.json()
        if not body.get("success"):
            raise D1Error(f"D1 error: {body.get('errors')!r}")
        return body.get("result", [])

    # ---------- public API ----------

    def execute(self, sql: str, params: list | None = None) -> dict:
        """执行一条 SQL，返回 D1 API 的 result[0]。"""
        payload = {"sql": sql, "params": params or []}
        result = self._post(payload)
        return result[0] if result else {}

    def query(self, sql: str, params: list | None = None) -> list[dict]:
        """执行一条 SELECT，返回 rows。"""
        result = self.execute(sql, params)
        if isinstance(result, dict):
            return result.get("results", []) or []
        return []

    def batch(self, statements: list[dict]) -> list[dict]:
        """批量执行。每个 statement 形如 `{sql, params}`。

        D1 query API 同一请求里接受 `[{sql, params}, ...]`。
        自动按总 SQL 长度切 chunk，每个 chunk ≤ _MAX_BATCH_SQL_BYTES。
        返回各 chunk result 的拼接。
        """
        if not statements:
            return []

        out: list[dict] = []
        chunk: list[dict] = []
        chunk_bytes = 0
        for stmt in statements:
            sql = stmt["sql"]
            sql_bytes = len(sql.encode("utf-8"))
            if chunk and chunk_bytes + sql_bytes > _MAX_BATCH_SQL_BYTES:
                out.extend(self._post(chunk))
                chunk = []
                chunk_bytes = 0
            chunk.append(stmt)
            chunk_bytes += sql_bytes
        if chunk:
            out.extend(self._post(chunk))
        return out
