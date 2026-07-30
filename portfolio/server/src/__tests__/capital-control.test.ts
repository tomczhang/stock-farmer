import { describe, expect, it } from "vitest";
import { authedJson, createTestApp, registerAndLogin } from "./helpers.test.js";

const BASE_STATEMENT = {
  broker: "ibkr",
  fileName: "activity.pdf",
  asOf: "2026-07-20",
  positions: [
    {
      broker: "ibkr",
      market: "US",
      currency: "USD",
      symbol: "AAPL",
      name: "Apple",
      quantity: 100,
      marketValue: 20_000,
      costBasis: 18_000,
    },
  ],
  cashBalances: [{ broker: "ibkr", currency: "USD", amount: 5_000 }],
};

async function summary(ctx: ReturnType<typeof createTestApp>, cookie: string) {
  return (await (
    await ctx.app.request("/api/portfolio/summary?display=USD", { headers: { Cookie: cookie } })
  ).json()) as any;
}

describe("资本、现金流与盈亏口径", () => {
  it("迁移框架在全新数据库上幂等建立 v1/v2/v3", () => {
    const ctx = createTestApp();
    const versions = ctx.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>;
    expect(versions.map((row) => row.version)).toEqual([1, 2, 3]);
    expect(ctx.db.prepare("PRAGMA table_info(capital_events)").all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "bucket" })]),
    );
    expect(ctx.db.prepare("PRAGMA table_info(pyramid_plans)").all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "estimated_fee", dflt_value: "0" })]),
    );
  });

  it("只有资本事件改变净投入，反复买卖与收益费用不改变", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    await ctx.app.request("/api/statements", authedJson(cookie, BASE_STATEMENT));
    await ctx.app.request(
      "/api/capital-events",
      authedJson(cookie, {
        type: "cash_in",
        eventDate: "2026-01-01",
        currency: "USD",
        amount: 10_000,
      }),
    );
    await ctx.app.request(
      "/api/trades",
      authedJson(cookie, {
        broker: "ibkr", market: "US", currency: "USD", symbol: "AAPL",
        side: "buy", tradeDate: "2026-07-21", quantity: 5, price: 200, fee: 1,
      }),
    );
    await ctx.app.request(
      "/api/trades",
      authedJson(cookie, {
        broker: "ibkr", market: "US", currency: "USD", symbol: "AAPL",
        side: "sell", tradeDate: "2026-07-22", quantity: 5, price: 220, fee: 1,
      }),
    );
    await ctx.app.request(
      "/api/cash-flow-events",
      authedJson(cookie, {
        type: "dividend", eventDate: "2026-07-23", market: "US", symbol: "AAPL",
        currency: "USD", grossAmount: 100, taxAmount: 10, feeAmount: 2,
      }),
    );
    expect((await summary(ctx, cookie)).costs.externalNetInvested).toBe(10_000);

    await ctx.app.request(
      "/api/capital-events",
      authedJson(cookie, {
        type: "transfer_in", eventDate: "2026-07-24", broker: "ibkr", market: "US", symbol: "MSFT",
        currency: "USD", quantity: 100, unitCost: 25,
      }),
    );
    await ctx.app.request(
      "/api/capital-events",
      authedJson(cookie, { type: "cash_out", eventDate: "2026-07-24", currency: "USD", amount: 1_000 }),
    );
    expect((await summary(ctx, cookie)).costs.externalNetInvested).toBe(11_500);
  });

  it("整体与单股盈亏分解，未归属融资费仅影响整体", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    await ctx.app.request("/api/statements", authedJson(cookie, BASE_STATEMENT));
    await ctx.app.request(
      "/api/capital-events",
      authedJson(cookie, { type: "cash_in", eventDate: "2026-01-01", currency: "USD", amount: 10_000 }),
    );
    const events = [
      { type: "realized_gain", grossAmount: 500, market: "US", symbol: "AAPL" },
      { type: "dividend", grossAmount: 100, taxAmount: 10, feeAmount: 2, market: "US", symbol: "AAPL" },
      { type: "trade_fee", grossAmount: 5, market: "US", symbol: "AAPL" },
      { type: "financing_fee", grossAmount: 10 },
      { type: "financing_fee", grossAmount: 3, market: "US", symbol: "AAPL" },
    ];
    for (const event of events) {
      const response = await ctx.app.request(
        "/api/cash-flow-events",
        authedJson(cookie, { ...event, eventDate: "2026-07-23", currency: "USD" }),
      );
      expect(response.status).toBe(201);
    }
    const result = await summary(ctx, cookie);
    expect(result.pnl).toMatchObject({
      realizedCapitalGain: 500,
      unrealizedCapitalGain: 2_000,
      dividendsNet: 88,
      tradingFees: 5,
      financingFees: 13,
      explainedTotal: 2_570,
      economicTotal: 15_000,
      unexplained: 12_430,
    });
    const aapl = result.instruments.find((row: any) => row.symbol === "AAPL");
    expect(aapl.pnl.financingFees).toBe(3);
    expect(aapl.pnl.explainedTotal).toBe(2_580);
    // 无标的级资本事件（场内现金买入）时，外部净投入默认 0 且视为完整，不再提示待补录
    expect(aapl).toMatchObject({
      externalNetInvested: 0,
      knownExternalNetInvested: 0,
      capitalCoverage: { status: "complete", missing: [] },
    });

    const flows = (await (
      await ctx.app.request("/api/cash-flows?display=USD&category=realized_gain", { headers: { Cookie: cookie } })
    ).json()) as any;
    expect(flows.display).toBe("USD");
    expect(flows.items).toHaveLength(1);
    expect(flows.items[0]).toMatchObject({ category: "realized_gain", pnlImpact: 500, pnlImpactUsd: 500 });
  });

  it("同一标的跨券商时只在 instrument 层呈现收益与外部投入，不对券商行做推测分摊", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    const statement = (broker: string, costBasis: number) => ({
      ...BASE_STATEMENT,
      broker,
      fileName: `${broker}.pdf`,
      positions: [{ ...BASE_STATEMENT.positions[0], broker, quantity: 1, marketValue: 100, costBasis }],
      cashBalances: [],
    });
    await ctx.app.request("/api/statements", authedJson(cookie, statement("b1", 80)));
    await ctx.app.request("/api/statements", authedJson(cookie, statement("b2", 90)));
    await ctx.app.request(
      "/api/cash-flow-events",
      authedJson(cookie, {
        type: "dividend", eventDate: "2026-07-23", market: "US", symbol: "AAPL",
        currency: "USD", grossAmount: 10,
      }),
    );
    await ctx.app.request(
      "/api/capital-events",
      authedJson(cookie, {
        type: "transfer_in", eventDate: "2026-07-23", market: "US", symbol: "AAPL",
        currency: "USD", quantity: 1, unitCost: 100,
      }),
    );
    const result = await summary(ctx, cookie);
    expect(result.positions).toHaveLength(2);
    expect(result.instruments).toHaveLength(1);
    expect(result.instruments[0]).toMatchObject({
      key: "US:AAPL",
      market: "US",
      symbol: "AAPL",
      brokers: ["b1", "b2"],
      positionCount: 2,
      quantity: 2,
      marketValueDisplay: 200,
      bookCostDisplay: 170,
      gainLossDisplay: 30,
      externalNetInvested: 100,
      knownExternalNetInvested: 100,
      externalNetInvestedScope: "instrument_direct_events",
      pnl: { dividendsNet: 10, explainedTotal: 40, scope: "instrument" },
    });
    expect(result.pnl.dividendsNet).toBe(10);
    expect(result.radar.find((item: any) => item.name === "个股分散度").value).toBe(0);
    for (const position of result.positions) {
      expect(position).toMatchObject({
        instrumentKey: "US:AAPL",
        externalNetInvested: null,
        knownExternalNetInvested: null,
        externalNetInvestedScope: "instrument_only",
        pnl: {
          dividendsNet: null,
          explainedTotal: null,
          scope: "broker_position_only",
          instrumentKey: "US:AAPL",
        },
      });
    }
  });

  it("历史任一持仓成本未知时不把未知成本当 0", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    await ctx.app.request(
      "/api/statements",
      authedJson(cookie, {
        ...BASE_STATEMENT,
        positions: [
          BASE_STATEMENT.positions[0],
          { ...BASE_STATEMENT.positions[0], symbol: "MSFT", name: "Microsoft", marketValue: 10_000, costBasis: null },
        ],
      }),
    );
    const result = await summary(ctx, cookie);
    const point = result.history.find((item: any) => item.month === "2026-07");
    expect(point).toMatchObject({
      valueDisplay: 30_000,
      knownCostDisplay: 18_000,
      costDisplay: null,
      gainLossDisplay: null,
      coverage: { status: "partial", ratio: 0.5 },
    });
    expect(point.coverage.missing).toContain("book_cost:US:MSFT");
  });

  it("现金流汇总按交易毛额统计买卖，手续费单列，净现金仍按净额", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    await ctx.app.request(
      "/api/trades",
      authedJson(cookie, {
        broker: "ibkr", market: "US", currency: "USD", symbol: "AAPL", side: "buy",
        tradeDate: "2026-07-21", quantity: 1, price: 100, fee: 2,
      }),
    );
    await ctx.app.request(
      "/api/trades",
      authedJson(cookie, {
        broker: "ibkr", market: "US", currency: "USD", symbol: "AAPL", side: "sell",
        tradeDate: "2026-07-22", quantity: 1, price: 150, fee: 3,
      }),
    );
    const flows = (await (
      await ctx.app.request("/api/cash-flows?display=USD", { headers: { Cookie: cookie } })
    ).json()) as any;
    expect(flows.summaryUsd).toMatchObject({ buy: 100, sell: 150, fees: 5, netCash: 45 });
    expect(flows.summary).toMatchObject({ buy: 100, sell: 150, fees: 5, netCash: 45 });
  });

  it("月结单结构化事件幂等导入，未确认转仓不形成资本事件", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    const payload = {
      ...BASE_STATEMENT,
      tradeActivities: [
        {
          id: "trade-1", broker: "ibkr", date: "2026-07-01", market: "US", currency: "USD",
          symbol: "AAPL", securityName: "Apple", side: "buy", quantity: 1, unitPrice: 190,
          grossAmount: 190, fee: 1, amount: 191, source: "activity.pdf",
        },
        {
          id: "transfer-unconfirmed", broker: "ibkr", date: "2026-07-02", market: "US", currency: "USD",
          symbol: "MSFT", securityName: "Microsoft", side: "transfer_in", quantity: 10, unitPrice: 100,
          amount: 1_000, source: "activity.pdf", capitalConfirmed: false,
        },
        {
          id: "transfer-confirmed", broker: "ibkr", date: "2026-07-03", market: "US", currency: "USD",
          symbol: "MSFT", securityName: "Microsoft", side: "transfer_in", quantity: 10, unitPrice: 100,
          amount: 1_000, source: "activity.pdf", capitalConfirmed: true,
        },
      ],
      realizedTrades: [
        {
          id: "realized-1", broker: "ibkr", sellDate: "2026-07-04", market: "US", currency: "USD",
          symbol: "AAPL", securityName: "Apple", proceeds: 300, costBasis: 250, gainLoss: 50, source: "activity.pdf",
        },
      ],
      dividends: [
        {
          id: "dividend-1", broker: "ibkr", date: "2026-07-05", market: "US", currency: "USD",
          symbol: "AAPL", securityName: "Apple", grossAmount: 20, taxWithheld: 2, fee: 0, source: "activity.pdf",
        },
      ],
    };
    expect((await ctx.app.request("/api/statements", authedJson(cookie, payload))).status).toBe(201);
    expect((await ctx.app.request("/api/statements", authedJson(cookie, payload))).status).toBe(201);
    const capital = (await (
      await ctx.app.request("/api/capital-events", { headers: { Cookie: cookie } })
    ).json()) as any[];
    const cashEvents = (await (
      await ctx.app.request("/api/cash-flow-events", { headers: { Cookie: cookie } })
    ).json()) as any[];
    const trades = (await (
      await ctx.app.request("/api/trades", { headers: { Cookie: cookie } })
    ).json()) as any[];
    expect(capital).toHaveLength(1);
    expect(capital[0].capitalAmount).toBe(1_000);
    expect(cashEvents).toHaveLength(2);
    expect(trades).toHaveLength(1);
  });
});

