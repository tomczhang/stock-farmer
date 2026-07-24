import { describe, expect, it } from "vitest";
import { computePlan } from "../plans.js";
import { authedJson, createTestApp, registerAndLogin } from "./helpers.test.js";

describe("computePlan（纯函数）", () => {
  it("pct_drop + pct 标准金字塔", () => {
    const result = computePlan(100, 10000, [
      { seq: 1, triggerType: "pct_drop", triggerValue: 10, allocType: "pct", allocValue: 10 },
      { seq: 2, triggerType: "pct_drop", triggerValue: 20, allocType: "pct", allocValue: 20 },
      { seq: 3, triggerType: "pct_drop", triggerValue: 30, allocType: "pct", allocValue: 30 },
      { seq: 4, triggerType: "pct_drop", triggerValue: 40, allocType: "pct", allocValue: 40 },
    ]);
    expect(result.tiers[0].buyPrice).toBe(90);
    expect(result.tiers[0].amount).toBe(1000);
    expect(result.tiers[0].shares).toBeCloseTo(11.11, 2);
    expect(result.tiers[3].buyPrice).toBe(60);
    expect(result.tiers[3].cumulativeAmount).toBe(10000);
    expect(result.totalPlanned).toBe(10000);
    // 摊薄成本应低于基准价且逐档下降
    expect(result.tiers[3].avgCost).toBeLessThan(result.tiers[0].avgCost);
    expect(result.warning).toBeUndefined();
  });

  it("price + amount 混合档位", () => {
    const result = computePlan(100, 10000, [
      { seq: 1, triggerType: "price", triggerValue: 85.5, allocType: "amount", allocValue: 5000 },
      { seq: 2, triggerType: "pct_drop", triggerValue: 25, allocType: "pct", allocValue: 50 },
    ]);
    expect(result.tiers[0].buyPrice).toBe(85.5);
    expect(result.tiers[0].amount).toBe(5000);
    expect(result.tiers[1].buyPrice).toBe(75);
    expect(result.tiers[1].amount).toBe(5000);
    expect(result.tiers[1].cumulativeShares).toBeCloseTo(5000 / 85.5 + 5000 / 75, 1);
  });

  it("超预算与超现金给出 warning", () => {
    const over = computePlan(100, 1000, [
      { seq: 1, triggerType: "pct_drop", triggerValue: 10, allocType: "amount", allocValue: 2000 },
    ]);
    expect(over.warning).toContain("超出总预算");

    const cashGap = computePlan(
      100,
      10000,
      [{ seq: 1, triggerType: "pct_drop", triggerValue: 10, allocType: "pct", allocValue: 100 }],
      3000,
    );
    expect(cashGap.warning).toContain("闲置现金");
  });

  it("非法参数抛错", () => {
    expect(() => computePlan(0, 1000, [])).toThrow();
    expect(() =>
      computePlan(100, 1000, [
        { seq: 1, triggerType: "pct_drop", triggerValue: 120, allocType: "pct", allocValue: 10 },
      ]),
    ).toThrow(/买入价非法/);
  });

  it("档位按 seq 排序计算", () => {
    const result = computePlan(100, 9000, [
      { seq: 3, triggerType: "pct_drop", triggerValue: 30, allocType: "pct", allocValue: 40 },
      { seq: 1, triggerType: "pct_drop", triggerValue: 10, allocType: "pct", allocValue: 20 },
      { seq: 2, triggerType: "pct_drop", triggerValue: 20, allocType: "pct", allocValue: 40 },
    ]);
    expect(result.tiers.map((t) => t.seq)).toEqual([1, 2, 3]);
    expect(result.tiers.map((t) => t.buyPrice)).toEqual([90, 80, 70]);
  });
});

describe("plans API", () => {
  const PLAN = {
    symbol: "aapl",
    name: "Apple Inc",
    market: "US",
    currency: "USD",
    basePrice: 200,
    totalBudget: 20000,
    tiers: [
      { seq: 1, triggerType: "pct_drop", triggerValue: 10, allocType: "pct", allocValue: 30 },
      { seq: 2, triggerType: "pct_drop", triggerValue: 20, allocType: "pct", allocValue: 70 },
    ],
  };

  it("CRUD + 档位成交", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);

    const create = await ctx.app.request("/api/plans", authedJson(cookie, PLAN));
    expect(create.status).toBe(201);
    const plan = (await create.json()) as {
      id: number;
      symbol: string;
      totalPlanned: number;
      tiers: Array<{ id: number; buyPrice: number; amount: number }>;
    };
    expect(plan.symbol).toBe("AAPL");
    expect(plan.totalPlanned).toBe(20000);
    expect(plan.tiers[0].buyPrice).toBe(180);
    expect(plan.tiers[1].amount).toBe(14000);

    // 更新第 2 档为具体价格 + 固定金额
    const updated = await ctx.app.request(
      `/api/plans/${plan.id}`,
      authedJson(
        cookie,
        {
          ...PLAN,
          tiers: [
            PLAN.tiers[0],
            { seq: 2, triggerType: "price", triggerValue: 150, allocType: "amount", allocValue: 5000 },
          ],
        },
        "PUT",
      ),
    );
    const updatedPlan = (await updated.json()) as { tiers: Array<{ id: number; buyPrice: number; amount: number }> };
    expect(updatedPlan.tiers[1].buyPrice).toBe(150);
    expect(updatedPlan.tiers[1].amount).toBe(5000);

    // 标记第 1 档成交
    const fill = await ctx.app.request(
      `/api/plans/${plan.id}/tiers/${updatedPlan.tiers[0].id}/fill`,
      authedJson(cookie, { filled: true }, "PUT"),
    );
    const filledPlan = (await fill.json()) as { filledAmount: number };
    expect(filledPlan.filledAmount).toBe(6000);

    // 删除
    const del = await ctx.app.request(`/api/plans/${plan.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(del.status).toBe(200);
    const list = (await (
      await ctx.app.request("/api/plans", { headers: { Cookie: cookie } })
    ).json()) as unknown[];
    expect(list).toHaveLength(0);
  });

  it("总投入超过闲置现金时返回 warning", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    // 无任何现金，直接建 2 万美元计划
    const create = await ctx.app.request("/api/plans", authedJson(cookie, PLAN));
    const plan = (await create.json()) as { warning?: string };
    expect(plan.warning).toContain("闲置现金");
  });

  it("非法档位返回 400；跨用户不可见", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx, "u1@example.com");
    const bad = await ctx.app.request(
      "/api/plans",
      authedJson(cookie, { ...PLAN, tiers: [{ seq: 1, triggerType: "bad", triggerValue: 1, allocType: "pct", allocValue: 1 }] }),
    );
    expect(bad.status).toBe(400);

    await ctx.app.request("/api/plans", authedJson(cookie, PLAN));
    const { cookie: cookie2 } = await registerAndLogin(ctx, "u2@example.com");
    const list = (await (
      await ctx.app.request("/api/plans", { headers: { Cookie: cookie2 } })
    ).json()) as unknown[];
    expect(list).toHaveLength(0);
  });
});
