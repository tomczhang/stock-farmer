## 1. 基础结构与类型定义

- [x] 1.1 创建 `pipeline/data/` 模块目录结构：`__init__.py`, `types.py`, `router.py`, `proxy_pool.py`, `indicators.py`, `adapters/`
- [x] 1.2 在 `types.py` 中定义核心数据类型：`Quote` dataclass、`AdapterError` / `DataSourceError` 异常类、`normalize_ticker()` 函数
- [x] 1.3 在 `types.py` 中定义常量：数据源优先级链表、超时默认值、secid 前缀映射

## 2. 数据源适配器

- [x] 2.1 实现 `adapters/eastmoney.py`：push2 实时行情（`fetch_quotes`）+ push2his K线（`fetch_klines`）+ 资金流（`fetch_money_flow`），含 ticker → secid 转换和 f59 小数位处理
- [x] 2.2 实现 `adapters/yahoo.py`：Yahoo Finance chart v8 K线（`fetch_klines`），含 ticker → Yahoo symbol 转换（复用现有 `ticker_normalize.to_yahoo`）
- [x] 2.3 实现 `adapters/sina.py`：新浪实时行情（`fetch_quotes`）+ 美股日K（`fetch_klines`），含 JSONP 响应解析
- [x] 2.4 实现 `adapters/xueqiu.py`：雪球 PE-TTM quote（`fetch_pe_ttm`），复用现有 cookie 会话管理逻辑

## 3. 代理 IP 池

- [x] 3.1 实现 `proxy_pool.py`：`ProxyPool` 类，含 `get_proxy()` 轮换、`report_success/failure()` 健康管理、3次失败标记不健康、120秒冷却恢复
- [x] 3.2 实现代理列表从 `PROXY_PROVIDER_URL` 获取、定时刷新（默认5分钟）、无配置时降级直连

## 4. 路由与降级

- [x] 4.1 实现 `router.py`：`DataRouter` 类，按数据类型查优先级链依次尝试 adapter，失败自动 fallback
- [x] 4.2 实现数据源健康追踪：3次连续失败标记不健康、60秒冷却后重试
- [x] 4.3 实现总超时控制：跨所有 fallback 尝试的 30 秒总超时

## 5. 技术指标与 Volume Profile

- [x] 5.1 实现 `indicators.py`：封装 ta 库，支持 macd / rsi / kdj / bollinger / atr / ma / ema / obv / mfi / cci 等指标名到 ta 函数的映射
- [x] 5.2 实现 Volume Profile 构建：拉 5 分钟 K 线 → 按价格分桶 → 返回 `[{price_level, volume, pct}]`

## 6. 公开 API

- [x] 6.1 在 `__init__.py` 中暴露公开 API：`get_quotes()`, `get_klines()`, `get_indicators()`, `get_money_flow()`, `get_volume_profile()`, `get_pe_ttm()`
- [x] 6.2 各公开函数内部调用 `DataRouter`，对外隐藏数据源选择和代理逻辑

## 7. 依赖与测试

- [x] 7.1 更新 `pipeline/requirements.txt`：添加 `ta` 依赖（不添加 efinance，自己实现 adapter）
- [x] 7.2 为各 adapter 编写单元测试（mock HTTP 响应）
- [x] 7.3 为 router failover 逻辑编写测试（模拟 primary 失败 → fallback 成功）
- [x] 7.4 为 proxy pool 编写测试（轮换、健康标记、冷却恢复）
- [x] 7.5 为 indicators 和 volume profile 编写测试
