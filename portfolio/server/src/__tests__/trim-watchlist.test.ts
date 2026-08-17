import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db.js";
import type { Mailer } from "../mailer.js";
import type { QuoteFetcher } from "../quotes.js";
import { authedJson, createTestApp, registerAndLogin, type TestContext } from "./helpers.test.js";

/** 建立持仓上下文：月结单持仓 + 现金 + 仓别 + 预算，使 riskContext 可用。 */
async function setupHolding(ctx: TestContext, cookie: string, opts: { symbol?: string; quantity?: number; marketValue?: number; costBasis?: number; cash?: number } = {}) {
  const symbol = opts.symbol ?? "AAPL";
  const res = await ctx.app.request(
    "/api/statements",
    authedJson(cookie, {
      broker: "IBKR",
      fileName: "stmt.pdf",
      asOf: "2026-08-01",
      positions: [
        {
          broker: "IBKR",
          market: "US",
          currency: "USD",
          symbol,
          name: symbol,
          quantity: opts.quantity ?? 100,
          marketValue: opts.marketValue ?? 10000,
          costBasis: opts.costBasis ?? 1000,
        },
      ],
      cashBalances: [{ broker: "IBKR", currency: "USD", amount: opts.cash ?? 50000 }],
    }),
  );
  expect(res.status).toBe(201);
  await ctx.app.request("/api/buckets", authedJson(cookie, { symbol, bucket: "aggressive", market: "US" }, "PUT"));
}

function trimPlan(overrides: Record<string, unknown> = {}) {
  return {
    symbol: "AAPL",
    name: "AAPL",
    market: "US",
    currency: "USD",
    basePrice: 100,
    totalBudget: 0,
    direction: "trim",
    tiers: [
      { seq: 1, triggerType: "pct_gain", triggerValue: 20, allocType: "pct", allocValue: 30 },
      { seq: 2, triggerType: "pct_gain", triggerValue: 40, allocType: "pct", allocValue: 30 },
    ],
    ...overrides,
  };
}

describe("卖出计划（trim）", () => {
  it("direction 与 trigger_type 错配返回 400", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    await setupHolding(ctx, cookie);
    const res = await ctx.app.request(
      "/api/plans/preview",
      authedJson(cookie, trimPlan({ tiers: [{ seq: 1, triggerType: "pct_drop", triggerValue: 10, allocType: "pct", allocValue: 30 }] })),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toContain("pct_gain/price");
  });

  it("pct_gain 档触发价 = base × (1 + 涨幅)：base 100 + 20% = 120", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    await setupHolding(ctx, cookie);
    const res = await ctx.app.request("/api/plans/preview", authedJson(cookie, trimPlan()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.direction).toBe("trim");
    expect(body.tiers[0].sellPrice).toBeCloseTo(120, 4);
    expect(body.tiers[1].sellPrice).toBeCloseTo(140, 4);
    // 100 股，30% + 30%
    expect(body.tiers[0].quantity).toBeCloseTo(30, 4);
    expect(body.tiers[1].cumulativeQuantity).toBeCloseTo(60, 4);
  });

  it("超卖校验：合计卖出比例超过 100% 返回 400", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    await setupHolding(ctx, cookie);
    const res = await ctx.app.request(
      "/api/plans/preview",
      authedJson(
        cookie,
        trimPlan({
          tiers: [
            { seq: 1, triggerType: "pct_gain", triggerValue: 20, allocType: "pct", allocValue: 60 },
            { seq: 2, triggerType: "pct_gain", triggerValue: 40, allocType: "pct", allocValue: 60 },
          ],
        }),
      ),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toContain("超出当前持仓");
  });

  it("逐档预览：剩余持仓/成本等比结转/回收现金/集中度单调不升/现金率单调不降", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    await setupHolding(ctx, cookie, { quantity: 100, marketValue: 10000, costBasis: 1000, cash: 50000 });
    const res = await ctx.app.request("/api/plans/preview", authedJson(cookie, trimPlan({ estimatedFee: 10 })));
    const body = (await res.json()) as any;
    const [t1, t2] = body.tiers;
    // 第一档卖 30 股 @120：剩 70 股，账面成本 1000 × 70% = 700
    expect(t1.postQuantity).toBeCloseTo(70, 4);
    expect(t1.postBookCost).toBeCloseTo(700, 2);
    expect(t1.postAvgCost).toBeCloseTo(10, 4); // 每股摊薄成本不变
    expect(t1.proceeds).toBeCloseTo(3600, 2);
    // 第二档再卖 30 股 @140：剩 40 股，成本 400
    expect(t2.postQuantity).toBeCloseTo(40, 4);
    expect(t2.postBookCost).toBeCloseTo(400, 2);
    // 单调性
    expect(t2.postSymbolRatio).toBeLessThanOrEqual(t1.postSymbolRatio + 1e-9);
    expect(t2.postCashRatio).toBeGreaterThanOrEqual(t1.postCashRatio - 1e-9);
    // 总回收 = 3600 + 4200 − 10 费
    expect(body.totalNetProceeds).toBeCloseTo(7790, 2);
  });

  it("创建 trim 计划落库并可列出；既有 add 计划兼容 direction 默认 add", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    await setupHolding(ctx, cookie);
    const created = await ctx.app.request("/api/plans", authedJson(cookie, trimPlan()));
    expect(created.status).toBe(201);
    const addPlan = await ctx.app.request(
      "/api/plans",
      authedJson(cookie, {
        symbol: "AAPL",
        name: "AAPL",
        market: "US",
        currency: "USD",
        basePrice: 100,
        totalBudget: 5000,
        tiers: [{ seq: 1, triggerType: "pct_drop", triggerValue: 10, allocType: "pct", allocValue: 100 }],
      }),
    );
    expect(addPlan.status).toBe(201);
    const list = (await (await ctx.app.request("/api/plans", { headers: { Cookie: cookie } })).json()) as any[];
    expect(list.map((p) => p.direction).sort()).toEqual(["add", "trim"]);
    const trim = list.find((p) => p.direction === "trim");
    expect(trim.scenarioName).toContain("减仓");
  });

  it("无持仓时创建 trim 计划返回 400", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    const res = await ctx.app.request("/api/plans/preview", authedJson(cookie, trimPlan()));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toContain("无持仓");
  });
});

