"""入场标准实验室控制器页面（复用 HeroUI v3 设计 token + lightweight-charts）。

纯静态单页：从 /api/entry-scan/<ticker> 拉取预计算快照，
所有节点调整（档位 / 触发 / 灯色 / 数量 / 干净度）均为客户端过滤，
调整即时反映在命中日期列表与 K 线标记上。
"""
from __future__ import annotations

from .renderer import _render_design_tokens

_PAGE_TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>入场标准实验室 — stock-farmer</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://unpkg.com/lightweight-charts@4/dist/lightweight-charts.standalone.production.js"></script>
  __TOKENS__
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro", "Segoe UI", sans-serif; }
    .chart-container { height: 360px; border-radius: 8px; overflow: hidden; border: 1px solid var(--color-divider); }
    .chip { cursor: pointer; user-select: none; border: 1px solid var(--color-divider); transition: all .15s; }
    .chip.on { border-color: var(--color-primary); background: var(--color-primary-100, #eef2ff); color: var(--color-primary); font-weight: 600; }
    .chip.off { color: var(--text-muted); background: var(--color-surface-secondary); }
    .pg-btn { cursor: pointer; border: 1px solid var(--color-divider); border-radius: 8px; padding: 2px 10px; background: var(--color-surface); }
    .pg-btn:disabled { opacity: .4; cursor: not-allowed; }
  </style>
</head>
<body class="bg-gray-50 text-gray-900 min-h-screen">
  <div class="mx-auto px-6 py-6 md:py-10" style="max-width: 1180px;">
    <header class="mb-5 flex items-center gap-3 flex-wrap">
      <h1 class="text-2xl font-bold" style="color: var(--text-primary);">入场标准实验室</h1>
      <span class="text-xs" style="color: var(--text-muted);">调节入场节点 → 即时查看历史上哪些日期符合标准</span>
      <div class="ml-auto flex items-center gap-2">
        <input id="ticker" value="0700.HK" placeholder="如 0700.HK / AAPL"
          class="px-3 py-1.5 rounded-lg text-sm border" style="border-color: var(--color-divider); width: 140px;" />
        <button id="load" class="px-4 py-1.5 rounded-lg text-sm font-semibold text-white" style="background: var(--color-primary, #2563eb);">扫描</button>
      </div>
    </header>

    <div id="status" class="mb-4 text-sm rounded-xl px-4 py-3 hidden" style="background: var(--color-surface-secondary); color: var(--text-secondary);"></div>

    <section id="controls" class="rounded-2xl p-5 mb-5 hidden" style="border: 1px solid var(--color-divider); box-shadow: var(--shadow-xs); background: var(--color-surface);">
      <div class="flex items-baseline justify-between mb-3">
        <h3 class="text-sm font-semibold" style="color: var(--text-primary);">入场节点控制器</h3>
        <button id="reset" class="text-xs underline" style="color: var(--color-primary);">恢复生产默认</button>
      </div>
      <div class="grid md:grid-cols-2 gap-5">
        <div>
          <div class="text-[11px] uppercase tracking-wider mb-2" style="color: var(--text-muted);">筑底档位门槛（多选）</div>
          <div id="tier-chips" class="flex flex-wrap gap-2"></div>
        </div>
        <div>
          <div class="text-[11px] uppercase tracking-wider mb-2" style="color: var(--text-muted);">认可的右侧触发信号（多选）</div>
          <div id="trigger-chips" class="flex flex-wrap gap-2"></div>
        </div>
        <div>
          <div class="text-[11px] uppercase tracking-wider mb-2" style="color: var(--text-muted);">触发灯色要求</div>
          <div class="flex gap-2">
            <span class="chip on rounded-full px-3 py-1 text-xs" data-yellow="0" id="light-green">仅绿灯</span>
            <span class="chip off rounded-full px-3 py-1 text-xs" data-yellow="1" id="light-yellow">绿灯或黄灯</span>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-4">
          <div>
            <div class="text-[11px] uppercase tracking-wider mb-2" style="color: var(--text-muted);">最少触发个数 <strong id="min-green-val" style="color: var(--text-primary);">1</strong></div>
            <input id="min-green" type="range" min="1" max="3" step="1" value="1" class="w-full" />
          </div>
          <div>
            <div class="text-[11px] uppercase tracking-wider mb-2" style="color: var(--text-muted);">洗盘干净度下限 <strong id="clean-val" style="color: var(--text-primary);">0%</strong></div>
            <input id="clean" type="range" min="0" max="100" step="5" value="0" class="w-full" />
          </div>
        </div>
      </div>
      <div id="rule-diff" class="mt-4 text-xs rounded-xl px-4 py-3" style="background: var(--color-surface-secondary); color: var(--text-secondary);"></div>
    </section>

    <section id="result" class="rounded-2xl p-5 mb-5 hidden" style="border: 1px solid var(--color-divider); box-shadow: var(--shadow-xs); background: var(--color-surface);">
      <div class="flex items-baseline justify-between mb-2 flex-wrap gap-2">
        <h3 class="text-sm font-semibold" style="color: var(--text-primary);">命中日期 <span id="hit-count" class="font-bold" style="color: var(--color-primary);"></span></h3>
        <span class="text-[11px]" style="color: var(--text-muted);">▲ 命中日 · 收盘价线 · 扫描区间见下方</span>
      </div>
      <div id="chart" class="chart-container mb-4"></div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead><tr class="text-left text-[11px] uppercase tracking-wider" style="color: var(--text-muted); border-bottom: 1px solid var(--color-divider);">
            <th class="py-2 pr-3">日期</th><th class="py-2 pr-3">收盘</th><th class="py-2 pr-3">筑底档位</th>
            <th class="py-2 pr-3">命中触发</th><th class="py-2 pr-3">干净度</th><th class="py-2">回测命令</th>
          </tr></thead>
          <tbody id="hit-rows"></tbody>
        </table>
      </div>
      <div id="pager" class="items-center justify-between flex-wrap gap-2 mt-3 text-xs" style="color: var(--text-secondary); display: none;">
        <div class="flex items-center gap-1.5">
          <button id="pg-first" class="pg-btn">« 首页</button>
          <button id="pg-prev" class="pg-btn">‹ 上一页</button>
          <span id="pg-info" class="px-2 tabular-nums"></span>
          <button id="pg-next" class="pg-btn">下一页 ›</button>
          <button id="pg-last" class="pg-btn">末页 »</button>
        </div>
        <label class="flex items-center gap-1.5">每页
          <select id="pg-size" class="pg-btn" style="padding: 2px 6px;">
            <option value="25">25</option>
            <option value="50" selected>50</option>
            <option value="100">100</option>
            <option value="200">200</option>
          </select> 条
        </label>
      </div>
      <div id="hit-note" class="text-xs mt-3" style="color: var(--text-muted);"></div>
    </section>

    <footer class="text-center text-xs pt-4" style="color: var(--color-default); border-top: 1px solid var(--color-divider);">
      <p id="disclaimer">历史快照仅供研究复盘，干净度为结构强度语义，不构成投资建议。</p>
    </footer>
  </div>

  <script>
    let DATA = null;          // /api/entry-scan 返回的数据包
    let chart = null, closeSeries = null;
    let currentHits = [];     // 当前过滤命中（分页数据源）
    let page = 1, pageSize = 50;
    const state = { tiers: new Set(), triggers: new Set(), acceptYellow: false, minGreen: 1, minClean: 0 };

    const $ = (id) => document.getElementById(id);
    const TIER_ORDER = ["still_falling", "early_signs", "base_forming", "base_ready", "trend_running"];

    function setStatus(text, show = true) {
      const el = $('status');
      el.textContent = text;
      el.classList.toggle('hidden', !show);
    }

    async function load() {
      const ticker = $('ticker').value.trim().toUpperCase();
      if (!ticker) return;
      setStatus('首次扫描需逐日重算约 1000 个交易日的判定快照，约 1~2 分钟，之后有缓存秒回…');
      $('load').disabled = true;
      try {
        const resp = await fetch(`/api/entry-scan/${encodeURIComponent(ticker)}`);
        const body = await resp.json();
        if (!resp.ok) { setStatus(`扫描失败：${body.message || body.error}`); return; }
        DATA = body;
        setStatus(`已载入 ${DATA.ticker}：${DATA.range.start} ~ ${DATA.range.end}，共 ${DATA.range.scanned_days} 个交易日（预热期 ${DATA.range.warmup} 日不参与扫描）`);
        initControls();
        $('controls').classList.remove('hidden');
        $('result').classList.remove('hidden');
        $('disclaimer').textContent = DATA.disclaimer;
        initChart();
        applyFilter();
      } catch (e) {
        setStatus(`请求异常：${e}`);
      } finally {
        $('load').disabled = false;
      }
    }

    function chipHtml(id, label, on) {
      return `<span class="chip rounded-full px-3 py-1 text-xs ${on ? 'on' : 'off'}" data-id="${id}">${label}</span>`;
    }

    function initControls() {
      const rule = DATA.meta.default_rule;
      state.tiers = new Set(rule.tiers);
      state.triggers = new Set(rule.triggers);
      state.acceptYellow = rule.accept_yellow;
      state.minGreen = rule.min_green;
      state.minClean = 0;

      const tiers = [...DATA.meta.tiers].sort((a, b) => TIER_ORDER.indexOf(a.id) - TIER_ORDER.indexOf(b.id));
      $('tier-chips').innerHTML = tiers.map(t => chipHtml(t.id, `${t.icon} ${t.label}`, state.tiers.has(t.id))).join('');
      $('trigger-chips').innerHTML = DATA.meta.right_signals.map(s => chipHtml(s.id, s.name, state.triggers.has(s.id))).join('');
      $('min-green').value = state.minGreen;
      $('clean').value = state.minClean;
      syncControlLabels();

      $('tier-chips').querySelectorAll('.chip').forEach(el => el.onclick = () => toggle(el, state.tiers));
      $('trigger-chips').querySelectorAll('.chip').forEach(el => el.onclick = () => toggle(el, state.triggers));
    }

    function toggle(el, set) {
      const id = el.dataset.id;
      if (set.has(id)) { set.delete(id); el.className = el.className.replace(' on', ' off'); }
      else { set.add(id); el.className = el.className.replace(' off', ' on'); }
      applyFilter();
    }

    function syncControlLabels() {
      $('min-green-val').textContent = state.minGreen;
      $('clean-val').textContent = state.minClean + '%';
      $('light-green').className = `chip rounded-full px-3 py-1 text-xs ${state.acceptYellow ? 'off' : 'on'}`;
      $('light-yellow').className = `chip rounded-full px-3 py-1 text-xs ${state.acceptYellow ? 'on' : 'off'}`;
    }

    function dayHits(day) {
      // 返回该日命中的触发信号 id 列表（按当前灯色要求）
      const ok = [];
      for (const id of state.triggers) {
        const r = day.rights[id];
        if (!r) continue;
        if (r.light === 'green' || (state.acceptYellow && r.light === 'yellow')) ok.push(id);
      }
      return ok;
    }

    function qualified(day) {
      if (!state.tiers.has(day.tier)) return null;
      if (day.cleanliness_pct < state.minClean) return null;
      const hits = dayHits(day);
      return hits.length >= state.minGreen ? hits : null;
    }

    function applyFilter() {
      if (!DATA) return;
      const hits = [];
      for (const day of DATA.days) {
        const hitIds = qualified(day);
        if (hitIds) hits.push({ day, hitIds });
      }
      currentHits = hits;
      page = 1;  // 节点变化后回到首页
      $('hit-count').textContent = `${hits.length} 个 / ${DATA.days.length} 日`;
      renderPage();
      $('hit-note').textContent = hits.length === 0
        ? '当前标准下无命中日期，可尝试放宽档位门槛或接受黄灯。'
        : '';
      renderMarkers(hits);
      renderRuleDiff(hits.length);
    }

    function renderPage() {
      const nameOf = Object.fromEntries(DATA.meta.right_signals.map(s => [s.id, s.name]));
      const tierOf = Object.fromEntries(DATA.meta.tiers.map(t => [t.id, `${t.icon} ${t.label}`]));
      const total = currentHits.length;
      const pages = Math.max(1, Math.ceil(total / pageSize));
      page = Math.min(Math.max(1, page), pages);
      const start = (page - 1) * pageSize;
      const rows = currentHits.slice(start, start + pageSize);

      $('hit-rows').innerHTML = rows.map(({ day, hitIds }) => `
        <tr style="border-bottom: 1px solid var(--color-divider);">
          <td class="py-1.5 pr-3 tabular-nums">${day.date}</td>
          <td class="py-1.5 pr-3 tabular-nums">${day.close}</td>
          <td class="py-1.5 pr-3">${tierOf[day.tier] || day.tier}</td>
          <td class="py-1.5 pr-3">${hitIds.map(id => nameOf[id] || id).join('、')}</td>
          <td class="py-1.5 pr-3 tabular-nums">${day.cleanliness_pct}%</td>
          <td class="py-1.5"><code class="text-[11px] px-1.5 py-0.5 rounded" style="background: var(--color-surface-secondary);">python backtest_trade.py ${DATA.ticker} --as-of ${day.date}</code></td>
        </tr>`).join('');

      $('pager').style.display = total === 0 ? 'none' : 'flex';
      if (total > 0) {
        const end = Math.min(start + pageSize, total);
        $('pg-info').textContent = `第 ${page} / ${pages} 页（${start + 1}-${end} / 共 ${total} 条）`;
        $('pg-first').disabled = $('pg-prev').disabled = page <= 1;
        $('pg-next').disabled = $('pg-last').disabled = page >= pages;
      }
    }

    function gotoPage(p) {
      page = p;
      renderPage();
    }

    function renderRuleDiff(hitCount) {
      const rule = DATA.meta.default_rule;
      const nameOf = Object.fromEntries(DATA.meta.right_signals.map(s => [s.id, s.name]));
      const tierOf = Object.fromEntries(DATA.meta.tiers.map(t => [t.id, t.label]));
      const diffs = [];
      const addedTiers = [...state.tiers].filter(t => !rule.tiers.includes(t));
      const removedTiers = rule.tiers.filter(t => !state.tiers.has(t));
      if (addedTiers.length) diffs.push(`放宽档位：接受「${addedTiers.map(t => tierOf[t] || t).join('、')}」`);
      if (removedTiers.length) diffs.push(`收紧档位：不再接受「${removedTiers.map(t => tierOf[t] || t).join('、')}」`);
      const removedTrig = rule.triggers.filter(t => !state.triggers.has(t));
      const addedTrig = [...state.triggers].filter(t => !rule.triggers.includes(t));
      if (removedTrig.length) diffs.push(`剔除触发：${removedTrig.map(t => nameOf[t] || t).join('、')}`);
      if (addedTrig.length) diffs.push(`新增触发：${addedTrig.map(t => nameOf[t] || t).join('、')}`);
      if (state.acceptYellow !== rule.accept_yellow) diffs.push(state.acceptYellow ? '放宽灯色：黄灯也算触发' : '收紧灯色：仅绿灯');
      if (state.minGreen !== rule.min_green) diffs.push(`最少触发数：${rule.min_green} → ${state.minGreen}`);
      if (state.minClean > 0) diffs.push(`干净度下限：≥ ${state.minClean}%`);
      $('rule-diff').innerHTML = diffs.length
        ? `<strong style="color: var(--text-primary);">相对生产默认的调整：</strong>${diffs.join('；')}　→　命中 <strong style="color: var(--color-primary);">${hitCount}</strong> 日`
        : `当前即生产默认标准（档位 ≥ 基本成立 + 认可触发中 ≥ ${rule.min_green} 个绿灯）　→　命中 <strong style="color: var(--color-primary);">${hitCount}</strong> 日`;
    }

    function initChart() {
      const el = $('chart');
      el.innerHTML = '';
      chart = LightweightCharts.createChart(el, {
        layout: { background: { color: '#ffffff' }, textColor: '#6b7280' },
        grid: { vertLines: { color: '#f3f4f6' }, horzLines: { color: '#f3f4f6' } },
        height: 360,
      });
      closeSeries = chart.addLineSeries({ color: '#9ca3af', lineWidth: 1, title: '收盘价' });
      closeSeries.setData(DATA.klines.map(k => ({ time: k.date, value: k.close })));
      chart.timeScale().fitContent();
    }

    function renderMarkers(hits) {
      if (!closeSeries) return;
      closeSeries.setMarkers(hits.map(({ day }) => ({
        time: day.date, position: 'belowBar', shape: 'arrowUp', color: '#16a34a', text: '',
      })));
    }

    $('load').onclick = load;
    $('ticker').addEventListener('keydown', e => { if (e.key === 'Enter') load(); });
    $('reset').onclick = () => { initControls(); applyFilter(); };
    $('light-green').onclick = () => { state.acceptYellow = false; syncControlLabels(); applyFilter(); };
    $('light-yellow').onclick = () => { state.acceptYellow = true; syncControlLabels(); applyFilter(); };
    $('min-green').oninput = (e) => { state.minGreen = Number(e.target.value); syncControlLabels(); applyFilter(); };
    $('clean').oninput = (e) => { state.minClean = Number(e.target.value); syncControlLabels(); applyFilter(); };
    $('pg-first').onclick = () => gotoPage(1);
    $('pg-prev').onclick = () => gotoPage(page - 1);
    $('pg-next').onclick = () => gotoPage(page + 1);
    $('pg-last').onclick = () => gotoPage(Infinity);
    $('pg-size').onchange = (e) => { pageSize = Number(e.target.value); gotoPage(1); };
  </script>
</body>
</html>"""


def render_entry_lab_html() -> str:
    """渲染入场标准实验室控制器页面。"""
    return _PAGE_TEMPLATE.replace("__TOKENS__", _render_design_tokens())
