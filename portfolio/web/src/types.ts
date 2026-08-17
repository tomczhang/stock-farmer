export type Currency = "USD" | "HKD" | "CNY";

export type CoverageStatus = "complete" | "partial" | "missing";

export interface Coverage {
  status: CoverageStatus;
  ratio?: number;
  missing: string[];
  issues: string[];
}

export interface PnlBreakdown {
  realizedCapitalGain: number;
  unrealizedCapitalGain: number | null;
  capitalGain: number | null;
  dividendsGross: number;
  dividendsNet: number;
  tradingFees: number;
  financingFees: number;
  explainedTotal: number | null;
  economicTotal: number | null;
  unexplained: number | null;
}

export interface InstrumentPnlBreakdown {
  realizedCapitalGain: number | null;
  unrealizedCapitalGain: number | null;
  capitalGain: number | null;
  dividendsGross: number | null;
  dividendsNet: number | null;
  tradingFees: number | null;
  financingFees: number | null;
  explainedTotal: number | null;
  economicTotal: number | null;
  unexplained: number | null;
}

export interface Me {
  id: number;
  email: string;
}

export interface StatementRow {
  id: number;
  broker: string;
  fileName: string;
  asOf: string;
  uploadedAt: string;
  positionCount: number;
  cashCount: number;
}

export interface SummaryPosition {
  broker: string;
  market: string;
  currency: Currency;
  symbol: string;
  name: string;
  quantity: number;
  asOf: string;
  marketValue: number;
  currentPrice: number | null;
  quoteApplied: boolean;
  bucket: string;
  effectiveCost: number | null;
  costSource: "manual" | "trades" | "statement" | "none";
  valueDisplay: number;
  costDisplay: number | null;
  gainLossDisplay: number | null;
  holdingRatio?: number;
  bookCost?: number | null;
  bookCostSource?: "manual" | "statement" | "none";
  externalNetInvested?: number | null;
  pnl?: InstrumentPnlBreakdown;
  coverage?: Coverage;
}

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
  pnl: InstrumentPnlBreakdown;
  coverage: Coverage;
}

export interface SummaryCash {
  broker: string;
  currency: Currency;
  amount: number;
  source: string;
  asOf: string;
  /** 货币基金等现金等价物的标识（代码+名称） */
  label?: string;
  amountDisplay: number;
}

export interface NamedValue {
  name: string;
  value: number;
}

export interface HistoryPoint {
  month: string;
  valueDisplay: number;
  costDisplay: number | null;
  gainLossDisplay: number | null;
  symbolCount: number;
}

export interface Summary {
  display: Currency;
  scope?: "all" | "self";
  /** 授予仓（RSU）概况，与 scope 无关始终返回 */
  grant?: { count: number; symbols: string[]; valueDisplay: number };
  asOf: Array<{ broker: string; asOf: string }>;
  kpi: {
    totalAssets: number;
    positionsValue: number;
    totalCost: number;
    gainLoss: number;
    gainLossRatio: number | null;
    idleCash: number;
    positionRatio: number;
  };
  allocation: {
    positionVsCash: NamedValue[];
    bySymbol: NamedValue[];
    byBucket: NamedValue[];
    byMarket: NamedValue[];
  };
  positions: SummaryPosition[];
  instruments?: SummaryInstrument[];
  cash: SummaryCash[];
  radar: NamedValue[];
  history: HistoryPoint[];
  staleQuotes: string[];
  costs?: {
    bookCost: number | null;
    externalNetInvested: number | null;
  };
  pnl?: PnlBreakdown;
  coverage?: Coverage;
}

export type Bucket = "aggressive" | "defensive" | "stable" | "grant";

export const BUCKET_LABELS: Record<string, string> = {
  aggressive: "进取仓",
  defensive: "防守仓",
  stable: "稳健仓",
  grant: "授予仓",
  unassigned: "未分类",
};

export interface TradeRow {
  id: number;
  broker: string;
  market: string;
  currency: Currency;
  symbol: string;
  name: string;
  side: "buy" | "sell";
  tradeDate: string;
  quantity: number;
  price: number;
  fee: number;
  source: string;
  reason: string | null;
  createdAt: string;
}

export interface PerformanceMonth {
  month: string;
  netAssetsDisplay: number;
  flowDisplay: number;
  /** 截至该月末的累计外部净投入（含首个快照月之前的存量事件基线） */
  investedDisplay: number;
  pnlDisplay: number | null;
  nav: number | null;
  cumulativeReturn: number | null;
  drawdown: number | null;
  carried: boolean;
  carriedBrokers: string[];
  warning: string | null;
}