describe("季度仓预算与安全加仓", () => {
  it("首次设定加一次调整，卖出净回款与股息净额恢复且跨季度连续", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    await ctx.app.request("/api/statements", authedJson(cookie, BASE_STATEMENT));
    await ctx.app.request("/api/buckets", authedJson(cookie, { market: "US", symbol: "AAPL", bucket: "aggressive" }, "PUT"));
    const set = (limitAmount: number, quarter = "2026-Q3") =>
      ctx.app.request("/api/bucket-budgets", authedJson(cookie, { bucket: "aggressive", quarter, limitAmount, currency: "USD" }, "PUT"));
    expect((await set(10_000)).status).toBe(200);
    expect((await set(12_000)).status).toBe(200);
    const rejected = await set(13_000);
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ nextAdjustableQuarter: "2026-Q4" });

    await ctx.app.request(
      "/api/trades",
      authedJson(cookie, {
        broker: "ibkr", market: "US", currency: "USD", symbol: "AAPL", side: "buy",
        tradeDate: "2026-07-21", quantity: 10, price: 300, fee: 10,
      }),
    );
    await ctx.app.request(
      "/api/trades",
      authedJson(cookie, {
        broker: "ibkr", market: "US", currency: "USD", symbol: "AAPL", side: "sell",
        tradeDate: "2026-07-22", quantity: 5, price: 200, fee: 10,
      }),
    );
    await ctx.app.request(
      "/api/cash-flow-events",
      authedJson(cookie, {
        type: "dividend", eventDate: "2026-07-23", market: "US", symbol: "AAPL", currency: "USD",
        grossAmount: 100, taxAmount: 10,
      }),
    );
    const q3 = (await (
      await ctx.app.request("/api/bucket-budgets?quarter=2026-Q3", { headers: { Cookie: cookie } })
    ).json()) as any;
    const aggressive = q3.budgets.find((row: any) => row.bucket === "aggressive");
    expect(aggressive.usedUsd).toBe(1_930); // 3010 - 990 - 90
    expect(aggressive.availableUsd).toBe(10_070);

    expect((await set(15_000, "2026-Q4")).status).toBe(200);
    const q4 = (await (
      await ctx.app.request("/api/bucket-budgets?quarter=2026-Q4", { headers: { Cookie: cookie } })
    ).json()) as any;
    expect(q4.budgets.find((row: any) => row.bucket === "aggressive").usedUsd).toBe(1_930);
  });

  it("安全金额由持仓内标的/仓集中度、现金与预算四项共同决定", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    await ctx.app.request(
      "/api/statements",
      authedJson(cookie, {
        ...BASE_STATEMENT,
        positions: [
          BASE_STATEMENT.positions[0],
          { ...BASE_STATEMENT.positions[0], symbol: "MSFT", name: "Microsoft", marketValue: 30_000, costBasis: 25_000 },
        ],
        cashBalances: [{ broker: "ibkr", currency: "USD", amount: 50_000 }],
      }),
    );
    await ctx.app.request("/api/buckets", authedJson(cookie, { market: "US", symbol: "AAPL", bucket: "aggressive" }, "PUT"));
    await ctx.app.request("/api/buckets", authedJson(cookie, { market: "US", symbol: "MSFT", bucket: "stable" }, "PUT"));
    await ctx.app.request(
      "/api/bucket-budgets",
      authedJson(cookie, { bucket: "aggressive", quarter: "2026-Q3", limitAmount: 100_000, currency: "USD" }, "PUT"),
    );
    const response = await ctx.app.request(
      "/api/portfolio/safe-add",
      authedJson(cookie, { market: "US", symbol: "AAPL", currency: "USD", candidateAmount: 12_000 }),
    );
    const result = (await response.json()) as any;
    expect(result.complete).toBe(true);
    expect(result.safeAmountUsd).toBe(10_000);
    expect(["symbol", "bucket"]).toContain(result.bottleneck);
    expect(result.rooms.symbol.currentRatio).toBeCloseTo(0.4, 5);
    expect(result.rooms.symbol.postRatio).toBeCloseTo(32 / 62, 5);
    expect(result.candidate).toMatchObject({ safe: false });
    expect(result.candidate.violations).toEqual(expect.arrayContaining(["symbol", "bucket"]));

    const missing = (await (
      await ctx.app.request(
        "/api/portfolio/safe-add",
        authedJson(cookie, { market: "US", symbol: "GOOGL", currency: "USD" }),
      )
    ).json()) as any;
    expect(missing.safeAmount).toBeNull();
    expect(missing.missing).toContain("bucket");
  });

  it("兼容旧库中文市场与仅按 symbol 保存的仓别", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    await ctx.app.request("/api/statements", authedJson(cookie, BASE_STATEMENT));
    await ctx.app.request(
      "/api/buckets",
      authedJson(cookie, { market: "US", symbol: "AAPL", bucket: "aggressive" }, "PUT"),
    );
    ctx.db.prepare("UPDATE positions SET market = '美国市场' WHERE symbol = 'AAPL'").run();
    ctx.db.prepare("DELETE FROM instrument_buckets WHERE symbol = 'AAPL'").run();
    await ctx.app.request(
      "/api/bucket-budgets",
      authedJson(cookie, { bucket: "aggressive", quarter: "2026-Q3", limitAmount: 100_000, currency: "USD" }, "PUT"),
    );

    const safe = (await (
      await ctx.app.request(
        "/api/portfolio/safe-add",
        authedJson(cookie, { market: "US", symbol: "AAPL", currency: "USD" }),
      )
    ).json()) as any;
    expect(safe.complete).toBe(true);
    expect(safe.context).toMatchObject({ currentQuantity: 100, bucket: "aggressive", symbolValueUsd: 20_000 });
    expect(safe.missing).not.toContain("bucket");

    const result = await summary(ctx, cookie);
    expect(result.positions[0]).toMatchObject({ market: "US", symbol: "AAPL" });
    const plan = (await (
      await ctx.app.request(
        "/api/plans/preview",
        authedJson(cookie, {
          symbol: "AAPL", name: "Apple", market: "US", currency: "USD",
          basePrice: 200, totalBudget: 1_000,
          tiers: [{ seq: 1, triggerType: "pct_drop", triggerValue: 10, allocType: "pct", allocValue: 100 }],
        }),
      )
    ).json()) as any;
    expect(plan.currentPosition).toMatchObject({ quantity: 100, bookCost: 18_000 });
  });
});

