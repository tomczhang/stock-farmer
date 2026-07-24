export type Currency = "USD" | "HKD" | "CNY";

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
}

export interface SummaryCash {
  broker: string;
  currency: Currency;
  amount: number;
  source: string;
  asOf: string;
  amountDisplay: number;
}

export interface NamedValue {
  name: string;
  value: number;
}

export interface HistoryPoint {
  month: string;
  valueDisplay: number;
  costDisplay: number;
  gainLossDisplay: number;
  symbolCount: number;
}

export interface Summary {
  display: Currency;
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
  cash: SummaryCash[];
  radar: NamedValue[];
  history: HistoryPoint[];
  staleQuotes: string[];
}

export type Bucket = "aggressive" | "defensive" | "stable";

export const BUCKET_LABELS: Record<string, string> = {
  aggressive: "进取仓",
  defensive: "防守仓",
  stable: "稳健仓",
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
  createdAt: string;
}

export interface PlanTier {
  id: number;
  seq: number;
  triggerType: "pct_drop" | "price";
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
}
