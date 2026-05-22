## ADDED Requirements

### Requirement: Fetch Historical Daily Prices

The pipeline SHALL fetch historical daily K-line prices (adjusted close) for every ticker in the watchlist via the `global-stock-data` skill's `stock_kline_yahoo` interface. On the first run for a ticker, the pipeline SHALL request the longest available history using `range_="max"`. On subsequent runs, the pipeline SHALL perform an incremental fetch only for dates after the ticker's last persisted data date.

#### Scenario: First-time fetch for a new ticker

- **WHEN** a ticker has no existing price rows in D1 and no `fetch_log` entry
- **THEN** the pipeline MUST call `stock_kline_yahoo` with `range_="max"` and persist the full returned history

#### Scenario: Incremental fetch for an existing ticker

- **WHEN** a ticker already has a `fetch_log` row with `last_data_date = D`
- **THEN** the pipeline MUST only fetch and persist rows with trade_date > D

### Requirement: Fetch Quarterly EPS Data

The pipeline SHALL fetch quarterly EPS (both basic and diluted) for every ticker in the watchlist. For Hong Kong tickers, the pipeline SHALL use `key_indicators_eastmoney` as the primary source. For US tickers, the pipeline SHALL use `key_indicators_eastmoney` as the primary source and MAY cross-validate with `sec_xbrl_facts` in a v2 iteration.

#### Scenario: Hong Kong ticker EPS fetch

- **WHEN** the ticker matches the `*.HK` pattern
- **THEN** the pipeline MUST call `key_indicators_eastmoney` and persist quarterly basic/diluted EPS into `eps_quarterly`

#### Scenario: US ticker EPS fetch

- **WHEN** the ticker is a US-listed symbol (e.g. `AAPL`)
- **THEN** the pipeline MUST call `key_indicators_eastmoney` for primary EPS data; it MAY additionally call `sec_xbrl_facts` for cross-validation in v2

### Requirement: Compute TTM EPS Time Series

The pipeline SHALL convert the quarterly EPS data into a daily TTM EPS time series, where TTM EPS at any date equals the sum of the most recent four reported quarters as-of that date. Between report-release days, the TTM value SHALL be forward-filled from the prior TTM.

#### Scenario: New quarterly report released

- **WHEN** a new quarterly EPS row is recorded with announce_date = D
- **THEN** the daily TTM EPS series on date D MUST step to the new sum of the latest four quarters

#### Scenario: Day between two report releases

- **WHEN** a date D falls between two consecutive announce_dates
- **THEN** the TTM EPS value on D MUST equal the TTM EPS computed from the most recent announce_date <= D

#### Scenario: Ticker with fewer than 4 reported quarters

- **WHEN** a ticker has only N < 4 quarterly EPS rows available
- **THEN** the pipeline MUST NOT emit a TTM EPS value for any date prior to the 4th quarterly release

### Requirement: Compute PE-TTM Series

The pipeline SHALL compute PE_ttm for every trading day as `adjusted_close / TTM_EPS_on_that_day`.

#### Scenario: Positive TTM EPS

- **WHEN** TTM_EPS on a trading day D is > 0
- **THEN** the pipeline MUST persist `pe_ttm = adjusted_close(D) / TTM_EPS(D)` for date D

#### Scenario: Non-positive TTM EPS

- **WHEN** TTM_EPS on a trading day D is <= 0
- **THEN** the pipeline MUST NOT compute a numeric PE_ttm for D and MUST mark D as a loss period

### Requirement: Handle Loss Periods

The pipeline SHALL mark loss periods (TTM EPS <= 0) in the PE series, and these dates SHALL be excluded from all percentile calculations.

#### Scenario: Consecutive loss-period dates

- **WHEN** a span of dates has TTM EPS <= 0
- **THEN** every row in `pe_series` for that span MUST have `is_loss = true` and `pe_ttm = NULL`, and these rows MUST be excluded from the percentile window calculations

### Requirement: Compute Historical Percentiles

