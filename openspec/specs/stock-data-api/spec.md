## ADDED Requirements

### Requirement: Unified quote retrieval

The system SHALL provide a `get_quotes(tickers: list[str]) -> list[Quote]` function that returns the latest real-time quote for each ticker.

Each `Quote` object SHALL contain: `ticker`, `name`, `price`, `open`, `high`, `low`, `prev_close`, `volume`, `amount`, `change_pct`, `change_amount`, `turnover_rate`, `timestamp`.

The function SHALL accept tickers in normalized format: `AAPL` (US) or `0700.HK` (HK).

#### Scenario: Fetch US stock quotes
- **WHEN** caller invokes `get_quotes(["AAPL", "TSLA", "NVDA"])`
- **THEN** system returns a list of 3 Quote objects with current market data for each ticker

#### Scenario: Fetch HK stock quotes
- **WHEN** caller invokes `get_quotes(["0700.HK", "9988.HK"])`
- **THEN** system returns a list of 2 Quote objects with HKD-denominated prices

#### Scenario: Mixed US and HK tickers
- **WHEN** caller invokes `get_quotes(["AAPL", "0700.HK"])`
- **THEN** system returns quotes for both tickers regardless of market

#### Scenario: Invalid ticker
- **WHEN** caller invokes `get_quotes(["INVALIDXYZ"])`
- **THEN** system returns a Quote with `price=None` and does not raise an exception

### Requirement: Multi-period K-line retrieval

The system SHALL provide a `get_klines(ticker: str, period: str, count: int, adjust: str) -> DataFrame` function that returns OHLCV candlestick data.

The `period` parameter SHALL support: `1d`, `1w`, `1mo`, `5m`, `15m`, `30m`, `60m`.

The `adjust` parameter SHALL support: `qfq` (forward adjust, default), `hfq` (backward adjust), `none`.

The returned DataFrame SHALL contain columns: `date`, `open`, `high`, `low`, `close`, `volume`, `amount`.

#### Scenario: Daily K-line with default count
- **WHEN** caller invokes `get_klines("AAPL", period="1d", count=250)`
- **THEN** system returns a DataFrame with up to 250 rows of daily OHLCV data, forward-adjusted

#### Scenario: 5-minute K-line
- **WHEN** caller invokes `get_klines("AAPL", period="5m", count=100)`
- **THEN** system returns a DataFrame with up to 100 rows of 5-minute OHLCV data

#### Scenario: Weekly K-line for HK stock
- **WHEN** caller invokes `get_klines("0700.HK", period="1w", count=52)`
- **THEN** system returns a DataFrame with up to 52 rows of weekly OHLCV data

### Requirement: Technical indicator calculation

The system SHALL provide a `get_indicators(ticker: str, indicators: list[str], period: str, count: int) -> DataFrame` function that returns K-line data with requested technical indicators appended as additional columns.

Supported indicator names SHALL include: `macd`, `rsi`, `kdj`, `bollinger`, `atr`, `ma`, `ema`, `obv`, `mfi`, `cci`.

The function SHALL automatically fetch K-line data internally — callers do not need to provide raw price data.

#### Scenario: MACD indicator
- **WHEN** caller invokes `get_indicators("AAPL", indicators=["macd"])`
- **THEN** system returns a DataFrame with columns `date, open, high, low, close, volume` plus `macd`, `macd_signal`, `macd_hist`

#### Scenario: Multiple indicators
- **WHEN** caller invokes `get_indicators("AAPL", indicators=["rsi", "atr", "bollinger"])`
- **THEN** system returns a DataFrame with columns including `rsi`, `atr`, `bb_upper`, `bb_middle`, `bb_lower`

#### Scenario: Indicators with custom period
- **WHEN** caller invokes `get_indicators("AAPL", indicators=["macd"], period="1w", count=100)`
- **THEN** system computes MACD based on weekly K-line data

### Requirement: Money flow retrieval

The system SHALL provide a `get_money_flow(ticker: str, days: int) -> DataFrame` function that returns daily-level capital flow data.

The returned DataFrame SHALL contain columns: `date`, `main_net_inflow`, `large_net_inflow`, `xlarge_net_inflow`, `medium_net_inflow`, `small_net_inflow`, `main_net_pct`, `close`, `change_pct`.

#### Scenario: Recent money flow
- **WHEN** caller invokes `get_money_flow("AAPL", days=30)`
- **THEN** system returns a DataFrame with up to 30 rows of daily capital flow data

#### Scenario: HK stock money flow
- **WHEN** caller invokes `get_money_flow("0700.HK", days=10)`
- **THEN** system returns capital flow data for the HK-listed stock

### Requirement: Volume Profile construction

The system SHALL provide a `get_volume_profile(ticker: str, days: int, num_bins: int) -> list[dict]` function that constructs a price-volume distribution from intraday minute-level K-line data.

Each element in the returned list SHALL contain: `price_level` (bin center price), `volume` (total volume in this bin), `pct` (percentage of total volume).

The bins SHALL be evenly spaced across the price range of the specified period.

#### Scenario: Single day Volume Profile
- **WHEN** caller invokes `get_volume_profile("AAPL", days=1, num_bins=30)`
- **THEN** system fetches 5-minute K-line data for the most recent trading day and returns 30 price-volume bins

#### Scenario: Multi-day Volume Profile
- **WHEN** caller invokes `get_volume_profile("AAPL", days=5, num_bins=50)`
- **THEN** system aggregates 5-minute K-line data over the last 5 trading days into 50 bins

### Requirement: PE-TTM retrieval

The system SHALL provide a `get_pe_ttm(ticker: str) -> float | None` function that returns the current trailing-twelve-month PE ratio.

This SHALL delegate to the existing Xueqiu quote endpoint internally.

#### Scenario: Fetch PE for US stock
- **WHEN** caller invokes `get_pe_ttm("AAPL")`
- **THEN** system returns the current PE-TTM value (e.g., 37.39)

#### Scenario: Stock with negative earnings
- **WHEN** caller invokes `get_pe_ttm("SOME_LOSS_TICKER")`
- **THEN** system returns `None`
