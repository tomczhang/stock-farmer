"""金字塔回测 HTML 报告渲染（复用 HeroUI v3 设计 token + lightweight-charts）。"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from .renderer import _render_design_tokens

_ACTION_LABELS = {
    "buy": ("建仓", "var(--color-success)"),
    "add": ("加仓", "var(--color-success)"),
    "trim": ("减仓", "var(--color-warning)"),
    "stop_loss": ("止损清仓", "var(--color-danger)"),
}

_EVENT_LABELS = {
    "stop_buy": "🚫 停止买入红线",
    "trim_start": "📤 倒金字塔减仓启动",
    "stop_loss": "🛑 支撑失效止损",
    "skip_buy": "⏭ 跳过买入",
}


def _fmt_money(v: Any) -> str:
    if v is None:
        return "—"
    return f"{float(v):,.2f}"


def _conclusion(payload: dict[str, Any]) -> tuple[str, str]:
    """(结论文案, 主色)"""
    summary = payload["summary"]
    if not summary["entered"]:
        return summary.get("reason", "未入场"), "var(--color-default)"
    if summary["stop_loss_triggered"]:
        return "支撑失效，触发止损清仓退出", "var(--color-danger)"
    parts = []
    if summary["negative_cost"]:
        parts.append("底仓已做成负成本")
    elif summary["trim_started"]:
        parts.append("已分批止盈回收本金")
    if summary["stop_buy_triggered"]:
        parts.append("停止买入红线已执行（未追高）")
    if not parts:
        parts.append("持仓推演至窗口结束")
    return "，".join(parts), "var(--color-success)"


def _render_summary_banner(payload: dict[str, Any]) -> str:
    summary = payload["summary"]
    text, color = _conclusion(payload)
    pnl = summary.get("pnl")
    pnl_pct = summary.get("pnl_pct")
    pnl_str = (
        f"{_fmt_money(pnl)}（{pnl_pct:+.2f}%）" if pnl is not None and pnl_pct is not None
        else "—"
    )
    net_cost = summary.get("net_cost")
    net_cost_str = f"{net_cost:,.4f}" if net_cost is not None else "—（无持仓）"
    cells = [
        ("总投入", _fmt_money(summary.get("invested"))),
        ("已收回", _fmt_money(summary.get("recovered"))),
        ("窗口末估值", _fmt_money(summary.get("end_value"))),
        ("总盈亏", pnl_str),
        ("剩余底仓", f"{summary.get('shares', 0)} 股"),
        ("底仓净成本", net_cost_str),
    ]
    cells_html = "".join(
        f'<div class="rounded-xl px-4 py-3" style="background: var(--color-surface-secondary); border: 1px solid var(--color-divider);">'
        f'<div class="text-[11px]" style="color: var(--text-muted);">{label}</div>'
        f'<div class="text-sm font-semibold tabular-nums mt-0.5" style="color: var(--text-primary);">{value}</div>'
        f"</div>"
        for label, value in cells
    )
    flags = []
    if summary.get("stop_buy_triggered"):
        flags.append('<span class="text-[11px] px-2 py-0.5 rounded-full" style="background: var(--color-warning-100); color: var(--color-warning);">红线触发</span>')
    if summary.get("stop_loss_triggered"):
        flags.append('<span class="text-[11px] px-2 py-0.5 rounded-full" style="background: var(--color-danger-100); color: var(--color-danger);">止损退出</span>')
    if summary.get("negative_cost"):
        flags.append('<span class="text-[11px] px-2 py-0.5 rounded-full" style="background: var(--color-success-100); color: var(--color-success);">负成本底仓</span>')
    return f"""<section class="rounded-2xl p-5 mb-6" style="border: 1px solid var(--color-divider); border-left: 4px solid {color}; box-shadow: var(--shadow-xs); background: var(--color-surface);">
  <div class="text-[11px] uppercase tracking-wider" style="color: var(--text-muted);">金字塔回测结论</div>
  <div class="flex items-center gap-2 flex-wrap mt-1">
    <h2 class="text-xl font-bold" style="color: var(--text-primary);">{text}</h2>
    {' '.join(flags)}
  </div>
  <div class="grid grid-cols-2 md:grid-cols-6 gap-3 mt-4">{cells_html}</div>
