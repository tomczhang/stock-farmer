## ADDED Requirements

### Requirement: Historical right-signal report

The system SHALL allow callers to request a right-side trend report for a historical as-of date by providing a ticker and `as_of` date in `YYYY-MM-DD` format.

The historical report SHALL use the same signal formulas, signal weights, light mapping, right-state mapping, phase rules, and narrative generation as the current report.

#### Scenario: Report for a trading day

- **WHEN** caller requests `/api/signal-report/AAPL?as_of=2026-05-15`
- **THEN** the system returns a report whose effective analysis date is `2026-05-15`
- **THEN** all signal calculations use market data ending on `2026-05-15`

#### Scenario: Report for a non-trading day

- **WHEN** caller requests a Saturday, Sunday, or market holiday in `as_of`
- **THEN** the system uses the latest available trading day not later than the requested date as `effective_date`
- **THEN** the response includes both the requested date and the effective trading date

#### Scenario: Date before available history

- **WHEN** caller requests an `as_of` date earlier than the first available K-line row for the ticker
- **THEN** the API responds with 400 and an error code indicating the date is outside available history

### Requirement: No future data in historical mode

The system MUST NOT use market data later than the effective analysis date when computing a historical report.

This constraint SHALL apply to daily K-lines, index environment inputs, volume profile inputs, price, change percentage, signal descriptions, phase, narrative, and right-trend summary points.

#### Scenario: Future daily rows are excluded

- **WHEN** a ticker has daily K-line rows after the effective analysis date
- **THEN** those rows are excluded before `compute_all_signals` is called

#### Scenario: Historical price does not use realtime quote

- **WHEN** caller requests a historical `as_of` date
- **THEN** the response price equals the effective date close from the historical K-line data
- **THEN** the response change percentage is calculated from the previous available close

#### Scenario: Minute profile cannot be safely historical

- **WHEN** minute-level volume profile data cannot be constrained to the effective analysis date
- **THEN** the system MUST omit or degrade the volume profile input rather than using future minute data
- **THEN** the response metadata identifies the volume profile mode used for the historical report

### Requirement: Historical report metadata

The response SHALL include metadata that tells users how the historical analysis date was resolved and what data window was used.

The metadata SHALL include at minimum: report mode, requested as-of date, effective date, data start date, data end date, trend window, and whether the analysis used a historical cutoff.

#### Scenario: Historical metadata is present

- **WHEN** caller requests a report with `as_of`
- **THEN** the response includes `report_context.mode = "historical"`
- **THEN** the response includes `report_context.requested_as_of`, `report_context.effective_date`, `report_context.data_start_date`, and `report_context.data_end_date`

#### Scenario: Current metadata is present

- **WHEN** caller requests a report without `as_of`
- **THEN** the response includes `report_context.mode = "current"`
- **THEN** the response effective date equals the latest available K-line date

### Requirement: Score semantics and layered explanation

The system SHALL present the total confirmation score as current structure strength or trend confirmation strength, not as accuracy, win rate, forecast probability, or probability of future price increase.

The report SHALL expose and explain left-side preparation and right-side trigger strength separately wherever the total confirmation score is shown.

#### Scenario: Total score is not probability

- **WHEN** the report displays `confirmation.score_pct`
- **THEN** the label uses structure strength or trend confirmation strength wording
- **THEN** the UI and narrative do not describe the score as accuracy, win rate, forecast probability, or future price increase probability

#### Scenario: Left and right summaries are visible

- **WHEN** the report displays the total confirmation score
- **THEN** it also displays left-side preparation score and right-side trigger score
- **THEN** it explains that left-side score reflects bottoming/preparation evidence and right-side score reflects trend-trigger evidence

#### Scenario: Mixed left-right diagnosis

- **WHEN** left-side preparation is strong and right-side trigger is weak
- **THEN** the report diagnosis indicates that the structure is prepared but right-side confirmation is incomplete

#### Scenario: Strong trigger with weak preparation

- **WHEN** right-side trigger is strong and left-side preparation is weak
- **THEN** the report diagnosis indicates strong launch or momentum trigger with weaker base quality and need for follow-up confirmation

### Requirement: Right trend series

The system SHALL include a right-side trend series for the latest N effective trading days ending at the report effective date.

