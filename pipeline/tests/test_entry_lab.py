"""入场标准实验室（entry_lab）与其 server 路由测试。"""
from __future__ import annotations

import json
import sys
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

import pandas as pd
import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import pipeline.analyzer.entry_lab as entry_lab  # noqa: E402
import pipeline.server as server_mod  # noqa: E402
from pipeline.analyzer.entry_lab_renderer import render_entry_lab_html  # noqa: E402

FORBIDDEN_WORDS = ("胜率", "准确率", "上涨概率")


def _df(n: int, start: str = "2025-01-01") -> pd.DataFrame:
    dates = pd.date_range(start, periods=n, freq="B").strftime("%Y-%m-%d")
    return pd.DataFrame({
        "date": dates,
        "open": [100.0] * n, "high": [101.0] * n,
        "low": [99.0] * n, "close": [100.0] * n,
        "volume": [1_000_000] * n,
    })


def _fake_signal(sig_id: str, category: str, light: str, name: str = "", weight: int = 1):
    return SimpleNamespace(
        id=sig_id, name=name or sig_id, category=category,
        light=light, confidence=0.8 if light == "green" else 0.3, weight=weight,
    )


def _patch_chain(monkeypatch, tier: str = "base_forming", light: str = "green"):
    signals = [
        _fake_signal("vol_shrink", "left", "green"),
        _fake_signal("above_ma", "right", light, "站回均线"),
        _fake_signal("macd_cross", "right", "red", "MACD金叉"),
    ]
    monkeypatch.setattr(entry_lab, "compute_all_signals", lambda df: signals)
    monkeypatch.setattr(
        entry_lab, "compute_bottoming",
        lambda df, signals=None: SimpleNamespace(tier=tier, cleanliness_pct=66),
    )


class TestScanEntrySnapshots:
    def test_snapshot_shape_and_warmup(self, monkeypatch):
        _patch_chain(monkeypatch)
        df = _df(15)
        days, meta = entry_lab.scan_entry_snapshots(df, warmup=10)
        assert len(days) == 5  # 15 - 10
        day = days[0]
        assert day["date"] == df["date"].iloc[10]
        assert day["tier"] == "base_forming"
        assert day["cleanliness_pct"] == 66
        # 只收右侧信号，左侧不入 rights
        assert set(day["rights"]) == {"above_ma", "macd_cross"}
        assert day["rights"]["above_ma"]["light"] == "green"
        # meta 只含右侧信号
        assert [m["id"] for m in meta] == ["above_ma", "macd_cross"]

    def test_snapshot_uses_truncated_window(self, monkeypatch):
        seen_lens: list[int] = []

        def spy_signals(df):
            seen_lens.append(len(df))
            return [_fake_signal("above_ma", "right", "green")]

        monkeypatch.setattr(entry_lab, "compute_all_signals", spy_signals)
        monkeypatch.setattr(
            entry_lab, "compute_bottoming",
            lambda df, signals=None: SimpleNamespace(tier="early_signs", cleanliness_pct=0),
        )
        entry_lab.scan_entry_snapshots(_df(20), warmup=5, tail=8)
        # 截断窗口不超过 tail，且逐日只含当日及之前数据（防未来函数）
        assert max(seen_lens) <= 8
        assert seen_lens[0] == 6  # warmup 日：min(5+1, tail)


class TestBuildEntryScan:
    def test_payload_contract(self, monkeypatch):
        _patch_chain(monkeypatch)
        monkeypatch.setattr("pipeline.data.get_klines", lambda *a, **kw: _df(15))
        payload = entry_lab.build_entry_scan("0700.HK", warmup=10)
        assert payload["ticker"] == "0700.HK"
        assert payload["range"]["scanned_days"] == 5
        assert payload["range"]["warmup"] == 10
        # 生产默认规则与 pyramid 常量一致
        from pipeline.analyzer.pyramid import ENTRY_TIERS, RIGHT_TRIGGER_IDS
        rule = payload["meta"]["default_rule"]
        assert rule["tiers"] == list(ENTRY_TIERS)
        assert rule["triggers"] == list(RIGHT_TRIGGER_IDS)
        assert rule["min_green"] == 1
        # 档位元数据覆盖全部 5 档
        assert {t["id"] for t in payload["meta"]["tiers"]} >= {
            "still_falling", "early_signs", "base_forming", "base_ready", "trend_running",
        }
        # klines 与 days 对齐（都从 warmup 起）
        assert len(payload["klines"]) == len(payload["days"])
        json.dumps(payload, ensure_ascii=False)  # 原生可序列化

    def test_insufficient_history_raises(self, monkeypatch):
        monkeypatch.setattr("pipeline.data.get_klines", lambda *a, **kw: _df(8))
        with pytest.raises(ValueError, match="预热期"):
            entry_lab.build_entry_scan("AAPL", warmup=10)

    def test_no_data_raises(self, monkeypatch):
        monkeypatch.setattr("pipeline.data.get_klines", lambda *a, **kw: None)
        with pytest.raises(ValueError, match="无可用日线数据"):
            entry_lab.build_entry_scan("AAPL")


class TestEntryLabRenderer:
    def test_page_contains_controls_and_red_lines(self):
        html = render_entry_lab_html()
        assert "入场标准实验室" in html
        assert "筑底档位门槛" in html
        assert "认可的右侧触发信号" in html
        assert "触发灯色要求" in html
        assert "洗盘干净度下限" in html
        assert "恢复生产默认" in html
        assert "/api/entry-scan/" in html
        assert "结构强度" in html  # 语义红线：干净度 = 结构强度
        # 命中列表为前端分页，不再截断
        for token in ("上一页", "下一页", "pg-size", "renderPage"):
            assert token in html
        assert "仅显示前" not in html
        for word in FORBIDDEN_WORDS:
            assert word not in html


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


def _get(url: str) -> tuple[int, bytes]:
    try:
        with urllib.request.urlopen(url) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


class TestEntryScanApi:
    @pytest.fixture(autouse=True)
    def _clear_cache(self):
        server_mod._ENTRY_SCAN_CACHE.clear()
        yield
        server_mod._ENTRY_SCAN_CACHE.clear()

    def test_scan_and_cache(self, base_url, monkeypatch):
        calls: list[str] = []

        def fake_build(ticker):
            calls.append(ticker)
            return {"ticker": ticker, "days": []}

        monkeypatch.setattr(server_mod, "build_entry_scan", fake_build)
        status, body = _get(f"{base_url}/api/entry-scan/0700.hk")
        assert status == 200
        assert json.loads(body)["ticker"] == "0700.HK"
        # 二次请求命中缓存，不重复扫描
        status, _ = _get(f"{base_url}/api/entry-scan/0700.HK")
        assert status == 200
        assert calls == ["0700.HK"]
        # refresh=1 强制重扫
        status, _ = _get(f"{base_url}/api/entry-scan/0700.HK?refresh=1")
        assert status == 200
        assert calls == ["0700.HK", "0700.HK"]

    def test_value_error_maps_400(self, base_url, monkeypatch):
        def fake_build(ticker):
            raise ValueError("XX 无可用日线数据")

        monkeypatch.setattr(server_mod, "build_entry_scan", fake_build)
        status, body = _get(f"{base_url}/api/entry-scan/XX")
        assert status == 400
        assert json.loads(body)["error"] == "invalid_entry_scan"

    def test_entry_lab_page(self, base_url):
        status, body = _get(f"{base_url}/entry-lab")
        assert status == 200
        assert "入场标准实验室" in body.decode("utf-8")
