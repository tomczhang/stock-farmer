export type Currency = "USD" | "HKD" | "CNY";

export type Market = "US" | "HK" | "CN" | "OTHER";

export interface PositionInput {
  broker: string;
  market: string;
  currency: Currency;
  symbol: string;
  name: string;
  quantity: number;
  marketValue: number;
  costBasis?: number | null;
  unrealizedGl?: number | null;
}

export interface CashBalanceInput {
  broker: string;
  currency: Currency;
  amount: number;
}

export interface StatementPayload {
  broker: string;
  fileName: string;
  asOf: string; // YYYY-MM-DD
  positions: PositionInput[];
  cashBalances: CashBalanceInput[];
  parsedMeta?: Record<string, unknown>;
  tradeActivities?: ImportedTradeActivity[];
  realizedTrades?: ImportedRealizedTrade[];
  dividends?: ImportedDividend[];
}

export type TierTriggerType = "pct_drop" | "price" | "pct_gain";
export type TierAllocType = "pct" | "amount";

export type PlanDirection = "add" | "trim";

export type Bucket = "aggressive" | "defensive" | "stable" | "grant";

export type CoverageStatus = "complete" | "partial" | "missing";

export interface Coverage {
  status: CoverageStatus;
  ratio: number;
  missing: string[];
  issues: string[];
}

export interface SummaryPnlBreakdown {
  realizedCapitalGain: number | null;
  unrealizedCapitalGain: number | null;
  capitalGain: number | null;
  dividendsGross: number | null;
  dividendsNet: number | null;
  tradingFees: number | null;
  financingFees: number | null;
  knownTotal: number | null;
  total: number | null;
  explainedTotal: number | null;
  economicTotal: number | null;
  unexplained: number | null;
  scope: "instrument" | "broker_position_only";
  financingScope: string;
  instrumentKey?: string;
}

/** summary.instruments：唯一 market+symbol 的标的级主视图，所有金额均为 summary.display 币种。 */
export interface SummaryInstrument {
  key: string;
  market: string;
  symbol: string;
  name: string;
  brokers: string[];
  currencies: string[];
  currency: Currency;
  positionCount: number;
  quantity: number;
  asOf: string;
  bucket: string;
  marketValue: number;
  marketValueDisplay: number;
  valueDisplay: number;
  currentPrice: number | null;
  currentPriceDisplay: number | null;
  quoteApplied: boolean;
  effectiveCost: number | null;
  costDisplay: number | null;
  bookCost: number | null;
  bookCostDisplay: number | null;
  knownBookCost: number;
  knownBookCostDisplay: number;
  bookCostSource: "manual" | "statement" | "none" | "mixed";
  gainLossDisplay: number | null;
  holdingRatio: number;
  externalNetInvested: number | null;
  knownExternalNetInvested: number;
  externalNetInvestedScope: "instrument_direct_events";
  capitalCoverage: Coverage;
  pnl: SummaryPnlBreakdown;
  coverage: Coverage;
}

export type CapitalEventType = "cash_in" | "cash_out" | "transfer_in" | "transfer_out" | "adjustment";
export type CashFlowEventType = "dividend" | "realized_gain" | "trade_fee" | "financing_fee";

export interface CapitalEventInput {
  type: CapitalEventType;
  eventDate: string;
  broker?: string;
  market?: string;
  currency: Currency;
  symbol?: string;
  name?: string;
  amount?: number;
  quantity?: number;
  unitCost?: number;
  source?: string;
  sourceId?: string;
  note?: string;
}

export interface CashFlowEventInput {
  type: CashFlowEventType;
  eventDate: string;
  broker?: string;
  market?: string;
  currency: Currency;
  symbol?: string;
  name?: string;
  grossAmount: number;
  taxAmount?: number;
  feeAmount?: number;
  source?: string;
  sourceId?: string;
  note?: string;
}

export interface ImportedTradeActivity {
  id: string;
  broker?: string;
  date: string;
  time?: string;
  sequence?: number;
  market: string;
  currency: Currency;
  symbol: string;
  securityName: string;
  side: "buy" | "long_open" | "sell" | "short_open" | "short_close" | "acquire" | "transfer_in" | "transfer_out" | "stock_split";
  quantity: number;
  unitPrice?: number;
  grossAmount?: number;
  fee?: number;
  amount: number;
  source: string;
  note?: string;
  capitalConfirmed?: boolean;
}

export interface ImportedRealizedTrade {
  id: string;
  broker?: string;
  sellDate: string;
  market: string;
  currency: Currency;
  symbol: string;
  securityName: string;
  proceeds: number;
  costBasis: number;
  gainLoss: number;
  source: string;
  note?: string;
}

export interface ImportedDividend {
  id: string;
  broker?: string;
  date: string;
  market?: string;
  currency: Currency;
  symbol: string;
  securityName: string;
  grossAmount: number;
  taxWithheld: number;
  fee: number;
  source: string;
  note?: string;
}

export interface TradeInput {
  broker: string;
  market: string;
  currency: Currency;
  symbol: string;
  name?: string;
  side: "buy" | "sell";
  tradeDate: string; // YYYY-MM-DD
  quantity: number;
  price: number;
  fee?: number;
  reason?: string;
}

export interface PlanTierInput {
  seq: number;
  triggerType: TierTriggerType;
  triggerValue: number;
  allocType: TierAllocType;
  allocValue: number;
}

export interface PlanInput {
  symbol: string;
  name: string;
  market: string;
  currency: Currency;
  basePrice: number;
  totalBudget: number;
  estimatedFee?: number;
  scenarioName?: string;
  templateWeights?: number[];
  note?: string;
  direction?: PlanDirection;
  tiers: PlanTierInput[];
}

export interface RiskSettingsInput {
  symbolLimit: number;
  bucketLimit: number;
  cashFloor: number;
}

export interface BucketBudgetInput {
  bucket: Bucket;
  quarter: string;
  limitAmount: number;
  currency: Currency;
}

export interface SafeAddInput {
  market: string;
  symbol: string;
  bucket?: Bucket;
  currency: Currency;
  estimatedFee?: number;
  candidateAmount?: number;
  display?: Currency;
}

export interface ComputedTier extends PlanTierInput {
  id?: number;
  buyPrice: number;
  amount: number;
  shares: number;
  cumulativeAmount: number;
  cumulativeShares: number;
  avgCost: number;
  filledAt?: string | null;
}

export interface ComputedPlan {
  totalPlanned: number;
  tiers: ComputedTier[];
  warning?: string;
}

export interface MonthlyReviewInput {
  attribution?: string;
  mistakes?: string;
  improvements?: string;
  macroNote?: string;
}

export interface WatchlistInput {
  market: string;
  symbol: string;
  name?: string;
  note?: string;
  refHigh?: number | null;
}