For every trading day's PE_ttm, the pipeline SHALL precompute the percentile rank (a value in 0-100) of that day's PE_ttm within three historical windows: trailing 5 years, trailing 10 years, and since-listing.

#### Scenario: Three-window percentile computation

- **WHEN** a daily PE_ttm value is available for date D
- **THEN** the pipeline MUST compute and persist three percentile fields for D: `pct_5y`, `pct_10y`, and `pct_all`, each representing the percentile rank of PE_ttm(D) within the respective historical window (loss-period dates excluded)

### Requirement: Detect Stock Splits and Refresh

The pipeline SHALL perform a full re-fetch of the price history for every watchlist ticker at least once per calendar month to guard against split/adjustment changes that would distort historical PE.

#### Scenario: First pipeline run of the month

- **WHEN** the current run is the first scheduled execution within a new calendar month for a ticker
- **THEN** the pipeline MUST trigger a full price re-fetch for that ticker (equivalent to a first-time fetch) and overwrite the existing price rows

#### Scenario: Subsequent pipeline run in the same month

- **WHEN** a full monthly re-fetch has already completed for the current month
- **THEN** the pipeline MUST use the incremental fetch path

### Requirement: Persist to Cloudflare D1 Idempotently

The pipeline SHALL persist data into Cloudflare D1 tables `prices`, `eps_quarterly`, and `pe_series`. Re-running the pipeline for the same date(s) SHALL be idempotent through UPSERT / `INSERT OR REPLACE` semantics keyed on `(ticker, date)` or `(ticker, period)`.

#### Scenario: Re-writing same-day price data

- **WHEN** the pipeline writes price rows for `(ticker=T, trade_date=D)` that already exist in D1
- **THEN** the new rows MUST overwrite the existing rows in place and the resulting table MUST contain exactly one row for `(T, D)`

### Requirement: Track Fetch Log

The pipeline SHALL maintain a `fetch_log` table that records, per ticker and per data type, the timestamp of the last fetch attempt and the latest data date successfully retrieved, to drive incremental fetch decisions.

#### Scenario: Successful price fetch updates the log

- **WHEN** a price fetch for ticker T completes successfully and the latest retrieved trade_date is D
- **THEN** the pipeline MUST upsert a `fetch_log` row with `(ticker=T, data_type='price', last_fetch_at=now, last_data_date=D)`

### Requirement: Scheduled Daily Execution

The pipeline SHALL be triggered by GitHub Actions cron on weekdays after market close, with two batches (one after Hong Kong close, one after US close). Total monthly runtime SHALL remain within the GitHub Actions free tier (< 2000 minutes/month).

#### Scenario: Scheduled cron execution

- **WHEN** a GitHub Actions cron schedule triggers the pipeline on a weekday post-close
- **THEN** the pipeline MUST iterate every ticker in the watchlist, run the appropriate (incremental or full) fetch path for each, and complete within the free-tier minute budget

### Requirement: Graceful Per-Ticker Failure

The pipeline SHALL isolate failures at the per-ticker level: when fetching or computing fails for one ticker, the pipeline SHALL log the error and continue processing remaining tickers without aborting the entire job.

#### Scenario: One ticker's upstream API errors

- **WHEN** the upstream data source returns an error for a single ticker
- **THEN** the pipeline MUST record the error (ticker, data_type, error message) to logs and continue with the next ticker, and the GitHub Actions job MUST NOT exit with a non-zero status solely because of this single-ticker failure

### Requirement: Ticker Format Normalization

At the pipeline entry point, the pipeline SHALL normalize ticker formats to bridge between data-source-specific conventions (e.g. Yahoo uses `0700.HK`, Eastmoney uses `00700.HK`) and SHALL store a single canonical format in D1.

#### Scenario: Watchlist entry uses Yahoo Hong Kong format

- **WHEN** the watchlist contains the ticker `0700.HK`
- **THEN** the pipeline MUST internally map this to `00700.HK` when calling Eastmoney APIs and to `0700.HK` when calling Yahoo APIs, while persisting under the single canonical ticker string in D1
