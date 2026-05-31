## ADDED Requirements

### Requirement: HTML report structure

The system SHALL generate a single self-contained HTML file with the following sections in order:

1. **Header**: Ticker, stock name, current price, change percentage, analysis timestamp
2. **Conclusion card**: Phase icon + phase name, action recommendation, trigger condition, overall strength with range bar
3. **Left-side signals section**: 6 signal cards, each with light icon, name, confidence percentage, range bar, description text
4. **Right-side signals section**: 4 signal cards, same format as left-side
5. **Narrative summary**: 2-4 sentence analysis paragraph
6. **Footer**: Disclaimer ("仅供参考，不构成投资建议"), generation timestamp

#### Scenario: Complete report generated
- **WHEN** analyzer completes analysis for "AAPL"
- **THEN** output is a valid HTML file containing all 6 sections in the specified order

#### Scenario: Report is self-contained
- **WHEN** HTML file is opened in a browser without internet
- **THEN** the page renders correctly (layout/styling via CDN is acceptable to require internet for)

### Requirement: Signal card display

Each signal card SHALL display:
- Signal light icon (🔴 / 🟡 / 🟢) with colored background
- Signal name (Chinese)
- Confidence percentage (e.g., "85%")
- A horizontal range bar showing the confidence position relative to red/yellow/green thresholds
- Description text explaining the signal in plain Chinese with actual data values

The range bar SHALL visually indicate the three zones (red/yellow/green) and mark the current confidence position.

#### Scenario: Green signal card
- **WHEN** signal "缩量下跌" has confidence 0.85 and light "green"
- **THEN** card shows 🟢 icon, "85%", bar filled to 85% with green zone highlighted, description like "5日均量 = 20日均量的 55%，抛压明显减轻"

#### Scenario: Yellow signal card
- **WHEN** signal "MACD金叉" has confidence 0.52 and light "yellow"
- **THEN** card shows 🟡 icon, "52%", bar filled to 52% in yellow zone, description like "DIF 接近 DEA，差距收窄中"

### Requirement: Responsive layout

The HTML page SHALL be responsive:
- **Mobile (< 768px)**: Single column, cards stacked vertically, full-width range bars
- **Desktop (≥ 768px)**: Two-column grid for signal cards, wider conclusion card

The page SHALL use Tailwind CSS via CDN (`@tailwindcss/browser@4`) for styling.

#### Scenario: Mobile viewport
- **WHEN** page is viewed on a 375px wide screen
- **THEN** all cards display in a single column, text is readable without horizontal scrolling

#### Scenario: Desktop viewport
- **WHEN** page is viewed on a 1440px wide screen
- **THEN** signal cards display in a 2-column grid, conclusion card spans full width

### Requirement: Range bar visualization

The range bar for each signal SHALL:
- Show three colored zones (red, yellow, green) proportional to their threshold ranges
- Display a marker/fill indicating the current confidence value
- Show threshold labels below the bar (e.g., "🔴 0-35% 🟡 35-70% 🟢 70-100%")

The overall strength range bar SHALL show 5 zones matching the phase boundaries.

#### Scenario: Default threshold bar
- **WHEN** signal has default thresholds (0.35, 0.70)
- **THEN** bar shows red zone 0-35%, yellow zone 35-70%, green zone 70-100%

#### Scenario: Custom threshold bar
- **WHEN** signal "volume_breakout" has thresholds (0.35, 0.75)
- **THEN** bar shows red zone 0-35%, yellow zone 35-75%, green zone 75-100%

### Requirement: CLI entry point

The system SHALL provide a CLI script at `pipeline/analyze.py` that:
- Accepts a ticker as the first positional argument
- Generates the HTML report
- Saves to `output/<ticker>_<YYYYMMDD>.html`
- Prints the output file path to stdout

#### Scenario: Run analysis
- **WHEN** user runs `python analyze.py AAPL`
- **THEN** system fetches data, computes signals, generates HTML, saves file, prints path

#### Scenario: Missing ticker argument
- **WHEN** user runs `python analyze.py` without arguments
- **THEN** system prints usage message and exits with code 1

### Requirement: Color scheme and visual design

The report SHALL use a dark theme optimized for financial data:
- Background: dark gray (#1a1a2e or similar)
- Cards: slightly lighter background (#16213e)
- Text: white/light gray
- Signal lights: red (#ef4444), yellow (#f59e0b), green (#22c55e)
- Range bars: corresponding zone colors with muted backgrounds

#### Scenario: Visual hierarchy
- **WHEN** user opens the report
- **THEN** the conclusion card is the most prominent element (larger text, distinct background), followed by signal cards, then narrative
