## ADDED Requirements

### Requirement: Data source priority chain

The system SHALL define a priority chain for each data type, attempting the highest-priority source first and falling back to the next on failure.

The priority chains SHALL be:

| Data Type | Priority 1 | Priority 2 | Priority 3 |
|-----------|-----------|-----------|-----------|
| Real-time quote | EastMoney push2 | Sina | Tencent |
| Daily K-line | EastMoney push2his | Yahoo | Sina |
| Minute K-line | EastMoney push2his (proxy) | — | — |
| PE-TTM | Xueqiu | — | — |
| Money flow | EastMoney push2his | — | — |

#### Scenario: Primary source succeeds
- **WHEN** caller requests daily K-line for "AAPL" and EastMoney push2his responds successfully
- **THEN** system returns data from EastMoney without attempting Yahoo or Sina

#### Scenario: Primary source fails, fallback succeeds
- **WHEN** caller requests daily K-line for "AAPL" and EastMoney push2his returns an error or times out
- **THEN** system automatically attempts Yahoo Finance and returns data from Yahoo

#### Scenario: All sources fail
- **WHEN** caller requests daily K-line for "AAPL" and all sources in the priority chain fail
- **THEN** system raises a `DataSourceError` exception with details of all attempted sources

### Requirement: Adapter interface contract

Each data source adapter SHALL implement a common interface with the following methods:

- `fetch_quotes(tickers: list[str]) -> list[Quote]`
- `fetch_klines(ticker: str, period: str, count: int, adjust: str) -> DataFrame`

Each method SHALL raise `AdapterError` on failure (network error, rate limit, invalid response).

Each adapter SHALL handle its own ticker format conversion internally (e.g., `0700.HK` → `00700` for EastMoney, `0700.HK` for Yahoo).

#### Scenario: Adapter normalizes ticker
- **WHEN** EastMoney adapter receives ticker `0700.HK`
- **THEN** adapter internally converts to secid `116.00700` before making the HTTP request

#### Scenario: Adapter raises on HTTP error
- **WHEN** adapter receives HTTP 429 (rate limited) from data source
- **THEN** adapter raises `AdapterError` with the HTTP status code and source name

### Requirement: Health tracking per source

The router SHALL track success/failure counts per data source and temporarily skip sources with a high failure rate.

A source SHALL be marked unhealthy after 3 consecutive failures.

An unhealthy source SHALL be retried after a cooldown period of 60 seconds.

#### Scenario: Source becomes unhealthy
- **WHEN** EastMoney push2 fails 3 times consecutively for quote requests
- **THEN** router skips EastMoney and uses Sina directly for subsequent quote requests

#### Scenario: Unhealthy source recovers
- **WHEN** an unhealthy source's cooldown period (60s) expires
- **THEN** router attempts the source again on the next request and marks it healthy if it succeeds

### Requirement: Timeout configuration

Each adapter request SHALL have a configurable timeout, defaulting to 10 seconds.

The router SHALL enforce a total timeout across all fallback attempts, defaulting to 30 seconds.

#### Scenario: Single adapter timeout
- **WHEN** EastMoney push2 does not respond within 10 seconds
- **THEN** adapter raises `AdapterError` and router proceeds to the next source

#### Scenario: Total timeout exceeded
- **WHEN** all sources in the chain are slow and 30 seconds elapse before any returns data
- **THEN** router raises `DataSourceError` indicating total timeout exceeded
