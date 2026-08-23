## MODIFIED Requirements

### Requirement: Signal confidence calculation
The system SHALL compute a confidence value (0.0 to 1.0) for each of the 6 retained left-side signals: vol_shrink, no_new_low, false_breakdown, vol_contraction, chip_concentration, and market_env. The system MUST NOT compute above_ma, support_retest_hold, volume_breakout, macd_cross, or higher_low.

Each confidence value SHALL have a physically interpretable formula tied to observable market data.

#### Scenario: Signal set contains only retained signals
- **WHEN** `compute_all_signals` analyzes a valid daily series
- **THEN** it returns exactly the 6 retained left-side signal IDs and no right category signal

### Requirement: Action recommendation
The system SHALL derive neutral observation text from the bottoming verdict and MUST NOT recommend waiting for, building from, holding from, or adding from a right-side confirmation state.

#### Scenario: Base is ready
- **WHEN** the verdict is base_ready
- **THEN** the action describes the completed bottoming structure and continued support observation without a right-side trigger condition or buy instruction

### Requirement: Narrative summary generation
The system SHALL generate a deterministic narrative describing the bottoming verdict, three signs, retained left-side evidence, applicability, and research disclaimer. It MUST NOT mention right-side signals or right-side confirmation.

#### Scenario: Generate bottoming-only narrative
- **WHEN** a report is generated for any verdict tier
- **THEN** its narrative contains no right-side signal status or right-side watch condition

## REMOVED Requirements

### Requirement: Phase determination
**Reason**: The left/right green-count phase matrix is part of the deleted right-side system.
**Migration**: Use the canonical BottomingVerdict tier and trend regime background.

### Requirement: Overall strength calculation
**Reason**: The mixed 11-signal confirmation score changes meaning after right-side removal and would compete with washout cleanliness.
**Migration**: Use bottoming cleanliness as the only top-level structure score; retain individual left signal confidences as evidence.
