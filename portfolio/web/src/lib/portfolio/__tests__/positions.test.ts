import { describe, expect, it } from "vitest";
import { aggregateSummaryPositions } from "../positions";
import type { SummaryPosition } from "../../../types";

function position(overrides: Partial<SummaryPosition>): SummaryPosition {
  return {
    broker: "broker-a",
    market: "US",
    currency: "USD",
    symbol: "MSFT",
    name: "Microsoft",
    quantity: 10,
    asOf: "2026-07-01",
    marketValue: 1_500,
    currentPrice: 150,
    quoteApplied: false,
    bucket: "stable",
    effectiveCost: 1_000,
    costSource: "statement",
    valueDisplay: 1_500,
    costDisplay: 1_000,
    gainLossDisplay: 500,
    bookCost: 1_000,
    bookCostSource: "statement",
    externalNetInvested: 2_500,
    pnl: {
      realizedCapitalGain: 100,
      unrealizedCapitalGain: 500,
      capitalGain: 600,
      dividendsGross: 25,
      dividendsNet: 20,
      tradingFees: 5,
      financingFees: 0,
      explainedTotal: 615,
      economicTotal: null,
      unexplained: null,
    },
    coverage: { status: "complete", ratio: 1, missing: [], issues: [] },
    ...overrides,
  };
}

describe("aggregateSummaryPositions", () => {
  it("prefers the audited instrument layer and only attaches broker rows", () => {
    const brokerRows = [position({}), position({ broker: "broker-b" })];
    const result = aggregateSummaryPositions(brokerRows, 3_000, [{
      key: "US:MSFT",
      market: "US",
      symbol: "MSFT",
      name: "Microsoft",
      brokers: ["broker-a", "broker-b"],
      currencies: ["USD"],
      currency: "USD",
      positionCount: 2,
      quantity: 20,
      asOf: "2026-07-01",
      bucket: "stable",
      marketValue: 3_000,
      marketValueDisplay: 3_000,
      valueDisplay: 3_000,
      currentPrice: 150,
      currentPriceDisplay: 150,
      quoteApplied: false,
      effectiveCost: 2_000,
      costDisplay: 2_000,
      bookCost: 2_000,
      bookCostDisplay: 2_000,
      knownBookCost: 2_000,
      knownBookCostDisplay: 2_000,
      bookCostSource: "statement",
      gainLossDisplay: 1_000,
      holdingRatio: 1,
      externalNetInvested: null,
      knownExternalNetInvested: 0,
      externalNetInvestedScope: "instrument_direct_events",
      capitalCoverage: { status: "missing", ratio: 0, missing: ["instrument_external_net_invested"], issues: [] },
      pnl: { ...brokerRows[0].pnl!, realizedCapitalGain: 999, explainedTotal: 1_999 },
      coverage: { status: "complete", ratio: 1, missing: [], issues: [] },
    }]);

    expect(result[0].pnl.realizedCapitalGain).toBe(999);
    expect(result[0].brokerRows).toHaveLength(2);
    expect(result[0].coverage).toMatchObject({ status: "partial", missing: ["instrument_external_net_invested"] });
  });

  it("restores HKD cost and price for planning while keeping instrument P&L in display currency", () => {
    const brokerRows = [
      position({ broker: "broker-a", market: "HK", currency: "HKD", symbol: "00700", quantity: 6, marketValue: 2_400, effectiveCost: 1_800, bookCost: 1_800, costDisplay: 230 }),
      position({ broker: "broker-b", market: "HK", currency: "HKD", symbol: "00700", quantity: 4, marketValue: 1_600, effectiveCost: 1_200, bookCost: 1_200, costDisplay: 154 }),
    ];
    const result = aggregateSummaryPositions(brokerRows, 516, [{
      key: "HK:00700",
      market: "HK",
      symbol: "00700",
      name: "Tencent",
      currency: "USD",
      quantity: 10,
      asOf: "2026-07-01",
      bucket: "stable",
      valueDisplay: 516,
      bookCostDisplay: 384,
      bookCostSource: "statement",
      holdingRatio: 1,
      externalNetInvested: null,
      pnl: { ...brokerRows[0].pnl!, realizedCapitalGain: 25, explainedTotal: 157 },
      coverage: { status: "complete", ratio: 1, missing: [], issues: [] },
      capitalCoverage: { status: "complete", ratio: 1, missing: [], issues: [] },
    } as any]);

    expect(result[0]).toMatchObject({ currency: "HKD", marketValue: 4_000, bookCost: 3_000, avgCost: 300, currentPrice: 400, valueDisplay: 516, bookCostDisplay: 384 });
    expect(result[0].pnl.realizedCapitalGain).toBe(25);
  });

  it("sums broker balances but counts instrument flows once", () => {
    const result = aggregateSummaryPositions([
      position({}),
      position({ broker: "broker-b", quantity: 5, marketValue: 900, valueDisplay: 900, effectiveCost: 600, bookCost: 600, costDisplay: 600, gainLossDisplay: 300,
        pnl: { realizedCapitalGain: 100, unrealizedCapitalGain: 300, capitalGain: 400, dividendsGross: 25, dividendsNet: 20, tradingFees: 5, financingFees: 0, explainedTotal: 415, economicTotal: null, unexplained: null } }),
    ], 2_400);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ quantity: 15, valueDisplay: 2_400, bookCost: 1_600, externalNetInvested: 2_500 });
    expect(result[0].pnl).toMatchObject({ realizedCapitalGain: 100, unrealizedCapitalGain: 800, dividendsNet: 20, tradingFees: 5, explainedTotal: 915 });
  });

  it("keeps aggregate cost and unrealized gain unknown when any broker row is missing cost", () => {
    const result = aggregateSummaryPositions([
      position({}),
      position({ broker: "broker-b", effectiveCost: null, bookCost: null, costDisplay: null, gainLossDisplay: null,
        pnl: { realizedCapitalGain: 100, unrealizedCapitalGain: null, capitalGain: null, dividendsGross: 25, dividendsNet: 20, tradingFees: 5, financingFees: 0, explainedTotal: null, economicTotal: null, unexplained: null },
        coverage: { status: "missing", ratio: 0, missing: ["book_cost"], issues: [] } }),
    ], 3_000)[0];

    expect(result.bookCost).toBeNull();
    expect(result.pnl.unrealizedCapitalGain).toBeNull();
    expect(result.pnl.explainedTotal).toBeNull();
    expect(result.coverage.status).toBe("partial");
    expect(result.coverage.missing).toEqual(["book_cost"]);
  });
});