</section>"""


def _render_entry_card(payload: dict[str, Any]) -> str:
    entry = payload.get("entry")
    if not entry:
        return ""
    target = entry.get("target") or {}
    support = entry.get("support") or {}
    src_label = "技术压力位" if target.get("source") == "technical" else "回退（入场价+20%）"
    return f"""<section class="rounded-2xl p-5 mb-6" style="border: 1px solid var(--color-divider); box-shadow: var(--shadow-xs); background: var(--color-surface);">
  <div class="text-[11px] uppercase tracking-wider mb-2" style="color: var(--text-muted);">入场与锚点</div>
  <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm" style="color: var(--text-secondary);">
    <div>手动决策日 <strong style="color: var(--text-primary);">{entry.get('decision_date', '—')}</strong><br/>
      <span class="text-xs">用户选择日期 · 系统不判断买点</span></div>
    <div>入场价 <strong style="color: var(--text-primary);">{entry.get('fill_price', '—')}</strong><br/>
      <span class="text-xs">次日开盘成交</span></div>
    <div>目标价 <strong style="color: var(--text-primary);">{target.get('price', '—')}</strong><br/>
      <span class="text-xs">{src_label}：{target.get('basis', '')}</span></div>
    <div>止损锚 <strong style="color: var(--text-primary);">{support.get('price', '—')}</strong><br/>
      <span class="text-xs">支撑来源：{support.get('source', '—')}，推演期内不移动</span></div>
  </div>
</section>"""


def _render_trades_table(payload: dict[str, Any]) -> str:
    rows = []
    for t in payload.get("trades", []):
        label, color = _ACTION_LABELS.get(t["action"], (t["action"], "var(--color-default)"))
        rows.append(
            f'<tr style="border-top: 1px solid var(--color-divider);">'
            f'<td class="px-3 py-2 text-xs">{t["date"]}</td>'
            f'<td class="px-3 py-2 text-xs font-semibold" style="color: {color};">{label}</td>'
            f'<td class="px-3 py-2 text-xs tabular-nums">{t["price"]}</td>'
            f'<td class="px-3 py-2 text-xs tabular-nums">{t["shares"]}</td>'
            f'<td class="px-3 py-2 text-xs tabular-nums">{_fmt_money(t["amount"])}</td>'
            f'<td class="px-3 py-2 text-xs" style="color: var(--text-secondary);">{t["reason"]}</td>'
            f"</tr>"
        )
    if not rows:
        rows.append(
            '<tr><td colspan="6" class="px-3 py-4 text-xs text-center" '
            'style="color: var(--text-muted);">无交易记录</td></tr>'
        )
    return f"""<section class="rounded-2xl p-5 mb-6" style="border: 1px solid var(--color-divider); box-shadow: var(--shadow-xs); background: var(--color-surface);">
  <div class="text-[11px] uppercase tracking-wider mb-2" style="color: var(--text-muted);">逐笔账本</div>
  <div class="overflow-x-auto">
  <table class="w-full text-left">
    <thead><tr class="text-[11px]" style="color: var(--text-muted);">
      <th class="px-3 py-1.5">成交日</th><th class="px-3 py-1.5">动作</th>
      <th class="px-3 py-1.5">价格</th><th class="px-3 py-1.5">股数</th>
      <th class="px-3 py-1.5">金额</th><th class="px-3 py-1.5">原因</th>
    </tr></thead>
    <tbody>{''.join(rows)}</tbody>
  </table>
  </div>