export interface PerformanceKpi {
  cumulativeReturn: number | null;
  annualizedReturn: number | null;
  annualizedPartial: boolean;
  maxDrawdown: number | null;
  cumulativeInDisplay: number;
  cumulativeOutDisplay: number;
  netInvestedDisplay: number;
  latestMonthPnlDisplay: number | null;
  avgMonthlyPnlDisplay: number | null;
  monthCount: number;
}

export interface PerformanceResponse {
  display: Currency;
  scope: "self" | "all";
  months: PerformanceMonth[];
  kpi: PerformanceKpi;
}

export interface ClosedStats {
  display: Currency;
  closedCount: number;
  unknownCount: number;
  winCount: number;
  lossCount: number;
  winRate: number | null;
  avgWinDisplay: number | null;
  avgLossDisplay: number | null;
  payoffRatio: number | null;
  maxWinDisplay: number | null;
  maxLossDisplay: number | null;
  avgHoldingDays: number | null;
  totalFeesDisplay: number;
  feeRatio: number | null;
  histogram: {
    bucketWidthDisplay: number;
    buckets: Array<{ from: number | null; to: number | null; count: number }>;
  };
  openHoldingAges: Array<{ key: string; firstBuyDate: string; days: number }>;
}

export interface ReviewTopTrade {
  id: number;
  symbol: string;
  market: string;
  name: string;
  tradeDate: string;
  pnlDisplay: number;
  reason: string | null;
}

export interface ReviewResponse {
  month: string;
  display: Currency;
  scope: "self" | "all";
  auto: {
    startAssetsDisplay: number | null;
    endAssetsDisplay: number;
    assetsChangeDisplay: number | null;
    flowDisplay: number;
    pnlDisplay: number | null;
    monthlyReturn: number | null;
    maxDrawdownToDate: number | null;
    topWins: ReviewTopTrade[];
    topLosses: ReviewTopTrade[];
    closedCount: number;
    feesDisplay: number;
    discipline: Array<{ key: string; ok: boolean; note: string }>;
  } | null;
  manual: {
    month: string;
    attribution: string;
    mistakes: string;
    improvements: string;
    macroNote: string;
    createdAt: string | null;
    updatedAt: string | null;
  };
}

export interface WatchlistItem {
  id: number;
  market: string;
  symbol: string;
  name: string;
  note: string;
  refHigh: number | null;
  refHighDate: string | null;
  createdAt: string;
  price: number | null;
  currency: string | null;
  drawdownFromHigh: number | null;
}

export interface ReviewListItem {
  month: string;
  attribution: string;
  mistakes: string;
  improvements: string;
  macroNote: string;
  updatedAt: string;
}

export interface PlanTier {
  id: number;
  seq: number;
  triggerType: "pct_drop" | "price" | "pct_gain";
  triggerValue: number;
  allocType: "pct" | "amount";
  allocValue: number;
  buyPrice: number;
  amount: number;
  shares: number;
  cumulativeAmount: number;
  cumulativeShares: number;
  avgCost: number;
  filledAt: string | null;
  postQuantity?: number | null;
  postBookCost?: number | null;
  postAvgCost?: number | null;
  safety?: SafetyAddResult | null;
  // trim（减仓）档位字段
  sellPrice?: number;
  quantity?: number;
  cumulativeQuantity?: number;
  proceeds?: number;
  cumulativeProceeds?: number;
  netProceeds?: number;
  postSymbolRatio?: number | null;
  postBucketRatio?: number | null;
  postCashRatio?: number | null;
}

export interface Plan {
  id: number;
  symbol: string;
  name: string;
  market: string;
  currency: Currency;
  basePrice: number;
  totalBudget: number;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  totalPlanned: number;
  filledAmount: number;
  warning?: string;
  tiers: PlanTier[];
  scenarioName?: string;
  templateWeights?: number[];
  currentPosition?: PlanPositionState | null;
  final?: PlanFinalState | null;
  coverage?: Coverage;
  totalPlannedUsd?: number;
  estimatedFee?: number;
  estimatedFeeUsd?: number;
  direction?: "add" | "trim";
  totalSellQuantity?: number;
  totalProceeds?: number;
  totalNetProceeds?: number;
}

export type CapitalEventType = "cash_in" | "cash_out" | "transfer_in" | "transfer_out" | "adjustment";

