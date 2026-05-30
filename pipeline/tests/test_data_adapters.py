"""数据层 adapter 单元测试（mock HTTP）。"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pandas as pd
import pytest

from data.adapters import eastmoney, sina, yahoo
from data.adapters.xueqiu import fetch_pe_ttm
from data.types import AdapterError


# ---------- eastmoney ----------

class TestEastmoneyQuotes:
    def test_fetch_quotes_parses_response(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "rc": 0, "data": {
                "total": 1,
                "diff": [{"f2": 312.06, "f3": -0.14, "f12": "AAPL", "f14": "苹果",
                           "f5": 70000000, "f6": 21800000000.0, "f7": 1.75,
                           "f15": 315.0, "f16": 309.53, "f17": 311.78, "f18": 312.51, "f4": -0.45}],
            },
        }
        with patch("data.adapters.eastmoney._session") as mock_session:
            mock_session.return_value.get.return_value = mock_resp
            quotes = eastmoney.fetch_quotes(["AAPL"])
        assert len(quotes) == 1
        assert quotes[0].ticker == "AAPL"
        assert quotes[0].price == 312.06
        assert quotes[0].name == "苹果"

    def test_fetch_quotes_empty_raises(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"rc": 0, "data": None}
        with patch("data.adapters.eastmoney._session") as mock_session:
            mock_session.return_value.get.return_value = mock_resp
            with pytest.raises(AdapterError, match="eastmoney"):
                eastmoney.fetch_quotes(["AAPL"])


class TestEastmoneyKlines:
    def test_fetch_klines_parses_csv(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "data": {
                "klines": [
                    "2026-05-29,311.78,312.06,315.00,309.53,70026752,21846708992",
                    "2026-05-28,310.68,312.51,312.80,309.57,48220390,15023130000",
                ],
            },
        }
        with patch("data.adapters.eastmoney._session") as mock_session:
            mock_session.return_value.get.return_value = mock_resp
            df = eastmoney.fetch_klines("AAPL", period="1d", count=10)
        assert isinstance(df, pd.DataFrame)
        assert len(df) == 2
        assert "close" in df.columns
        assert df.iloc[-1]["close"] == 312.06


# ---------- yahoo ----------

class TestYahooKlines:
    def test_fetch_klines_parses_chart(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "chart": {"result": [{
                "timestamp": [1717000000, 1717086400],
                "indicators": {"quote": [{
                    "open": [310.0, 311.0], "high": [315.0, 313.0],
                    "low": [309.0, 310.0], "close": [312.0, 312.5],
                    "volume": [50000000, 48000000],
                }]},
            }]},
        }
        with patch("data.adapters.yahoo.requests.get", return_value=mock_resp):
            df = yahoo.fetch_klines("AAPL", period="1d", count=10)
        assert isinstance(df, pd.DataFrame)
        assert len(df) == 2


# ---------- sina ----------

class TestSinaQuotes:
    def test_fetch_quotes_parses_us(self):
        hq_text = (
            'var hq_str_gb_aapl="苹果,312.06,-0.14,2026-05-30 09:38:15,-0.45,311.78,315.00,309.53,'
            + ",".join(["0"] * 18) + ',312.51,0,0,0,0,0,0";'
        )
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.text = hq_text
        with patch("data.adapters.sina.requests.get", return_value=mock_resp):
            quotes = sina.fetch_quotes(["AAPL"])
        assert len(quotes) == 1
        assert quotes[0].name == "苹果"
        assert quotes[0].price == 312.06


# ---------- xueqiu ----------

class TestXueqiuPE:
    def test_fetch_pe_ttm_returns_value(self):
        mock_session = MagicMock()
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "error_code": 0,
            "data": {"quote": {"pe_ttm": 37.39, "current": 312.06, "eps": 8.35}},
        }
        mock_session.get.return_value = mock_resp
        with patch("data.adapters.xueqiu._COOKIE") as mock_cookie:
            mock_cookie.get_session.return_value = mock_session
            pe = fetch_pe_ttm("AAPL")
        assert pe == 37.39

    def test_fetch_pe_ttm_negative_returns_none(self):
        mock_session = MagicMock()
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "error_code": 0,
            "data": {"quote": {"pe_ttm": -5.0}},
        }
        mock_session.get.return_value = mock_resp
        with patch("data.adapters.xueqiu._COOKIE") as mock_cookie:
            mock_cookie.get_session.return_value = mock_session
            pe = fetch_pe_ttm("LOSS_STOCK")
        assert pe is None
