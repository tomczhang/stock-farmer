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
  quoteApplied: boolean;
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

export interface Summary {
  display: Currency;
  asOf: Array<{ broker: string; asOf: string }>;
  kpi: {
    totalAssets: number;
    positionsValue: number;
    idleCash: number;
    positionRatio: number;
  };
  allocation: {
    positionVsCash: NamedValue[];
    byBroker: NamedValue[];
    byCurrency: NamedValue[];
    byMarket: NamedValue[];
  };
  positions: SummaryPosition[];
  cash: SummaryCash[];
  radar: NamedValue[];
  staleQuotes: string[];
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
