"""Local Python API server for the React signal report frontend."""
from __future__ import annotations

import argparse
import json
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

from pipeline.analyzer.report import build_demo_signal_report, build_signal_report


class SignalReportHandler(BaseHTTPRequestHandler):
    server_version = "stock-farmer-python-api/0.1"

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
            try:
                payload = (
                    build_demo_signal_report(ticker)
                    if demo or ticker == "DEMO"
                    else build_signal_report(ticker)
                )
            except Exception as exc:  # pragma: no cover - integration boundary
                self._send_error(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    "analysis_failed",
                    f"{type(exc).__name__}: {exc}",
                )
                return
            self._send_json(payload)
            return

        self._send_error(HTTPStatus.NOT_FOUND, "not_found", "未找到 API 路由")

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


def run(host: str = "127.0.0.1", port: int = 8765) -> None:
    server = ThreadingHTTPServer((host, port), SignalReportHandler)
    print(f"Python API listening on http://{host}:{port}")
    print("Signal report endpoint: /api/signal-report/DEMO?demo=1")
    server.serve_forever()


def main() -> int:
    parser = argparse.ArgumentParser(description="stock-farmer Python API server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    run(args.host, args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