</section>"""


def _render_events(payload: dict[str, Any]) -> str:
    items = []
    for e in payload.get("events", []):
        label = _EVENT_LABELS.get(e.get("type"), e.get("type", ""))
        detail = e.get("reason", "")
        items.append(
            f'<li class="flex items-baseline gap-3 py-1.5" style="border-top: 1px dashed var(--color-divider);">'
            f'<span class="text-xs whitespace-nowrap tabular-nums" style="color: var(--text-muted);">{e.get("date", "")}</span>'
            f'<span class="text-xs font-semibold" style="color: var(--text-primary);">{label}</span>'
            f'<span class="text-xs" style="color: var(--text-secondary);">{detail}</span></li>'
        )
    if not items:
        return ""
    return f"""<section class="rounded-2xl p-5 mb-6" style="border: 1px solid var(--color-divider); box-shadow: var(--shadow-xs); background: var(--color-surface);">
  <div class="text-[11px] uppercase tracking-wider mb-1" style="color: var(--text-muted);">纪律事件</div>
  <ul>{''.join(items)}</ul>
</section>"""


def _render_assumptions(payload: dict[str, Any]) -> str:
    chips = "".join(
        f'<span class="text-[11px] px-2 py-0.5 rounded-full" style="background: var(--color-surface-secondary); border: 1px solid var(--color-divider); color: var(--text-secondary);">{a}</span>'
        for a in payload.get("assumptions", [])
    )
    return f"""<section class="rounded-xl px-4 py-3 mb-6 flex flex-wrap items-center gap-2" style="border: 1px solid var(--color-divider); background: var(--color-surface);">
  <span class="text-[11px] font-semibold" style="color: var(--text-muted);">执行假设</span>
  {chips}
  <span class="text-[11px]" style="color: var(--text-muted);">{payload.get('disclaimer', '')}</span>
