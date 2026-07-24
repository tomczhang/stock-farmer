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
}

export type TierTriggerType = "pct_drop" | "price";
export type TierAllocType = "pct" | "amount";

export type Bucket = "aggressive" | "defensive" | "stable";

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
  note?: string;
  tiers: PlanTierInput[];
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
