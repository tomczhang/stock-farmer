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
  --accent: #2563eb;
  --text-primary: #0f172a;
  --text-secondary: #475569;
  --text-muted: #94a3b8;
  --bg-app: #f8fafc;
}
/* details / summary 自定义视觉 */
details.signal-row > summary { list-style: none; cursor: pointer; }
details.signal-row > summary::-webkit-details-marker { display: none; }
details.signal-row > summary::marker { content: ""; }
details.signal-row > summary.signal-summary {
  column-gap: 12px;
  row-gap: 12px;
}
details.signal-row > summary::after {
  content: "+"; margin-left: 8px; color: var(--text-muted);
  font-weight: 600; font-size: 14px; line-height: 1;
}
details.signal-row[open] > summary::after { content: "−"; }
/* 子信号明细表 tabs filter 隐藏规则 */
table[data-active="left"] tr[data-category="right"] { display: none; }
table[data-active="right"] tr[data-category="left"] { display: none; }
.seg-btn { transition: background 120ms; }
.seg-btn[data-on="1"] {
  background: var(--color-surface);
  box-shadow: var(--shadow-xs);
  color: var(--text-primary);
}
.report-shell {
  max-width: 72rem;
}
.signal-groups-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
}
@media (min-width: 1920px) {
  .report-shell {
    max-width: min(1760px, calc(100vw - 96px));
  }
  .signal-groups-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
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


# --- 左侧信号 3 态视觉规范 (基于 light 字段).
_LEFT_STATE_TABLE: dict[str, tuple[str, str, str]] = {
    "red": ("未触发", "var(--color-default)", "var(--color-default-100)"),
    "yellow": ("观察", "var(--color-warning)", "var(--color-warning-100)"),
    "green": ("确认", "var(--color-success)", "var(--color-success-100)"),
}


def _resolve_left_state(light: str) -> str:
    """把 SignalResult.light 字符串映射为 _LEFT_STATE_TABLE 键。未知值兜底 'red'。"""
    return light if light in _LEFT_STATE_TABLE else "red"


def _compute_confirmation(signals: list[SignalResult]) -> dict:
    """计算左右双侧加权 confidence 与总分。

    各组 score_pct = round(100 * sum(c*w) / sum(w))。空组 score_pct/weight 均为 0。
    confirmed_count = count(s.light == "green")。
    """

    def _group(group_signals: list[SignalResult]) -> dict:
        weight = sum(s.weight for s in group_signals)
        if weight == 0:
            return {
                "score_pct": 0,
                "weight": 0,
                "confirmed_count": 0,
                "total_count": len(group_signals),
            }
        weighted = sum(s.confidence * s.weight for s in group_signals)
        return {
            "score_pct": int(round(100 * weighted / weight)),
            "weight": weight,
            "confirmed_count": sum(1 for s in group_signals if s.light == "green"),
            "total_count": len(group_signals),
        }

    left_signals = [s for s in signals if s.category == "left"]
    right_signals = [s for s in signals if s.category == "right"]
    left = _group(left_signals)
    right = _group(right_signals)

    total_weight = left["weight"] + right["weight"]
    if total_weight == 0:
        score_pct = 0
    else:
        weighted_total = sum(s.confidence * s.weight for s in signals)
        score_pct = int(round(100 * weighted_total / total_weight))

    return {
        "score_pct": score_pct,
        "total_weight": total_weight,
        "left": left,
        "right": right,
    }


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
    klines = (chart_data or {}).get("klines") or []
    if price is None and klines:
        try:
            price = float(klines[-1]["close"])
        except (KeyError, TypeError, ValueError):
            price = None
    if change_pct is None and price is not None and klines:
        try:
            ref_close = float(klines[-1]["close"])
            if abs(float(price) - ref_close) < 1e-9 and len(klines) >= 2:
                ref_close = float(klines[-2]["close"])
            if ref_close:
                change_pct = (float(price) - ref_close) / ref_close * 100
        except (KeyError, TypeError, ValueError):
            change_pct = None

    price_str = f"${price:.2f}" if price else "N/A"
    change_str = f"{change_pct:+.2f}%" if change_pct is not None else ""
    change_color = "text-green-600" if (change_pct or 0) >= 0 else "text-red-600"

    left_signals = [s for s in signals if s.category == "left"]
    right_signals = [s for s in signals if s.category == "right"]

    confirmation = _compute_confirmation(signals)
    hero_html = _render_hero(phase, confirmation)
    left_panel = _render_signal_group_panel("left", left_signals, confirmation["left"], 0)
    right_panel = _render_signal_group_panel("right", right_signals, confirmation["right"], 6)
    detail_table = _render_signal_detail_table(signals)

    design_tokens = _render_design_tokens()

    chart_payload = dict(chart_data or {})
    chart_payload["signal_data"] = {s.id: s.data for s in signals}
    chart_json = json.dumps(chart_payload, ensure_ascii=False, default=str)

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
  <div class="report-shell mx-auto px-6 py-6 md:py-10">

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
        <h1 class="text-2xl md:text-3xl font-bold" style="color: var(--text-primary);">{ticker}</h1>
        <span class="text-lg" style="color: var(--text-secondary);">{name}</span>
        <span class="text-xl font-semibold" style="color: var(--text-primary);">{price_str}</span>
        <span class="{change_color} text-sm font-medium">{change_str}</span>
      </div>
      <p class="text-xs mt-1" style="color: var(--text-muted);">分析时间：{now}</p>
    </header>

    <!-- Hero: 圆环 + 加权公式 + 趋势主图 -->
    {hero_html}

    <!-- Narrative + Next Trigger -->
    <section class="rounded-2xl p-5 mb-6 grid grid-cols-1 md:grid-cols-3 gap-4 items-start"
             style="border: 1px solid var(--color-divider); box-shadow: var(--shadow-xs); background: var(--color-surface);">
      <div class="md:col-span-2">
        <div class="text-[11px] uppercase tracking-wider mb-1.5" style="color: var(--text-muted);">综述</div>
        <p class="text-sm leading-relaxed" style="color: var(--text-secondary);">{narrative}</p>
      </div>
      <div class="md:col-span-1 rounded-xl p-4"
           style="background: var(--color-surface-secondary); border: 1px solid var(--color-divider);">
        <div class="text-[11px] uppercase tracking-wider mb-1" style="color: var(--text-muted);">下一触发</div>
        <strong class="text-sm font-semibold" style="color: var(--text-primary);">{phase.trigger}</strong>
      </div>
    </section>

    <!-- Signal Groups: 左右双大卡 -->
    <div class="signal-groups-grid gap-6 items-start mb-6">
      {left_panel}
      {right_panel}
    </div>

    <!-- 子信号明细表 + tabs -->
    {detail_table}

    <!-- Footer -->
    <footer class="text-center text-xs pt-4" style="color: var(--color-default); border-top: 1px solid var(--color-divider);">
      <p>仅供参考，不构成投资建议 · stock-farmer · {now}</p>
      <p class="text-[10px] mt-1" style="color: var(--color-default);">右侧状态 4 态：未触发 / 酝酿中 / 临界 / 已触发</p>
    </footer>

  </div>

  <script>
    const DATA = {chart_json};
    const CHARTS = {{}};
    const RENDERED_SIGNAL_CHARTS = new Set();
    const VOLUME_SIGNAL_VISIBLE_DAYS = 120;

    function renderSignalChart(idx) {{
      if (RENDERED_SIGNAL_CHARTS.has(idx)) return;
      if (!DATA.klines || !DATA.klines.length) return;
      const klines = DATA.klines;
      const indexKlines = DATA.index_klines || [];
      const vp = DATA.volume_profile || [];
      const idxNum = Number(idx);
      switch (idxNum) {{
        case 0: renderVolumeChart('chart-0', klines); break;
        case 1: renderPriceWithLevels('chart-1', klines, 'no_new_low'); break;
        case 2: renderSupportChart('chart-2', klines, DATA.signal_data?.false_breakdown || {{}}); break;
        case 3: renderATR('chart-3', klines); break;
        case 4: renderVolumeProfile('chart-4', vp); break;
        case 5: renderIndexChart('chart-5', indexKlines); break;
        case 6: renderPriceWithMA('chart-6', klines); break;
        case 7: renderSupportChart('chart-7', klines, DATA.signal_data?.support_retest_hold || DATA.signal_data?.false_breakdown || {{}}); break;
        case 8: renderCandlestickWithVolume('chart-8', klines); break;
        case 9: renderMACD('chart-9', klines); break;
        case 10: renderPriceWithLevels('chart-10', klines, 'higher_low'); break;
        default: return;
      }}
      RENDERED_SIGNAL_CHARTS.add(idx);
    }}

    function renderHero() {{
      if (!DATA.klines || !DATA.klines.length) return;
      renderHeroTrendChart('chart-hero', DATA.klines);
    }}

    function renderHeroTrendChart(id, klines) {{
      const el = document.getElementById(id);
      if (!el) return;
      const w = el.clientWidth || el.parentElement.clientWidth || 600;
      const chart = LightweightCharts.createChart(el, {{
        width: w, height: 320,
        layout: {{ background: {{ color: '#ffffff' }}, textColor: '#94a3b8' }},
        grid: {{ vertLines: {{ color: '#f3f4f6' }}, horzLines: {{ color: '#f3f4f6' }} }},
        crosshair: {{ mode: 0 }},
        rightPriceScale: {{ borderColor: '#e5e7eb' }},
        timeScale: {{ borderColor: '#e5e7eb', timeVisible: false }},
        handleScroll: false, handleScale: false,
        localization: {{ locale: 'zh-CN', dateFormat: 'yyyy-MM-dd' }},
      }});
      // 价格 area
      const area = chart.addAreaSeries({{
        lineColor: '#2563eb', topColor: 'rgba(37,99,235,0.25)', bottomColor: 'rgba(37,99,235,0.02)',
        lineWidth: 2, priceScaleId: 'right',
      }});
      area.priceScale().applyOptions({{ scaleMargins: {{ top: 0.05, bottom: 0.32 }} }});
      area.setData(klines.map(k => ({{ time: k.date, value: k.close }})));
      // 成交量 histogram (下方 ~30%)
      const vol = chart.addHistogramSeries({{ priceFormat: {{ type: 'volume' }}, priceScaleId: 'vol' }});
      vol.priceScale().applyOptions({{ scaleMargins: {{ top: 0.7, bottom: 0 }} }});
      const volumes = klines.map((k, i) => {{
        const isUp = i === 0 ? true : k.close >= klines[i-1].close;
        return {{ time: k.date, value: k.volume, color: isUp ? '#dc262699' : '#16a34a99' }};
      }});
      vol.setData(volumes);
      chart.timeScale().fitContent();
      new ResizeObserver(() => chart.applyOptions({{ width: el.clientWidth }})).observe(el);
    }}

    function attachDetailsToggleListeners() {{
      document.querySelectorAll('details[data-chart-idx]').forEach(d => {{
        d.addEventListener('toggle', () => {{
          if (!d.open) return;
          const idx = d.getAttribute('data-chart-idx');
          // 等浏览器先 layout,让容器拿到实际宽度
          requestAnimationFrame(() => requestAnimationFrame(() => renderSignalChart(idx)));
        }});
      }});
    }}

    function attachSignalDetailTabs() {{
      const table = document.getElementById('signal-detail-table');
      if (!table) return;
      const buttons = document.querySelectorAll('button[data-filter]');
      buttons.forEach(btn => {{
        btn.addEventListener('click', () => {{
          const v = btn.getAttribute('data-filter');
          table.setAttribute('data-active', v);
          buttons.forEach(b => b.removeAttribute('data-on'));
          btn.setAttribute('data-on', '1');
        }});
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

    function createSupportChart(containerId) {{
      const el = document.getElementById(containerId);
      if (!el) return null;
      el.style.height = '360px';
      const w = el.clientWidth || el.parentElement.clientWidth || 600;
      const chart = LightweightCharts.createChart(el, {{
        width: w,
        height: 360,
        layout: {{ background: {{ color: '#ffffff' }}, textColor: '#6b7280' }},
        grid: {{ vertLines: {{ color: '#f3f4f6' }}, horzLines: {{ color: '#f3f4f6' }} }},
        crosshair: {{ mode: 0 }},
        rightPriceScale: {{ borderColor: '#e5e7eb' }},
        timeScale: {{ borderColor: '#e5e7eb', timeVisible: false, rightOffset: 5 }},
        handleScroll: false,
        handleScale: false,
        localization: {{ locale: 'zh-CN', dateFormat: 'yyyy-MM-dd' }},
      }});
      new ResizeObserver(() => chart.applyOptions({{ width: el.clientWidth }})).observe(el);
      return chart;
    }}

    function weekStart(dateStr) {{
      const d = new Date(dateStr + 'T00:00:00');
      const day = d.getDay();
      const diff = (day + 6) % 7;
      d.setDate(d.getDate() - diff);
      return d.toISOString().slice(0, 10);
    }}

    function aggregateWeeklyKlines(klines) {{
      const rows = [];
      let cur = null;
      klines.forEach(k => {{
        const key = weekStart(k.date);
        if (!cur || cur.time !== key) {{
          if (cur) rows.push(cur);
          cur = {{
            time: key,
            start_date: key,
            end_date: k.date,
            open: k.open,
            high: k.high,
            low: k.low,
            close: k.close,
            volume: k.volume || 0,
          }};
        }} else {{
          cur.high = Math.max(cur.high, k.high);
          cur.low = Math.min(cur.low, k.low);
          cur.close = k.close;
          cur.volume += k.volume || 0;
          cur.end_date = k.date;
        }}
      }});
      if (cur) rows.push(cur);
      return rows;
    }}

    function aggregateMonthlyKlines(klines) {{
      const rows = [];
      let cur = null;
      klines.forEach(k => {{
        const key = k.date.slice(0, 7) + '-01';
        if (!cur || cur.time !== key) {{
          if (cur) rows.push(cur);
          cur = {{
            time: key,
            start_date: key,
            end_date: k.date,
            open: k.open,
            high: k.high,
            low: k.low,
            close: k.close,
            volume: k.volume || 0,
          }};
        }} else {{
          cur.high = Math.max(cur.high, k.high);
          cur.low = Math.min(cur.low, k.low);
          cur.close = k.close;
          cur.volume += k.volume || 0;
          cur.end_date = k.date;
        }}
      }});
      if (cur) rows.push(cur);
      return rows;
    }}

    function weekTimeForDate(weeklyRows, dateStr) {{
      const row = weeklyRows.find(w => w.start_date ? (w.start_date <= dateStr && dateStr <= w.end_date) : w.date === dateStr)
        || weeklyRows.find(w => w.end_date ? w.end_date >= dateStr : w.date >= dateStr)
        || weeklyRows[weeklyRows.length - 1];
      return row ? (row.time || row.date || dateStr) : dateStr;
    }}

    function renderVolumeChart(id, klines) {{
      const el = document.getElementById(id);
      if (!el) return;
      const visibleKlines = klines.slice(-VOLUME_SIGNAL_VISIBLE_DAYS);
      const visibleTimes = new Set(visibleKlines.map(k => k.date));
      const visibleOffset = Math.max(0, klines.length - visibleKlines.length);
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
      candleSeries.setData(visibleKlines.map(k => ({{ time: k.date, open: k.open, high: k.high, low: k.low, close: k.close }})));
      // 成交量（占下方30%）— 下跌日红色，上涨日浅灰
      const volumes = visibleKlines.map((k, i) => {{
        const prev = klines[visibleOffset + i - 1] || visibleKlines[i - 1];
        const isDown = prev ? k.close < prev.close : false;
        return {{ time: k.date, value: k.volume, color: isDown ? '#16a34acc' : '#d1d5db' }};
      }});
      const volSeries = chart.addHistogramSeries({{
        priceFormat: {{ type: 'volume' }},
        priceScaleId: 'vol',
      }});
      volSeries.priceScale().applyOptions({{ scaleMargins: {{ top: 0.52, bottom: 0 }} }});
      volSeries.setData(volumes);
      // MA20 成交量均线
      const ma20Data = klines.map((k, i) => i >= 19 ? {{ time: k.date, value: klines.slice(i-19, i+1).reduce((s,x) => s+x.volume, 0) / 20 }} : null).filter(p => p && visibleTimes.has(p.time));
      chart.addLineSeries({{ color: '#2563eb', lineWidth: 2, title: 'MA20', priceScaleId: 'vol' }}).setData(ma20Data);
      // MA60 成交量均线
      const ma60Data = klines.map((k, i) => i >= 59 ? {{ time: k.date, value: klines.slice(i-59, i+1).reduce((s,x) => s+x.volume, 0) / 60 }} : null).filter(p => p && visibleTimes.has(p.time));
      chart.addLineSeries({{ color: '#7c3aed', lineWidth: 2, title: 'MA60', priceScaleId: 'vol' }}).setData(ma60Data);
      chart.timeScale().applyOptions({{ barSpacing: 5, minBarSpacing: 3, rightOffset: 4 }});
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

    function renderSupportChart(id, klines, signalData) {{
      const el = document.getElementById(id);
      const zones = (signalData.display_support_zones || signalData.support_zones || []).filter(z => z.low != null && z.high != null).slice(0, 2);
      const supportFocus = signalData.support_focus || {{}};
      const colors = ['#16a34a', '#f59e0b'];
      if (!el) return;

      const oldMethod = el.parentElement.querySelector('.support-method-panel');
      if (oldMethod) oldMethod.remove();
      if (id === 'chart-2') {{
        const method = document.createElement('div');
        method.className = 'support-method-panel';
        method.style.cssText = 'border:1px solid #dbeafe;border-radius:8px;background:linear-gradient(180deg,#eff6ff 0%,#ffffff 100%);padding:10px 12px;margin:8px 0 10px;color:#334155;font-size:11px;line-height:1.55;';
        const strongText = supportFocus.has_strong_support
          ? '当前已识别到稳定性 ≥60% 的强支撑，若跌破后快速收回，才会在图上标记“破位/收回”。'
          : '当前没有稳定性 ≥60% 的强支撑，所以不在图上标记“破位/收回”。';
        method.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;">'
          + '<div style="font-weight:700;color:#1e3a8a;font-size:12px;">支撑位怎么判断</div>'
          + '<div style="color:#64748b;">强支撑门槛：稳定性 ≥60%</div>'
          + '</div>'
          + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;">'
          + '<div><div style="font-weight:600;color:#0f172a;">1. 先找候选</div><div>前低、平台下沿、整数关口都算候选。候选越接近，说明市场可能在同一价格带反复关注。</div></div>'
          + '<div><div style="font-weight:600;color:#0f172a;">2. 再合并区间</div><div>价格足够接近的候选会合成一个支撑区间；区间太宽会扣分，因为防线不够集中。</div></div>'
          + '<div><div style="font-weight:600;color:#0f172a;">3. 最后看稳定性</div><div>稳定性看证据质量、类型多样性、重复确认和区间宽度；共振表示这些证据在同一区间重合的程度。</div></div>'
          + '</div>'
          + '<div style="margin-top:8px;padding-top:8px;border-top:1px solid #dbeafe;color:#475569;">'
          + strongText + ' 关键观察支撑可以用于跟踪和风控，但不等同于强支撑。'
          + '</div>';
        el.parentElement.insertBefore(method, el);
      }}

      const oldToolbar = el.parentElement.querySelector('.support-zone-toolbar');
      if (oldToolbar) oldToolbar.remove();
      const toolbar = document.createElement('div');
      toolbar.className = 'support-zone-toolbar';
      toolbar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;margin:8px 0;font-size:11px;color:#64748b;';
      toolbar.innerHTML = '<span>结构周期</span><div style="display:inline-flex;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;background:#f8fafc;">'
        + '<button type="button" data-support-tf="day" style="padding:4px 10px;border:0;background:transparent;color:#64748b;font-size:11px;">日K</button>'
        + '<button type="button" data-support-tf="week" style="padding:4px 10px;border:0;background:#111827;color:#fff;font-size:11px;">周K</button>'
        + '<button type="button" data-support-tf="month" style="padding:4px 10px;border:0;background:transparent;color:#64748b;font-size:11px;">月K</button>'
        + '</div>';
      el.parentElement.insertBefore(toolbar, el);

      function drawSupportFrame(tf) {{
        if (CHARTS[id] && typeof CHARTS[id].remove === 'function') CHARTS[id].remove();
        el.innerHTML = '';
        const chart = createSupportChart(id);
        if (!chart) return;
        CHARTS[id] = chart;
        const frameRows = tf === 'day' ? klines : tf === 'month' ? aggregateMonthlyKlines(klines) : aggregateWeeklyKlines(klines);
        const sourceRows = frameRows.length >= 8 ? frameRows : klines;
        const recent = sourceRows.slice(tf === 'day' ? -160 : tf === 'month' ? -72 : -120);
        const data = recent.map(k => ({{ time: k.time || k.date, open: k.open, high: k.high, low: k.low, close: k.close }}));
        const series = chart.addCandlestickSeries({{
          upColor: 'rgba(220, 38, 38, 0)', downColor: '#16a34a',
          borderVisible: true, borderUpColor: '#dc2626', borderDownColor: '#16a34a',
          wickUpColor: '#dc2626', wickDownColor: '#16a34a',
          priceLineVisible: true,
          lastValueVisible: true,
        }});
        series.setData(data);

        zones.forEach((z, i) => {{
          const color = colors[i] || '#64748b';
          series.createPriceLine({{ price: z.low, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '' }});
          series.createPriceLine({{ price: z.high, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '' }});
        }});

        const ev = signalData.breakdown_event || {{}};
        const retest = signalData.retest_event || {{}};
        if (ev.break_date && ev.recover_date && typeof series.setMarkers === 'function') {{
          const markers = [
            {{ time: weekTimeForDate(sourceRows, ev.break_date), position: 'belowBar', color: '#ef4444', shape: 'arrowDown', text: '破位' }},
            {{ time: weekTimeForDate(sourceRows, ev.recover_date), position: 'aboveBar', color: '#16a34a', shape: 'arrowUp', text: '收回' }},
          ];
          if (retest.date && !retest.failed) {{
            markers.push({{ time: weekTimeForDate(sourceRows, retest.date), position: 'belowBar', color: '#2563eb', shape: 'circle', text: '回踩' }});
          }}
          series.setMarkers(markers);
        }}
        chart.timeScale().applyOptions({{ barSpacing: 8, minBarSpacing: 4, rightOffset: 6 }});
        const from = Math.max(0, data.length - (tf === 'day' ? 160 : tf === 'month' ? 72 : 120));
        chart.timeScale().setVisibleLogicalRange({{ from, to: data.length + 6 }});
      }}

      toolbar.querySelectorAll('button[data-support-tf]').forEach(btn => {{
        btn.addEventListener('click', () => {{
          const tf = btn.getAttribute('data-support-tf') || 'week';
          toolbar.querySelectorAll('button[data-support-tf]').forEach(b => {{
            b.style.background = 'transparent';
            b.style.color = '#64748b';
          }});
          btn.style.background = '#111827';
          btn.style.color = '#fff';
          drawSupportFrame(tf);
        }});
      }});

      drawSupportFrame('week');

      const oldLegend = el.parentElement.querySelector('.support-zone-legend');
      if (oldLegend) oldLegend.remove();
      const legend = document.createElement('div');
      legend.className = 'support-zone-legend';
      legend.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;margin-top:10px;font-size:11px;color:#475569;';
      const tooltipStyleId = 'support-zone-tooltip-style';
      if (!document.getElementById(tooltipStyleId)) {{
        const style = document.createElement('style');
        style.id = tooltipStyleId;
        style.textContent = `
          .support-tip {{ position: relative; display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 999px; border: 1px solid #cbd5e1; color: #64748b; font-size: 11px; cursor: help; margin: -2px 2px; vertical-align: middle; }}
          .support-tip-bubble {{ display: none; position: absolute; left: 50%; bottom: calc(100% + 8px); transform: translateX(-50%); width: 220px; padding: 8px 10px; border-radius: 8px; border: 1px solid #e5e7eb; background: #fff; color: #334155; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.14); line-height: 1.5; z-index: 40; }}
          .support-tip-bubble::after {{ content: ''; position: absolute; left: 50%; top: 100%; transform: translateX(-50%); border: 6px solid transparent; border-top-color: #fff; }}
          .support-tip:hover .support-tip-bubble {{ display: block; }}
        `;
        document.head.appendChild(style);
      }}
      if (!zones.length) {{
        legend.innerHTML = '<div style="border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;background:#f9fafb;">支撑区间数据不足</div>';
      }} else {{
        legend.innerHTML = zones.map((z, i) => {{
          const color = colors[i] || '#64748b';
          const sources = (z.sources || []).join(' / ');
          const strength = Math.round((z.strength || 0) * 100);
          const confluence = z.confluence != null ? ' · 共振 ' + Math.round((z.confluence || 0) * 100) + '%' : '';
          const width = z.width_pct ? ' · 宽度 ' + z.width_pct + '%' : '';
          const strengthLabel = z.stability_label || (strength >= 60 ? '强' : strength >= 35 ? '中' : '弱');
          const tip = '支撑稳定性综合前低、平台、整数位、候选重复度和区间宽度。弱：<35%，中：35%–59%，强：≥60%；关键观察支撑表示结构重要但稳定性待确认。';
          const role = z.display_role || '关注支撑';
          return '<div style="border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;background:#f9fafb;">'
            + '<div style="display:flex;align-items:center;gap:6px;font-weight:600;color:#111827;">'
            + '<span style="width:10px;height:10px;border-radius:999px;background:' + color + ';display:inline-block;"></span>'
            + role + ' ' + Number(z.low).toFixed(2) + '–' + Number(z.high).toFixed(2)
            + '</div>'
            + '<div style="margin-top:4px;color:#64748b;">支撑稳定性 '
            + '<span class="support-tip">?<span class="support-tip-bubble">' + tip + '</span></span> '
            + strength + '%（' + strengthLabel + '）' + confluence + width + ' · ' + sources + '</div>'
            + '</div>';
        }}).join('');
        if (supportFocus.has_strong_support === false) {{
          legend.innerHTML += '<div style="border:1px dashed #cbd5e1;border-radius:8px;padding:8px 10px;background:#ffffff;color:#64748b;">'
            + '<div style="font-weight:600;color:#334155;">下个强支撑：暂无</div>'
            + '<div style="margin-top:4px;">当前价格下方未识别到稳定性 ≥60% 的强支撑位。</div>'
            + '</div>';
        }}
      }}
      legend.querySelectorAll('.support-tip').forEach(tip => {{
        const bubble = tip.querySelector('.support-tip-bubble');
        if (!bubble) return;
        tip.setAttribute('tabindex', '0');
        const show = () => {{ bubble.style.display = 'block'; }};
        const hide = () => {{ bubble.style.display = ''; }};
        const toggle = () => {{ bubble.style.display = bubble.style.display === 'block' ? '' : 'block'; }};
        tip.addEventListener('mouseenter', show);
        tip.addEventListener('mouseover', show);
        tip.addEventListener('pointerenter', show);
        tip.addEventListener('pointerover', show);
        tip.addEventListener('mouseleave', hide);
        tip.addEventListener('pointerleave', hide);
        tip.addEventListener('click', toggle);
        tip.addEventListener('focus', show);
        tip.addEventListener('blur', hide);
      }});
      el.parentElement.insertBefore(legend, el.nextSibling);
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

    window.addEventListener('load', () => setTimeout(() => {{
      renderHero();
      attachDetailsToggleListeners();
      attachSignalDetailTabs();
    }}, 100));
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
        single_pct = single_ratio * 100
        stage_pct = stage_ratio * 100
        obvious_base = vol20 * 0.8
        obvious_ratio = avg_down_vol / obvious_base if obvious_base else 0
        obvious_pct = obvious_ratio * 100
        single_detail = (
            f"{last_down_date} 量={_fmt_vol(last_down_vol)}，MA20={_fmt_vol(vol20)}，"
            f"实际/基准={single_pct:.0f}%"
        )
        # 维度2 详情
        stage_detail = (
            f"近10日{down_days}天下跌均量={_fmt_vol(avg_down_vol)}，MA20={_fmt_vol(vol20)}，"
            f"实际/基准={stage_pct:.0f}%"
        )
        # 维度3 详情
        obvious_detail = (
            f"下跌日均量={_fmt_vol(avg_down_vol)}，MA20×80%={_fmt_vol(obvious_base)}，"
            f"实际/基准={obvious_pct:.0f}%"
        )
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
            trend_pct = trend_ratio * 100
            trend_dot = _dot(trend_ratio)
        else:
            tooltip_html = "波段数据不足"
            trend_pct = None
            trend_dot = "⚪"
        trend_detail = (
            f'{tooltip_html}，实际/基准={trend_pct:.0f}%'
            if trend_pct is not None else tooltip_html
        )
        # 维度5 详情
        if div_detail:
            div_info = (
                f"价格新低{div_detail['recent_low_price']:.2f}({div_detail['recent_low_date']})"
                f"量={_fmt_vol(div_detail['recent_low_vol'])}，"
                f"前低{div_detail['prev_low_price']:.2f}({div_detail['prev_low_date']})"
                f"量={_fmt_vol(div_detail['prev_low_vol'])}，"
                f"量价背离={'是' if score_div > 0 else '否'}"
            )
        else:
            div_info = "近期未创新低，量价背离=否"
        div_dot = "🟢" if score_div > 0 else "🔴"

        # 权重公式
        s_single = scores.get("single", 0)
        s_stage = scores.get("stage", 0)
        s_obvious = scores.get("obvious", 0)
        s_trend = scores.get("trend", 0)
        s_div = scores.get("divergence", 0)
        conf_pct = int(round(s.confidence * 100))
        formula_parts = [
            ("量价背离", s_div, "30%"),
            ("趋势缩量", s_trend, "25%"),
            ("明显缩量", s_obvious, "20%"),
            ("阶段缩量", s_stage, "15%"),
            ("单日缩量", s_single, "10%"),
        ]
        formula_items = "".join(
            f'<span class="inline-flex items-center gap-0.5 whitespace-nowrap">'
            f'{label}(<b>{_fmt_score(score)}</b>)×{weight}'
            f'</span>'
            f'<span class="text-gray-300">+</span>'
            for label, score, weight in formula_parts[:-1]
        )
        last_label, last_score, last_weight = formula_parts[-1]
        formula_items += (
            f'<span class="inline-flex items-center gap-0.5 whitespace-nowrap">'
            f'{last_label}(<b>{_fmt_score(last_score)}</b>)×{last_weight}'
            f'</span>'
        )
        formula_html = (
            f'<div class="rounded-xl px-4 py-3 text-[11px] leading-relaxed" '
            f'style="background: var(--color-surface-secondary); border: 1px solid var(--color-divider); color: var(--text-secondary);">'
            f'<div class="flex flex-wrap items-center gap-x-1.5 gap-y-1.5">'
            f'<span class="font-medium" style="color: var(--text-primary);">综合评分 = </span>'
            f'{formula_items}'
            f'<span class="text-gray-300">=</span>'
            f'<b class="inline-flex items-center rounded-md px-1.5 py-0.5 tabular-nums" '
            f'style="background: var(--color-default-100); color: var(--text-primary);">{conf_pct}%</b>'
            f'</div>'
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
<div class="mt-4 text-xs">
  {formula_html}
  <div class="mt-4 overflow-x-auto rounded-xl" style="border: 1px solid var(--color-divider);">
  <table class="w-full min-w-[720px] border-collapse" style="table-layout:fixed">
    <colgroup>
      <col style="width:84px">
      <col style="width:56px">
      <col style="width:22%">
      <col>
      <col style="width:52px">
    </colgroup>
    <thead><tr class="text-gray-400 border-b border-gray-200" style="background: var(--color-surface-secondary);">
      <th class="text-left px-3 py-2.5 font-medium">观察项</th>
      <th class="text-center px-3 py-2.5 font-medium">权重</th>
      <th class="text-left px-3 py-2.5 font-medium">判断标准</th>
      <th class="text-left px-3 py-2.5 font-medium">数据明细</th>
      <th class="text-center px-3 py-2.5 font-medium">状态</th>
    </tr></thead>
    <tbody class="text-gray-600">
      <tr class="border-b border-gray-50">
        <td class="px-3 py-2.5 font-medium text-gray-700">单日缩量</td>
        <td class="text-center px-3 py-2.5 text-gray-400">10%</td>
        <td class="px-3 py-2.5 leading-snug">最近下跌日量 &lt; MA20</td>
        <td class="px-3 py-2.5 leading-snug">{single_detail}</td>
        <td class="text-center px-3 py-2.5">{_dot(single_ratio)}</td>
      </tr>
      <tr class="border-b border-gray-50">
        <td class="px-3 py-2.5 font-medium text-gray-700">阶段缩量</td>
        <td class="text-center px-3 py-2.5 text-gray-400">15%</td>
        <td class="px-3 py-2.5 leading-snug">近期下跌日均量 &lt; MA20</td>
        <td class="px-3 py-2.5 leading-snug">{stage_detail}</td>
        <td class="text-center px-3 py-2.5">{_dot(stage_ratio)}</td>
      </tr>
      <tr class="border-b border-gray-50">
        <td class="px-3 py-2.5 font-medium text-gray-700">明显缩量</td>
        <td class="text-center px-3 py-2.5 text-gray-400">20%</td>
        <td class="px-3 py-2.5 leading-snug">下跌日均量 &lt; MA20×80%</td>
        <td class="px-3 py-2.5 leading-snug">{obvious_detail}</td>
        <td class="text-center px-3 py-2.5">{_dot(stage_ratio, 0.8)}</td>
      </tr>
      <tr class="border-b border-gray-50">
        <td class="px-3 py-2.5 font-medium text-gray-700">趋势缩量</td>
        <td class="text-center px-3 py-2.5 text-gray-400">25%</td>
        <td class="px-3 py-2.5 leading-snug">近一轮下跌量 &lt; 上一轮</td>
        <td class="px-3 py-2.5 leading-snug">{trend_detail}</td>
        <td class="text-center px-3 py-2.5">{trend_dot}</td>
      </tr>
      <tr>
        <td class="px-3 py-2.5 font-medium text-gray-700">量价背离</td>
        <td class="text-center px-3 py-2.5 text-gray-400">30%</td>
        <td class="px-3 py-2.5 leading-snug">价创新低且量能萎缩</td>
        <td class="px-3 py-2.5 leading-snug">{div_info}</td>
        <td class="text-center px-3 py-2.5">{div_dot}</td>
      </tr>
    </tbody>
  </table>
  </div>
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


def _hero_strength_color_var(strength_pct: int) -> str:
    """Hero 圆环色按综合强度区间映射。"""
    if strength_pct < 25:
        return "var(--color-danger)"
    if strength_pct < 60:
        return "var(--color-warning)"
    return "var(--color-success)"


def _render_hero_circle(phase: PhaseResult) -> str:
    """Hero 左侧:SVG 圆环 + 中心 strength_pct + 下方 phase 名 + action。"""
    pct = max(0, min(100, int(phase.strength_pct)))
    radius = 42
    circumference = 2 * 3.141592653589793 * radius  # ≈ 263.89
    offset = circumference * (1 - pct / 100)
    color_var = _hero_strength_color_var(pct)

    return f"""<div class="flex flex-col items-center text-center gap-3 px-2">
  <div class="relative" style="width: 116px; height: 116px;">
    <svg viewBox="0 0 104 104" width="116" height="116" aria-hidden="true">
      <circle cx="52" cy="52" r="{radius}" fill="none" stroke="var(--color-default-100)" stroke-width="8"></circle>
      <circle cx="52" cy="52" r="{radius}" fill="none" stroke="{color_var}" stroke-width="8"
              stroke-linecap="round" transform="rotate(-90 52 52)"
              stroke-dasharray="{circumference:.2f}" stroke-dashoffset="{offset:.2f}"></circle>
    </svg>
    <div class="absolute inset-0 flex items-center justify-center">
      <span class="text-3xl font-bold tabular-nums" style="color: var(--text-primary);">{pct}<span class="text-base font-medium" style="color: var(--text-muted);">%</span></span>
    </div>
  </div>
  <div>
    <div class="text-[11px] uppercase tracking-wider" style="color: var(--text-muted);">右侧趋势确认度</div>
    <div class="text-lg font-bold mt-1" style="color: var(--text-primary);">{phase.phase}</div>
    <div class="text-xs mt-1" style="color: var(--text-secondary);">{phase.action}</div>
  </div>
</div>"""


def _render_hero_meter(side_label: str, group: dict, color_var: str) -> str:
    """单侧 meter:meter-head + 进度条 + K/N 项确认 · 权重 W。"""
    pct = group["score_pct"]
    return f"""<div class="flex flex-col gap-1.5">
  <div class="flex items-center justify-between text-xs" style="color: var(--text-secondary);">
    <span>{side_label}</span>
    <strong class="tabular-nums" style="color: var(--text-primary);">{pct}%</strong>
  </div>
  <div class="h-1.5 rounded-full overflow-hidden" style="background: var(--color-default-100);">
    <div class="h-full rounded-full" style="width: {pct}%; background: {color_var};"></div>
  </div>
  <p class="text-[11px]" style="color: var(--text-muted);">{group["confirmed_count"]}/{group["total_count"]} 项确认 · 权重 {group["weight"]}</p>
</div>"""


def _render_hero_formula(conf: dict) -> str:
    """加权分公式 + 双 meter。"""
    left = conf["left"]
    right = conf["right"]
    formula = (
        f'<span class="font-medium" style="color: var(--text-secondary);">右侧趋势确认度 = </span>'
        f'<strong class="tabular-nums" style="color: var(--text-primary);">{left["score_pct"]}%</strong>'
        f'<span style="color: var(--text-muted);"> × </span>'
        f'<strong class="tabular-nums" style="color: var(--text-primary);">{left["weight"]}</strong>'
        f'<span style="color: var(--text-muted);">权重 + </span>'
        f'<strong class="tabular-nums" style="color: var(--text-primary);">{right["score_pct"]}%</strong>'
        f'<span style="color: var(--text-muted);"> × </span>'
        f'<strong class="tabular-nums" style="color: var(--text-primary);">{right["weight"]}</strong>'
        f'<span style="color: var(--text-muted);">权重</span>'
    )
    left_meter = _render_hero_meter("左侧信号", left, "var(--color-warning)")
    right_meter = _render_hero_meter("右侧信号", right, "var(--color-success)")
    return f"""<div class="flex flex-col gap-3 mt-4">
  <div class="text-xs leading-relaxed" style="color: var(--text-secondary);">{formula}</div>
  <div class="grid grid-cols-2 gap-4">
    {left_meter}
    {right_meter}
  </div>
</div>"""


def _render_hero(phase: PhaseResult, conf: dict) -> str:
    """Hero 双栏:左 1/3 圆环+phase+公式;右 2/3 lightweight-charts 主图容器。"""
    circle = _render_hero_circle(phase)
    formula = _render_hero_formula(conf)
    return f"""<section class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
  <div class="md:col-span-1 rounded-2xl p-5"
       style="border: 1px solid var(--color-divider); box-shadow: var(--shadow-xs); background: var(--color-surface);">
    {circle}
    {formula}
  </div>
  <div class="md:col-span-2 rounded-2xl p-5"
       style="border: 1px solid var(--color-divider); box-shadow: var(--shadow-xs); background: var(--color-surface);">
    <div class="flex items-baseline justify-between mb-2">
      <h3 class="text-sm font-semibold" style="color: var(--text-primary);">价格趋势 · 趋势确认轨迹</h3>
      <span class="text-[11px]" style="color: var(--text-muted);">收盘价 + 成交量</span>
    </div>
    <div id="chart-hero" class="chart-container" style="height: 320px;"></div>
  </div>
</section>"""


def _render_signal_row(s: SignalResult, chart_idx: int, side: str) -> str:
    """双大卡内单行 details:summary 行 + 展开容器(可选 5 维详情 + chart)。"""
    if side == "right":
        state = _resolve_right_state(s.confidence, s.thresholds)
        chip_label, color_var, color_100_var = _RIGHT_STATE_TABLE[state]
    else:
        state = _resolve_left_state(s.light)
        chip_label, color_var, color_100_var = _LEFT_STATE_TABLE[state]

    conf_pct = int(round(s.confidence * 100))

    weight_badge = (
        f'<span class="text-[10px] px-1 rounded ml-1" '
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

    detail_html = _render_signal_detail(s)  # vol_shrink 才返回非空

    return f"""<details class="signal-row" data-chart-idx="{chart_idx}">
  <summary class="signal-summary flex items-start justify-between flex-wrap sm:flex-nowrap py-3"
           style="border-top: 1px solid var(--color-divider);">
    <div class="flex-1 min-w-0">
      <div class="flex items-center gap-1.5 flex-wrap">
        <span class="text-sm font-semibold" style="color: var(--text-primary);">{s.name}</span>
        {weight_badge}
      </div>
      <p class="text-xs mt-1" style="color: var(--text-secondary);">{s.description}</p>
    </div>
    <div class="flex items-center gap-3 shrink-0">
      {chip_html}
      <span class="text-sm font-semibold tabular-nums" style="color: {color_var}; min-width: 42px; text-align: right;">{conf_pct}%</span>
    </div>
  </summary>
  <div class="pb-4 px-1">
    {detail_html}
    <div id="chart-{chart_idx}" class="chart-container"></div>
  </div>
</details>"""


def _render_signal_group_panel(
    side: str,
    signals: list[SignalResult],
    group: dict,
    idx_offset: int,
) -> str:
    """单侧大卡:头部 + 信号列表(details 行)。"""
    side_label = "左侧信号" if side == "left" else "右侧信号"
    rows = "\n".join(
        _render_signal_row(s, i + idx_offset, side) for i, s in enumerate(signals)
    )
    return f"""<section class="rounded-2xl p-5"
         style="border: 1px solid var(--color-divider); box-shadow: var(--shadow-xs); background: var(--color-surface);">
  <header class="flex items-start justify-between gap-3 mb-3">
    <div>
      <div class="text-[11px] uppercase tracking-wider" style="color: var(--text-muted);">{side_label}</div>
      <h2 class="text-2xl font-bold mt-1 tabular-nums" style="color: var(--text-primary);">
        {group["score_pct"]}%
        <span class="text-sm font-medium ml-1" style="color: var(--text-secondary);">加权分</span>
      </h2>
    </div>
    <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs"
          style="background: var(--color-default-100); color: var(--text-secondary);">
      权重 <strong class="ml-0.5" style="color: var(--text-primary);">{group["weight"]}</strong>
    </span>
  </header>
  <div>
    {rows}
  </div>
</section>"""


def _render_signal_detail_table(signals: list[SignalResult]) -> str:
    """子信号明细表 + 全部/左/右 tabs。"""

    def _row(s: SignalResult) -> str:
        if s.category == "right":
            state = _resolve_right_state(s.confidence, s.thresholds)
            chip_label, color_var, color_100_var = _RIGHT_STATE_TABLE[state]
            cat_label = "右侧"
        else:
            state = _resolve_left_state(s.light)
            chip_label, color_var, color_100_var = _LEFT_STATE_TABLE[state]
            cat_label = "左侧"
        pct = int(round(s.confidence * 100))
        chip = (
            f'<span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium" '
            f'style="background: {color_100_var}; color: {color_var};">'
            f'<span class="w-1.5 h-1.5 rounded-full" style="background: {color_var};"></span>'
            f'{chip_label}</span>'
        )
        meter = (
            f'<div class="flex items-center gap-2">'
            f'<div class="flex-1 h-1.5 rounded-full overflow-hidden" style="background: var(--color-default-100); min-width: 80px;">'
            f'<div class="h-full rounded-full" style="width: {pct}%; background: {color_var};"></div>'
            f'</div>'
            f'<span class="text-xs tabular-nums shrink-0" style="color: {color_var}; min-width: 36px; text-align: right;">{pct}%</span>'
            f'</div>'
        )
        return f"""<tr data-category="{s.category}" style="border-top: 1px solid var(--color-divider);">
  <td class="py-2.5 pr-3 align-top" style="min-width: 220px;">
    <div class="text-sm font-semibold" style="color: var(--text-primary);">{s.name}</div>
    <div class="text-[11px] mt-0.5" style="color: var(--text-secondary);">{s.description}</div>
  </td>
  <td class="py-2.5 pr-3 text-xs align-top" style="color: var(--text-secondary);">{cat_label}</td>
  <td class="py-2.5 pr-3 text-xs tabular-nums align-top" style="color: var(--text-secondary);">{s.weight}x</td>
  <td class="py-2.5 pr-3 align-top">{chip}</td>
  <td class="py-2.5 align-top" style="min-width: 140px;">{meter}</td>
</tr>"""

    rows = "\n".join(_row(s) for s in signals)

    tabs_html = """<div class="inline-flex items-center gap-0 p-1 rounded-lg"
       style="background: var(--color-default-100);" role="tablist" aria-label="信号筛选">
    <button type="button" class="seg-btn px-3 py-1 rounded-md text-xs font-medium" data-filter="all" data-on="1" style="color: var(--text-secondary);">全部</button>
    <button type="button" class="seg-btn px-3 py-1 rounded-md text-xs font-medium" data-filter="left" style="color: var(--text-secondary);">左侧</button>
    <button type="button" class="seg-btn px-3 py-1 rounded-md text-xs font-medium" data-filter="right" style="color: var(--text-secondary);">右侧</button>
  </div>"""

    return f"""<section class="rounded-2xl p-5 mt-6"
         style="border: 1px solid var(--color-divider); box-shadow: var(--shadow-xs); background: var(--color-surface);">
  <header class="flex items-start justify-between gap-3 mb-4 flex-wrap">
    <div>
      <div class="text-[11px] uppercase tracking-wider" style="color: var(--text-muted);">子信号明细</div>
      <h2 class="text-base font-semibold mt-1" style="color: var(--text-primary);">权重、确认度与状态</h2>
    </div>
    {tabs_html}
  </header>
  <div class="overflow-x-auto">
    <table id="signal-detail-table" class="w-full text-left" data-active="all" style="border-collapse: collapse;">
      <thead>
        <tr style="color: var(--text-muted);">
          <th class="text-[11px] font-medium py-2 pr-3 uppercase tracking-wider">信号</th>
          <th class="text-[11px] font-medium py-2 pr-3 uppercase tracking-wider">类别</th>
          <th class="text-[11px] font-medium py-2 pr-3 uppercase tracking-wider">权重</th>
          <th class="text-[11px] font-medium py-2 pr-3 uppercase tracking-wider">状态</th>
          <th class="text-[11px] font-medium py-2 uppercase tracking-wider">确认度</th>
        </tr>
      </thead>
      <tbody>
        {rows}
      </tbody>
    </table>
  </div>
</section>"""


# DEPRECATED: 旧版独立信号卡渲染函数。port-codex-design-to-static-report 之后,
# render_html 不再调用它。保留代码以满足前一个 spec (heroui-right-signals-redesign) 的兼容。
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
