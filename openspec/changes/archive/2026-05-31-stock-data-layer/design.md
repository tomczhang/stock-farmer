## Context

stock-farmer 当前的数据获取分散在多个 fetcher 模块中，每个调用方直接处理 HTTP 请求、ticker 格式转换、cookie 管理等细节。随着评分系统（缩量下跌、假破位收回、Volume Profile 等 8 个模块）的引入，需要一个统一的数据访问层，让上层业务只关心"拿什么数据"而不关心"从哪里拿、怎么拿"。

已验证的免费数据源：
- 东财 push2 `stock/get`：单只实时行情，免费高频
- 东财 push2 `ulist.np/get`：批量实时行情，fltt=2 返回浮点
- 东财 push2his `kline/get`：多周期 K 线（日/周/分钟），高频封 IP
- 雪球 `kline.json` + `quote.json`：日 K + PE-TTM + 实时 quote
- Yahoo Finance `chart/v8`：日 K 复权价，多周期
- 新浪 `hq.sinajs.cn`：美股实时行情 + 日 K
- 腾讯 `web.sqt.gtimg.cn`：美港股实时行情
- efinance 库：封装东财 push2/push2his，Python API

## Goals / Non-Goals

### Goals
- 提供统一的 Python API，调用方 `from data import quotes, klines, indicators` 即可使用
- 内部管理数据源选择、failover、代理 IP 轮换，调用方不感知
- 支持评分系统所需的全部数据类型：实时行情、多周期 K 线、技术指标、资金流、Volume Profile
- 统一 ticker 格式：外部统一用 `AAPL`（美股）/ `0700.HK`（港股），内部自动转换

### Non-Goals
- 不替换现有 `pipeline/run.py` 和 `api/` 层的雪球 PE 路径（已跑通，保持不变）
- 不做实时推送（WebSocket），只做轮询模式
- 不做 A 股支持（仅美股 + 港股）
- 不做历史数据持久化（数据层是无状态的获取层，持久化由上层决定）
- 不自建代理 IP 池服务，使用外部代理 IP 服务商的 API

## Decisions

### 决策 1：模块结构 — Adapter 模式

**选择**：每个数据源一个 Adapter 类，实现统一接口；上层通过 Router 调度。

```
pipeline/data/
├── __init__.py          # 公开 API：get_quotes, get_klines, get_indicators, ...
├── types.py             # 数据类型定义：Quote, KlineBar, Indicator, MoneyFlow, ...
├── router.py            # 数据源路由 + failover 逻辑
├── proxy_pool.py        # 代理 IP 池管理
├── adapters/
│   ├── __init__.py
│   ├── eastmoney.py     # 东财 push2 (实时行情) + push2his (K线/资金流)
│   ├── xueqiu.py        # 雪球 (PE-TTM + quote)
│   ├── yahoo.py         # Yahoo Finance (K线 fallback)
│   └── sina.py          # 新浪 (行情 + 美股K线 fallback)
└── indicators.py        # 技术指标计算（封装 ta 库）
```

**备选**：直接用 efinance 库作为唯一数据源。
**否决原因**：efinance 只封装东财，无法 fallback 到 Yahoo/新浪；且库更新节奏不可控。

### 决策 2：Ticker 规范化 — 统一外部格式

**选择**：外部 API 统一使用 `AAPL`（美股）和 `0700.HK`（港股），内部各 adapter 自行转换。

复用现有 `pipeline/fetcher/ticker_normalize.py` 的逻辑，扩展为 `data/types.py` 中的 `normalize_ticker()` 函数。

### 决策 3：数据源路由策略

**选择**：按数据类型定义优先级链，失败自动降级。

| 数据类型 | 优先级 1 | 优先级 2 | 优先级 3 |
|---------|---------|---------|---------|
| 实时行情 | 东财 push2 | 新浪 | 腾讯 |
| 日 K 线 | 东财 push2his | Yahoo | 新浪 |
| 分钟 K 线 | 东财 push2his (代理) | — | — |
| PE-TTM | 雪球 | — | — |
| 资金流向 | 东财 push2his | — | — |

