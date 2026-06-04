"""HTML 报告渲染（暗色主题、响应式、TradingView lightweight-charts）。"""
from __future__ import annotations

import json
from datetime import datetime

import pandas as pd

from .phase import PhaseResult
from .signals import SignalResult


_LIGHT_COLORS = {
    "red": ("#ef4444", "bg-red-500"),
    "yellow": ("#f59e0b", "bg-amber-500"),
    "green": ("#22c55e", "bg-green-500"),
}

_LIGHT_EMOJI = {"red": "🔴", "yellow": "🟡", "green": "🟢"}


# --- HeroUI v3 design tokens (浅色主题). 通过内联 <style> 注入 :root.
# 在 Tailwind CDN 路线下，配合 [color:var(--xxx)] 任意值类或内联 style 使用。
_DESIGN_TOKENS_CSS = """<style>
:root {
  --color-default: #6b7280;
  --color-default-100: #f3f4f6;
  --color-success: #16a34a;
  --color-success-100: #dcfce7;
  --color-warning: #d97706;
  --color-warning-100: #fef3c7;
  --color-danger: #dc2626;
  --color-danger-100: #fee2e2;
  --color-surface: #ffffff;
  --color-surface-secondary: #f8fafc;
  --color-divider: #e5e7eb;
  --radius-card: 1rem;
  --shadow-xs: 0 1px 2px rgba(15, 23, 42, 0.04);
}
</style>"""


def _render_design_tokens() -> str:
    """返回内联的 HeroUI v3 设计 token <style> 块。"""
    return _DESIGN_TOKENS_CSS


# --- 右侧信号 4 态视觉规范.
# (state_key) -> (chip_label, color_var, color_100_var)
_RIGHT_STATE_TABLE: dict[str, tuple[str, str, str]] = {
    "default": ("未触发", "var(--color-default)", "var(--color-default-100)"),
    "warning-soft": ("酝酿中", "var(--color-warning)", "var(--color-warning-100)"),
    "warning": ("临界", "var(--color-warning)", "var(--color-warning-100)"),
    "success": ("已触发", "var(--color-success)", "var(--color-success-100)"),
}

# 在 [thresholds[0], thresholds[1]) 区间内进一步切分 warning-soft / warning.
_RIGHT_TIER_BREAK: float = 0.55


def _resolve_right_state(confidence: float, thresholds: tuple[float, float]) -> str:
    """按 design D2 表把 confidence + thresholds 映射为 4 态键名。

    返回值 ∈ {"default", "warning-soft", "warning", "success"}。
    """
    red_max, yellow_max = thresholds
    if confidence >= yellow_max:
        return "success"
    if confidence < red_max:
        return "default"
    if confidence < _RIGHT_TIER_BREAK:
        return "warning-soft"
    return "warning"


def render_html(
    ticker: str,
    name: str,
    price: float | None,
    change_pct: float | None,
    signals: list[SignalResult],
    phase: PhaseResult,
    narrative: str,
    chart_data: dict | None = None,
) -> str:
    """渲染完整 HTML 报告。

    chart_data: {
        "klines": [{date, open, high, low, close, volume}, ...],
        "index_klines": [{date, close}, ...] (可选),
        "volume_profile": [{price_level, volume, pct}, ...] (可选),
    }
    """
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    price_str = f"${price:.2f}" if price else "N/A"
    change_str = f"{change_pct:+.2f}%" if change_pct is not None else ""
    change_color = "text-green-600" if (change_pct or 0) >= 0 else "text-red-600"

    left_signals = [s for s in signals if s.category == "left"]
    right_signals = [s for s in signals if s.category == "right"]

    left_cards = "\n".join(_render_signal_card(s, i) for i, s in enumerate(left_signals))
    right_cards = "\n".join(
        _render_right_signal_card(s, i + 6) for i, s in enumerate(right_signals)
    )

    design_tokens = _render_design_tokens()

    strength_bar = _render_strength_bar(phase.strength)

    chart_json = json.dumps(chart_data or {}, ensure_ascii=False, default=str)

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{ticker} 信号诊断 — stock-farmer</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://unpkg.com/lightweight-charts@4/dist/lightweight-charts.standalone.production.js"></script>
  {design_tokens}
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, "SF Pro", "Segoe UI", sans-serif; }}
    .chart-container {{ height: 320px; border-radius: 8px; overflow: hidden; margin-top: 8px; border: 1px solid var(--color-divider); }}
  </style>
