## Why

项目当前的数据获取逻辑散落在 `pipeline/fetcher/` 各模块和 `api/src/lib/xueqiu.ts` 中，每个调用方都直接面对具体数据源（雪球、Yahoo、东财）的 HTTP 接口细节。这导致：

1. **调用方需感知数据源实现**：ticker 格式转换（`0700.HK` → `00700`）、cookie 管理、f59 小数位除法等逻辑重复散落
2. **无法支撑新的分析场景**：计划中的评分系统需要实时行情（2s 轮询）、分钟级 K 线（Volume Profile）、技术指标（MACD/RSI/ATR）、资金流向等数据，现有模块没有统一接口
3. **数据源切换困难**：东财封 IP 时需要 fallback 到 Yahoo/新浪，目前没有统一的降级机制

需要一个封装好的数据层，对外提供干净的 Python API，内部屏蔽数据源细节、代理 IP 轮换、限流重试等复杂度。

## What Changes

- 新建 `pipeline/data/` 模块，作为统一数据访问层
- 提供以下核心 API，调用方只需 `from data import get_quote, get_klines` 即可使用：
  - **实时行情**：批量获取最新价/涨跌幅/成交量，2s 轮询级别
  - **K 线数据**：日/周/月/5m/15m/30m/60m 多周期，自动前复权
  - **技术指标**：MACD、RSI、KDJ、布林带、ATR、MA/EMA、OBV 等，基于 ta 库
  - **资金流向**：日级主力/大单/中单/小单净流入
  - **估值数据**：PE-TTM（沿用雪球现有路径）
  - **Volume Profile**：基于分钟 K 线构建分价位成交量分布
- 内部实现多数据源自动 fallback（东财 → Yahoo → 新浪）
- 内部实现代理 IP 池管理（push2his K 线端点防封 IP）
- 现有 `pipeline/run.py` 和 `api/` 层逐步迁移到新数据层调用

## Capabilities

### New Capabilities

- `stock-data-api`: 统一数据访问接口层 — 定义 get_quote / get_klines / get_indicators / get_money_flow / get_volume_profile 等公开 API 的签名、参数、返回格式
- `data-source-routing`: 多数据源路由与降级 — 管理东财/雪球/Yahoo/新浪的优先级、健康检测、自动 fallback 逻辑
- `proxy-pool`: 代理 IP 池管理 — 为 push2his 等限流严格的端点提供代理轮换、健康检测、失败重试

### Modified Capabilities

（无现有 spec 需要修改）

## Impact

- **新增代码**：`pipeline/data/` 模块（API 层 + 数据源适配器 + 代理池）
- **依赖变更**：新增 `efinance`、`ta` 到 `pipeline/requirements.txt`
- **现有代码**：`pipeline/run.py` 后续可迁移到新数据层，但本次不改动现有逻辑，新旧并行
- **API 层**：`api/src/lib/xueqiu.ts`（Workers 端）暂不变，仍用雪球 quote；后续可考虑迁移
- **配置**：需要新增代理 IP 相关环境变量（`PROXY_POOL_URL` 或 `PROXY_LIST`）