The default window SHALL be 60 trading days. The API MAY accept a bounded `trend_window` parameter, but it MUST cap the value to prevent excessive computation.

Each trend point SHALL include at minimum: date, close, normalized close percentage, total confirmation score percentage, right-side score percentage, phase, right confirmed count, right total count, and per-right-signal state keys.

#### Scenario: Default 60-day trend

- **WHEN** caller requests `/api/signal-report/AAPL?as_of=2026-05-15` without `trend_window`
- **THEN** the response includes up to 60 trend points ending at the effective analysis date
- **THEN** trend points are sorted ascending by date

#### Scenario: Limited available history

- **WHEN** fewer than 60 effective trading days are available before or on the effective analysis date
- **THEN** the response includes all available trend points
- **THEN** the response does not fail solely because the full trend window is unavailable

#### Scenario: Trend point opens full report

- **WHEN** the frontend needs full signal details for a trend point date
- **THEN** it can request the same endpoint with `as_of` equal to that point date and receive the full historical report for that date

### Requirement: Falsification outcome labels

The system SHALL attach lightweight forward outcome labels to historical reports and right-trend points when enough future daily K-line data is available.

Forward outcome labels SHALL be descriptive validation aids only. They MUST NOT change as-of signal confidence, phase, narrative, action, right-state mapping, or report context.

Outcome labels SHALL include at minimum forward return percentages for 5, 10, and 20 trading days, plus 20-trading-day maximum gain and maximum drawdown percentages when enough future rows exist.

#### Scenario: Outcome labels for historical report

- **WHEN** caller requests a historical report whose effective date has at least 20 later trading days in the fetched K-line data
- **THEN** the response includes forward 5-day, 10-day, and 20-day return labels
- **THEN** the response includes 20-day maximum gain and maximum drawdown labels

#### Scenario: Outcome labels do not affect as-of judgment

- **WHEN** outcome labels are computed for a historical date
- **THEN** the signal confidences, right states, phase, and narrative are identical to the values computed from data ending on that historical date

#### Scenario: Insufficient future rows

- **WHEN** fewer than the required future rows are available for an outcome horizon
- **THEN** the unavailable outcome label is null or omitted
- **THEN** the historical report remains valid

### Requirement: Frontend historical controls

The frontend SHALL allow users to choose a historical as-of date while analyzing a ticker.

The frontend SHALL also allow users to clear the date and return to current analysis mode.

#### Scenario: Submit historical analysis

- **WHEN** user enters ticker `AAPL`, selects `2026-05-15`, and submits the form
- **THEN** the frontend requests `/api/signal-report/AAPL?as_of=2026-05-15`
- **THEN** the report displays the historical result returned by the API

#### Scenario: Return to current analysis

- **WHEN** user clears the selected historical date and submits the form
- **THEN** the frontend requests `/api/signal-report/<ticker>` without `as_of`
- **THEN** the report displays current analysis mode

### Requirement: Frontend historical context display

The frontend SHALL clearly show whether the report is current or historical.

For historical reports, the frontend SHALL display the requested as-of date, effective trading date, and a concise notice that the result only uses data available on or before the effective date.

#### Scenario: Historical context visible

- **WHEN** a historical report is displayed
- **THEN** the page shows the effective trading date near the main conclusion
- **THEN** the page shows the requested date if it differs from the effective trading date

#### Scenario: Current context visible

- **WHEN** a current report is displayed
- **THEN** the page identifies the report as current analysis and does not imply a historical cutoff

### Requirement: Right trend chart

The frontend SHALL render the right-side trend series as a falsification mirror that helps users inspect whether the right-side trend judgment leads, follows, or diverges from price movement.

The chart SHALL overlay total confirmation score percentage and normalized close percentage on the same time axis. It SHALL expose close price, phase, right-side score, right confirmed count, and available forward outcome labels in tooltip or equivalent detail.

#### Scenario: Trend chart with points

- **WHEN** the response includes right-trend points
- **THEN** the frontend renders chronological overlay lines for score percentage and normalized close percentage
- **THEN** the chart detail includes phase, right-side signal confirmation information, and available forward outcome labels for the hovered or selected date

#### Scenario: Trend chart unavailable

- **WHEN** the response has no right-trend points
- **THEN** the frontend shows an empty or unavailable state without crashing