export interface CapitalEventInput {
  type: CapitalEventType;
  eventDate: string;
  broker?: string;
  market?: string;
  symbol?: string;
  name?: string;
  currency: Currency;
  amount?: number;
  quantity?: number;
  unitCost?: number;
  source?: string;
  sourceId?: string;
  note?: string;
}

export interface CapitalEvent extends CapitalEventInput {
  id: number;
  capitalAmount: number;
  netInvestedImpact: number;
  createdAt: string;
  updatedAt: string;
}

export type CashFlowEventType = "dividend" | "realized_gain" | "trade_fee" | "financing_fee";

export interface CashFlowEventInput {
  type: CashFlowEventType;
  eventDate: string;
  broker?: string;
  market?: string;
  symbol?: string;
  name?: string;
  currency: Currency;
  grossAmount: number;
  taxAmount?: number;
  feeAmount?: number;
  source?: string;
  sourceId?: string;
  note?: string;
}

export interface CashFlowEvent extends CashFlowEventInput {
  id: number;
  netAmount: number;
  cashImpact: number;
  pnlImpact: number;
}

export interface UnifiedCashFlowItem {
  id: number | string;
  eventDate: string;
  category: string;
  type: string;
  market?: string;
  symbol?: string;
  currency: Currency;
  grossAmount: number;
  feeAmount: number;
  taxAmount: number;
  cashImpact: number;
  pnlImpact: number;
  source: string;
  fxRate?: number;
  grossAmountUsd?: number;
  feeAmountUsd?: number;
  taxAmountUsd?: number;
  cashImpactUsd?: number;
  pnlImpactUsd?: number;
  grossAmountDisplay?: number;
  cashImpactDisplay?: number;
  pnlImpactDisplay?: number;
}

export interface CashFlowResult {
  display?: Currency;
  items: UnifiedCashFlowItem[];
  summary: {
    buy: number;
    sell: number;
    dividend: number;
    fees: number;
    externalIn: number;
    externalOut: number;
    netCash: number;
  };
}

export interface RiskSettings {
  symbolLimit: number;
  bucketLimit: number;
  cashFloor: number;
  updatedAt?: string | null;
  source?: "default" | "custom" | string;
}

export interface BucketBudget {
  bucket: string;
  quarter: string;
  effectiveQuarter?: string | null;
  revision?: number | null;
  limitAmount: number | null;
  currency: Currency | null;
  fxRate?: number | null;
  limitUsd: number | null;
  usedUsd: number;
  availableUsd: number | null;
  recoveredSurplusUsd: number;
  adjustmentsUsed: number;
  canAdjust: boolean;
  nextAdjustableQuarter?: string;
  coverage: Coverage;
}

export interface BucketBudgetResult {
  quarter: string;
  budgets: BucketBudget[];
}

export interface SafetyRoom {
  limit: number;
  amount: number | null;
  amountUsd: number | null;
  currentRatio?: number | null;
  postRatio?: number | null;
}

export interface SafetyAddResult {
  complete: boolean;
  missing: string[];
  coverage?: Coverage;
  baseCurrency: "USD";
  currency: Currency;
  display?: Currency;
  fxRate: number;
  safeAmount: number | null;
  safeAmountUsd: number | null;
  bottleneck: "symbol" | "bucket" | "cash" | "budget" | null;
  rooms: {
    symbol: SafetyRoom;
    bucket: SafetyRoom;
    cash: SafetyRoom;
    budget: SafetyRoom;
  };
  context: Record<string, number | string | null>;
  candidate?: {
    amount: number;
    safe: boolean;
    violations?: string[];
  } | null;
}

export interface PlanInputTier {
  seq: number;
  triggerType: "pct_drop" | "price" | "pct_gain";
  triggerValue: number;
  allocType: "pct" | "amount";
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
  note?: string;
  scenarioName?: string;
  templateWeights?: number[];
  direction?: "add" | "trim";
  tiers: PlanInputTier[];
}

export interface PlanPositionState {
  quantity?: number | null;
  bookCost?: number | null;
  avgCost?: number | null;
  marketValue?: number | null;
}

export interface PlanFinalState extends PlanPositionState {
  cash?: number | null;
  cashRatio?: number | null;
  symbolRatio?: number | null;
  bucketRatio?: number | null;
  budgetAvailable?: number | null;
  safe?: boolean;
}

export interface PlanComparisonResult {
  market: string;
  symbol: string;
  scenarios: Plan[];
}