</section>"""


def render_pyramid_html(payload: dict[str, Any]) -> str:
    """渲染金字塔回测单页 HTML 报告。"""
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    ticker = payload["ticker"]
    window = payload.get("window", {})
    tokens = _render_design_tokens()

    entry = payload.get("entry") or {}
    target = (entry.get("target") or {}).get("price")
    support = (entry.get("support") or {}).get("price")
    fill = entry.get("fill_price")
    stop_buy_progress = (payload.get("params") or {}).get("stop_buy_progress", 0.8)
    redline = (
        round(fill + (target - fill) * stop_buy_progress, 4)
        if fill is not None and target is not None else None
    )

    chart_json = json.dumps({
        "klines": (payload.get("chart_data") or {}).get("klines", []),
        "trades": payload.get("trades", []),
        "ledger": payload.get("ledger_series", []),
        "lines": {"target": target, "support": support, "redline": redline},
    }, ensure_ascii=False, default=str)

    summary_banner = _render_summary_banner(payload)
    entry_card = _render_entry_card(payload)
    trades_table = _render_trades_table(payload)
    events_html = _render_events(payload)
    assumptions_html = _render_assumptions(payload)

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{ticker} 金字塔回测 — stock-farmer</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://unpkg.com/lightweight-charts@4/dist/lightweight-charts.standalone.production.js"></script>
  {tokens}
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, "SF Pro", "Segoe UI", sans-serif; }}
    .chart-container {{ height: 340px; border-radius: 8px; overflow: hidden; border: 1px solid var(--color-divider); }}
  </style>
</head>
<body class="bg-gray-50 text-gray-900 min-h-screen">
  <div class="report-shell mx-auto px-6 py-6 md:py-10" style="max-width: 1080px;">
    <header class="mb-6 flex items-baseline gap-3 flex-wrap">
      <h1 class="text-2xl md:text-3xl font-bold" style="color: var(--text-primary);">{ticker}</h1>
      <span class="text-sm" style="color: var(--text-secondary);">金字塔交易回测 · as-of {payload.get('effective_date', '')}</span>
      <span class="text-xs" style="color: var(--text-muted);">窗口 {window.get('start', '')} → {window.get('end', '')} · 生成于 {now}</span>
    </header>

    {summary_banner}
    {assumptions_html}
    {entry_card}

    <section class="rounded-2xl p-5 mb-6" style="border: 1px solid var(--color-divider); box-shadow: var(--shadow-xs); background: var(--color-surface);">
      <div class="flex items-baseline justify-between mb-2">
        <h3 class="text-sm font-semibold" style="color: var(--text-primary);">K 线与买卖点</h3>
        <span class="text-[11px]" style="color: var(--text-muted);">▲ 买入 · ▼ 卖出 · 虚线：目标价 / 支撑 / 红线</span>
      </div>
      <div id="chart-kline" class="chart-container"></div>
    </section>

    <section class="rounded-2xl p-5 mb-6" style="border: 1px solid var(--color-divider); box-shadow: var(--shadow-xs); background: var(--color-surface);">
      <div class="flex items-baseline justify-between mb-2">
        <h3 class="text-sm font-semibold" style="color: var(--text-primary);">持仓成本线</h3>
        <span class="text-[11px]" style="color: var(--text-muted);">成本随加仓抬升、随减仓回收下降，可降为负值</span>
      </div>
      <div id="chart-cost" class="chart-container" style="height: 240px;"></div>
    </section>

    {events_html}
    {trades_table}

    <footer class="text-center text-xs pt-4" style="color: var(--color-default); border-top: 1px solid var(--color-divider);">
      <p>{payload.get('disclaimer', '')}</p>
      <p class="text-[10px] mt-1">stock-farmer · {now}</p>
    </footer>
  </div>

  <script>
    const DATA = {chart_json};
    function renderKline() {{
      const el = document.getElementById('chart-kline');
      if (!el || !DATA.klines.length) return;
      const chart = LightweightCharts.createChart(el, {{
        layout: {{ background: {{ color: '#ffffff' }}, textColor: '#6b7280' }},
        grid: {{ vertLines: {{ color: '#f3f4f6' }}, horzLines: {{ color: '#f3f4f6' }} }},
        height: 340,
      }});
      const series = chart.addCandlestickSeries({{
        upColor: '#16a34a', downColor: '#dc2626',
        wickUpColor: '#16a34a', wickDownColor: '#dc2626', borderVisible: false,
      }});
      series.setData(DATA.klines.map(k => ({{
        time: k.date, open: k.open, high: k.high, low: k.low, close: k.close,
      }})));
      const lineDefs = [
        ['target', '目标价', '#d97706'],
        ['redline', '停止买入红线', '#dc2626'],
        ['support', '止损支撑', '#2563eb'],
      ];
      for (const [key, title, color] of lineDefs) {{
        const price = DATA.lines[key];
        if (price) series.createPriceLine({{ price, title, color, lineStyle: 2, lineWidth: 1 }});
      }}
      series.setMarkers(DATA.trades.map(t => ({{
        time: t.date,
        position: (t.action === 'buy' || t.action === 'add') ? 'belowBar' : 'aboveBar',
        shape: (t.action === 'buy' || t.action === 'add') ? 'arrowUp' : 'arrowDown',
        color: t.action === 'stop_loss' ? '#dc2626'
          : (t.action === 'trim' ? '#d97706' : '#16a34a'),
        text: (t.action === 'buy' ? '建' : t.action === 'add' ? '加' : t.action === 'trim' ? '减' : '损') + t.shares,
      }})));
      chart.timeScale().fitContent();
    }}
    function renderCost() {{
      const el = document.getElementById('chart-cost');
      const rows = DATA.ledger.filter(r => r.net_cost !== null);
      if (!el || !rows.length) {{ if (el) el.style.display = 'none'; return; }}
      const chart = LightweightCharts.createChart(el, {{
        layout: {{ background: {{ color: '#ffffff' }}, textColor: '#6b7280' }},
        grid: {{ vertLines: {{ color: '#f3f4f6' }}, horzLines: {{ color: '#f3f4f6' }} }},
        height: 240,
      }});
      const close = chart.addLineSeries({{ color: '#9ca3af', lineWidth: 1, title: '收盘价' }});
      close.setData(DATA.ledger.map(r => ({{ time: r.date, value: r.close }})));
      const cost = chart.addLineSeries({{ color: '#2563eb', lineWidth: 2, title: '持仓净成本' }});
      cost.setData(rows.map(r => ({{ time: r.date, value: r.net_cost }})));
      chart.timeScale().fitContent();
    }}
    window.addEventListener('load', () => {{ renderKline(); renderCost(); }});
  </script>
</body>
</html>"""
