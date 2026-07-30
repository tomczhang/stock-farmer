import type { AppDatabase } from "./db.js";
import { ConflictError, ValidationError } from "./errors.js";
import {
  BUCKETS,
  coverage,
  fromUsd,
  nextQuarter,
  quarterForDate,
  requireBucket,
  requireCurrency,
  roundAmount,
  toUsd,
  validateQuarter,
} from "./finance.js";
import type { LedgerService } from "./ledger.js";
import type { Bucket, BucketBudgetInput, Currency, RiskSettingsInput, SafeAddInput } from "./types.js";

export interface PortfolioRiskContext {
  market: string;
  symbol: string;
  bucket: Bucket | null;
  currentQuantity: number;
  currentBookCostUsd: number | null;
  positionsValueUsd: number;
  symbolValueUsd: number;
  bucketValueUsd: number | null;
  cashUsd: number;
  netAssetsUsd: number;
  asOf: string | null;
  hasValuation: boolean;
  hasCash: boolean;
}

export interface RiskScenarioOverride {
  currentQuantity?: number;
  currentBookCostUsd?: number | null;
  positionsValueUsd?: number;
  symbolValueUsd?: number;
  bucketValueUsd?: number | null;
  cashUsd?: number;
  netAssetsUsd?: number;
  budgetAvailableUsd?: number | null;
  budgetCoverageComplete?: boolean;
}

interface BudgetRow {
  id: number;
  bucket: Bucket;
  quarter: string;
  revision: number;
  limit_amount: number;
  currency: Currency;
  fx_to_usd: number;
  created_at: string;
}

function validateSettings(input: RiskSettingsInput) {
  if (!(input.symbolLimit > 0 && input.symbolLimit < 1)) throw new ValidationError("单标的上限需在 0% 到 100%（不含）之间");
  if (!(input.bucketLimit > 0 && input.bucketLimit < 1)) throw new ValidationError("单仓上限需在 0% 到 100%（不含）之间");
  if (!(input.cashFloor >= 0 && input.cashFloor < 1)) throw new ValidationError("最低现金率需在 0%（含）到 100%（不含）之间");
}

function concentrationRoom(limit: number, holdings: number, current: number) {
  if (!(holdings >= 0) || !(current >= 0)) return null;
  if (limit >= 1) return Number.POSITIVE_INFINITY;
  const currentRatio = holdings > 0 ? current / holdings : 0;
  if (holdings > 0 && currentRatio >= limit) return 0;
  return Math.max(0, (limit * holdings - current) / (1 - limit));
}

