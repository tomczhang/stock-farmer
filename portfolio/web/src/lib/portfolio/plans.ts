import type { Coverage, Plan, PlanInputTier, PlanTier } from "../../types";

export const PLAN_TEMPLATES = {
  "1248": [1, 2, 4, 8],
  "1234": [1, 2, 3, 4],
} as const;

export type PlanTemplateId = keyof typeof PLAN_TEMPLATES;

export function normalizeWeights(weights: readonly number[]) {
  if (weights.length === 0 || weights.some((weight) => !Number.isFinite(weight) || weight <= 0)) {
    throw new Error("模板权重必须全部为正数");
  }
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const raw = weights.map((weight) => (weight / total) * 100);
  const rounded = raw.map((value) => Math.round(value * 100) / 100);
  const correction = Math.round((100 - rounded.reduce((sum, value) => sum + value, 0)) * 100) / 100;
  rounded[rounded.length - 1] += correction;
  return rounded;
}

export function buildTemplateTiers(weights: readonly number[]): PlanInputTier[] {
  return normalizeWeights(weights).map((allocation, index) => ({
    seq: index + 1,
    triggerType: "pct_drop",
    triggerValue: (index + 1) * 10,
    allocType: "pct",
    allocValue: allocation,
  }));
}

export function sameInstrument(plans: Array<Pick<Plan, "market" | "symbol">>) {
  if (plans.length < 2) return false;
  const first = `${plans[0].market}:${plans[0].symbol.toUpperCase()}`;
  return plans.every((plan) => `${plan.market}:${plan.symbol.toUpperCase()}` === first);
}

export function canExecuteTier(tier: Pick<PlanTier, "safety">, coverage?: Coverage) {
  if (!coverage || coverage.status !== "complete") return false;
  if (!tier.safety || !tier.safety.complete) return false;
  return tier.safety.candidate?.safe === true;
}

export function hasPendingExecution(plan: Pick<Plan, "tiers">) {
  return plan.tiers.some((tier) => Boolean(tier.filledAt));
}

export function canPlanStartExecution(planId: number, plans: Array<Pick<Plan, "id" | "tiers">>) {
  return !plans.some((plan) => plan.id !== planId && hasPendingExecution(plan));
}
