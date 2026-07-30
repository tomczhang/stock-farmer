import { describe, expect, it } from "vitest";
import { authedJson, createTestApp, registerAndLogin } from "./helpers.test.js";

const STATEMENT = {
  broker: "ibkr",
  fileName: "activity-2026-06.pdf",
  asOf: "2026-06-30",
  positions: [
    {
      broker: "ibkr",
      market: "US",
      currency: "USD",
      symbol: "AAPL",
      name: "Apple Inc",
      quantity: 100,
      marketValue: 21000,
      costBasis: 18000,
    },
  ],
  cashBalances: [{ broker: "ibkr", currency: "USD", amount: 5000 }],
};

interface SummaryLike {
  kpi: {
    totalAssets: number;
    positionsValue: number;
    totalCost: number;
    gainLoss: number;
    gainLossRatio: number | null;
    idleCash: number;
  };
  pnl: { tradingFees: number };
  coverage: { status: string; missing: string[] };
  allocation: {
    bySymbol: Array<{ name: string; value: number }>;
    byBucket: Array<{ name: string; value: number }>;
  };
  positions: Array<{
    symbol: string;
    broker: string;
    quantity: number;
    effectiveCost: number | null;
    costSource: string;
    currentPrice: number | null;
    bucket: string;
    marketValue: number;
  }>;
  history: Array<{ month: string; valueDisplay: number; costDisplay: number; gainLossDisplay: number; symbolCount: number }>;
}

async function getSummary(ctx: ReturnType<typeof createTestApp>, cookie: string) {
  const res = await ctx.app.request("/api/portfolio/summary?display=USD", { headers: { Cookie: cookie } });
  return (await res.json()) as SummaryLike;
}

describe("账面成本与交易现金流分离", () => {
  it("部分手工交易绝不覆盖月结单账面成本", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    await ctx.app.request("/api/statements", authedJson(cookie, STATEMENT));
    // AAPL：买 50 股 @2（投入 100），卖 25 股 @8（回收 200）→ 净成本 = -100
    await ctx.app.request(
      "/api/trades",
      authedJson(cookie, {
        broker: "ibkr",
        market: "US",
        currency: "USD",
        symbol: "AAPL",
        side: "buy",
        tradeDate: "2026-01-05",
        quantity: 50,
        price: 2,
        fee: 0,
      }),
    );
    await ctx.app.request(
      "/api/trades",
      authedJson(cookie, {
        broker: "ibkr",
        market: "US",
        currency: "USD",
        symbol: "AAPL",
        side: "sell",
        tradeDate: "2026-03-10",
        quantity: 25,
        price: 8,
        fee: 0,
      }),
    );
    const summary = await getSummary(ctx, cookie);
    const aapl = summary.positions.find((p) => p.symbol === "AAPL")!;
    expect(aapl.effectiveCost).toBe(18000);
    expect(aapl.costSource).toBe("statement");
    expect(summary.kpi.totalCost).toBe(18000);
    expect(summary.kpi.gainLoss).toBeCloseTo(3000, 1);
    expect(summary.kpi.gainLossRatio).toBeCloseTo(3000 / 18000, 4);
  });

  it("只有交易的持仓成本未知，手续费只进入盈亏费用", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    await ctx.app.request(
      "/api/trades",
      authedJson(cookie, {
        broker: "futu",
        market: "US",
        currency: "USD",
        symbol: "TSLA",
        side: "buy",
        tradeDate: "2026-05-01",
        quantity: 10,
        price: 100,
        fee: 5,
      }),
    );
    const summary = await getSummary(ctx, cookie);
    const tsla = summary.positions.find((p) => p.symbol === "TSLA")!;
    expect(tsla.effectiveCost).toBeNull();
    expect(tsla.costSource).toBe("none");
    expect(summary.pnl.tradingFees).toBe(5);
    expect(summary.coverage.status).not.toBe("complete");
    expect(summary.coverage.missing).toContain("book_cost:US:TSLA");
  });

  it("纯手动交易可建立持仓（快照中不存在的标的）", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    await ctx.app.request(
      "/api/trades",
      authedJson(cookie, {
        broker: "manual",
        market: "HK",
        currency: "HKD",
        symbol: "00700",
        name: "腾讯控股",
        side: "buy",
        tradeDate: "2026-06-01",
        quantity: 100,
        price: 400,
        fee: 100,
      }),
    );
    const summary = await getSummary(ctx, cookie);
    const tencent = summary.positions.find((p) => p.symbol === "00700")!;
    expect(tencent.quantity).toBe(100);
    expect(tencent.effectiveCost).toBeNull();
    expect(tencent.marketValue).toBe(40000); // 100 × 最后成交价 400
  });

  it("交易列表与删除", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    await ctx.app.request(
      "/api/trades",
      authedJson(cookie, {
        broker: "ibkr", market: "US", currency: "USD", symbol: "AAPL",
        side: "buy", tradeDate: "2026-01-05", quantity: 1, price: 100,
      }),
    );
    const list = (await (await ctx.app.request("/api/trades", { headers: { Cookie: cookie } })).json()) as Array<{ id: number }>;
    expect(list).toHaveLength(1);
    const del = await ctx.app.request(`/api/trades/${list[0].id}`, { method: "DELETE", headers: { Cookie: cookie } });
    expect(del.status).toBe(200);
    expect((await (await ctx.app.request("/api/trades", { headers: { Cookie: cookie } })).json()) as unknown[]).toHaveLength(0);
  });

  it("非法交易返回 400", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    const bad = await ctx.app.request(
      "/api/trades",
      authedJson(cookie, { broker: "x", market: "US", currency: "USD", symbol: "A", side: "hold", tradeDate: "2026-01-01", quantity: 1, price: 1 }),
    );
    expect(bad.status).toBe(400);
  });
});

