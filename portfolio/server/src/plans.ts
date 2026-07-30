import type { AppDatabase } from "./db.js";
import { ConflictError, ValidationError } from "./errors.js";
import { coverage, normalizeMarket, requireCurrency, roundAmount } from "./finance.js";
import type { RiskService } from "./risk.js";
import type { ComputedPlan, ComputedTier, Currency, PlanInput, PlanTierInput } from "./types.js";

/** 基础金字塔计算保持为纯函数；组合上下文由 service 的 preview 叠加。 */
export function computePlan(
  basePrice: number,
  totalBudget: number,
  tiers: Array<PlanTierInput & { id?: number; filledAt?: string | null }>,
  idleCash?: number,
): ComputedPlan {
  if (!(basePrice > 0)) throw new ValidationError("基准价需大于 0");
  if (!(totalBudget > 0)) throw new ValidationError("总预算需大于 0");
  if (!tiers.length) throw new ValidationError("至少需要 1 个档位");

  let cumulativeAmount = 0;
  let cumulativeShares = 0;
  const computed: ComputedTier[] = [...tiers]
    .sort((a, b) => a.seq - b.seq)
    .map((tier) => {
      const buyPrice = tier.triggerType === "pct_drop" ? basePrice * (1 - tier.triggerValue / 100) : tier.triggerValue;
      if (!(buyPrice > 0)) throw new ValidationError(`第 ${tier.seq} 档买入价非法（${buyPrice.toFixed(4)}）`);
      const amount = tier.allocType === "pct" ? (totalBudget * tier.allocValue) / 100 : tier.allocValue;
      if (!(amount > 0)) throw new ValidationError(`第 ${tier.seq} 档投入金额非法`);
      const shares = amount / buyPrice;
      cumulativeAmount += amount;
      cumulativeShares += shares;
      return {
        ...tier,
        buyPrice: roundAmount(buyPrice, 4),
        amount: roundAmount(amount),
        shares: roundAmount(shares, 4),
        cumulativeAmount: roundAmount(cumulativeAmount),
        cumulativeShares: roundAmount(cumulativeShares, 4),
        avgCost: roundAmount(cumulativeAmount / cumulativeShares, 4),
      };
    });

  let warning: string | undefined;
  if (cumulativeAmount > totalBudget * 1.0001) {
    warning = `档位合计投入 ${cumulativeAmount.toFixed(2)} 超出总预算 ${totalBudget.toFixed(2)}`;
  }
  if (idleCash !== undefined && cumulativeAmount > idleCash) {
    const gap = cumulativeAmount - idleCash;
    warning = [warning, `计划总投入超出当前闲置现金，缺口约 ${gap.toFixed(2)}（USD 口径）`]
      .filter(Boolean)
      .join("；");
  }
  return { totalPlanned: roundAmount(cumulativeAmount), tiers: computed, warning };
}

function normalizedTiers(input: PlanInput) {
  if (!input.templateWeights?.length) return input.tiers.map((tier) => ({ ...tier }));
  if (input.templateWeights.length !== input.tiers.length) throw new ValidationError("模板权重数量需与档位数量一致");
  if (input.templateWeights.some((weight) => !(weight > 0) || !Number.isFinite(weight))) {
    throw new ValidationError("模板权重必须全部为正数");
  }
  const total = input.templateWeights.reduce((sum, value) => sum + value, 0);
  return input.tiers.map((tier, index) => ({
    ...tier,
    allocType: "pct" as const,
    allocValue: (input.templateWeights![index] / total) * 100,
  }));
}

function validatePlanInput(input: PlanInput) {
  if (!input.symbol?.trim()) throw new ValidationError("缺少标的代码");
  normalizeMarket(input.market);
  requireCurrency(input.currency);
  if (!(input.basePrice > 0) || !(input.totalBudget > 0)) throw new ValidationError("基准价和总预算需为正数");
  if (!Number.isFinite(input.estimatedFee ?? 0) || (input.estimatedFee ?? 0) < 0) {
    throw new ValidationError("预计交易费不能为负");
  }
  if (!Array.isArray(input.tiers) || input.tiers.length === 0) throw new ValidationError("至少需要 1 个档位");
  for (const tier of input.tiers) {
    if ((tier as PlanTierInput & { side?: string }).side && (tier as PlanTierInput & { side?: string }).side !== "buy") {
      throw new ValidationError("加仓方案只支持买入档位");
    }
    if (!["pct_drop", "price"].includes(tier.triggerType)) throw new ValidationError("触发方式非法");
    if (!["pct", "amount"].includes(tier.allocType)) throw new ValidationError("仓位方式非法");
    if (!Number.isFinite(tier.triggerValue) || tier.triggerValue <= 0) throw new ValidationError("触发值非法");
    if (tier.triggerType === "pct_drop" && tier.triggerValue >= 100) throw new ValidationError("跌幅需小于 100%");
    if (!Number.isFinite(tier.allocValue) || tier.allocValue <= 0) throw new ValidationError("仓位值非法");
  }
  normalizedTiers(input);
}

