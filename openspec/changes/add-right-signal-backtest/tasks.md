## 1. Historical Analysis Core

- [x] 1.1 Add date parsing and effective trading date resolution helpers for `YYYY-MM-DD` as-of input.
- [x] 1.2 Add a daily K-line cutoff helper that returns only rows whose `date` is not later than the effective analysis date.
- [x] 1.3 Add historical price and change percentage calculation from truncated daily K-line rows.
- [x] 1.4 Extend `build_signal_report` to accept `as_of` and `trend_window` with default 60 while preserving current behavior when `as_of` is omitted.
- [x] 1.5 Ensure historical mode does not use realtime quote price or realtime quote change percentage.
- [x] 1.6 Add report context metadata with mode, requested as-of date, effective date, data start/end dates, trend window, cutoff status, and volume profile mode.

## 2. Volume Profile And Index Inputs

- [x] 2.1 Audit index K-line fetching and truncate index data to the effective analysis date in historical mode.
- [x] 2.2 Update volume profile building so historical mode only uses minute data that can be constrained to the effective date.
- [x] 2.3 Add a safe fallback that omits or degrades volume profile input when historical minute cutoff cannot be guaranteed.
- [x] 2.4 Surface volume profile mode in response metadata for current and historical reports.

## 3. Right Trend Series

- [x] 3.1 Implement a `right_trend` builder that computes summary points for up to N effective trading days ending at the report effective date, defaulting to 60.
- [x] 3.2 Include date, close, normalized close percentage, total score percentage, right score percentage, phase, right confirmed count, right total count, and per-right-signal states in each trend point.
- [x] 3.3 Bound and validate `trend_window` to avoid excessive computation.
- [x] 3.4 Ensure trend points are sorted ascending by date and tolerate fewer than 60 available trading days.
- [x] 3.5 Add lightweight forward outcome labels to trend points when future rows are available.
- [x] 3.6 Ensure forward outcome labels never affect as-of signal, phase, action, or narrative calculation.

## 4. Falsification Labels

- [x] 4.1 Implement forward 5/10/20 trading-day return calculations from daily K-lines.
- [x] 4.2 Implement 20-trading-day maximum gain and maximum drawdown calculations.
- [x] 4.3 Attach forward outcome labels to historical report context when enough future rows exist.
- [x] 4.4 Return null or omit labels for unavailable horizons without failing the report.

## 5. Python API

- [x] 5.1 Parse `as_of` and optional `trend_window` query parameters in `pipeline/server.py`.
- [x] 5.2 Return 400 for malformed as-of dates and dates earlier than available history.
- [x] 5.3 Keep `/api/signal-report/DEMO?demo=1` working with deterministic demo data.
- [x] 5.4 Add API response examples or fixture payloads covering current mode and historical mode.

## 6. Frontend Data Contract

- [x] 6.1 Extend `web/src/types.ts` with `report_context`, `right_trend`, trend point, and forward outcome label types.
- [x] 6.2 Add or document fields needed to label total score as structure strength and left/right scores as preparation/trigger scores.
- [x] 6.3 Extend `getSignalReport` options to accept `asOf` and `trendWindow`.
- [x] 6.4 Preserve existing ticker-only calls and demo calls.

## 7. Frontend Interaction

- [x] 7.1 Add historical date state and input control to the ticker form.
- [x] 7.2 Submit `as_of` when a historical date is selected.
- [x] 7.3 Add a clear-date action that returns the report to current analysis mode.
- [x] 7.4 Display current vs historical mode near the main conclusion.
- [x] 7.5 Display requested date, effective trading date, and data cutoff notice for historical reports.
- [x] 7.6 Label total confirmation score as structure strength rather than accuracy or probability.
- [x] 7.7 Display left-side preparation and right-side trigger explanations near the total score.
- [x] 7.8 Add diagnosis copy for mixed cases such as strong left/weak right and weak left/strong right.

## 8. Right Trend Chart

- [x] 8.1 Add an ECharts line chart for `right_trend.points`.
- [x] 8.2 Overlay total confirmation score percentage and normalized close percentage on the same time axis.
- [x] 8.3 Include close price, phase, right-side score, confirmed count, and forward outcome labels in tooltip detail.
- [x] 8.4 Use copy that frames the chart as a 复盘/证伪/校准 view rather than a prediction view.
- [x] 8.5 Add an empty state when no trend points are available.
- [x] 8.6 Keep the chart responsive at desktop and mobile widths.

## 9. Tests And Verification

- [x] 9.1 Add unit tests for as-of parsing, non-trading-date resolution, and out-of-range errors.
- [x] 9.2 Add tests proving rows after effective date are excluded before signal calculation.
- [x] 9.3 Add tests proving historical mode uses historical close/change percentage rather than realtime quote values.
- [x] 9.4 Add tests for right trend point length, ordering, normalized close field, and required fields.
- [x] 9.5 Add tests for forward outcome labels and insufficient future-row handling.
- [x] 9.6 Add tests proving forward outcome labels do not affect as-of signal or phase output.
- [x] 9.7 Add tests or snapshots proving total score copy does not use accuracy, win-rate, or probability wording.
- [x] 9.8 Add tests or snapshots for visible left-side preparation and right-side trigger summaries.
- [x] 9.9 Add API tests for current mode, historical mode, malformed dates, and out-of-range dates.
- [x] 9.10 Run Python tests for analyzer/server changes.
- [x] 9.11 Run frontend typecheck/build for React changes.
