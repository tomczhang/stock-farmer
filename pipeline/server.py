"""Local Python API server for the React signal report frontend.

可选静态托管（STATIC_DIR / --static-dir）：用于 VPS 单容器部署时直接
供给 web 构建产物（SPA fallback 到 index.html），本地开发不受影响。
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from pipeline.analyzer.backtest import BacktestError
from pipeline.analyzer.entry_lab import build_entry_scan
from pipeline.analyzer.entry_lab_renderer import render_entry_lab_html
from pipeline.analyzer.pyramid import build_demo_pyramid_backtest, build_pyramid_backtest
from pipeline.analyzer.report import build_demo_signal_report, build_signal_report


_INVALID = object()  # sentinel：trend_window 解析失败

# 入场标准实验室扫描结果缓存（ticker → payload）；扫描耗时分钟级，
# 同 ticker 并发请求用锁串行，避免重复重算。
_ENTRY_SCAN_CACHE: dict[str, dict] = {}
_ENTRY_SCAN_LOCK = threading.Lock()


class SignalReportHandler(BaseHTTPRequestHandler):
    server_version = "stock-farmer-python-api/0.1"
    # 静态托管根目录（None = 纯 API 模式，非 /api 路径返回 404）
    static_dir: Path | None = None

    @staticmethod
    def _parse_trend_window(params: dict[str, list[str]]) -> int | None | object:
        """解析可选的 trend_window 查询参数。

        未提供时返回 None（交由 report 层使用默认窗口）；非正整数返回 _INVALID。
        """
        raw = params.get("trend_window", [None])[0]
        if raw is None or str(raw).strip() == "":
            return None
        try:
            value = int(str(raw).strip())
        except ValueError:
            return _INVALID
        if value <= 0:
            return _INVALID
        return value

    @staticmethod
    def _parse_positive_int(params: dict[str, list[str]], key: str) -> int | None | object:
        """解析可选正整数查询参数；未提供返回 None，非法返回 _INVALID。"""
        raw = params.get(key, [None])[0]
        if raw is None or str(raw).strip() == "":
            return None
        try:
            value = int(str(raw).strip())
        except ValueError:
            return _INVALID
        if value <= 0:
            return _INVALID
        return value

    def do_OPTIONS(self) -> None:  # noqa: N802 - stdlib hook
        self._send_empty(HTTPStatus.NO_CONTENT)

    def do_GET(self) -> None:  # noqa: N802 - stdlib hook
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            self._send_json({"status": "ok", "backend": "python"})
            return

        prefix = "/api/signal-report/"
        if parsed.path.startswith(prefix):
            ticker = unquote(parsed.path[len(prefix) :]).strip().upper()
            if not ticker:
                self._send_error(HTTPStatus.BAD_REQUEST, "missing_ticker", "ticker 不能为空")
                return

            params = parse_qs(parsed.query)
            demo = params.get("demo", ["0"])[0] in {"1", "true", "yes"}
            as_of = params.get("as_of", [None])[0]
            if as_of is not None:
                as_of = as_of.strip() or None
            trend_window = self._parse_trend_window(params)
            if trend_window is _INVALID:
                self._send_error(
                    HTTPStatus.BAD_REQUEST,
                    "invalid_trend_window",
                    "trend_window 必须为正整数",
                )
                return

            try:
                if demo or ticker == "DEMO":
                    payload = build_demo_signal_report(ticker)
                else:
                    payload = build_signal_report(
                        ticker, as_of=as_of, trend_window=trend_window
                    )
            except BacktestError as exc:
                self._send_error(HTTPStatus.BAD_REQUEST, "invalid_as_of", str(exc))
                return
            except Exception as exc:  # pragma: no cover - integration boundary
                self._send_error(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    "analysis_failed",
                    f"{type(exc).__name__}: {exc}",
                )
                return
            self._send_json(payload)
            return

        prefix = "/api/pyramid-backtest/"
        if parsed.path.startswith(prefix):
            ticker = unquote(parsed.path[len(prefix) :]).strip().upper()
            if not ticker:
                self._send_error(HTTPStatus.BAD_REQUEST, "missing_ticker", "ticker 不能为空")
                return

            params = parse_qs(parsed.query)
            demo = params.get("demo", ["0"])[0] in {"1", "true", "yes"}
            if demo or ticker == "DEMO":
                self._send_json(build_demo_pyramid_backtest(ticker))
                return

            as_of = (params.get("as_of", [None])[0] or "").strip() or None
            if as_of is None:
                self._send_error(
                    HTTPStatus.BAD_REQUEST, "missing_as_of",
                    "金字塔回测必须提供 as_of=YYYY-MM-DD",
                )
                return
            window = self._parse_positive_int(params, "window")
            budget = self._parse_positive_int(params, "budget")
            if window is _INVALID or budget is _INVALID:
                self._send_error(
                    HTTPStatus.BAD_REQUEST, "invalid_param",
                    "window / budget 必须为正整数",
                )
                return

            try:
                payload = build_pyramid_backtest(
                    ticker, as_of, window=window, budget=budget
                )
            except (BacktestError, ValueError) as exc:
                self._send_error(HTTPStatus.BAD_REQUEST, "invalid_backtest", str(exc))
                return
            except Exception as exc:  # pragma: no cover - integration boundary
                self._send_error(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    "backtest_failed",
                    f"{type(exc).__name__}: {exc}",
                )
                return
            self._send_json(payload)
            return

        prefix = "/api/entry-scan/"
        if parsed.path.startswith(prefix):
            ticker = unquote(parsed.path[len(prefix) :]).strip().upper()
            if not ticker:
                self._send_error(HTTPStatus.BAD_REQUEST, "missing_ticker", "ticker 不能为空")
                return
            params = parse_qs(parsed.query)
            refresh = params.get("refresh", ["0"])[0] in {"1", "true", "yes"}
            try:
                with _ENTRY_SCAN_LOCK:
                    if refresh or ticker not in _ENTRY_SCAN_CACHE:
                        _ENTRY_SCAN_CACHE[ticker] = build_entry_scan(ticker)
                    payload = _ENTRY_SCAN_CACHE[ticker]
            except ValueError as exc:
                self._send_error(HTTPStatus.BAD_REQUEST, "invalid_entry_scan", str(exc))
                return
            except Exception as exc:  # pragma: no cover - integration boundary
                self._send_error(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    "entry_scan_failed",
                    f"{type(exc).__name__}: {exc}",
                )
                return
            self._send_json(payload)
            return

        if parsed.path == "/entry-lab":
            body = render_entry_lab_html().encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(body)
            return

        if parsed.path.startswith("/api/"):
            self._send_error(HTTPStatus.NOT_FOUND, "not_found", "未找到 API 路由")
            return

        if self.static_dir is not None:
            self._serve_static(parsed.path)
            return

        self._send_error(HTTPStatus.NOT_FOUND, "not_found", "未找到 API 路由")

    def _serve_static(self, raw_path: str) -> None:
        """托管前端构建产物；未命中文件时 SPA fallback 到 index.html。"""
        assert self.static_dir is not None
        root = self.static_dir
        rel = unquote(raw_path).lstrip("/") or "index.html"
        target = (root / rel).resolve()
        # 路径穿越防护：解析后必须仍在静态根目录内
        if not target.is_relative_to(root.resolve()):
            self._send_error(HTTPStatus.FORBIDDEN, "forbidden", "非法路径")
            return
        if not target.is_file():
            target = root / "index.html"
            if not target.is_file():
                self._send_error(HTTPStatus.NOT_FOUND, "not_found", "静态资源不存在")
                return
        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        body = target.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        # 带 hash 的构建产物长缓存，index.html 不缓存
        if target.name == "index.html":
            self.send_header("Cache-Control", "no-cache")
        else:
            self.send_header("Cache-Control", "public, max-age=86400")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        return

    def _send_empty(self, status: HTTPStatus) -> None:
        self.send_response(status)
        self._write_headers("application/json")
        self.end_headers()

    def _send_json(self, payload: object, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(status)
        self._write_headers("application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_error(self, status: HTTPStatus, error: str, message: str) -> None:
        self._send_json({"error": error, "message": message}, status=status)

    def _write_headers(self, content_type: str) -> None:
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Accept, Content-Type")


def run(host: str = "127.0.0.1", port: int = 8765, static_dir: str | None = None) -> None:
    resolved = static_dir or os.environ.get("STATIC_DIR") or None
    if resolved:
        SignalReportHandler.static_dir = Path(resolved).resolve()
        print(f"Static dir: {SignalReportHandler.static_dir}")
    server = ThreadingHTTPServer((host, port), SignalReportHandler)
    print(f"Python API listening on http://{host}:{port}")
    print("Signal report endpoint: /api/signal-report/DEMO?demo=1")
    print("Pyramid backtest endpoint: /api/pyramid-backtest/DEMO?demo=1")
    print(f"Entry lab (入场标准实验室): http://{host}:{port}/entry-lab")
    server.serve_forever()


def main() -> int:
    parser = argparse.ArgumentParser(description="stock-farmer Python API server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--static-dir", default=None, help="可选：前端构建产物目录（亦可用 STATIC_DIR 环境变量）")
    args = parser.parse_args()
    run(args.host, args.port, static_dir=args.static_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