</head>
<body class="bg-gray-50 text-gray-900 min-h-screen">
  <div class="max-w-6xl mx-auto px-6 py-6 md:py-10">

    <!-- Nav + Quick Analyze -->
    <nav class="flex items-center justify-between mb-6 gap-3">
      <a href="./index.html" class="text-sm text-gray-500 hover:text-blue-600">&larr; 首页</a>
      <form id="quickForm" class="flex items-center gap-2" onsubmit="return handleQuickAnalyze(event)">
        <input id="quickTicker" type="text" placeholder="输入代码 如 AAPL"
               class="bg-white border border-gray-300 rounded-lg px-3 py-1.5 text-sm w-36 md:w-44
                      focus:border-blue-500 focus:outline-none text-gray-900 placeholder-gray-400">
        <button type="submit"
                class="bg-blue-600 hover:bg-blue-500 text-white text-sm px-3 py-1.5 rounded-lg transition-colors">
          分析
        </button>
      </form>
    </nav>

    <!-- Header -->
    <header class="mb-6">
      <div class="flex items-baseline gap-3 flex-wrap">
        <h1 class="text-2xl md:text-3xl font-bold text-gray-900">{ticker}</h1>
        <span class="text-gray-500 text-lg">{name}</span>
        <span class="text-xl font-semibold text-gray-800">{price_str}</span>
        <span class="{change_color} text-sm font-medium">{change_str}</span>
      </div>
      <p class="text-gray-400 text-xs mt-1">分析时间：{now}</p>
    </header>

    <!-- Conclusion Card -->
    <section class="bg-white rounded-xl border border-gray-200 shadow-sm p-5 md:p-6 mb-6">
      <div class="flex items-center gap-3 mb-3">
        <span class="text-3xl">{phase.icon}</span>
        <div>
          <h2 class="text-xl font-bold text-gray-900">{phase.phase}</h2>
          <p class="text-gray-500 text-sm">{phase.action}</p>
        </div>
      </div>
      <p class="text-sm text-blue-600 mb-4">📌 {phase.trigger}</p>
      <div class="mt-3">
        <div class="flex items-center justify-between text-xs text-gray-500 mb-1">
          <span>综合强度</span>
          <span class="font-semibold text-gray-800">{phase.strength_pct}%</span>
        </div>
        {strength_bar}
        <div class="flex justify-between text-[10px] text-gray-400 mt-1">
          <span>🔴 0-25%</span><span>🟡 25-45%</span><span>🟡⭐ 45-60%</span><span>🟢 60-80%</span><span>🟢🟢 80%+</span>
        </div>
      </div>
    </section>

    <!-- Narrative -->
    <section class="bg-white rounded-xl border border-gray-200 shadow-sm p-5 mb-6">
      <h3 class="text-sm font-semibold text-gray-500 mb-2">综述</h3>
      <p class="text-gray-700 text-sm leading-relaxed">{narrative}</p>
    </section>

    <!-- Left + Right Signals (side by side) -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start mb-6">
      <!-- Left Side Signals -->
      <section>
        <h3 class="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">左侧信号 · 底部特征</h3>
        <div class="grid grid-cols-1 gap-3">
          {left_cards}
        </div>
      </section>

      <!-- Right Side Signals -->
      <section>
        <h3 class="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">右侧信号 · 趋势确认</h3>
        <div class="grid grid-cols-1 gap-3">
          {right_cards}
        </div>
      </section>
    </div>

    <!-- Footer -->
    <footer class="text-center text-xs pt-4" style="color: var(--color-default); border-top: 1px solid var(--color-divider);">
      <p>仅供参考，不构成投资建议 · stock-farmer · {now}</p>
      <p class="text-[10px] mt-1" style="color: var(--color-default);">右侧信号 4 态：未触发 / 酝酿中 / 临界 / 已触发</p>
    </footer>

  </div>

  <script>
    const DATA = {chart_json};
    const CHARTS = {{}};

    function initCharts() {{
      if (!DATA.klines || !DATA.klines.length) return;
      const klines = DATA.klines;
      const indexKlines = DATA.index_klines || [];
      const vp = DATA.volume_profile || [];

      // Signal chart configs
      const configs = {{
        // S1: 缩量下跌 — 成交量柱状图 + MA5/MA20
        0: () => renderVolumeChart('chart-0', klines),
        // S2: 跌不动 — 价格折线 + 前低/近低标注
        1: () => renderPriceWithLevels('chart-1', klines, 'no_new_low'),
        // S3: 假破位收回 — K线 + 前低标注
        2: () => renderCandlestick('chart-2', klines),
        // S4: 波动收敛 — ATR 折线
        3: () => renderATR('chart-3', klines),
        // S5: 筹码集中 — Volume Profile
        4: () => renderVolumeProfile('chart-4', vp),
        // S6: 大盘环境 — 指数折线 + MA20
        5: () => renderIndexChart('chart-5', indexKlines),
        // S7: 站回均线 — 价格 + MA10/MA20
        6: () => renderPriceWithMA('chart-6', klines),
        // S8: 放量反包 — K线 + 成交量
        7: () => renderCandlestickWithVolume('chart-7', klines),
        // S9: MACD金叉 — MACD 图
        8: () => renderMACD('chart-8', klines),
        // S10: 低点抬升 — 价格折线 + 低点标注
        9: () => renderPriceWithLevels('chart-9', klines, 'higher_low'),
      }};

      Object.entries(configs).forEach(([idx, fn]) => {{
        const el = document.getElementById('chart-' + idx);
        if (el) fn();
      }});
    }}

    function createChart(containerId) {{
      const el = document.getElementById(containerId);
      if (!el) return null;
      const w = el.clientWidth || el.parentElement.clientWidth || 600;
      const chart = LightweightCharts.createChart(el, {{
        width: w,
        height: 320,
        layout: {{ background: {{ color: '#ffffff' }}, textColor: '#6b7280' }},
        grid: {{ vertLines: {{ color: '#f3f4f6' }}, horzLines: {{ color: '#f3f4f6' }} }},
        crosshair: {{ mode: 0 }},
        rightPriceScale: {{ borderColor: '#e5e7eb' }},
        timeScale: {{ borderColor: '#e5e7eb', timeVisible: false }},
        handleScroll: false,
        handleScale: false,
        localization: {{ locale: 'zh-CN', dateFormat: 'yyyy-MM-dd' }},
      }});
      new ResizeObserver(() => chart.applyOptions({{ width: el.clientWidth }})).observe(el);
      return chart;
    }}

    function renderVolumeChart(id, klines) {{
      const el = document.getElementById(id);
      if (!el) return;
      el.style.height = '420px';
      const w = el.clientWidth || el.parentElement.clientWidth || 600;
      const chart = LightweightCharts.createChart(el, {{
        width: w, height: 420,
        layout: {{ background: {{ color: '#ffffff' }}, textColor: '#6b7280' }},
        grid: {{ vertLines: {{ color: '#f3f4f6' }}, horzLines: {{ color: '#f3f4f6' }} }},
        crosshair: {{ mode: 0 }},
        rightPriceScale: {{ borderColor: '#e5e7eb' }},
        timeScale: {{ borderColor: '#e5e7eb', timeVisible: false }},
        handleScroll: false, handleScale: false,
        localization: {{ locale: 'zh-CN', dateFormat: 'yyyy-MM-dd' }},
      }});
      // K线 — 红涨绿跌（中国习惯）
      const candleSeries = chart.addCandlestickSeries({{
        upColor: '#dc2626', downColor: '#16a34a', borderVisible: false,
        wickUpColor: '#dc2626', wickDownColor: '#16a34a',
        priceScaleId: 'right',
      }});
      candleSeries.priceScale().applyOptions({{ scaleMargins: {{ top: 0.02, bottom: 0.52 }} }});
      candleSeries.setData(klines.map(k => ({{ time: k.date, open: k.open, high: k.high, low: k.low, close: k.close }})));
      // 成交量（占下方30%）— 下跌日红色，上涨日浅灰
      const volumes = klines.map((k, i) => {{
        const isDown = i > 0 && k.close < klines[i-1].close;
        return {{ time: k.date, value: k.volume, color: isDown ? '#16a34acc' : '#d1d5db' }};
      }});
      const volSeries = chart.addHistogramSeries({{
        priceFormat: {{ type: 'volume' }},
        priceScaleId: 'vol',
      }});
      volSeries.priceScale().applyOptions({{ scaleMargins: {{ top: 0.52, bottom: 0 }} }});
      volSeries.setData(volumes);
      // MA20 成交量均线
      const ma20Data = klines.map((k, i) => i >= 19 ? {{ time: k.date, value: klines.slice(i-19, i+1).reduce((s,x) => s+x.volume, 0) / 20 }} : null).filter(Boolean);
      chart.addLineSeries({{ color: '#2563eb', lineWidth: 2, title: 'MA20', priceScaleId: 'vol' }}).setData(ma20Data);
      // MA60 成交量均线
      const ma60Data = klines.map((k, i) => i >= 59 ? {{ time: k.date, value: klines.slice(i-59, i+1).reduce((s,x) => s+x.volume, 0) / 60 }} : null).filter(Boolean);
      chart.addLineSeries({{ color: '#7c3aed', lineWidth: 2, title: 'MA60', priceScaleId: 'vol' }}).setData(ma60Data);
      chart.timeScale().fitContent();
      new ResizeObserver(() => chart.applyOptions({{ width: el.clientWidth }})).observe(el);

      // 图例：当日成交量、MA20、MA60
      const lastK = klines[klines.length - 1];
      const lastVol = lastK.volume;
      const ma20Val = klines.length >= 20 ? klines.slice(-20).reduce((s,k) => s+k.volume, 0) / 20 : null;
      const ma60Val = klines.length >= 60 ? klines.slice(-60).reduce((s,k) => s+k.volume, 0) / 60 : null;
      function fmtVol(v) {{ return v >= 1e8 ? (v/1e8).toFixed(2)+'亿' : (v/1e4).toFixed(0)+'万'; }}
      const legendDiv = document.createElement('div');
      legendDiv.style.cssText = 'display:flex;gap:24px;justify-content:center;padding:8px 0 4px;font-size:12px;color:#6b7280;';
      legendDiv.innerHTML = '<span style="display:flex;align-items:center;gap:4px"><span style="width:12px;height:12px;background:#d1d5db;border-radius:2px;display:inline-block"></span>' + lastK.date + ' 成交量 <b style="color:#374151">' + fmtVol(lastVol) + '</b></span>'
        + '<span style="display:flex;align-items:center;gap:4px"><span style="width:16px;height:2px;background:#2563eb;display:inline-block"></span>MA20 <b style="color:#2563eb">' + (ma20Val ? fmtVol(ma20Val) : '—') + '</b></span>'
        + '<span style="display:flex;align-items:center;gap:4px"><span style="width:16px;height:2px;background:#7c3aed;display:inline-block"></span>MA60 <b style="color:#7c3aed">' + (ma60Val ? fmtVol(ma60Val) : '—') + '</b></span>';
      el.parentElement.insertBefore(legendDiv, el.nextSibling);
    }}

    function renderPriceWithLevels(id, klines, type) {{
      const chart = createChart(id);
      if (!chart) return;
      const data = klines.map(k => ({{ time: k.date, value: k.close }}));
      const line = chart.addLineSeries({{ color: '#2563eb', lineWidth: 2 }});
      line.setData(data);
      // Mark key levels
      const lows = klines.map(k => k.low);
      const recent5Low = Math.min(...lows.slice(-5));
      const prev20Low = Math.min(...lows.slice(-25, -5));
      line.createPriceLine({{ price: prev20Low, color: '#ef4444', lineWidth: 1, lineStyle: 2, title: '前低' }});
      line.createPriceLine({{ price: recent5Low, color: '#f59e0b', lineWidth: 1, lineStyle: 2, title: '近低' }});
      chart.timeScale().fitContent();
    }}

    function renderCandlestick(id, klines) {{
      const chart = createChart(id);
      if (!chart) return;
      const data = klines.slice(-30).map(k => ({{ time: k.date, open: k.open, high: k.high, low: k.low, close: k.close }}));
      const series = chart.addCandlestickSeries({{ upColor: '#dc2626', downColor: '#16a34a', borderVisible: false, wickUpColor: '#dc2626', wickDownColor: '#16a34a' }});
      series.setData(data);
      const lows = klines.map(k => k.low);
      const prevLow = Math.min(...lows.slice(-25, -5));
      series.createPriceLine({{ price: prevLow, color: '#ef4444', lineWidth: 1, lineStyle: 2, title: '前低' }});
      chart.timeScale().fitContent();
    }}

    function renderATR(id, klines) {{
      const chart = createChart(id);
      if (!chart) return;
      const atrData = [];
      for (let i = 1; i < klines.length; i++) {{
        const tr = Math.max(klines[i].high - klines[i].low, Math.abs(klines[i].high - klines[i-1].close), Math.abs(klines[i].low - klines[i-1].close));
        if (i >= 14) {{
          const sum = klines.slice(i-13, i+1).reduce((s, k, j) => {{
            if (j === 0) return Math.max(k.high - k.low);
            const prev = klines[i-14+j];
            return s + Math.max(k.high - k.low, Math.abs(k.high - prev.close), Math.abs(k.low - prev.close));
          }}, 0);
          atrData.push({{ time: klines[i].date, value: sum / 14 }});
        }}
      }}
      const line = chart.addLineSeries({{ color: '#7c3aed', lineWidth: 2, title: 'ATR(14)' }});
      line.setData(atrData);
      chart.timeScale().fitContent();
    }}

    function renderVolumeProfile(id, vp) {{
      const el = document.getElementById(id);
      if (!el || !vp.length) {{ if (el) el.innerHTML = '<p class="text-xs text-gray-500 p-2">Volume Profile 数据不可用</p>'; return; }}
      const maxVol = Math.max(...vp.map(b => b.volume));
      el.innerHTML = '<div class="flex flex-col gap-0.5 p-2">' + vp.slice().reverse().map(b => {{
        const pct = b.volume / maxVol * 100;
        return `<div class="flex items-center gap-1"><span class="text-[9px] text-gray-500 w-12 text-right">${{b.price_level.toFixed(1)}}</span><div class="flex-1 h-2.5 bg-gray-100 rounded-sm overflow-hidden"><div class="h-full bg-blue-500/80 rounded-sm" style="width:${{pct}}%"></div></div><span class="text-[9px] text-gray-500 w-8">${{b.pct.toFixed(0)}}%</span></div>`;
      }}).join('') + '</div>';
    }}

    function renderIndexChart(id, indexKlines) {{
      const chart = createChart(id);
      if (!chart || !indexKlines.length) return;
      const data = indexKlines.map(k => ({{ time: k.date, value: k.close }}));
      const line = chart.addLineSeries({{ color: '#2563eb', lineWidth: 2 }});
      line.setData(data);
      // MA20
      const ma20Data = indexKlines.map((k, i) => i >= 19 ? {{ time: k.date, value: indexKlines.slice(i-19, i+1).reduce((s,x) => s+x.close, 0) / 20 }} : null).filter(Boolean);
      const ma20Line = chart.addLineSeries({{ color: '#f59e0b', lineWidth: 1, lineStyle: 2, title: 'MA20' }});
      ma20Line.setData(ma20Data);
      chart.timeScale().fitContent();
    }}

    function renderPriceWithMA(id, klines) {{
      const chart = createChart(id);
      if (!chart) return;
      const data = klines.map(k => ({{ time: k.date, value: k.close }}));
      const line = chart.addLineSeries({{ color: '#2563eb', lineWidth: 2 }});
      line.setData(data);
      const ma10 = klines.map((k, i) => i >= 9 ? {{ time: k.date, value: klines.slice(i-9, i+1).reduce((s,x) => s+x.close, 0) / 10 }} : null).filter(Boolean);
      chart.addLineSeries({{ color: '#f59e0b', lineWidth: 1, title: 'MA10' }}).setData(ma10);
      const ma20 = klines.map((k, i) => i >= 19 ? {{ time: k.date, value: klines.slice(i-19, i+1).reduce((s,x) => s+x.close, 0) / 20 }} : null).filter(Boolean);
      chart.addLineSeries({{ color: '#22c55e', lineWidth: 1, title: 'MA20' }}).setData(ma20);
      chart.timeScale().fitContent();
    }}

    function renderCandlestickWithVolume(id, klines) {{
      const chart = createChart(id);
      if (!chart) return;
      const recent = klines.slice(-20);
      const data = recent.map(k => ({{ time: k.date, open: k.open, high: k.high, low: k.low, close: k.close }}));
      const series = chart.addCandlestickSeries({{ upColor: '#dc2626', downColor: '#16a34a', borderVisible: false, wickUpColor: '#dc2626', wickDownColor: '#16a34a' }});
      series.setData(data);
      const volData = recent.map(k => ({{ time: k.date, value: k.volume, color: k.close >= k.open ? '#dc262699' : '#16a34a99' }}));
      chart.addHistogramSeries({{ priceFormat: {{ type: 'volume' }}, priceScaleId: 'vol', scaleMargins: {{ top: 0.7, bottom: 0 }} }}).setData(volData);
      chart.timeScale().fitContent();
    }}

    function renderMACD(id, klines) {{
      const chart = createChart(id);
      if (!chart) return;
      const closes = klines.map(k => k.close);
      // EMA
      function ema(data, period) {{
        const k = 2 / (period + 1);
        const result = [data[0]];
        for (let i = 1; i < data.length; i++) result.push(data[i] * k + result[i-1] * (1-k));
        return result;
      }}
      const ema12 = ema(closes, 12);
      const ema26 = ema(closes, 26);
      const dif = ema12.map((v, i) => v - ema26[i]);
      const dea = ema(dif, 9);
      const macdData = dif.map((v, i) => ({{ time: klines[i].date, value: v - dea[i], color: (v - dea[i]) >= 0 ? '#dc2626aa' : '#16a34aaa' }}));
      chart.addHistogramSeries({{ priceFormat: {{ minMove: 0.01 }} }}).setData(macdData.slice(26));
      chart.addLineSeries({{ color: '#2563eb', lineWidth: 1, title: 'DIF' }}).setData(dif.slice(26).map((v, i) => ({{ time: klines[i+26].date, value: v }})));
      chart.addLineSeries({{ color: '#f59e0b', lineWidth: 1, title: 'DEA' }}).setData(dea.slice(26).map((v, i) => ({{ time: klines[i+26].date, value: v }})));
      chart.timeScale().fitContent();
    }}

    // Quick analyze
    const REPO = 'tomczhang/stock-farmer';
    function handleQuickAnalyze(e) {{
      e.preventDefault();
      const ticker = document.getElementById('quickTicker').value.trim().toUpperCase();
      if (!ticker) return false;
      const token = localStorage.getItem('gh_token');
      if (!token) {{
        const t = prompt('首次使用需输入 GitHub Personal Access Token:');
        if (!t) return false;
        localStorage.setItem('gh_token', t);
        triggerAnalyze(ticker, t);
      }} else triggerAnalyze(ticker, token);
      return false;
    }}
    async function triggerAnalyze(ticker, token) {{
      const btn = document.querySelector('#quickForm button');
      btn.textContent = '提交中...';
      try {{
        const r = await fetch('https://api.github.com/repos/' + REPO + '/dispatches', {{
          method: 'POST', headers: {{ 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github+json' }},
          body: JSON.stringify({{ event_type: 'analyze', client_payload: {{ ticker }} }})
        }});
        btn.textContent = r.status === 204 ? '已触发 ✓' : '失败';
        if (r.status === 401) localStorage.removeItem('gh_token');
      }} catch(e) {{ btn.textContent = '网络错误'; }}
      setTimeout(() => btn.textContent = '分析', 3000);
    }}

    window.addEventListener('load', () => setTimeout(initCharts, 100));
  </script>
</body>
</html>"""


def _render_signal_detail(s: SignalResult) -> str:
    """为特定信号渲染维度明细表格。"""
    if s.id == "vol_shrink" and s.data.get("down_days", 0) > 0:
        d = s.data
        single_ratio = d.get("single_ratio", 0)
        stage_ratio = d.get("stage_ratio", 0)
        trend_ratio = d.get("trend_ratio")
        score_div = d.get("score_divergence", 0)
        vol20 = d.get("vol20", 0)
        last_down_date = d.get("last_down_date", "—")
        last_down_vol = d.get("last_down_vol", 0)
        avg_down_vol = d.get("avg_down_vol", 0)
        down_days = d.get("down_days", 0)
        avg_recent_wave = d.get("avg_recent_wave")
        avg_prev_wave = d.get("avg_prev_wave")
        trend_detail_data = d.get("trend_detail", {})
        div_detail = d.get("div_detail", {})
        scores = d.get("scores", {})

        def _dot(val, threshold=1.0):
            return "🟢" if val < threshold else "🔴"

        def _fmt_vol(v):
            if v >= 1e8:
                return f"{v/1e8:.2f}亿"
            return f"{v/1e4:.0f}万"

        def _fmt_score(v):
            return f"{v*100:.0f}%"

        # 维度1 详情
        single_detail = f"{last_down_date} 量={_fmt_vol(last_down_vol)}，MA20={_fmt_vol(vol20)}"
        # 维度2 详情
        stage_detail = f"近10日{down_days}天下跌均量={_fmt_vol(avg_down_vol)}，MA20={_fmt_vol(vol20)}"
        # 维度3 详情
        obvious_detail = f"下跌日均量{_fmt_vol(avg_down_vol)} vs MA20×80%={_fmt_vol(vol20*0.8)}"
        # 维度4 详情 — 带波段日期的tooltip气泡
        if trend_ratio is not None and avg_recent_wave is not None:
            td = trend_detail_data
            if td:
                recent_dates = f"({td.get('recent_start','')} ~ {td.get('recent_end','')})"
                prev_dates = f"({td.get('prev_start','')} ~ {td.get('prev_end','')})"
                r_high = td.get('recent_high', 0)
                r_low = td.get('recent_low', 0)
                p_high = td.get('prev_high', 0)
                p_low = td.get('prev_low', 0)
                tooltip_html = (
                    f'<div class="tooltip-wrap">'
                    f'近一轮{recent_dates}={_fmt_vol(avg_recent_wave)}，'
                    f'上一轮{prev_dates}={_fmt_vol(avg_prev_wave)}'
                    f'<div class="tooltip-bubble">'
                    f'<b>近一轮下跌波段</b><br>'
                    f'{td.get("recent_start","")} ~ {td.get("recent_end","")}（{td.get("recent_days",0)}天）<br>'
                    f'价格 {r_high:.1f} → {r_low:.1f}，跌幅 {(r_high-r_low)/r_high*100:.1f}%<br>'
                    f'日均量 {_fmt_vol(avg_recent_wave)}<br><br>'
                    f'<b>上一轮下跌波段</b><br>'
                    f'{td.get("prev_start","")} ~ {td.get("prev_end","")}（{td.get("prev_days",0)}天）<br>'
                    f'价格 {p_high:.1f} → {p_low:.1f}，跌幅 {(p_high-p_low)/p_high*100:.1f}%<br>'
                    f'日均量 {_fmt_vol(avg_prev_wave)}'
                    f'</div></div>'
                )
            else:
                tooltip_html = f"近一轮={_fmt_vol(avg_recent_wave)}，上一轮={_fmt_vol(avg_prev_wave)}"
            trend_cell = f'{trend_ratio*100:.0f}%'
            trend_dot = _dot(trend_ratio)
        else:
            tooltip_html = "波段数据不足"
            trend_cell = "—"
            trend_dot = "⚪"
        # 维度5 详情
        if div_detail:
            div_info = f"价格新低{div_detail['recent_low_price']:.2f}({div_detail['recent_low_date']})量={_fmt_vol(div_detail['recent_low_vol'])}，前低{div_detail['prev_low_price']:.2f}({div_detail['prev_low_date']})量={_fmt_vol(div_detail['prev_low_vol'])}"
        else:
            div_info = "近期未创新低"
        div_dot = "🟢" if score_div > 0 else "🔴"
        div_cell = "是" if score_div > 0 else "否"

        # 权重公式
        s_single = scores.get("single", 0)
        s_stage = scores.get("stage", 0)
        s_obvious = scores.get("obvious", 0)
        s_trend = scores.get("trend", 0)
        s_div = scores.get("divergence", 0)
        conf_pct = int(round(s.confidence * 100))
        formula_html = (
            f'<div class="mt-3 px-3 py-2 bg-gray-50 rounded-lg text-[11px] text-gray-500 leading-relaxed">'
            f'<span class="font-medium text-gray-600">综合评分 = </span>'
            f'量价背离(<b>{_fmt_score(s_div)}</b>)×30% + '
            f'趋势缩量(<b>{_fmt_score(s_trend)}</b>)×25% + '
            f'明显缩量(<b>{_fmt_score(s_obvious)}</b>)×20% + '
            f'阶段缩量(<b>{_fmt_score(s_stage)}</b>)×15% + '
            f'单日缩量(<b>{_fmt_score(s_single)}</b>)×10%'
            f' = <b class="text-gray-800">{conf_pct}%</b>'
            f'</div>'
        )

        return f"""<style>
  .tooltip-wrap {{ position: relative; cursor: help; border-bottom: 1px dashed #9ca3af; display: inline; }}
  .tooltip-bubble {{ display: none; position: absolute; bottom: calc(100% + 8px); left: 0; z-index: 50;
    background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.12);
    padding: 10px 14px; min-width: 280px; font-size: 11px; line-height: 1.6; color: #374151; white-space: nowrap; }}
  .tooltip-bubble::after {{ content: ''; position: absolute; top: 100%; left: 20px;
    border: 6px solid transparent; border-top-color: #fff; }}
  .tooltip-bubble::before {{ content: ''; position: absolute; top: 100%; left: 19px;
    border: 7px solid transparent; border-top-color: #e5e7eb; }}
  .tooltip-wrap:hover .tooltip-bubble {{ display: block; }}
</style>
<div class="mt-3 text-xs">
  {formula_html}
  <table class="w-full border-collapse mt-3" style="table-layout:fixed">
    <colgroup>
      <col style="width:72px">
      <col style="width:48px">
      <col style="width:22%">
      <col>
      <col style="width:50px">
      <col style="width:40px">
    </colgroup>
    <thead><tr class="text-gray-400 border-b border-gray-200">
      <th class="text-left py-1.5 font-medium">观察项</th>
      <th class="text-center py-1.5 font-medium">权重</th>
      <th class="text-left py-1.5 font-medium">判断标准</th>
      <th class="text-left py-1.5 font-medium">数据明细</th>
      <th class="text-center py-1.5 font-medium">比值</th>
      <th class="text-center py-1.5 font-medium">状态</th>
    </tr></thead>
    <tbody class="text-gray-600">
      <tr class="border-b border-gray-50">
        <td class="py-1.5 font-medium text-gray-700">单日缩量</td>
        <td class="text-center py-1.5 text-gray-400">10%</td>
        <td class="py-1.5">最近下跌日量 &lt; MA20</td>
        <td class="py-1.5">{single_detail}</td>
        <td class="text-center py-1.5">{single_ratio*100:.0f}%</td>
        <td class="text-center py-1.5">{_dot(single_ratio)}</td>
      </tr>
      <tr class="border-b border-gray-50">
        <td class="py-1.5 font-medium text-gray-700">阶段缩量</td>
        <td class="text-center py-1.5 text-gray-400">15%</td>
        <td class="py-1.5">近期下跌日均量 &lt; MA20</td>
        <td class="py-1.5">{stage_detail}</td>
        <td class="text-center py-1.5">{stage_ratio*100:.0f}%</td>
        <td class="text-center py-1.5">{_dot(stage_ratio)}</td>
      </tr>
      <tr class="border-b border-gray-50">
        <td class="py-1.5 font-medium text-gray-700">明显缩量</td>
        <td class="text-center py-1.5 text-gray-400">20%</td>
        <td class="py-1.5">下跌日均量 &lt; MA20×80%</td>
        <td class="py-1.5">{obvious_detail}</td>
        <td class="text-center py-1.5">{stage_ratio*100:.0f}%</td>
        <td class="text-center py-1.5">{_dot(stage_ratio, 0.8)}</td>
      </tr>
      <tr class="border-b border-gray-50">
        <td class="py-1.5 font-medium text-gray-700">趋势缩量</td>
        <td class="text-center py-1.5 text-gray-400">25%</td>
        <td class="py-1.5">近一轮下跌量 &lt; 上一轮</td>
        <td class="py-1.5">{tooltip_html}</td>
        <td class="text-center py-1.5">{trend_cell}</td>
        <td class="text-center py-1.5">{trend_dot}</td>
      </tr>
      <tr>
        <td class="py-1.5 font-medium text-gray-700">量价背离</td>
        <td class="text-center py-1.5 text-gray-400">30%</td>
        <td class="py-1.5">价创新低但量不创新低</td>
        <td class="py-1.5">{div_info}</td>
        <td class="text-center py-1.5">{div_cell}</td>
        <td class="text-center py-1.5">{div_dot}</td>
      </tr>
    </tbody>
  </table>
  <p class="text-[10px] text-gray-400 mt-2">MA20 = 20日平均成交量（近1个月量能基准） · MA60 = 60日平均成交量（近3个月中长期量能基准）</p>
</div>"""
    return ""


def _render_signal_card(s: SignalResult, chart_idx: int) -> str:
    emoji = _LIGHT_EMOJI[s.light]
    color_hex = _LIGHT_COLORS[s.light][0]
    conf_pct = int(round(s.confidence * 100))
    bar_html = _render_range_bar(s.confidence, s.thresholds)
    weight_badge = f'<span class="text-[10px] bg-gray-200 text-gray-600 px-1 rounded">×{s.weight}</span>' if s.weight > 1 else ""

    detail_html = _render_signal_detail(s)

    return f"""<div class="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
  <div class="flex items-center justify-between mb-2">
    <div class="flex items-center gap-2">
      <span class="text-lg">{emoji}</span>
      <span class="font-medium text-sm text-gray-800">{s.name}</span>
      {weight_badge}
    </div>
    <span class="text-sm font-bold" style="color:{color_hex}">{conf_pct}%</span>
  </div>
  {bar_html}
  <p class="text-xs text-gray-500 mt-2">{s.description}</p>
  {detail_html}
  <div id="chart-{chart_idx}" class="chart-container"></div>
</div>"""


def _render_right_signal_card(s: SignalResult, chart_idx: int) -> str:
    """右侧信号卡片：HeroUI 风格 Chip + Title + Description + ProgressBar。

    采用 4 态视觉规范，不使用 emoji 状态指示，不展示阈值刻度尺。
    """
    state = _resolve_right_state(s.confidence, s.thresholds)
    chip_label, color_var, color_100_var = _RIGHT_STATE_TABLE[state]
    conf_pct = int(round(s.confidence * 100))

    # 已触发：用次级 surface 强调；其它：默认 surface
    bg_var = "var(--color-surface-secondary)" if state == "success" else "var(--color-surface)"

    weight_badge = (
        f'<span class="text-[10px] px-1 rounded" '
        f'style="background: var(--color-default-100); color: var(--color-default);">×{s.weight}</span>'
        if s.weight > 1
        else ""
    )

    chip_html = (
        f'<span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium" '
        f'style="background: {color_100_var}; color: {color_var};">'
        f'<span class="w-1.5 h-1.5 rounded-full" style="background: {color_var};"></span>'
        f'{chip_label}'
        f'</span>'
    )

    progress_html = (
        f'<div class="flex items-center justify-between mb-1">'
        f'<span class="text-[11px]" style="color: var(--color-default);">确定度</span>'
        f'<output class="text-xs tabular-nums font-medium" style="color: {color_var};">{conf_pct}%</output>'
        f'</div>'
        f'<div class="h-1.5 rounded-full overflow-hidden" style="background: var(--color-default-100);">'
        f'<div class="h-full rounded-full" style="width: {conf_pct}%; background: {color_var};"></div>'
        f'</div>'
    )

    return f"""<div class="rounded-2xl p-4"
     style="border:1px solid var(--color-divider); box-shadow: var(--shadow-xs); background: {bg_var};">
  <div class="flex items-center justify-between mb-2">
    <div class="flex items-center gap-2">
      {chip_html}
      {weight_badge}
    </div>
  </div>
  <h4 class="text-sm font-semibold" style="color: #0f172a;">{s.name}</h4>
  <p class="text-xs mt-1 mb-3" style="color: var(--color-default);">{s.description}</p>
  {progress_html}
  <div id="chart-{chart_idx}" class="chart-container"></div>
</div>"""


def _render_range_bar(confidence: float, thresholds: tuple[float, float]) -> str:
    red_end = thresholds[0] * 100
    yellow_end = thresholds[1] * 100
    pos = confidence * 100

    return f"""<div class="relative h-2 rounded-full overflow-hidden bg-gray-100">
  <div class="absolute inset-y-0 left-0 bg-red-100" style="width:{red_end}%"></div>
  <div class="absolute inset-y-0 bg-amber-100" style="left:{red_end}%;width:{yellow_end - red_end}%"></div>
  <div class="absolute inset-y-0 bg-green-100" style="left:{yellow_end}%;width:{100 - yellow_end}%"></div>
  <div class="absolute inset-y-0 left-0 rounded-full" style="width:{pos}%;background:linear-gradient(90deg,{'#ef4444' if pos < red_end else '#f59e0b' if pos < yellow_end else '#22c55e'},{'#ef4444' if pos < red_end else '#f59e0b' if pos < yellow_end else '#22c55e'})"></div>
</div>
<div class="flex justify-between text-[9px] text-gray-400 mt-0.5">
  <span>🔴 {red_end:.0f}%</span><span>🟡 {yellow_end:.0f}%</span><span>🟢</span>
</div>"""


def _render_strength_bar(strength: float) -> str:
    pos = strength * 100
    return f"""<div class="relative h-3 rounded-full overflow-hidden bg-gray-100">
  <div class="absolute inset-y-0 left-0 bg-red-100" style="width:25%"></div>
  <div class="absolute inset-y-0 bg-amber-100" style="left:25%;width:20%"></div>
  <div class="absolute inset-y-0 bg-yellow-100" style="left:45%;width:15%"></div>
  <div class="absolute inset-y-0 bg-green-100" style="left:60%;width:20%"></div>
  <div class="absolute inset-y-0 bg-emerald-100" style="left:80%;width:20%"></div>
  <div class="absolute top-0.5 w-2 h-2 rounded-full bg-blue-600 shadow-md" style="left:calc({pos}% - 4px)"></div>
</div>"""
