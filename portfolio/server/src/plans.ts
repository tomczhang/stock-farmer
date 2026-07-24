import type { AppDatabase } from "./db.js";
import { ValidationError } from "./portfolio.js";
import type { ComputedPlan, ComputedTier, PlanInput, PlanTierInput } from "./types.js";

/** 金字塔计算：每档买入价/金额/股数/累计投入/摊薄成本。纯函数，便于测试。 */
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
      const buyPrice =
        tier.triggerType === "pct_drop"
          ? basePrice * (1 - tier.triggerValue / 100)
          : tier.triggerValue;
      if (!(buyPrice > 0)) {
        throw new ValidationError(`第 ${tier.seq} 档买入价非法（${buyPrice.toFixed(4)}）`);
      }
      const amount = tier.allocType === "pct" ? (totalBudget * tier.allocValue) / 100 : tier.allocValue;
      if (!(amount > 0)) throw new ValidationError(`第 ${tier.seq} 档投入金额非法`);
      const shares = amount / buyPrice;
      cumulativeAmount += amount;
      cumulativeShares += shares;
      return {
        ...tier,
        buyPrice: Math.round(buyPrice * 10000) / 10000,
        amount: Math.round(amount * 100) / 100,
        shares: Math.round(shares * 100) / 100,
        cumulativeAmount: Math.round(cumulativeAmount * 100) / 100,
        cumulativeShares: Math.round(cumulativeShares * 100) / 100,
        avgCost: Math.round((cumulativeAmount / cumulativeShares) * 10000) / 10000,
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
  return { totalPlanned: Math.round(cumulativeAmount * 100) / 100, tiers: computed, warning };
}

function validatePlanInput(input: PlanInput) {
  if (!input.symbol?.trim()) throw new ValidationError("缺少标的代码");
  if (!Array.isArray(input.tiers) || input.tiers.length === 0) throw new ValidationError("至少需要 1 个档位");
  for (const tier of input.tiers) {
    if (!["pct_drop", "price"].includes(tier.triggerType)) throw new ValidationError("触发方式非法");
    if (!["pct", "amount"].includes(tier.allocType)) throw new ValidationError("仓位方式非法");
    if (!Number.isFinite(tier.triggerValue) || tier.triggerValue <= 0) throw new ValidationError("触发值非法");
    if (tier.triggerType === "pct_drop" && tier.triggerValue >= 100) throw new ValidationError("跌幅需小于 100%");
    if (!Number.isFinite(tier.allocValue) || tier.allocValue <= 0) throw new ValidationError("仓位值非法");
  }
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
  currency: string;
  base_price: number;
  total_budget: number;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export function createPlanService(db: AppDatabase, idleCashUsd: (userId: number) => number) {
  function tiersForPlan(planId: number) {
    return (db.prepare("SELECT * FROM plan_tiers WHERE plan_id = ? ORDER BY seq").all(planId) as TierRow[]).map(
      (t) => ({
        id: t.id,
        seq: t.seq,
        triggerType: t.trigger_type,
        triggerValue: t.trigger_value,
        allocType: t.alloc_type,
        allocValue: t.alloc_value,
        filledAt: t.filled_at,
      }),
    );
  }

  function serialize(userId: number, row: PlanRow) {
    const tiers = tiersForPlan(row.id);
    const computed = computePlan(row.base_price, row.total_budget, tiers, idleCashUsd(userId));
    const filledAmount = computed.tiers
      .filter((t) => t.filledAt)
      .reduce((sum, t) => sum + t.amount, 0);
    return {
      id: row.id,
      symbol: row.symbol,
      name: row.name,
      market: row.market,
      currency: row.currency,
      basePrice: row.base_price,
      totalBudget: row.total_budget,
      note: row.note,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      totalPlanned: computed.totalPlanned,
      filledAmount: Math.round(filledAmount * 100) / 100,
      warning: computed.warning,
      tiers: computed.tiers,
    };
  }

  const replaceTiersTx = db.transaction((planId: number, tiers: PlanTierInput[]) => {
    db.prepare("DELETE FROM plan_tiers WHERE plan_id = ?").run(planId);
    const insert = db.prepare(
      "INSERT INTO plan_tiers (plan_id, seq, trigger_type, trigger_value, alloc_type, alloc_value) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const tier of tiers) {
      insert.run(planId, tier.seq, tier.triggerType, tier.triggerValue, tier.allocType, tier.allocValue);
    }
  });

  return {
    list(userId: number) {
      const rows = db
        .prepare("SELECT * FROM pyramid_plans WHERE user_id = ? ORDER BY updated_at DESC")
        .all(userId) as PlanRow[];
      return rows.map((row) => serialize(userId, row));
    },

    create(userId: number, input: PlanInput) {
      validatePlanInput(input);
      computePlan(input.basePrice, input.totalBudget, input.tiers); // 提前校验计算合法性
      const result = db
        .prepare(
          "INSERT INTO pyramid_plans (user_id, symbol, name, market, currency, base_price, total_budget, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          userId,
          input.symbol.trim().toUpperCase(),
          input.name ?? input.symbol,
          input.market ?? "US",
          input.currency ?? "USD",
          input.basePrice,
          input.totalBudget,
          input.note ?? null,
        );
      const planId = Number(result.lastInsertRowid);
      replaceTiersTx(planId, input.tiers);
      const row = db.prepare("SELECT * FROM pyramid_plans WHERE id = ?").get(planId) as PlanRow;
      return serialize(userId, row);
    },

    update(userId: number, planId: number, input: PlanInput) {
      const existing = db
        .prepare("SELECT * FROM pyramid_plans WHERE id = ? AND user_id = ?")
        .get(planId, userId) as PlanRow | undefined;
      if (!existing) return null;
      validatePlanInput(input);
      computePlan(input.basePrice, input.totalBudget, input.tiers);
      db.prepare(
        "UPDATE pyramid_plans SET symbol = ?, name = ?, market = ?, currency = ?, base_price = ?, total_budget = ?, note = ?, updated_at = datetime('now') WHERE id = ?",
      ).run(
        input.symbol.trim().toUpperCase(),
        input.name ?? input.symbol,
        input.market ?? existing.market,
        input.currency ?? existing.currency,
        input.basePrice,
        input.totalBudget,
        input.note ?? null,
        planId,
      );
      replaceTiersTx(planId, input.tiers);
      const row = db.prepare("SELECT * FROM pyramid_plans WHERE id = ?").get(planId) as PlanRow;
      return serialize(userId, row);
    },

    remove(userId: number, planId: number) {
      return db.prepare("DELETE FROM pyramid_plans WHERE id = ? AND user_id = ?").run(planId, userId).changes > 0;
    },

    setTierFilled(userId: number, planId: number, tierId: number, filled: boolean) {
      const owned = db
        .prepare("SELECT id FROM pyramid_plans WHERE id = ? AND user_id = ?")
        .get(planId, userId);
      if (!owned) return null;
      const result = db
        .prepare("UPDATE plan_tiers SET filled_at = ? WHERE id = ? AND plan_id = ?")
        .run(filled ? new Date().toISOString() : null, tierId, planId);
      if (result.changes === 0) return null;
      const row = db.prepare("SELECT * FROM pyramid_plans WHERE id = ?").get(planId) as PlanRow;
      return serialize(userId, row);
    },
  };
}