export function createRiskService(
  db: AppDatabase,
  fxToUsd: Record<string, number>,
  ledger: LedgerService,
  contextFor: (userId: number, market: string, symbol: string, bucket?: Bucket) => PortfolioRiskContext,
) {
  function settings(userId: number) {
    const row = db
      .prepare("SELECT symbol_limit, bucket_limit, cash_floor, updated_at FROM risk_settings WHERE user_id = ?")
      .get(userId) as { symbol_limit: number; bucket_limit: number; cash_floor: number; updated_at: string } | undefined;
    return {
      symbolLimit: row?.symbol_limit ?? 0.5,
      bucketLimit: row?.bucket_limit ?? 0.5,
      cashFloor: row?.cash_floor ?? 0.3,
      updatedAt: row?.updated_at ?? null,
      source: row ? "custom" : "default",
    };
  }

  function budgetRowFor(userId: number, bucket: Bucket, quarter: string) {
    return db
      .prepare(
        `SELECT * FROM bucket_budgets
         WHERE user_id = ? AND bucket = ? AND quarter <= ?
         ORDER BY quarter DESC, revision DESC LIMIT 1`,
      )
      .get(userId, bucket, quarter) as BudgetRow | undefined;
  }

  function budgetState(userId: number, bucket: Bucket, quarter = quarterForDate()) {
    const validQuarter = validateQuarter(quarter);
    const row = budgetRowFor(userId, bucket, validQuarter);
    const count = (
      db.prepare("SELECT COUNT(*) AS count FROM bucket_budgets WHERE user_id = ? AND bucket = ? AND quarter = ?").get(
        userId,
        bucket,
        validQuarter,
      ) as { count: number }
    ).count;
    const usage = ledger.budgetUsage(userId, bucket);
    const limitUsd = row ? row.limit_amount * row.fx_to_usd : null;
    const availableUsd = limitUsd == null ? null : Math.max(0, limitUsd - usage.usedUsd);
    const missing = [
      ...(row ? [] : ["bucket_budget"]),
      ...usage.coverage.missing,
    ];
    return {
      bucket,
      quarter: validQuarter,
      effectiveQuarter: row?.quarter ?? null,
      revision: row?.revision ?? null,
      limitAmount: row?.limit_amount ?? null,
      currency: row?.currency ?? null,
      fxRate: row?.fx_to_usd ?? null,
      limitUsd: limitUsd == null ? null : roundAmount(limitUsd),
      usedUsd: usage.usedUsd,
      availableUsd: availableUsd == null ? null : roundAmount(availableUsd),
      recoveredSurplusUsd: usage.recoveredSurplusUsd,
      adjustmentsUsed: Math.max(0, count - 1),
      canAdjust: count < 2,
      nextAdjustableQuarter: count < 2 ? validQuarter : nextQuarter(validQuarter),
      coverage: coverage(row ? Math.max(1, usage.coverage.ratio === 1 ? 1 : 2) : 1, row && usage.coverage.status === "complete" ? 1 : 0, missing),
    };
  }

  function evaluate(
    userId: number,
    input: SafeAddInput,
    override: RiskScenarioOverride = {},
  ) {
    if (!input.symbol?.trim()) throw new ValidationError("缺少标的代码");
    const currency = requireCurrency(input.currency);
    const fee = input.estimatedFee ?? 0;
    const candidate = input.candidateAmount;
    if (!(fee >= 0) || !Number.isFinite(fee)) throw new ValidationError("预计费用不能为负");
    if (candidate != null && (!(candidate >= 0) || !Number.isFinite(candidate))) throw new ValidationError("候选加仓金额不能为负");
    const context = contextFor(userId, input.market, input.symbol, input.bucket);
    const bucket = input.bucket ?? context.bucket ?? undefined;
    const policy = settings(userId);
    const rate = fxToUsd[currency];
    if (!(rate > 0)) throw new ValidationError(`缺少 ${currency} 汇率`);
    const budget = bucket ? budgetState(userId, bucket) : null;
    const positionsValueUsd = override.positionsValueUsd ?? context.positionsValueUsd;
    const symbolValueUsd = override.symbolValueUsd ?? context.symbolValueUsd;
    const bucketValueUsd = override.bucketValueUsd ?? context.bucketValueUsd;
    const cashUsd = override.cashUsd ?? context.cashUsd;
    const netAssetsUsd = override.netAssetsUsd ?? context.netAssetsUsd;
    const budgetAvailableUsd = override.budgetAvailableUsd === undefined ? budget?.availableUsd ?? null : override.budgetAvailableUsd;
    const budgetComplete = override.budgetCoverageComplete ?? budget?.coverage.status === "complete";
    const feeUsd = fee * rate;
    const missing: string[] = [];
    if (!bucket) missing.push("bucket");
    if (bucketValueUsd == null) missing.push("bucket_valuation");
    if (!context.hasCash && override.cashUsd === undefined) missing.push("cash");
    if (!context.hasValuation && override.positionsValueUsd === undefined) missing.push("valuation");
    if (budgetAvailableUsd == null) missing.push("bucket_budget");
    if (budget && !budgetComplete) missing.push(...budget.coverage.missing.map((item) => `budget:${item}`));

    const symbolRoomUsd = concentrationRoom(policy.symbolLimit, positionsValueUsd, symbolValueUsd);
    const bucketRoomUsd = bucketValueUsd == null ? null : concentrationRoom(policy.bucketLimit, positionsValueUsd, bucketValueUsd);
    const cashRoomUsd = Math.max(0, cashUsd - policy.cashFloor * netAssetsUsd - feeUsd);
    const budgetRoomUsd = budgetAvailableUsd == null ? null : Math.max(0, budgetAvailableUsd - feeUsd);
    const roomValues = { symbol: symbolRoomUsd, bucket: bucketRoomUsd, cash: cashRoomUsd, budget: budgetRoomUsd };
    const finiteRooms = Object.entries(roomValues).filter((entry): entry is [string, number] => entry[1] != null);
    const complete = missing.length === 0 && finiteRooms.length === 4;
    const safeAmountUsd = complete ? Math.max(0, Math.min(...finiteRooms.map(([, value]) => value))) : null;
    const bottleneck = safeAmountUsd == null
      ? null
      : finiteRooms.find(([, value]) => Math.abs(value - safeAmountUsd) < 0.005)?.[0] ?? null;
    const amountForRatiosUsd = (candidate != null ? candidate * rate : safeAmountUsd) ?? 0;
    const postHoldings = positionsValueUsd + amountForRatiosUsd;
    const postCash = cashUsd - amountForRatiosUsd - feeUsd;
    const postRatio = (value: number | null) => (value == null ? null : postHoldings > 0 ? (value + amountForRatiosUsd) / postHoldings : 0);
    const amountInCurrency = (value: number | null) => value == null || !Number.isFinite(value) ? value : roundAmount(value / rate);
    const room = (key: keyof typeof roomValues, limit: number, currentRatio: number | null, afterRatio: number | null) => ({
      limit,
      amount: amountInCurrency(roomValues[key]),
      amountUsd: roomValues[key] == null || !Number.isFinite(roomValues[key]!) ? roomValues[key] : roundAmount(roomValues[key]!),
      currentRatio,
      postRatio: afterRatio,
    });
    const candidateViolations = complete
      ? [
          ...(postHoldings > 0 && (symbolValueUsd + amountForRatiosUsd) / postHoldings > policy.symbolLimit + 1e-9
            ? ["symbol"]
            : []),
          ...(bucketValueUsd != null && postHoldings > 0 && (bucketValueUsd + amountForRatiosUsd) / postHoldings > policy.bucketLimit + 1e-9
            ? ["bucket"]
            : []),
          ...(netAssetsUsd > 0 && postCash / netAssetsUsd < policy.cashFloor - 1e-9 ? ["cash"] : []),
          ...(budgetAvailableUsd != null && amountForRatiosUsd + feeUsd > budgetAvailableUsd + 0.005 ? ["budget"] : []),
        ]
      : ["incomplete"];
    const result = {
      complete,
      missing: Array.from(new Set(missing)),
      coverage: coverage(4, complete ? 4 : 4 - new Set(missing).size, missing),
      baseCurrency: "USD",
      currency,
      display: input.display ?? currency,
      fxRate: rate,
      safeAmount: amountInCurrency(safeAmountUsd),
      safeAmountUsd: safeAmountUsd == null ? null : roundAmount(safeAmountUsd),
      bottleneck,
      rooms: {
        symbol: room("symbol", policy.symbolLimit, positionsValueUsd > 0 ? symbolValueUsd / positionsValueUsd : 0, postRatio(symbolValueUsd)),
        bucket: room(
          "bucket",
          policy.bucketLimit,
          bucketValueUsd == null ? null : positionsValueUsd > 0 ? bucketValueUsd / positionsValueUsd : 0,
          postRatio(bucketValueUsd),
        ),
        cash: room(
          "cash",
          policy.cashFloor,
          netAssetsUsd > 0 ? cashUsd / netAssetsUsd : 0,
          netAssetsUsd > 0 ? postCash / netAssetsUsd : 0,
        ),
        budget: {
          ...room(
            "budget",
            budget?.limitUsd ?? 0,
            budget?.limitUsd ? budget.usedUsd / budget.limitUsd : null,
            budget?.limitUsd ? (budget.usedUsd + amountForRatiosUsd + feeUsd) / budget.limitUsd : null,
          ),
          availableUsd: budgetAvailableUsd,
        },
      },
      context: {
        currentQuantity: override.currentQuantity ?? context.currentQuantity,
        currentBookCost: amountInCurrency(override.currentBookCostUsd ?? context.currentBookCostUsd),
        currentBookCostUsd: override.currentBookCostUsd ?? context.currentBookCostUsd,
        positionsValue: amountInCurrency(positionsValueUsd),
        positionsValueUsd: roundAmount(positionsValueUsd),
        symbolValue: amountInCurrency(symbolValueUsd),
        symbolValueUsd: roundAmount(symbolValueUsd),
        bucketValue: amountInCurrency(bucketValueUsd),
        bucketValueUsd: bucketValueUsd == null ? null : roundAmount(bucketValueUsd),
        cash: amountInCurrency(cashUsd),
        cashUsd: roundAmount(cashUsd),
        netAssets: amountInCurrency(netAssetsUsd),
        netAssetsUsd: roundAmount(netAssetsUsd),
        bucket: bucket ?? null,
        budgetAvailable: amountInCurrency(budgetAvailableUsd),
        budgetAvailableUsd,
        asOf: context.asOf,
      },
      policy,
      candidate:
        candidate == null
          ? null
          : {
              amount: candidate,
              amountUsd: roundAmount(candidate * rate),
              safe: complete && safeAmountUsd != null && candidateViolations.length === 0,
              violations: candidateViolations,
            },
    };
    return result;
  }

  return {
    getSettings: settings,
    updateSettings(userId: number, input: RiskSettingsInput) {
      validateSettings(input);
      db.prepare(
        `INSERT INTO risk_settings (user_id, symbol_limit, bucket_limit, cash_floor) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET symbol_limit = excluded.symbol_limit,
         bucket_limit = excluded.bucket_limit, cash_floor = excluded.cash_floor, updated_at = datetime('now')`,
      ).run(userId, input.symbolLimit, input.bucketLimit, input.cashFloor);
      return settings(userId);
    },
    listBudgets(userId: number, quarter = quarterForDate()) {
      const validQuarter = validateQuarter(quarter);
      return { quarter: validQuarter, budgets: BUCKETS.map((bucket) => budgetState(userId, bucket, validQuarter)) };
    },
    setBudget(userId: number, input: BucketBudgetInput) {
      const bucket = requireBucket(input.bucket);
      const quarter = validateQuarter(input.quarter);
      const currency = requireCurrency(input.currency);
      if (!(input.limitAmount > 0) || !Number.isFinite(input.limitAmount)) throw new ValidationError("仓预算需为正数");
      const count = (
        db.prepare("SELECT COUNT(*) AS count FROM bucket_budgets WHERE user_id = ? AND bucket = ? AND quarter = ?").get(
          userId,
          bucket,
          quarter,
        ) as { count: number }
      ).count;
      if (count >= 2) {
        throw new ConflictError("本季度该仓预算已调整一次", { nextAdjustableQuarter: nextQuarter(quarter) });
      }
      db.prepare(
        `INSERT INTO bucket_budgets (user_id, bucket, quarter, revision, limit_amount, currency, fx_to_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(userId, bucket, quarter, count, input.limitAmount, currency, fxToUsd[currency]);
      return budgetState(userId, bucket, quarter);
    },
    budgetState,
    safeAdd(userId: number, input: SafeAddInput) {
      return evaluate(userId, input);
    },
    evaluateScenario: evaluate,
  };
}

export type RiskService = ReturnType<typeof createRiskService>;
