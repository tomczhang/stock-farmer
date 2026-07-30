import type { Coverage, Currency, InstrumentPnlBreakdown, PnlBreakdown, SummaryInstrument, SummaryPosition } from "../../types";

export type AggregatedCostSource = SummaryPosition["costSource"] | "mixed";

export interface InstrumentPosition {
  key: string;
  market: string;
  currency: Currency;
  symbol: string;
  name: string;
  quantity: number;
  marketValue: number | null;
  valueDisplay: number;
  bookCost: number | null;
  bookCostDisplay: number | null;
  avgCost: number | null;
  currentPrice: number | null;
  quoteApplied: boolean;
  bucket: string;
  holdingRatio: number;
  externalNetInvested: number | null;
  pnl: InstrumentPnlBreakdown;
  coverage: Coverage;
  costSource: AggregatedCostSource;
  asOf: string;
  brokerRows: SummaryPosition[];
}

export function positionInstrumentKey(position: Pick<SummaryPosition, "market" | "symbol">) {
  return `${position.market}:${position.symbol.toUpperCase()}`;
}

function marketCurrency(market: string): Currency {
  if (market === "HK") return "HKD";
  if (market === "CN") return "CNY";
  return "USD";
}

function rowPnl(position: SummaryPosition): PnlBreakdown {
  if (!position.pnl) return {
    realizedCapitalGain: 0,
    unrealizedCapitalGain: position.gainLossDisplay,
    capitalGain: position.gainLossDisplay,
    dividendsGross: 0,
    dividendsNet: 0,
    tradingFees: 0,
    financingFees: 0,
    explainedTotal: position.gainLossDisplay,
    economicTotal: null,
    unexplained: null,
  };
  return {
    realizedCapitalGain: position.pnl.realizedCapitalGain ?? 0,
    unrealizedCapitalGain: position.pnl.unrealizedCapitalGain,
    capitalGain: position.pnl.capitalGain,
    dividendsGross: position.pnl.dividendsGross ?? 0,
    dividendsNet: position.pnl.dividendsNet ?? 0,
    tradingFees: position.pnl.tradingFees ?? 0,
    financingFees: position.pnl.financingFees ?? 0,
    explainedTotal: position.pnl.explainedTotal,
    economicTotal: position.pnl.economicTotal,
    unexplained: position.pnl.unexplained,
  };
}

function combinedCoverage(rows: SummaryPosition[]): Coverage {
  const missing = Array.from(new Set(rows.flatMap((row) => row.coverage?.missing ?? [])));
  const issues = Array.from(new Set(rows.flatMap((row) => row.coverage?.issues ?? [])));
  const completeCount = rows.filter((row) => row.coverage?.status === "complete").length;
  const hasPartial = rows.some((row) => row.coverage?.status === "partial");
  const status = completeCount === rows.length
    ? "complete"
    : completeCount > 0 || hasPartial
      ? "partial"
      : "missing";
  return { status, ratio: rows.length > 0 ? completeCount / rows.length : 0, missing, issues };
}

function mergeCoverages(...items: Coverage[]): Coverage {
  const missing = Array.from(new Set(items.flatMap((item) => item.missing)));
  const issues = Array.from(new Set(items.flatMap((item) => item.issues)));
  const completeCount = items.filter((item) => item.status === "complete").length;
  const status = completeCount === items.length
    ? "complete"
    : completeCount > 0 || items.some((item) => item.status === "partial")
      ? "partial"
      : "missing";
  return {
    status,
    ratio: items.length > 0 ? items.reduce((sum, item) => sum + (item.ratio ?? (item.status === "complete" ? 1 : 0)), 0) / items.length : 0,
    missing,
    issues,
  };
}

/** Prefer the server's audited instrument layer. The local grouping remains only
 * for compatibility with summaries produced before `summary.instruments` existed.
 */