describe("观察窗口 watchlist", () => {
  it("添加时用报价初始化观察高点；重复添加 409", async () => {
    const ctx = createTestApp(590);
    const { cookie } = await registerAndLogin(ctx);
    const created = await ctx.app.request("/api/watchlist", authedJson(cookie, { market: "US", symbol: "VOO" }));
    expect(created.status).toBe(201);
    const body = (await created.json()) as any;
    expect(body.refHigh).toBe(590);
    expect(body.refHighDate).toBeTruthy();

    const dup = await ctx.app.request("/api/watchlist", authedJson(cookie, { market: "US", symbol: "voo" }));
    expect(dup.status).toBe(409);
  });

  it("手填 ref_high 优先于报价；PATCH 可重置", async () => {
    const ctx = createTestApp(590);
    const { cookie } = await registerAndLogin(ctx);
    const created = await ctx.app.request("/api/watchlist", authedJson(cookie, { market: "US", symbol: "QQQM", refHigh: 300 }));
    const body = (await created.json()) as any;
    expect(body.refHigh).toBe(300);
    const patched = await ctx.app.request(`/api/watchlist/${body.id}`, authedJson(cookie, { refHigh: 650 }, "PATCH"));
    expect(((await patched.json()) as any).refHigh).toBe(650);
  });

  it("refresh 棘轮：现价高于高点则上调，低于则不动并给出回撤", async () => {
    const ctx = createTestApp(600);
    const { cookie } = await registerAndLogin(ctx);
    // 手填高点 590 < 现价 600 → 棘轮上调至 600，回撤 0
    await ctx.app.request("/api/watchlist", authedJson(cookie, { market: "US", symbol: "VOO", refHigh: 590 }));
    let refreshed = (await (await ctx.app.request("/api/watchlist/refresh", authedJson(cookie, {}))).json()) as any[];
    expect(refreshed[0].refHigh).toBe(600);
    expect(refreshed[0].drawdownFromHigh).toBeCloseTo(0, 6);

    // 手动把高点重置为 750 > 现价 600 → 不动，回撤 = 600/750 − 1 = −20%
    await ctx.app.request(`/api/watchlist/${refreshed[0].id}`, authedJson(cookie, { refHigh: 750 }, "PATCH"));
    refreshed = (await (await ctx.app.request("/api/watchlist/refresh", authedJson(cookie, {}))).json()) as any[];
    expect(refreshed[0].refHigh).toBe(750);
    expect(refreshed[0].drawdownFromHigh).toBeCloseTo(-0.2, 4);
  });

  it("报价失败降级：现价与回撤为 null，不抛错", async () => {
    // 自建 ctx：HK 报价失败、US 正常
    const db = openDatabase(":memory:");
    const sentCodes: Array<{ to: string; code: string }> = [];
    const mailer: Mailer = { async sendCode(to, code) { sentCodes.push({ to, code }); } };
    const quoteFetcher: QuoteFetcher = async (_symbol, market) => (market === "HK" ? null : { price: 100, currency: "USD" });
    const app = createApp({ db, config: loadConfig({} as NodeJS.ProcessEnv), mailer, quoteFetcher, secureCookie: false });
    const ctx = { app, db, sentCodes, quoteCalls: [] } as TestContext;
    const { cookie } = await registerAndLogin(ctx);
    await ctx.app.request("/api/watchlist", authedJson(cookie, { market: "US", symbol: "VOO" }));
    await ctx.app.request("/api/watchlist", authedJson(cookie, { market: "HK", symbol: "00700", refHigh: 500 }));
    const refreshed = (await (await ctx.app.request("/api/watchlist/refresh", authedJson(cookie, {}))).json()) as any[];
    const hk = refreshed.find((r) => r.symbol === "00700");
    const us = refreshed.find((r) => r.symbol === "VOO");
    expect(hk.price).toBeNull();
    expect(hk.drawdownFromHigh).toBeNull();
    expect(hk.refHigh).toBe(500);
    expect(us.price).toBe(100);
  });

  it("删除后列表为空", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    const created = await ctx.app.request("/api/watchlist", authedJson(cookie, { market: "US", symbol: "VOO" }));
    const { id } = (await created.json()) as any;
    const removed = await ctx.app.request(`/api/watchlist/${id}`, { method: "DELETE", headers: { Cookie: cookie } });
    expect(removed.status).toBe(200);
    const list = (await (await ctx.app.request("/api/watchlist", { headers: { Cookie: cookie } })).json()) as any[];
    expect(list).toEqual([]);
  });
});
