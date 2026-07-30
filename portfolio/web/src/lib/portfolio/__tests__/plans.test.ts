import { describe, expect, it } from "vitest";
import { buildTemplateTiers, canExecuteTier, canPlanStartExecution, hasPendingExecution, normalizeWeights, sameInstrument } from "../plans";

describe("加仓方案前端展示口径", () => {
  it("将 1:2:4:8 与 1:2:3:4 归一化到同一预算", () => {
    expect(normalizeWeights([1, 2, 4, 8]).reduce((sum, value) => sum + value, 0)).toBe(100);
    expect(normalizeWeights([1, 2, 3, 4])).toEqual([10, 20, 30, 40]);
    expect(buildTemplateTiers([1, 2, 4, 8])).toHaveLength(4);
  });

  it("只允许同市场同标的进入比较", () => {
    expect(sameInstrument([{ market: "US", symbol: "MSFT" }, { market: "US", symbol: "msft" }])).toBe(true);
    expect(sameInstrument([{ market: "US", symbol: "MSFT" }, { market: "US", symbol: "AAPL" }])).toBe(false);
  });

  it("数据不完整或不安全时禁止标记成交", () => {
    const coverage = { status: "complete" as const, missing: [], issues: [] };
    const safety = { complete: true, candidate: { amount: 100, safe: false } } as any;
    expect(canExecuteTier({ safety }, coverage)).toBe(false);
    expect(canExecuteTier({ safety: { ...safety, candidate: { amount: 100, safe: true } } }, coverage)).toBe(true);
    expect(canExecuteTier({ safety: { ...safety, candidate: { amount: 100, safe: true } } }, { ...coverage, status: "partial" })).toBe(false);
  });

  it("同一标的同一时间只允许一个方案保留未同步成交", () => {
    const plans = [
      { id: 1, tiers: [{ filledAt: "2026-07-24T01:00:00Z" }] },
      { id: 2, tiers: [{ filledAt: null }] },
    ] as any;
    expect(hasPendingExecution(plans[0])).toBe(true);
    expect(canPlanStartExecution(1, plans)).toBe(true);
    expect(canPlanStartExecution(2, plans)).toBe(false);
  });
});