export function aggregateSummaryPositions(
  positions: SummaryPosition[],
  positionsValueDisplay: number,
  instruments?: SummaryInstrument[],
): InstrumentPosition[] {
  const groups = new Map<string, SummaryPosition[]>();
  for (const position of positions) {
    const key = positionInstrumentKey(position);
    const group = groups.get(key) ?? [];
    group.push(position);
    groups.set(key, group);
  }

  if (instruments != null) {
    return instruments.map((instrument) => {
      const brokerRows = groups.get(instrument.key) ?? [];
      const nativeCurrencies = Array.from(new Set(brokerRows.map((row) => row.currency)));
      const nativeComplete = nativeCurrencies.length === 1;
      const currency = nativeComplete ? nativeCurrencies[0] : marketCurrency(instrument.market);
      const nativeCosts = brokerRows.map((row) => row.bookCost ?? row.effectiveCost);
      const marketValue = nativeComplete
        ? brokerRows.reduce((sum, row) => sum + row.marketValue, 0)
        : null;
      const bookCost = nativeComplete && nativeCosts.every((value) => value != null)
        ? nativeCosts.reduce((sum, value) => sum + (value ?? 0), 0)
        : null;
      const nativeCoverage: Coverage = nativeComplete
        ? { status: "complete", ratio: 1, missing: [], issues: [] }
        : { status: "missing", ratio: 0, missing: ["native_currency_aggregation"], issues: [] };

      return {
        key: instrument.key,
        market: instrument.market,
        currency,
        symbol: instrument.symbol,
        name: instrument.name,
        quantity: instrument.quantity,
        marketValue,
        valueDisplay: instrument.valueDisplay,
        bookCost,
        bookCostDisplay: instrument.bookCostDisplay,
        avgCost: bookCost == null || instrument.quantity <= 0 ? null : bookCost / instrument.quantity,
        currentPrice: marketValue == null || instrument.quantity <= 0 ? null : marketValue / instrument.quantity,
        quoteApplied: instrument.quoteApplied,
        bucket: instrument.bucket,
        holdingRatio: instrument.holdingRatio,
        externalNetInvested: instrument.externalNetInvested,
        pnl: instrument.pnl,
        coverage: mergeCoverages(instrument.coverage, instrument.capitalCoverage, nativeCoverage),
        costSource: instrument.bookCostSource,
        asOf: instrument.asOf,
        brokerRows,
      };
    }).sort((a, b) => b.valueDisplay - a.valueDisplay);
  }

  return Array.from(groups.entries()).map(([key, unsortedRows]) => {
    const rows = [...unsortedRows].sort((a, b) => a.broker.localeCompare(b.broker));
    const first = rows[0];
    const flow = rowPnl(first);
    const quantity = rows.reduce((sum, row) => sum + row.quantity, 0);
    const marketValue = rows.reduce((sum, row) => sum + row.marketValue, 0);
    const valueDisplay = rows.reduce((sum, row) => sum + row.valueDisplay, 0);
    const originalCosts = rows.map((row) => row.bookCost ?? row.effectiveCost);
    const displayCosts = rows.map((row) => row.costDisplay);
    const bookCost = originalCosts.every((value) => value != null)
      ? originalCosts.reduce((sum, value) => sum + (value ?? 0), 0)
      : null;
    const bookCostDisplay = displayCosts.every((value) => value != null)
      ? displayCosts.reduce((sum, value) => sum + (value ?? 0), 0)
      : null;
    const unrealizedValues = rows.map((row) => rowPnl(row).unrealizedCapitalGain);
    const unrealizedCapitalGain = unrealizedValues.every((value) => value != null)
      ? unrealizedValues.reduce((sum, value) => sum + (value ?? 0), 0)
      : null;
    const capitalGain = unrealizedCapitalGain == null
      ? null
      : flow.realizedCapitalGain + unrealizedCapitalGain;
    const explainedTotal = capitalGain == null
      ? null
      : capitalGain + flow.dividendsNet - flow.tradingFees - flow.financingFees;
    const sources = Array.from(new Set<AggregatedCostSource>(rows.map((row) => row.bookCostSource ?? row.costSource)));
    const externalValues = rows.map((row) => row.externalNetInvested);
    const externalNetInvested = externalValues.every((value) => value != null)
      ? (externalValues[0] ?? null)
      : null;

    return {
      key,
      market: first.market,
      currency: first.currency,
      symbol: first.symbol,
      name: first.name,
      quantity,
      marketValue,
      valueDisplay,
      bookCost,
      bookCostDisplay,
      avgCost: bookCost == null || quantity <= 0 ? null : bookCost / quantity,
      currentPrice: quantity > 0 ? marketValue / quantity : null,
      quoteApplied: rows.every((row) => row.quoteApplied),
      bucket: first.bucket,
      holdingRatio: positionsValueDisplay > 0 ? valueDisplay / positionsValueDisplay : 0,
      externalNetInvested,
      pnl: {
        ...flow,
        unrealizedCapitalGain,
        capitalGain,
        explainedTotal,
        economicTotal: flow.economicTotal,
        unexplained: flow.unexplained,
      },
      coverage: combinedCoverage(rows),
      costSource: sources.length === 1 ? sources[0] : "mixed",
      asOf: rows.map((row) => row.asOf).sort().at(-1) ?? first.asOf,
      brokerRows: rows,
    };
  }).sort((a, b) => b.valueDisplay - a.valueDisplay);
}