**备选**：所有数据类型统一走一个数据源。
**否决原因**：没有单一免费数据源能覆盖全部需求。

### 决策 4：代理 IP 管理 — 外部服务 + 本地池

**选择**：从外部代理服务商 API 获取代理 IP 列表，本地维护一个池做健康检测和轮换。

- 代理 IP 通过环境变量 `PROXY_PROVIDER_URL` 配置（指向代理服务商的提取 API）
- 本地缓存可用代理列表，每个代理记录成功/失败计数
- 请求 push2his 时从池中取一个代理，失败则标记并换下一个
- 池空时直连（降级，可能被封但不至于完全不可用）

### 决策 5：技术指标 — 封装 ta 库

**选择**：`indicators.py` 封装 ta 库，提供面向业务的高层 API。

```python
# 调用方只需：
from data import get_indicators
result = get_indicators("AAPL", indicators=["macd", "rsi", "atr", "bollinger"])
# 返回 DataFrame，列名为 macd, macd_signal, macd_hist, rsi, atr, bb_upper, bb_lower, ...
```

内部自动拉 K 线 → 喂给 ta 库 → 返回拼好的 DataFrame。调用方无需知道 ta 库的存在。

### 决策 6：Volume Profile — 基于分钟 K 线分桶

**选择**：拉 5 分钟 K 线，按价格分桶（桶宽 = ATR / 20 或固定百分比），累加每根 K 线的成交量到对应桶。

返回 `[{price_level: float, volume: int, pct: float}, ...]`，上层可直接判断筹码集中度。

### 决策 7：返回类型 — dataclass + DataFrame 双模式

**选择**：
- 单条数据（quote）返回 dataclass（`Quote`, `MoneyFlow`）
- 序列数据（klines, indicators）返回 pandas DataFrame
- 所有公开 API 支持 `as_dataframe=True/False` 参数

## Risks / Trade-offs

- **[东财封 IP]** → 代理 IP 池 + 自动 fallback 到 Yahoo/新浪。极端情况全部不可用时，上层需要有降级逻辑（返回 None / 抛异常由调用方处理）
- **[代理 IP 成本]** → 只有 push2his K 线端点需要代理，实时行情 push2 不需要。成本取决于查询频率和股票数量，个人使用量级可控
- **[数据源接口变更]** → 东财/雪球/新浪都是非官方接口，随时可能变。Adapter 模式隔离了变更影响，只需修改对应 adapter
- **[efinance 库依赖]** → 不直接依赖 efinance，自己实现 adapter。参考 efinance 的接口调用方式但不引入库依赖，避免被库的更新节奏卡住
- **[分钟 K 线覆盖]** → 东财 push2his 分钟 K 线对美股港股已验证可用，但历史深度有限（约数天）。Volume Profile 只用当天或近几天数据，够用

## Migration Plan

1. **Phase 1**：新建 `pipeline/data/` 模块，实现核心 API + 东财 adapter + Yahoo fallback
2. **Phase 2**：实现代理 IP 池 + 分钟 K 线 + Volume Profile
3. **Phase 3**：实现技术指标封装 + 资金流向
4. **Phase 4**：评分系统作为数据层的第一个消费方接入

现有 `pipeline/run.py` 和 `pipeline/fetcher/` 保持不变，新旧并行。不做 breaking change。

## Open Questions

- 代理 IP 服务商选择？需要用户配置具体的提取 API URL
- 分钟 K 线历史深度：东财 push2his 对美股能回溯多少天的分钟数据？（已验证 2 天 156 条，更长需测试）
- 是否需要本地缓存层（SQLite/文件缓存）避免重复拉取同一天的 K 线数据？
