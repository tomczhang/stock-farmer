## ADDED Requirements

### Requirement: PE History Endpoint

系统 SHALL 提供 `GET /api/pe-history/{ticker}?range=5y|10y|all` 端点，返回该 ticker 在指定时间窗内的 PE-TTM 时间序列以及当前指标卡片数据（包含 `current_pe`、`median_pe`、`current_percentile`、`min_pe`、`max_pe`、`loss_ratio` 六个字段）。

#### Scenario: 查询港股 5 年窗口

- **WHEN** 客户端请求 `GET /api/pe-history/0700.HK?range=5y`
- **THEN** 响应 SHALL 包含过去 5 年的 PE-TTM 日序列数组，以及含 `current_pe`、`median_pe`、`current_percentile`、`min_pe`、`max_pe`、`loss_ratio` 的指标卡片对象

#### Scenario: 查询上市以来全部数据

- **WHEN** 客户端请求 `range=all`
- **THEN** 响应 SHALL 包含该 ticker 上市以来全部可用的 PE-TTM 时间序列

#### Scenario: ticker 不在 watchlist

- **WHEN** 客户端请求的 ticker 不在 watchlist 内
- **THEN** 响应 SHALL 返回 HTTP 404 且 body 为 `{ "error": "ticker_not_in_watchlist" }`

#### Scenario: 未提供 range 参数

- **WHEN** 客户端请求 `/api/pe-history/{ticker}` 但未带 `range` 查询参数
- **THEN** 服务端 SHALL 默认使用 `range=5y` 处理

### Requirement: Time Series Response Format

系统 SHALL 在返回的时间序列中为每个日期包含 `date`、`pe_ttm`、`is_loss` 三个字段；当当日处于亏损期时 `pe_ttm` MUST 为 `null` 且 `is_loss` MUST 为 `true`。

#### Scenario: 亏损期数据点

- **WHEN** 响应中某条记录的 `is_loss` 为 `true`
- **THEN** 该记录的 `pe_ttm` 字段 MUST 为 `null`

### Requirement: Watchlist List Endpoint

系统 SHALL 提供 `GET /api/watchlist` 端点，返回当前 watchlist 全部 ticker 及其市场标识（`US` 或 `HK`）和加入时间 `added_at`。

#### Scenario: 列出 watchlist

- **WHEN** 客户端调用 `GET /api/watchlist`
- **THEN** 响应 SHALL 返回数组，每个元素含 `ticker`、`market`、`added_at` 字段

### Requirement: Watchlist Add Endpoint

系统 SHALL 提供 `POST /api/watchlist` 端点，请求体格式为 `{ ticker, market }`，向 watchlist 添加新股票；该接口 MUST 是幂等的：当 ticker 已存在时不重复插入并返回成功。

#### Scenario: 添加新 ticker

- **WHEN** 客户端 POST 一个 watchlist 中不存在的 ticker
- **THEN** 服务端 SHALL 将该 ticker 写入 watchlist 并返回 HTTP 201

#### Scenario: 重复添加已存在 ticker

- **WHEN** 客户端 POST 一个 watchlist 中已存在的 ticker
- **THEN** 服务端 SHALL 不重复插入并返回 HTTP 200

### Requirement: Watchlist Remove Endpoint

系统 SHALL 提供 `DELETE /api/watchlist/{ticker}` 端点，从 watchlist 中移除指定 ticker。

#### Scenario: 删除已存在的 ticker

- **WHEN** 客户端 DELETE 一个 watchlist 中存在的 ticker
- **THEN** 服务端 SHALL 从 watchlist 中移除该 ticker 并返回 HTTP 204

#### Scenario: 删除不存在的 ticker

- **WHEN** 客户端 DELETE 一个 watchlist 中不存在的 ticker
- **THEN** 服务端 SHALL 返回 HTTP 404

### Requirement: Read-Only Hot Path

系统 SHALL 保证所有 GET 端点仅执行 D1 读取和 JSON 格式化，MUST NOT 触发任何外部数据抓取或重计算。

#### Scenario: PE 历史查询不触发外部抓取

- **WHEN** 客户端请求 `GET /api/pe-history/{ticker}`
- **THEN** Worker SHALL 只查询 D1 中的 `pe_series` 表，MUST NOT 调用任何外部数据源 API

### Requirement: CORS Support

系统 SHALL 为浏览器 fetch 调用提供 CORS 响应头，允许来自 Cloudflare Pages 站点域名以及本地开发域名（如 `http://localhost:5173`）的跨域请求。

#### Scenario: Pages 域名跨域请求

- **WHEN** 浏览器从 Pages 站点域名向 API 发起 fetch
- **THEN** 响应 SHALL 包含正确的 `Access-Control-Allow-Origin` 头

### Requirement: Error Response Format

系统 SHALL 为所有错误响应使用统一 JSON 格式 `{ "error": "<code>", "message": "<human readable>" }`。

#### Scenario: 错误响应结构

- **WHEN** API 返回任意错误响应（4xx 或 5xx）
- **THEN** 响应 body SHALL 同时包含 `error`（机器可读 code）和 `message`（人类可读说明）两个字段

### Requirement: Response Caching Headers

系统 SHALL 为 PE history 响应设置 `Cache-Control` 头（例如 `max-age=3600`），以允许 Cloudflare CDN 缓存（数据每天才更新一次）。

#### Scenario: PE 历史响应带缓存头

- **WHEN** 客户端请求 `GET /api/pe-history/{ticker}`
- **THEN** 响应 SHALL 包含 `Cache-Control` 头且其 `max-age` 大于 0

### Requirement: Health Check Endpoint

系统 SHALL 提供 `GET /api/health` 端点，返回 `{ "status": "ok", "last_pipeline_run": "<ISO timestamp>" }`，供外部监控调用。

#### Scenario: 调用健康检查

- **WHEN** 客户端调用 `GET /api/health`
- **THEN** 响应 SHALL 返回 `status` 字段值为 `"ok"` 以及 `last_pipeline_run` 字段为最近一次流水线运行的 ISO 8601 时间戳
