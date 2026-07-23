"""signal-report HTTP API 测试（as_of / trend_window 解析与错误映射）。

server.py 使用 `pipeline.*` 绝对导入，因此把 repo root 加入 sys.path 后
以包形式导入，并启动真实的 ThreadingHTTPServer 做端到端验证。
"""
from __future__ import annotations

import json
import sys
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import pipeline.server as server_mod  # noqa: E402
from pipeline.analyzer.backtest import AsOfOutOfRange, InvalidAsOfDate  # noqa: E402


class _Spy:
    def __init__(self, result=None, exc=None):
        self.calls: list[tuple] = []
        self.result = result if result is not None else {"ok": True}
        self.exc = exc

    def __call__(self, ticker, as_of=None, trend_window=None):
        self.calls.append((ticker, as_of, trend_window))
        if self.exc is not None:
            raise self.exc
        return self.result


@pytest.fixture
def base_url():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), server_mod.SignalReportHandler)
    port = srv.server_address[1]
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        srv.shutdown()


def _get(url: str) -> tuple[int, dict]:
    try:
        with urllib.request.urlopen(url) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode("utf-8"))


class TestTrendWindowParsing:
    def test_none_when_absent(self):
        assert server_mod.SignalReportHandler._parse_trend_window({}) is None

    def test_valid(self):
        assert server_mod.SignalReportHandler._parse_trend_window({"trend_window": ["30"]}) == 30

    def test_invalid(self):
        h = server_mod.SignalReportHandler
        assert h._parse_trend_window({"trend_window": ["abc"]}) is server_mod._INVALID
        assert h._parse_trend_window({"trend_window": ["0"]}) is server_mod._INVALID
        assert h._parse_trend_window({"trend_window": ["-3"]}) is server_mod._INVALID


class TestSignalReportApi:
    def test_current_mode(self, base_url, monkeypatch):
        spy = _Spy(result={"mode": "current"})
        monkeypatch.setattr(server_mod, "build_signal_report", spy)
        status, body = _get(f"{base_url}/api/signal-report/AAPL")
        assert status == 200
        assert body == {"mode": "current"}
        assert spy.calls == [("AAPL", None, None)]

    def test_historical_mode(self, base_url, monkeypatch):
        spy = _Spy(result={"mode": "historical"})
        monkeypatch.setattr(server_mod, "build_signal_report", spy)
        status, body = _get(f"{base_url}/api/signal-report/AAPL?as_of=2026-05-15")
        assert status == 200
        assert spy.calls == [("AAPL", "2026-05-15", None)]

    def test_trend_window_passed(self, base_url, monkeypatch):
        spy = _Spy()
        monkeypatch.setattr(server_mod, "build_signal_report", spy)
        status, _ = _get(f"{base_url}/api/signal-report/AAPL?as_of=2026-05-15&trend_window=30")
        assert status == 200
        assert spy.calls == [("AAPL", "2026-05-15", 30)]

    def test_malformed_as_of_returns_400(self, base_url, monkeypatch):
        spy = _Spy(exc=InvalidAsOfDate("bad date"))
        monkeypatch.setattr(server_mod, "build_signal_report", spy)
        status, body = _get(f"{base_url}/api/signal-report/AAPL?as_of=2026/05/15")
        assert status == 400
        assert body["error"] == "invalid_as_of"

    def test_out_of_range_returns_400(self, base_url, monkeypatch):
        spy = _Spy(exc=AsOfOutOfRange("too early"))
        monkeypatch.setattr(server_mod, "build_signal_report", spy)
        status, body = _get(f"{base_url}/api/signal-report/AAPL?as_of=1990-01-01")
        assert status == 400
        assert body["error"] == "invalid_as_of"

    def test_invalid_trend_window_returns_400_without_calling_builder(self, base_url, monkeypatch):
        spy = _Spy()
        monkeypatch.setattr(server_mod, "build_signal_report", spy)
        status, body = _get(f"{base_url}/api/signal-report/AAPL?trend_window=oops")
        assert status == 400
        assert body["error"] == "invalid_trend_window"
        assert spy.calls == []

    def test_demo_uses_demo_builder(self, base_url, monkeypatch):
        demo_spy = _Spy(result={"demo": True})
        live_spy = _Spy()
        monkeypatch.setattr(server_mod, "build_demo_signal_report", demo_spy)
        monkeypatch.setattr(server_mod, "build_signal_report", live_spy)
        status, body = _get(f"{base_url}/api/signal-report/AAPL?demo=1")
        assert status == 200
        assert body == {"demo": True}
        assert live_spy.calls == []

    def test_demo_ticker_uses_demo_builder(self, base_url, monkeypatch):
        demo_spy = _Spy(result={"demo": True})
        monkeypatch.setattr(server_mod, "build_demo_signal_report", demo_spy)
        status, body = _get(f"{base_url}/api/signal-report/DEMO")
        assert status == 200
        assert body == {"demo": True}