describe("成本编辑与仓别标注", () => {
  it("手动编辑成本优先级最高", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    await ctx.app.request("/api/statements", authedJson(cookie, STATEMENT));
    await ctx.app.request(
      "/api/positions/cost",
      authedJson(cookie, { broker: "ibkr", symbol: "AAPL", costBasis: 12345 }, "PUT"),
    );
    let summary = await getSummary(ctx, cookie);
    let aapl = summary.positions.find((p) => p.symbol === "AAPL")!;
    expect(aapl.effectiveCost).toBe(12345);
    expect(aapl.costSource).toBe("manual");
    expect(summary.kpi.gainLossRatio).toBeCloseTo((21000 - 12345) / 12345, 4);

    // 清除后回退到月结单成本
    await ctx.app.request(
      "/api/positions/cost",
      authedJson(cookie, { broker: "ibkr", symbol: "AAPL", costBasis: null }, "PUT"),
    );
    summary = await getSummary(ctx, cookie);
    aapl = summary.positions.find((p) => p.symbol === "AAPL")!;
    expect(aapl.effectiveCost).toBe(18000);
    expect(aapl.costSource).toBe("statement");
  });

  it("仓别标注与三仓分布聚合", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    await ctx.app.request("/api/statements", authedJson(cookie, STATEMENT));
    await ctx.app.request("/api/buckets", authedJson(cookie, { symbol: "AAPL", bucket: "aggressive" }, "PUT"));
    let summary = await getSummary(ctx, cookie);
    expect(summary.positions.find((p) => p.symbol === "AAPL")!.bucket).toBe("aggressive");
    expect(summary.allocation.byBucket.find((b) => b.name === "进取仓")?.value).toBeCloseTo(21000, 1);

    // 改仓 + 未分类
    await ctx.app.request("/api/buckets", authedJson(cookie, { symbol: "AAPL", bucket: "stable" }, "PUT"));
    summary = await getSummary(ctx, cookie);
    expect(summary.allocation.byBucket.find((b) => b.name === "稳健仓")?.value).toBeCloseTo(21000, 1);

    const bad = await ctx.app.request("/api/buckets", authedJson(cookie, { symbol: "AAPL", bucket: "yolo" }, "PUT"));
    expect(bad.status).toBe(400);
  });

  it("标的市值分布 bySymbol", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    await ctx.app.request("/api/statements", authedJson(cookie, STATEMENT));
    const summary = await getSummary(ctx, cookie);
    expect(summary.allocation.bySymbol[0]).toEqual({ name: "AAPL", value: 21000 });
  });
});

describe("近 1 年历史盈亏", () => {
  it("按月聚合市值/成本/盈亏/标的数", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    await ctx.app.request(
      "/api/statements",
      authedJson(cookie, { ...STATEMENT, asOf: "2026-05-29", positions: [{ ...STATEMENT.positions[0], marketValue: 19000 }] }),
    );
    await ctx.app.request("/api/statements", authedJson(cookie, STATEMENT)); // 2026-06-30
    const summary = await getSummary(ctx, cookie);
    expect(summary.history).toHaveLength(2);
    const may = summary.history.find((h) => h.month === "2026-05")!;
    const jun = summary.history.find((h) => h.month === "2026-06")!;
    expect(may.valueDisplay).toBeCloseTo(19000, 1);
    expect(may.gainLossDisplay).toBeCloseTo(1000, 1);
    expect(jun.valueDisplay).toBeCloseTo(21000, 1);
    expect(jun.gainLossDisplay).toBeCloseTo(3000, 1);
    expect(jun.symbolCount).toBe(1);
  });
});
