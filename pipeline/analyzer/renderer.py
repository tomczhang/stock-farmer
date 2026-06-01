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
    change_color = "text-green-400" if (change_pct or 0) >= 0 else "text-red-400"

    left_signals = [s for s in signals if s.category == "left"]
    right_signals = [s for s in signals if s.category == "right"]

    left_cards = "\n".join(_render_signal_card(s, i) for i, s in enumerate(left_signals))
    right_cards = "\n".join(_render_signal_card(s, i + 6) for i, s in enumerate(right_signals))

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
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, "SF Pro", "Segoe UI", sans-serif; }}
    .chart-container {{ height: 160px; border-radius: 8px; overflow: hidden; margin-top: 8px; }}
  </style>
</head>
<body class="bg-[#0f1117] text-gray-100 min-h-screen">
  <div class="max-w-3xl mx-auto px-4 py-6 md:py-10">

    <!-- Nav + Quick Analyze -->
    <nav class="flex items-center justify-between mb-6 gap-3">
      <a href="./index.html" class="text-sm text-gray-400 hover:text-blue-400">&larr; 首页</a>
      <form id="quickForm" class="flex items-center gap-2" onsubmit="return handleQuickAnalyze(event)">
        <input id="quickTicker" type="text" placeholder="输入代码 如 AAPL"
               class="bg-[#1a1f2e] border border-gray-600 rounded-lg px-3 py-1.5 text-sm w-36 md:w-44
                      focus:border-blue-500 focus:outline-none text-gray-100 placeholder-gray-500">
        <button type="submit"
                class="bg-blue-600 hover:bg-blue-500 text-white text-sm px-3 py-1.5 rounded-lg transition-colors">
          分析
        </button>
      </form>
    </nav>

    <!-- Header -->
    <header class="mb-6">
      <div class="flex items-baseline gap-3 flex-wrap">
        <h1 class="text-2xl md:text-3xl font-bold">{ticker}</h1>
        <span class="text-gray-400 text-lg">{name}</span>
        <span class="text-xl font-semibold">{price_str}</span>
        <span class="{change_color} text-sm font-medium">{change_str}</span>
      </div>
      <p class="text-gray-500 text-xs mt-1">分析时间：{now}</p>
    </header>

    <!-- Conclusion Card -->
    <section class="bg-[#1a1f2e] rounded-xl border border-gray-700/50 p-5 md:p-6 mb-6">
      <div class="flex items-center gap-3 mb-3">
        <span class="text-3xl">{phase.icon}</span>
        <div>
          <h2 class="text-xl font-bold">{phase.phase}</h2>
          <p class="text-gray-400 text-sm">{phase.action}</p>
        </div>
      </div>
      <p class="text-sm text-blue-300 mb-4">📌 {phase.trigger}</p>
      <div class="mt-3">
        <div class="flex items-center justify-between text-xs text-gray-400 mb-1">
          <span>综合强度</span>
          <span class="font-semibold text-gray-200">{phase.strength_pct}%</span>
        </div>
        {strength_bar}
        <div class="flex justify-between text-[10px] text-gray-500 mt-1">
          <span>🔴 0-25%</span><span>🟡 25-45%</span><span>🟡⭐ 45-60%</span><span>🟢 60-80%</span><span>🟢🟢 80%+</span>
        </div>
      </div>
    </section>

    <!-- Left Side Signals -->
    <section class="mb-6">
      <h3 class="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">左侧信号 · 底部特征</h3>
      <div class="grid grid-cols-1 gap-3">
        {left_cards}
      </div>
    </section>

    <!-- Right Side Signals -->
    <section class="mb-6">
      <h3 class="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">右侧信号 · 趋势确认</h3>
      <div class="grid grid-cols-1 gap-3">
        {right_cards}
      </div>
    </section>

    <!-- Narrative -->
    <section class="bg-[#1a1f2e] rounded-xl border border-gray-700/50 p-5 mb-6">
      <h3 class="text-sm font-semibold text-gray-400 mb-2">综述</h3>
      <p class="text-gray-200 text-sm leading-relaxed">{narrative}</p>
    </section>

    <!-- Footer -->
    <footer class="text-center text-xs text-gray-600 pt-4 border-t border-gray-800">
      <p>仅供参考，不构成投资建议 · stock-farmer · {now}</p>
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
        height: 160,
        layout: {{ background: {{ color: '#141820' }}, textColor: '#9ca3af' }},
        grid: {{ vertLines: {{ color: '#1f293744' }}, horzLines: {{ color: '#1f293744' }} }},
        crosshair: {{ mode: 0 }},
        rightPriceScale: {{ borderColor: '#374151' }},
        timeScale: {{ borderColor: '#374151', timeVisible: false }},
        handleScroll: false,
        handleScale: false,
      }});
      new ResizeObserver(() => chart.applyOptions({{ width: el.clientWidth }})).observe(el);
      return chart;
    }}

    function renderVolumeChart(id, klines) {{
      const chart = createChart(id);
      if (!chart) return;
      const volumes = klines.map((k, i) => {{
        const ma5 = i >= 4 ? klines.slice(i-4, i+1).reduce((s,x) => s+x.volume, 0) / 5 : null;
        const ma20 = i >= 19 ? klines.slice(i-19, i+1).reduce((s,x) => s+x.volume, 0) / 20 : null;
        return {{ time: k.date, value: k.volume, color: k.close >= k.open ? '#22c55e44' : '#ef444444' }};
      }});
      const volSeries = chart.addHistogramSeries({{ priceFormat: {{ type: 'volume' }} }});
      volSeries.setData(volumes);
      // MA5 line
      const ma5Data = klines.map((k, i) => i >= 4 ? {{ time: k.date, value: klines.slice(i-4, i+1).reduce((s,x) => s+x.volume, 0) / 5 }} : null).filter(Boolean);
      const ma5Line = chart.addLineSeries({{ color: '#f59e0b', lineWidth: 1, title: 'MA5' }});
      ma5Line.setData(ma5Data);
      // MA20 line
      const ma20Data = klines.map((k, i) => i >= 19 ? {{ time: k.date, value: klines.slice(i-19, i+1).reduce((s,x) => s+x.volume, 0) / 20 }} : null).filter(Boolean);
      const ma20Line = chart.addLineSeries({{ color: '#3b82f6', lineWidth: 1, title: 'MA20' }});
      ma20Line.setData(ma20Data);
      chart.timeScale().fitContent();
    }}

    function renderPriceWithLevels(id, klines, type) {{
      const chart = createChart(id);
      if (!chart) return;
      const data = klines.map(k => ({{ time: k.date, value: k.close }}));
      const line = chart.addLineSeries({{ color: '#60a5fa', lineWidth: 2 }});
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
      const series = chart.addCandlestickSeries({{ upColor: '#22c55e', downColor: '#ef4444', borderVisible: false, wickUpColor: '#22c55e', wickDownColor: '#ef4444' }});
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
      const line = chart.addLineSeries({{ color: '#a78bfa', lineWidth: 2, title: 'ATR(14)' }});
      line.setData(atrData);
      chart.timeScale().fitContent();
    }}

    function renderVolumeProfile(id, vp) {{
      const el = document.getElementById(id);
      if (!el || !vp.length) {{ if (el) el.innerHTML = '<p class="text-xs text-gray-500 p-2">Volume Profile 数据不可用</p>'; return; }}
      const maxVol = Math.max(...vp.map(b => b.volume));
      el.innerHTML = '<div class="flex flex-col gap-0.5 p-2">' + vp.slice().reverse().map(b => {{
        const pct = b.volume / maxVol * 100;
        return `<div class="flex items-center gap-1"><span class="text-[9px] text-gray-500 w-12 text-right">${{b.price_level.toFixed(1)}}</span><div class="flex-1 h-2.5 bg-gray-800 rounded-sm overflow-hidden"><div class="h-full bg-blue-500/60 rounded-sm" style="width:${{pct}}%"></div></div><span class="text-[9px] text-gray-500 w-8">${{b.pct.toFixed(0)}}%</span></div>`;
      }}).join('') + '</div>';
    }}

    function renderIndexChart(id, indexKlines) {{
      const chart = createChart(id);
      if (!chart || !indexKlines.length) return;
      const data = indexKlines.map(k => ({{ time: k.date, value: k.close }}));
      const line = chart.addLineSeries({{ color: '#60a5fa', lineWidth: 2 }});
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
      const line = chart.addLineSeries({{ color: '#60a5fa', lineWidth: 2 }});
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
      const series = chart.addCandlestickSeries({{ upColor: '#22c55e', downColor: '#ef4444', borderVisible: false, wickUpColor: '#22c55e', wickDownColor: '#ef4444' }});
      series.setData(data);
      const volData = recent.map(k => ({{ time: k.date, value: k.volume, color: k.close >= k.open ? '#22c55e44' : '#ef444444' }}));
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
      const macdData = dif.map((v, i) => ({{ time: klines[i].date, value: v - dea[i], color: (v - dea[i]) >= 0 ? '#22c55e88' : '#ef444488' }}));
      chart.addHistogramSeries({{ priceFormat: {{ minMove: 0.01 }} }}).setData(macdData.slice(26));
      chart.addLineSeries({{ color: '#60a5fa', lineWidth: 1, title: 'DIF' }}).setData(dif.slice(26).map((v, i) => ({{ time: klines[i+26].date, value: v }})));
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


def _render_signal_card(s: SignalResult, chart_idx: int) -> str:
    emoji = _LIGHT_EMOJI[s.light]
    color_hex = _LIGHT_COLORS[s.light][0]
    conf_pct = int(round(s.confidence * 100))
    bar_html = _render_range_bar(s.confidence, s.thresholds)
    weight_badge = f'<span class="text-[10px] bg-gray-700 px-1 rounded">×{s.weight}</span>' if s.weight > 1 else ""

    return f"""<div class="bg-[#141820] rounded-lg border border-gray-700/40 p-4">
  <div class="flex items-center justify-between mb-2">
    <div class="flex items-center gap-2">
      <span class="text-lg">{emoji}</span>
      <span class="font-medium text-sm">{s.name}</span>
      {weight_badge}
    </div>
    <span class="text-sm font-bold" style="color:{color_hex}">{conf_pct}%</span>
  </div>
  {bar_html}
  <p class="text-xs text-gray-400 mt-2">{s.description}</p>
  <div id="chart-{chart_idx}" class="chart-container"></div>
</div>"""


def _render_range_bar(confidence: float, thresholds: tuple[float, float]) -> str:
    red_end = thresholds[0] * 100
    yellow_end = thresholds[1] * 100
    pos = confidence * 100

    return f"""<div class="relative h-2 rounded-full overflow-hidden bg-gray-800">
  <div class="absolute inset-y-0 left-0 bg-red-900/60" style="width:{red_end}%"></div>
  <div class="absolute inset-y-0 bg-amber-900/60" style="left:{red_end}%;width:{yellow_end - red_end}%"></div>
  <div class="absolute inset-y-0 bg-green-900/60" style="left:{yellow_end}%;width:{100 - yellow_end}%"></div>
  <div class="absolute inset-y-0 left-0 rounded-full" style="width:{pos}%;background:linear-gradient(90deg,{'#ef4444' if pos < red_end else '#f59e0b' if pos < yellow_end else '#22c55e'},{'#ef4444' if pos < red_end else '#f59e0b' if pos < yellow_end else '#22c55e'})"></div>
</div>
<div class="flex justify-between text-[9px] text-gray-600 mt-0.5">
  <span>🔴 {red_end:.0f}%</span><span>🟡 {yellow_end:.0f}%</span><span>🟢</span>
</div>"""


def _render_strength_bar(strength: float) -> str:
    pos = strength * 100
    return f"""<div class="relative h-3 rounded-full overflow-hidden bg-gray-800">
  <div class="absolute inset-y-0 left-0 bg-red-900/50" style="width:25%"></div>
  <div class="absolute inset-y-0 bg-amber-900/50" style="left:25%;width:20%"></div>
  <div class="absolute inset-y-0 bg-yellow-900/50" style="left:45%;width:15%"></div>
  <div class="absolute inset-y-0 bg-green-900/50" style="left:60%;width:20%"></div>
  <div class="absolute inset-y-0 bg-emerald-900/50" style="left:80%;width:20%"></div>
  <div class="absolute top-0.5 w-2 h-2 rounded-full bg-white shadow-lg" style="left:calc({pos}% - 4px)"></div>
</div>"""