interface TierRow {
  id: number;
  seq: number;
  trigger_type: "pct_drop" | "price";
  trigger_value: number;
  alloc_type: "pct" | "amount";
  alloc_value: number;
  filled_at: string | null;
}

interface PlanRow {
  id: number;
  symbol: string;
  name: string;
  market: string;
  currency: Currency;
  base_price: number;
  total_budget: number;
  estimated_fee: number;
  scenario_name: string | null;
  template_weights_json: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export function createPlanService(db: AppDatabase, fxToUsd: Record<string, number>, risk: RiskService) {
  function tiersForPlan(planId: number) {
    return (db.prepare("SELECT * FROM plan_tiers WHERE plan_id = ? ORDER BY seq").all(planId) as TierRow[]).map((tier) => ({
      id: tier.id,
      seq: tier.seq,
      triggerType: tier.trigger_type,
      triggerValue: tier.trigger_value,
      allocType: tier.alloc_type,
      allocValue: tier.alloc_value,
      filledAt: tier.filled_at,
    }));
  }

  function preview(
    userId: number,
    input: PlanInput,
    metadata: { id?: number; createdAt?: string; updatedAt?: string } = {},
    suppliedTiers?: Array<PlanTierInput & { id?: number; filledAt?: string | null }>,
  ) {
    validatePlanInput(input);
    const tiers = suppliedTiers ?? normalizedTiers(input);
    const computed = computePlan(input.basePrice, input.totalBudget, tiers);
    const currency = requireCurrency(input.currency);
    const rate = fxToUsd[currency];
    if (!(rate > 0)) throw new ValidationError(`缺少 ${currency} 汇率`);
    const estimatedFee = input.estimatedFee ?? 0;
    const initialSafety = risk.evaluateScenario(userId, {
      market: input.market,
      symbol: input.symbol,
      currency,
      candidateAmount: computed.totalPlanned,
      estimatedFee,
    });
    const currentQuantity = Number(initialSafety.context.currentQuantity ?? 0);
    const currentBookCostUsd = initialSafety.context.currentBookCostUsd as number | null;
    const currentBookCost = currentBookCostUsd == null ? null : currentBookCostUsd / rate;
    const otherPositionsUsd =
      Number(initialSafety.context.positionsValueUsd ?? 0) - Number(initialSafety.context.symbolValueUsd ?? 0);
    const currentBucketValueUsd = initialSafety.context.bucketValueUsd as number | null;
    const otherBucketUsd = currentBucketValueUsd == null
      ? null
      : currentBucketValueUsd - Number(initialSafety.context.symbolValueUsd ?? 0);
    const initialCashUsd = Number(initialSafety.context.cashUsd ?? 0);
    const initialBudgetUsd = initialSafety.context.budgetAvailableUsd as number | null;

    const enrichedTiers = computed.tiers.map((tier) => {
      const tierEstimatedFee = computed.totalPlanned > 0 ? (estimatedFee * tier.amount) / computed.totalPlanned : 0;
      const cumulativeEstimatedFee =
        computed.totalPlanned > 0 ? (estimatedFee * tier.cumulativeAmount) / computed.totalPlanned : 0;
      const cumulativeCashRequired = tier.cumulativeAmount + cumulativeEstimatedFee;
      const cumulativeSpendUsd = cumulativeCashRequired * rate;
      const postQuantity = currentQuantity + tier.cumulativeShares;
      const postBookCost = currentBookCost == null ? null : currentBookCost + cumulativeCashRequired;
      const postAvgCost = postBookCost == null || postQuantity <= 0 ? null : postBookCost / postQuantity;
      const existingTargetValueUsdAtTier = currentQuantity * tier.buyPrice * rate;
      const positionsValueUsdBeforeAdd = otherPositionsUsd + existingTargetValueUsdAtTier;
      const bucketValueUsdBeforeAdd = otherBucketUsd == null ? null : otherBucketUsd + existingTargetValueUsdAtTier;
      const remainingCashUsd = initialCashUsd - cumulativeSpendUsd;
      const remainingBudgetUsd = initialBudgetUsd == null ? null : initialBudgetUsd - cumulativeSpendUsd;
      const safety = risk.evaluateScenario(
        userId,
        {
          market: input.market,
          symbol: input.symbol,
          currency,
          candidateAmount: tier.cumulativeAmount,
          estimatedFee: cumulativeEstimatedFee,
        },
        {
          currentQuantity,
          currentBookCostUsd,
          positionsValueUsd: positionsValueUsdBeforeAdd,
          symbolValueUsd: existingTargetValueUsdAtTier,
          bucketValueUsd: bucketValueUsdBeforeAdd,
          cashUsd: initialCashUsd,
          netAssetsUsd: positionsValueUsdBeforeAdd + initialCashUsd,
          budgetAvailableUsd: initialBudgetUsd,
          budgetCoverageComplete: initialSafety.complete,
        },
      );
      return {
        ...tier,
        estimatedFee: roundAmount(tierEstimatedFee),
        cumulativeEstimatedFee: roundAmount(cumulativeEstimatedFee),
        cashRequired: roundAmount(tier.amount + tierEstimatedFee),
        cumulativeCashRequired: roundAmount(cumulativeCashRequired),
        postQuantity: roundAmount(postQuantity, 4),
        postBookCost: postBookCost == null ? null : roundAmount(postBookCost),
        postAvgCost: postAvgCost == null ? null : roundAmount(postAvgCost, 4),
        remainingCashUsd: roundAmount(remainingCashUsd),
        remainingBudgetUsd: remainingBudgetUsd == null ? null : roundAmount(remainingBudgetUsd),
        safety,
      };
    });
    const finalTier = enrichedTiers.at(-1)!;
    const filledAmount = enrichedTiers.filter((tier) => tier.filledAt).reduce((sum, tier) => sum + tier.amount, 0);
    const filledFee = enrichedTiers.filter((tier) => tier.filledAt).reduce((sum, tier) => sum + tier.estimatedFee, 0);
    const missing = currentBookCost == null && currentQuantity > 0 ? ["current_book_cost"] : [];
    const finalSafety = finalTier.safety;
    const finalCandidate = finalSafety.candidate as { safe?: boolean; violations?: string[] } | null;
    return {
      id: metadata.id,
      symbol: input.symbol.trim().toUpperCase(),
      name: input.name || input.symbol,
      market: normalizeMarket(input.market),
      currency,
      scenarioName: input.scenarioName?.trim() || `${input.symbol.trim().toUpperCase()} 加仓方案`,
      templateWeights: input.templateWeights ?? null,
      basePrice: input.basePrice,
      totalBudget: input.totalBudget,
      estimatedFee: roundAmount(estimatedFee),
      estimatedFeeUsd: roundAmount(estimatedFee * rate),
      note: input.note ?? null,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      totalPlanned: computed.totalPlanned,
      totalPlannedUsd: roundAmount(computed.totalPlanned * rate),
      totalCashRequired: roundAmount(computed.totalPlanned + estimatedFee),
      totalCashRequiredUsd: roundAmount((computed.totalPlanned + estimatedFee) * rate),
      filledAmount: roundAmount(filledAmount),
      filledFee: roundAmount(filledFee),
      warning: computed.warning,
      currentPosition: {
        quantity: currentQuantity,
        bookCost: currentBookCost,
        bookCostUsd: currentBookCostUsd,
      },
      final: {
        addedShares: roundAmount(finalTier.cumulativeShares, 4),
        totalQuantity: finalTier.postQuantity,
        quantity: finalTier.postQuantity,
        bookCost: finalTier.postBookCost,
        avgCost: finalTier.postAvgCost,
        remainingCashUsd: finalTier.remainingCashUsd,
        cash: finalTier.remainingCashUsd / rate,
        cashRatio: finalSafety.rooms.cash.postRatio,
        symbolRatio: finalSafety.rooms.symbol.postRatio,
        bucketRatio: finalSafety.rooms.bucket.postRatio,
        budgetRemainingUsd: finalTier.remainingBudgetUsd,
        budgetAvailable: finalTier.remainingBudgetUsd == null ? null : finalTier.remainingBudgetUsd / rate,
        estimatedFee: roundAmount(estimatedFee),
        totalCashRequired: roundAmount(computed.totalPlanned + estimatedFee),
        safe: finalSafety.complete && finalCandidate?.safe === true,
        violations: finalCandidate?.violations ?? finalSafety.missing,
      },
      coverage: coverage(2, missing.length || !finalSafety.complete ? 1 : 2, [...missing, ...finalSafety.missing]),
      tiers: enrichedTiers,
    };
  }

  function serialize(userId: number, row: PlanRow) {
    const tiers = tiersForPlan(row.id);
    return preview(
      userId,
      {
        symbol: row.symbol,
        name: row.name,
        market: row.market,
        currency: row.currency,
        basePrice: row.base_price,
        totalBudget: row.total_budget,
        estimatedFee: row.estimated_fee,
        scenarioName: row.scenario_name ?? undefined,
        templateWeights: row.template_weights_json ? (JSON.parse(row.template_weights_json) as number[]) : undefined,
        note: row.note ?? undefined,
        tiers,
      },
      { id: row.id, createdAt: row.created_at, updatedAt: row.updated_at },
      tiers,
    );
  }

  function replaceTiers(planId: number, tiers: PlanTierInput[]) {
    db.prepare("DELETE FROM plan_tiers WHERE plan_id = ?").run(planId);
    const insert = db.prepare(
      `INSERT INTO plan_tiers (plan_id, seq, trigger_type, trigger_value, alloc_type, alloc_value, filled_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    );
    for (const tier of tiers) {
      insert.run(planId, tier.seq, tier.triggerType, tier.triggerValue, tier.allocType, tier.allocValue);
    }
  }

  const replaceTiersTx = db.transaction(replaceTiers);

  const updatePlanTx = db.transaction((userId: number, planId: number, input: PlanInput, tiers: PlanTierInput[]) => {
    const existing = db.prepare("SELECT * FROM pyramid_plans WHERE id = ? AND user_id = ?").get(planId, userId) as PlanRow | undefined;
    if (!existing) return null;
    const filled = db
      .prepare("SELECT id FROM plan_tiers WHERE plan_id = ? AND filled_at IS NOT NULL ORDER BY seq")
      .all(planId) as Array<{ id: number }>;
    if (filled.length > 0) {
      throw new ConflictError("该计划已有成交档位，请先取消成交标记后再编辑", {
        planId,
        filledTierIds: filled.map((tier) => tier.id),
      });
    }
    db.prepare(
      `UPDATE pyramid_plans SET symbol = ?, name = ?, market = ?, currency = ?, base_price = ?, total_budget = ?, estimated_fee = ?,
       scenario_name = ?, template_weights_json = ?, note = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(
      input.symbol.trim().toUpperCase(),
      input.name || input.symbol,
      normalizeMarket(input.market),
      requireCurrency(input.currency),
      input.basePrice,
      input.totalBudget,
      input.estimatedFee ?? 0,
      input.scenarioName?.trim() || existing.scenario_name || `${input.symbol.trim().toUpperCase()} 加仓方案`,
      input.templateWeights ? JSON.stringify(input.templateWeights) : null,
      input.note ?? null,
      planId,
    );
    replaceTiers(planId, tiers);
    return db.prepare("SELECT * FROM pyramid_plans WHERE id = ?").get(planId) as PlanRow;
  });

  const setTierFilledTx = db.transaction((userId: number, planId: number, tierId: number, filled: boolean) => {
    const row = db.prepare("SELECT * FROM pyramid_plans WHERE id = ? AND user_id = ?").get(planId, userId) as PlanRow | undefined;
    if (!row) return null;
    const tierRow = db.prepare("SELECT id, filled_at FROM plan_tiers WHERE id = ? AND plan_id = ?").get(tierId, planId) as
      | { id: number; filled_at: string | null }
      | undefined;
    if (!tierRow) return null;
    if ((filled && tierRow.filled_at) || (!filled && !tierRow.filled_at)) return row;
    if (filled) {
      const active = db
        .prepare(
          `SELECT p.id, p.scenario_name FROM pyramid_plans p
           WHERE p.user_id = ? AND p.id <> ?
           AND EXISTS (SELECT 1 FROM plan_tiers t WHERE t.plan_id = p.id AND t.filled_at IS NOT NULL)
           ORDER BY p.updated_at DESC LIMIT 1`,
        )
        .get(userId, planId) as { id: number; scenario_name: string | null } | undefined;
      if (active) {
        throw new ConflictError("已有其他活动成交计划，请先取消其成交标记后再执行当前方案", {
          activePlanId: active.id,
          activeScenarioName: active.scenario_name,
        });
      }
      const plan = serialize(userId, row);
      const tier = plan.tiers.find((item) => item.id === tierId);
      if (!tier) return null;
      const candidate = tier.safety.candidate as { safe?: boolean } | null;
      if (plan.coverage.status !== "complete" || !tier.safety.complete || candidate?.safe !== true) {
        throw new ConflictError("安全校验未通过，不能标记该档已执行", {
          missing: tier.safety.missing,
          violations: candidate?.safe === false ? tier.safety.candidate?.violations : ["incomplete"],
        });
      }
    }
    db.prepare("UPDATE plan_tiers SET filled_at = ? WHERE id = ? AND plan_id = ?").run(
      filled ? new Date().toISOString() : null,
      tierId,
      planId,
    );
    return row;
  });

  const removePlanTx = db.transaction((userId: number, planId: number) => {
    const existing = db.prepare("SELECT id FROM pyramid_plans WHERE id = ? AND user_id = ?").get(planId, userId) as
      | { id: number }
      | undefined;
    if (!existing) return false;
    const filled = db
      .prepare("SELECT id FROM plan_tiers WHERE plan_id = ? AND filled_at IS NOT NULL ORDER BY seq")
      .all(planId) as Array<{ id: number }>;
    if (filled.length > 0) {
      throw new ConflictError("该计划已有成交档位，请先取消成交标记后再删除", {
        planId,
        filledTierIds: filled.map((tier) => tier.id),
      });
    }
    return db.prepare("DELETE FROM pyramid_plans WHERE id = ? AND user_id = ?").run(planId, userId).changes > 0;
  });

  return {
    list(userId: number) {
      const rows = db.prepare("SELECT * FROM pyramid_plans WHERE user_id = ? ORDER BY updated_at DESC").all(userId) as PlanRow[];
      return rows.map((row) => serialize(userId, row));
    },

    preview(userId: number, input: PlanInput) {
      const normalized = { ...input, tiers: normalizedTiers(input) };
      return preview(userId, normalized);
    },

    create(userId: number, input: PlanInput) {
      validatePlanInput(input);
      const tiers = normalizedTiers(input);
      computePlan(input.basePrice, input.totalBudget, tiers);
      const result = db
        .prepare(
          `INSERT INTO pyramid_plans
           (user_id, symbol, name, market, currency, base_price, total_budget, estimated_fee, scenario_name, template_weights_json, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          userId,
          input.symbol.trim().toUpperCase(),
          input.name || input.symbol,
          normalizeMarket(input.market),
          requireCurrency(input.currency),
          input.basePrice,
          input.totalBudget,
          input.estimatedFee ?? 0,
          input.scenarioName?.trim() || `${input.symbol.trim().toUpperCase()} 加仓方案`,
          input.templateWeights ? JSON.stringify(input.templateWeights) : null,
          input.note ?? null,
        );
      const planId = Number(result.lastInsertRowid);
      replaceTiersTx(planId, tiers);
      return serialize(userId, db.prepare("SELECT * FROM pyramid_plans WHERE id = ?").get(planId) as PlanRow);
    },

    update(userId: number, planId: number, input: PlanInput) {
      validatePlanInput(input);
      const tiers = normalizedTiers(input);
      computePlan(input.basePrice, input.totalBudget, tiers);
      const updated = updatePlanTx(userId, planId, input, tiers);
      return updated ? serialize(userId, updated) : null;
    },

    remove(userId: number, planId: number) {
      return removePlanTx(userId, planId);
    },

    compare(userId: number, input: { planIds?: number[]; scenarios?: PlanInput[] }) {
      const scenarios = (input.scenarios ?? []).map((scenario) => preview(userId, { ...scenario, tiers: normalizedTiers(scenario) }));
      for (const id of input.planIds ?? []) {
        const row = db.prepare("SELECT * FROM pyramid_plans WHERE id = ? AND user_id = ?").get(id, userId) as PlanRow | undefined;
        if (!row) throw new ValidationError(`计划 ${id} 不存在`);
        scenarios.push(serialize(userId, row));
      }
      if (scenarios.length < 2) throw new ValidationError("至少选择两个方案进行比较");
      const first = scenarios[0];
      if (scenarios.some((scenario) => scenario.market !== first.market || scenario.symbol !== first.symbol)) {
        throw new ValidationError("只能比较同一市场、同一标的的方案");
      }
      return { market: first.market, symbol: first.symbol, scenarios };
    },

    setTierFilled(userId: number, planId: number, tierId: number, filled: boolean) {
      const row = setTierFilledTx(userId, planId, tierId, filled);
      return row ? serialize(userId, row) : null;
    },
  };
}
