"""HTML 报告渲染（暗色主题、响应式、Tailwind CDN）。"""
from __future__ import annotations

from datetime import datetime

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
) -> str:
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    price_str = f"${price:.2f}" if price else "N/A"
    change_str = f"{change_pct:+.2f}%" if change_pct is not None else ""
    change_color = "text-green-400" if (change_pct or 0) >= 0 else "text-red-400"

    left_signals = [s for s in signals if s.category == "left"]
    right_signals = [s for s in signals if s.category == "right"]

    left_cards = "\n".join(_render_signal_card(s) for s in left_signals)
    right_cards = "\n".join(_render_signal_card(s) for s in right_signals)

    strength_bar = _render_strength_bar(phase.strength)

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{ticker} 信号诊断 — stock-farmer</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, "SF Pro", "Segoe UI", sans-serif; }}
  </style>
</head>
<body class="bg-[#0f1117] text-gray-100 min-h-screen">
  <div class="max-w-3xl mx-auto px-4 py-6 md:py-10">

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
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        {left_cards}
      </div>
    </section>

    <!-- Right Side Signals -->
    <section class="mb-6">
      <h3 class="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">右侧信号 · 趋势确认</h3>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
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
</body>
</html>"""


def _render_signal_card(s: SignalResult) -> str:
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
    # 5 zones: 0-25 red, 25-45 yellow, 45-60 yellow-star, 60-80 green, 80-100 green-green
    return f"""<div class="relative h-3 rounded-full overflow-hidden bg-gray-800">
  <div class="absolute inset-y-0 left-0 bg-red-900/50" style="width:25%"></div>
  <div class="absolute inset-y-0 bg-amber-900/50" style="left:25%;width:20%"></div>
  <div class="absolute inset-y-0 bg-yellow-900/50" style="left:45%;width:15%"></div>
  <div class="absolute inset-y-0 bg-green-900/50" style="left:60%;width:20%"></div>
  <div class="absolute inset-y-0 bg-emerald-900/50" style="left:80%;width:20%"></div>
  <div class="absolute top-0.5 w-2 h-2 rounded-full bg-white shadow-lg" style="left:calc({pos}% - 4px)"></div>
</div>"""
