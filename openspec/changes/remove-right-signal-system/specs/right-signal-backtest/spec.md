## REMOVED Requirements

### Requirement: Historical right-signal report
**Reason**: The complete right-side signal system is being removed.
**Migration**: Use the bottoming-only historical report and `bottoming_history`.

### Requirement: Right trend series
**Reason**: The series is derived from removed right-side signals.
**Migration**: Use `bottoming_history`, which contains bottoming tier, cleanliness and three-sign states.

### Requirement: Right trend chart
**Reason**: The chart visualizes removed right-side metrics.
**Migration**: Render the structure falsification chart from `bottoming_history`.

## MODIFIED Requirements

### Requirement: No future data in historical mode
The system MUST NOT use market data later than the effective analysis date when computing a historical bottoming report. This constraint SHALL apply to daily K-lines, index inputs, price, change percentage, retained signals, bottoming signs, verdict, narrative, and bottoming history points.

#### Scenario: Future rows are excluded
- **WHEN** a historical report is requested
- **THEN** all structural calculations use data ending on the effective trading date

### Requirement: Score semantics and layered explanation
The system SHALL present washout cleanliness as the only top-level structure strength, not accuracy, win rate, forecast probability, or future price increase probability. Retained signal confidences are evidence details and MUST NOT be aggregated into a competing total score. The report MUST NOT expose a right-side trigger layer.

#### Scenario: Bottoming-only semantics
- **WHEN** the report displays a score
- **THEN** it labels the score as structure strength and contains no right-side score explanation

### Requirement: Falsification outcome labels
The system SHALL attach available forward outcome labels to historical reports and bottoming history points. Outcome labels MUST NOT change as-of retained signals, bottoming verdict, narrative, or report context.

#### Scenario: Labels remain descriptive only
- **WHEN** future outcomes are available
- **THEN** they are displayed for falsification without affecting the as-of judgment
