## Why

stock-farmer 的生产链路是 GitHub Actions → 跑 `pipeline/analyze.py` → 用 `pipeline/analyzer/renderer.py` 输出静态 HTML → 推到 gh-pages。**生产没有 Python web server,也没有 React 运行时**。

最近作者用 codex 在 `web/`(React) + 新增的 `pipeline/server.py` + `pipeline/analyzer/report.py` 里完成了一轮设计 spike,做出了一份完整的 React 报告页(双信号大卡 / Hero 圆环 + 趋势主图 / 综述 + 下一触发 / 子信号明细表 + tabs / Chip 4 态)。视觉远超此前的 `heroui-right-signals-redesign` 仅改右侧的版本,但这条 React 链路在 GitHub Actions 上跑不起来——生产打开 gh-pages 看到的仍然是旧版 HTML。

本变更把 codex 的视觉与布局**迁回 Python 静态 HTML**,让 GitHub Actions 跑出来的报告与 React 设计稿对齐;同时保留两个关键约束:

1. 折线 / 成交量主图继续用 TradingView **lightweight-charts**(不切换到 echarts)。
2. **缩量下跌(`vol_shrink`)5 维详情**(综合评分公式 + 5 行表格 + 趋势缩量 tooltip 气泡)必须保留,不能因布局重做而丢失。

codex 的 React 链路保留作 dev 预览 / 设计参考,不删。

## What Changes

- **Hero 双栏**: 左 1/3 是 SVG 圆环(展示综合强度) + phase 名 + action + 加权公式 + 双 meter;右 2/3 是 lightweight-charts 价格趋势主图(收盘 area + 成交量 histogram)。替换原 Conclusion 卡里的"综合强度"水平进度条 + emoji 大字头部。
- **加权分计算迁入 renderer.py**: 新增 `_compute_confirmation()`,算法对齐 `pipeline/analyzer/report.py:_group_summary`(只读其逻辑,不耦合调用)。
- **左右双信号大卡(列表式)**: 替换原"6 卡 + 4 卡"两栏布局。每栏 1 张大卡,头部 "左/右侧信号" + 权重胶囊 + "X% 加权分"大字;主体是若干 `<details>` 行。每行收起时:`name + description + Chip + confidence%`;展开时下方展示该信号的 lightweight-charts 容器。
- **vol_shrink 行特殊处理**: 展开时除 chart 外,还显示既有的 5 维详情(公式 + 表 + tooltip),保留 `_render_signal_detail` 全部内容,只换外壳样式 token。
- **Chart 触发时机改造**: 从 `window.load` 时 10 张全部立刻渲染,改为监听 `<details>` 的 `toggle` 事件首次展开时按需渲染;**Hero 主图**仍立刻渲染。
- **Chip 文案规则**: 左侧 3 态(red→未触发/灰、yellow→观察/warning-soft、green→确认/success);右侧 4 态沿用 `_RIGHT_STATE_TABLE`(已触发/临界/酝酿中/未触发)。
- **子信号明细表**: 在双大卡下方新增第三块,头部 "子信号明细 · 权重、确认度与状态" + 全部/左/右 segmented-control tabs,主体一张 5 列表(信号 / 类别 / 权重 / 状态 / 确认度);客户端 JS 切换显隐。
- **设计 token 同步**: 把 `web/src/styles/global.css:1-30` 的 `:root` token 命名 / 色值同步到 `_DESIGN_TOKENS_CSS`,扩出此前未声明的 `--accent / *-soft / --text-primary/secondary` 等。
- **移除冗余视觉**: 删 conclusion 区下方的 `🔴 0-25% 🟡 25-45% ...` 阈值刻度尺(信息已被圆环 + 双 meter 表达);左侧信号行去掉 🔴/🟡/🟢 emoji 前缀(由 Chip 替代);Hero 圆环内不再放 phase emoji。
- **不删 codex spike**: `pipeline/server.py` / `pipeline/analyzer/report.py` / `pipeline/fetcher/macro.py` / `web/src/components/SignalTrendReport.tsx` / 旧 PE React 组件 全部不动。

## Capabilities

### New Capabilities
<!-- 无新能力 -->

### Modified Capabilities
- `signal-report-rendering`: 此前 `heroui-right-signals-redesign` 变更建立的渲染规范从"仅右侧 4 态卡"扩展为"全报告 Hero + 双大卡 + 明细表"的完整视觉契约;`vol_shrink` 5 维详情位置从"卡内固定区"迁到"展开容器内";chart 渲染时机从立刻改为按需。

## Impact

- **受影响代码**:
  - `pipeline/analyzer/renderer.py`(主)—— 模板大改、渲染函数新增/重构、JS 段重写。
  - `pipeline/analyzer/test_renderer.py` —— 单测扩展 6-10 条。
- **不影响**: 信号算法 (`signals.py` / `phase.py` / `narrative.py`)、数据源 (`pipeline/fetcher/*` / `pipeline/data.py`)、GitHub Actions workflow、`api/`(Cloudflare Workers)、codex React/server spike(`pipeline/server.py` / `report.py` / `web/src/components/SignalTrendReport.tsx`)。
- **依赖**: 仍 Tailwind CDN + lightweight-charts CDN,**不引入 echarts**,不引入 React。
- **风险**: 1) 双大卡 `<details>` toggle 触发的按需渲染需要正确处理 chart 容器宽度(展开瞬间宽度从 0 变到实际值);2) 设计 token 与 React 端漂移可能导致两端视觉不完全一致。
- **回滚**: 单文件改动,git revert 可还原。