describe("同股加仓方案", () => {
  it("模板归一、纳入现有成本并支持同股比较，拒绝跨标的", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    await ctx.app.request(
      "/api/statements",
      authedJson(cookie, {
        ...BASE_STATEMENT,
        positions: [
          { ...BASE_STATEMENT.positions[0], symbol: "MSFT", name: "Microsoft", quantity: 100, marketValue: 10_000, costBasis: 8_000 },
          { ...BASE_STATEMENT.positions[0], symbol: "AAPL", marketValue: 30_000, costBasis: 25_000 },
        ],
        cashBalances: [{ broker: "ibkr", currency: "USD", amount: 60_000 }],
      }),
    );
    await ctx.app.request("/api/buckets", authedJson(cookie, { market: "US", symbol: "MSFT", bucket: "aggressive" }, "PUT"));
    await ctx.app.request(
      "/api/bucket-budgets",
      authedJson(cookie, { bucket: "aggressive", quarter: "2026-Q3", limitAmount: 100_000, currency: "USD" }, "PUT"),
    );
    const scenario = (name: string, weights: number[]) => ({
      symbol: "MSFT", name: "Microsoft", market: "US", currency: "USD", scenarioName: name,
      basePrice: 100, totalBudget: 10_000, templateWeights: weights,
      tiers: [10, 20, 30, 40].map((drop, index) => ({
        seq: index + 1, triggerType: "pct_drop", triggerValue: drop, allocType: "pct", allocValue: 25,
      })),
    });
    const preview = (await (
      await ctx.app.request("/api/plans/preview", authedJson(cookie, scenario("1:2:4:8", [1, 2, 4, 8])))
    ).json()) as any;
    expect(preview.totalPlanned).toBe(10_000);
    expect(preview.currentPosition).toMatchObject({ quantity: 100, bookCost: 8_000 });
    expect(preview.final.bookCost).toBe(18_000);
    expect(preview.final.avgCost).toBeGreaterThan(0);

    const compared = (await (
      await ctx.app.request(
        "/api/plans/compare",
        authedJson(cookie, { scenarios: [scenario("1:2:4:8", [1, 2, 4, 8]), scenario("1:2:3:4", [1, 2, 3, 4])] }),
      )
    ).json()) as any;
    expect(compared).toMatchObject({ market: "US", symbol: "MSFT" });
    expect(compared.scenarios).toHaveLength(2);
    expect(compared.scenarios[0].final.totalQuantity).not.toBe(compared.scenarios[1].final.totalQuantity);

    const cross = await ctx.app.request(
      "/api/plans/compare",
      authedJson(cookie, {
        scenarios: [scenario("MSFT", [1, 2, 4, 8]), { ...scenario("AAPL", [1, 2, 3, 4]), symbol: "AAPL", name: "Apple" }],
      }),
    );
    expect(cross.status).toBe(400);
  });

  it("预计交易费计入成本/现金/预算，并以活动成交计划锁避免方案重复占用", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    await ctx.app.request(
      "/api/statements",
      authedJson(cookie, {
        ...BASE_STATEMENT,
        positions: [
          BASE_STATEMENT.positions[0],
          { ...BASE_STATEMENT.positions[0], symbol: "MSFT", name: "Microsoft", marketValue: 30_000, costBasis: 25_000 },
        ],
        cashBalances: [{ broker: "ibkr", currency: "USD", amount: 50_000 }],
      }),
    );
    await ctx.app.request("/api/buckets", authedJson(cookie, { market: "US", symbol: "AAPL", bucket: "aggressive" }, "PUT"));
    await ctx.app.request("/api/buckets", authedJson(cookie, { market: "US", symbol: "MSFT", bucket: "stable" }, "PUT"));
    await ctx.app.request(
      "/api/bucket-budgets",
      authedJson(cookie, { bucket: "aggressive", quarter: "2026-Q3", limitAmount: 100_000, currency: "USD" }, "PUT"),
    );
    const planInput = (scenarioName: string, estimatedFee: number) => ({
      symbol: "AAPL", name: "Apple", market: "US", currency: "USD", scenarioName,
      basePrice: 200, totalBudget: 1_000, estimatedFee,
      tiers: [
        { seq: 1, triggerType: "pct_drop", triggerValue: 10, allocType: "pct", allocValue: 50 },
        { seq: 2, triggerType: "pct_drop", triggerValue: 20, allocType: "pct", allocValue: 50 },
      ],
    });
    const create = async (input: ReturnType<typeof planInput>) => {
      const response = await ctx.app.request("/api/plans", authedJson(cookie, input));
      expect(response.status).toBe(201);
      return (await response.json()) as any;
    };
    const first = await create(planInput("方案 A", 50));
    const second = await create(planInput("方案 B", 20));
    expect(first).toMatchObject({
      estimatedFee: 50,
      totalCashRequired: 1_050,
      final: { bookCost: 19_050, cash: 48_950, budgetAvailable: 98_950, safe: true },
    });
    expect(first.tiers[0]).toMatchObject({ estimatedFee: 25, cumulativeEstimatedFee: 25, cumulativeCashRequired: 525 });
    expect(second.final.safe).toBe(true);

    const listed = (await (
      await ctx.app.request("/api/plans", { headers: { Cookie: cookie } })
    ).json()) as any[];
    expect(listed.find((item) => item.id === first.id).estimatedFee).toBe(50);

    const update = await ctx.app.request(
      `/api/plans/${first.id}`,
      authedJson(cookie, planInput("方案 A 调整", 60), "PUT"),
    );
    expect(update.status).toBe(200);
    const updated = (await update.json()) as any;
    expect(updated).toMatchObject({ estimatedFee: 60, totalCashRequired: 1_060, final: { bookCost: 19_060 } });
    expect(updated.tiers.at(-1)).toMatchObject({ cumulativeEstimatedFee: 60, cumulativeCashRequired: 1_060 });

    const fill = (planId: number, tierId: number, filled = true) =>
      ctx.app.request(`/api/plans/${planId}/tiers/${tierId}/fill`, authedJson(cookie, { filled }, "PUT"));
    expect((await fill(first.id, updated.tiers[0].id)).status).toBe(200);
    expect((await fill(first.id, updated.tiers[1].id)).status).toBe(200); // 同一活动计划可继续执行后续档位

    const deleteLocked = await ctx.app.request(`/api/plans/${first.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(deleteLocked.status).toBe(409);
    expect(await deleteLocked.json()).toMatchObject({ error: expect.stringContaining("取消成交标记") });

    const locked = await fill(second.id, second.tiers[0].id);
    expect(locked.status).toBe(409);
    expect(await locked.json()).toMatchObject({ activePlanId: first.id });

    const editLocked = await ctx.app.request(
      `/api/plans/${first.id}`,
      authedJson(cookie, planInput("不应保存", 0), "PUT"),
    );
    expect(editLocked.status).toBe(409);
    expect(await editLocked.json()).toMatchObject({ error: expect.stringContaining("取消成交标记") });

    expect((await fill(first.id, updated.tiers[0].id, false)).status).toBe(200);
    expect((await fill(first.id, updated.tiers[1].id, false)).status).toBe(200);
    expect(
      (await ctx.app.request(`/api/plans/${first.id}`, authedJson(cookie, planInput("可再次编辑", 0), "PUT"))).status,
    ).toBe(200);
  });

  it("本金恰达无费用安全边界时，新增预计费用会使方案不安全并禁止成交", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    await ctx.app.request(
      "/api/statements",
      authedJson(cookie, {
        ...BASE_STATEMENT,
        positions: [
          { ...BASE_STATEMENT.positions[0], symbol: "AAPL", quantity: 0, marketValue: 0, costBasis: 0 },
          { ...BASE_STATEMENT.positions[0], symbol: "MSFT", name: "Microsoft", quantity: 100, marketValue: 50_000, costBasis: 40_000 },
        ],
        cashBalances: [{ broker: "ibkr", currency: "USD", amount: 50_000 }],
      }),
    );
    await ctx.app.request("/api/buckets", authedJson(cookie, { market: "US", symbol: "AAPL", bucket: "aggressive" }, "PUT"));
    await ctx.app.request("/api/buckets", authedJson(cookie, { market: "US", symbol: "MSFT", bucket: "stable" }, "PUT"));
    await ctx.app.request(
      "/api/bucket-budgets",
      authedJson(cookie, { bucket: "aggressive", quarter: "2026-Q3", limitAmount: 100_000, currency: "USD" }, "PUT"),
    );
    const input = (estimatedFee: number) => ({
      symbol: "AAPL", name: "Apple", market: "US", currency: "USD",
      basePrice: 100, totalBudget: 20_000, estimatedFee,
      tiers: [{ seq: 1, triggerType: "price", triggerValue: 100, allocType: "pct", allocValue: 100 }],
    });
    const withoutFee = (await (
      await ctx.app.request("/api/plans/preview", authedJson(cookie, input(0)))
    ).json()) as any;
    expect(withoutFee.final.safe).toBe(true);
    expect(withoutFee.final.cashRatio).toBeCloseTo(0.3, 8);

    const withFee = (await (
      await ctx.app.request("/api/plans", authedJson(cookie, input(1)))
    ).json()) as any;
    expect(withFee.final.safe).toBe(false);
    expect(withFee.final.violations).toContain("cash");
    expect(withFee.final.remainingCashUsd).toBe(29_999);
    const fill = await ctx.app.request(
      `/api/plans/${withFee.id}/tiers/${withFee.tiers[0].id}/fill`,
      authedJson(cookie, { filled: true }, "PUT"),
    );
    expect(fill.status).toBe(409);
    expect(await fill.json()).toMatchObject({ violations: expect.arrayContaining(["cash"]) });
  });
});
