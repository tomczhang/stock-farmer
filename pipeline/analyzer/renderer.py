"""筑底结构静态 HTML 报告渲染器。"""
from __future__ import annotations

from dataclasses import asdict
from html import escape
import json
from typing import Any

from .bottoming import BottomingVerdict
from .signals import SignalResult


def _render_design_tokens() -> str:
    """供金字塔静态报告复用的轻量设计 token。"""
    return """<style>:root{
      --color-default:#64748b;--color-default-100:#f1f5f9;
      --color-success:#15803d;--color-success-100:#dcfce7;
      --color-warning:#b45309;--color-warning-100:#fef3c7;
      --color-danger:#b91c1c;--color-danger-100:#fee2e2;
      --color-surface:#fff;--color-surface-secondary:#f8fafc;
      --color-divider:#e2e8f0;--text-primary:#0f172a;
      --text-secondary:#475569;--text-muted:#64748b;
      --radius-card:18px;--shadow-xs:0 1px 2px rgba(15,23,42,.06)
    }</style>"""


def render_html(
    ticker: str,
    name: str,
    price: float | None,
    change_pct: float | None,
    signals: list[SignalResult],
    narrative: str,
    chart_data: dict[str, Any] | None = None,
    report_context: dict[str, Any] | None = None,
    bottoming_history: dict[str, Any] | None = None,
    bottoming: BottomingVerdict | None = None,
) -> str:
    """渲染单页筑底结构报告。"""
    if bottoming is None:
        raise ValueError("bottoming verdict is required")

    chart_data = chart_data or {}
    report_context = report_context or {}
    bottoming_history = bottoming_history or {"window": 0, "points": []}
    payload = {
        "klines": chart_data.get("klines", []),
        "history": bottoming_history.get("points", []),
    }
    payload_json = json.dumps(payload, ensure_ascii=False, default=str).replace("</", "<\\/")

    price_text = "—" if price is None else f"{price:,.2f}"
    change_text = "—" if change_pct is None else f"{change_pct:+.2f}%"
    mode = "历史复盘" if report_context.get("mode") == "historical" else "当前分析"
    effective = report_context.get("effective_date") or "—"

    sign_cards = "".join(_render_bottoming_sign(sign) for sign in bottoming.signs)
    evidence_cards = "".join(_render_evidence(signal) for signal in signals)

    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>{escape(ticker)} 筑底结构报告</title>
  <script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
  <style>
    :root {{
      --color-default:#64748b; --color-default-100:#f1f5f9;
      --color-success:#15803d; --color-success-100:#dcfce7;
      --color-warning:#b45309; --color-warning-100:#fef3c7;
      --color-danger:#b91c1c; --color-danger-100:#fee2e2;
      --color-surface:#ffffff; --color-surface-secondary:#f8fafc;
      --color-divider:#e2e8f0; --radius-card:18px;
      --shadow-xs:0 1px 2px rgba(15,23,42,.06);
      --text:#0f172a; --muted:#64748b; --bg:#f6f7f9;
    }}
    * {{ box-sizing:border-box }}
    body {{ margin:0; background:var(--bg); color:var(--text); font:14px/1.6 ui-sans-serif,system-ui,-apple-system,"PingFang SC",sans-serif }}
    main {{ max-width:1120px; margin:0 auto; padding:32px 20px 56px }}
    .hero,.panel,.card {{ background:var(--color-surface); border:1px solid var(--color-divider); border-radius:var(--radius-card); box-shadow:var(--shadow-xs) }}
    .hero {{ padding:28px; display:grid; grid-template-columns:1fr auto; gap:20px; align-items:center }}
    .eyebrow {{ color:var(--muted); font-size:12px; letter-spacing:.08em; text-transform:uppercase }}
    h1 {{ margin:4px 0 6px; font-size:30px }} h2 {{ margin:0 0 14px; font-size:20px }}
    .quote {{ text-align:right }} .quote strong {{ display:block; font-size:28px }}
    .verdict {{ margin-top:18px; padding:24px }}
    .verdict-head {{ display:grid; grid-template-columns:1fr minmax(240px,360px); gap:28px }}
    .tier {{ display:flex; align-items:center; gap:10px; font-size:24px; font-weight:750 }}
    .meter {{ height:10px; background:#e2e8f0; border-radius:999px; overflow:hidden }}
    .meter span {{ display:block; height:100%; background:var(--color-success); border-radius:inherit }}
    .caption,.muted {{ color:var(--muted) }}
    .grid {{ display:grid; grid-template-columns:repeat(3,1fr); gap:14px; margin-top:16px }}
    .card {{ padding:18px }} .card h3 {{ margin:0 0 5px; font-size:16px }}
    .chip {{ display:inline-flex; align-items:center; border-radius:999px; padding:3px 9px; font-size:12px; background:var(--color-default-100); color:var(--color-default) }}
    .chip.early {{ background:var(--color-warning-100); color:var(--color-warning) }}
    .chip.clear {{ background:var(--color-success-100); color:var(--color-success) }}
    .section {{ margin-top:18px; padding:24px }}
    .evidence {{ display:grid; grid-template-columns:repeat(2,1fr); gap:12px }}
    .evidence .card {{ box-shadow:none }}
    .narrative {{ font-size:15px; line-height:1.8; margin:0 }}
    #price-chart,#history-chart {{ height:360px }}
    footer {{ margin-top:18px; color:var(--muted); text-align:center; font-size:12px }}
    @media(max-width:760px) {{ .hero,.verdict-head {{ grid-template-columns:1fr }} .quote {{ text-align:left }} .grid,.evidence {{ grid-template-columns:1fr }} }}
  </style>
</head>
<body>
<main>
  <section class="hero">
    <div><div class="eyebrow">筑底结构诊断 · 规则版本 2</div><h1>{escape(ticker)} · {escape(name)}</h1><div class="muted">{mode} · 有效交易日 {escape(str(effective))}</div></div>
    <div class="quote"><strong>{price_text}</strong><span>{change_text}</span></div>
  </section>

  <section class="panel verdict">
    <div class="verdict-head">
      <div><div class="eyebrow">当前结论</div><div class="tier"><span>{escape(bottoming.icon)}</span>{escape(bottoming.tier_label)}</div><p>{escape(bottoming.action)}</p><p class="muted">下一项观察：{escape(bottoming.next_observation)}</p></div>
      <div><div style="display:flex;justify-content:space-between"><strong>筑底结构强度</strong><strong>{bottoming.cleanliness_pct}%</strong></div><div class="meter"><span style="width:{bottoming.cleanliness_pct}%"></span></div><p class="caption">仅描述当前结构，不代表准确率、胜率、买入时机或上涨概率。</p></div>
    </div>
    <div class="grid">{sign_cards}</div>
  </section>

  <section class="panel section"><h2>结构综述</h2><p class="narrative">{escape(narrative)}</p></section>
  <section class="panel section"><h2>价格位置</h2><div id="price-chart"></div></section>
  <section class="panel section"><h2>证据明细</h2><div class="evidence">{evidence_cards}</div></section>
  <section class="panel section"><h2>筑底历史 · 证伪镜</h2><p class="muted">逐日只使用当时可见数据；后续涨跌仅作事后证伪，不参与当天结论。</p><div id="history-chart"></div></section>
  <footer>仅供研究复盘，不构成投资建议或收益承诺。</footer>
</main>
<script>
const DATA={payload_json};
const rows=DATA.klines||[];
const priceChart=echarts.init(document.getElementById('price-chart'));
priceChart.setOption({{
  tooltip:{{trigger:'axis'}}, xAxis:{{type:'category',data:rows.map(r=>String(r.date).split(' ')[0]),axisLabel:{{hideOverlap:true}}}},
  yAxis:{{type:'value',scale:true}},
  series:[{{name:'收盘价',type:'line',showSymbol:false,data:rows.map(r=>r.close),lineStyle:{{color:'#2563eb'}}}}]
}});
const points=DATA.history||[];
const chart=echarts.init(document.getElementById('history-chart'));
chart.setOption({{
  tooltip:{{trigger:'axis'}}, legend:{{data:['筑底结构强度','归一化价格']}},
  xAxis:{{type:'category',data:points.map(p=>p.date),axisLabel:{{hideOverlap:true}}}},
  yAxis:{{type:'value',min:0,max:100}},
  series:[
    {{name:'筑底结构强度',type:'line',showSymbol:false,data:points.map(p=>p.cleanliness_pct),lineStyle:{{color:'#15803d'}}}},
    {{name:'归一化价格',type:'line',showSymbol:false,data:points.map(p=>p.normalized_close_pct),lineStyle:{{color:'#2563eb'}}}}
  ]
}});
addEventListener('resize',()=>{{priceChart.resize();chart.resize();}});
</script>
</body></html>"""


def _render_bottoming_sign(sign: Any) -> str:
    return (
        '<article class="card">'
        f'<span class="chip {escape(sign.state)}">{escape(sign.state_label)} · {int(round(sign.score * 100))}%</span>'
        f'<h3>{escape(sign.name)}</h3><div class="muted">“{escape(sign.plain_name)}”</div>'
        f'<p>{escape(sign.description)}</p></article>'
    )


def _render_evidence(signal: SignalResult) -> str:
    return (
        '<article class="card">'
        f'<span class="chip {escape(signal.light)}">{escape(signal.light)} · {int(round(signal.confidence * 100))}%</span>'
        f'<h3>{escape(signal.name)}</h3><p>{escape(signal.description)}</p></article>'
    )
