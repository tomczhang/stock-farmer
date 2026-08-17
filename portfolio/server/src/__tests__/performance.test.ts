import { describe, expect, it } from "vitest";
import { authedJson, createTestApp, registerAndLogin, type TestContext } from "./helpers.test.js";

/** 上传一份月结单快照（简化：单券商、USD、若干持仓 + 现金）。 */
async function uploadStatement(
  ctx: TestContext,
  cookie: string,
  opts: {
    broker?: string;
    asOf: string;
    positions?: Array<{ symbol: string; marketValue: number; market?: string; quantity?: number }>;
    cash?: number;
  },
) {
  const res = await ctx.app.request(
    "/api/statements",
    authedJson(cookie, {
      broker: opts.broker ?? "IBKR",
      fileName: `stmt-${opts.asOf}.pdf`,
      asOf: opts.asOf,
      positions: (opts.positions ?? []).map((p) => ({
        broker: opts.broker ?? "IBKR",
        market: p.market ?? "US",
        currency: "USD",
        symbol: p.symbol,
        name: p.symbol,
        quantity: p.quantity ?? 1,
        marketValue: p.marketValue,
        costBasis: null,
      })),
      cashBalances: opts.cash != null ? [{ broker: opts.broker ?? "IBKR", currency: "USD", amount: opts.cash }] : [],
    }),
  );
  expect(res.status).toBe(201);
}

async function addCapital(ctx: TestContext, cookie: string, type: string, eventDate: string, amount: number) {
  const res = await ctx.app.request(
    "/api/capital-events",
    authedJson(cookie, { type, eventDate, currency: "USD", amount }),
  );
  expect(res.status).toBe(201);
}

async function getPerformance(ctx: TestContext, cookie: string, query = "") {
  const res = await ctx.app.request(`/api/portfolio/performance${query}`, { headers: { Cookie: cookie } });
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

describe("绩效：单位净值与衍生指标", () => {
  it("未登录返回 401", async () => {
    const ctx = createTestApp();
    const res = await ctx.app.request("/api/portfolio/performance");
    expect(res.status).toBe(401);
  });

  it("无月结单时返回空序列与 null KPI", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    const body = await getPerformance(ctx, cookie);
    expect(body.months).toEqual([]);
    expect(body.kpi.cumulativeReturn).toBeNull();
    expect(body.kpi.maxDrawdown).toBeNull();
  });

  it("入金只改份额不改净值；无出入金月份净值随资产变动", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    // 首月 V0 = 100,000
    await uploadStatement(ctx, cookie, { asOf: "2026-01-31", positions: [{ symbol: "VOO", marketValue: 90000 }], cash: 10000 });
    // 次月入金 20,000 且无涨跌：V1 = 120,000 → NAV 不变
    await addCapital(ctx, cookie, "cash_in", "2026-02-10", 20000);
    await uploadStatement(ctx, cookie, { asOf: "2026-02-28", positions: [{ symbol: "VOO", marketValue: 90000 }], cash: 30000 });
    // 第三月无出入金，资产 +5%：V2 = 126,000 → NAV ×1.05
    await uploadStatement(ctx, cookie, { asOf: "2026-03-31", positions: [{ symbol: "VOO", marketValue: 94500 }], cash: 31500 });

    const body = await getPerformance(ctx, cookie);
    const [m1, m2, m3] = body.months;
    expect(m1.nav).toBeCloseTo(1, 9);
    expect(m2.nav).toBeCloseTo(1, 9);
    expect(m2.pnlDisplay).toBeCloseTo(0, 2);
    expect(m3.nav).toBeCloseTo(1.05, 9);
    expect(m3.pnlDisplay).toBeCloseTo(6000, 2);
    expect(body.kpi.cumulativeReturn).toBeCloseTo(0.05, 6);
    expect(body.kpi.cumulativeInDisplay).toBeCloseTo(20000, 2);
    // 累计净投入序列：1 月无事件为 0，2 月入金后与 3 月持平
    expect(m1.investedDisplay).toBeCloseTo(0, 2);
    expect(m2.investedDisplay).toBeCloseTo(20000, 2);
    expect(m3.investedDisplay).toBeCloseTo(20000, 2);
  });

  it("累计净投入基线：首个快照月之前的存量事件计入首月", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    // 快照前的存量入金（基线）
    await addCapital(ctx, cookie, "cash_in", "2025-11-20", 80000);
    await uploadStatement(ctx, cookie, { asOf: "2026-01-31", cash: 100000 });
    await addCapital(ctx, cookie, "cash_in", "2026-02-10", 5000);
    await uploadStatement(ctx, cookie, { asOf: "2026-02-28", cash: 105000 });
    const body = await getPerformance(ctx, cookie);
    expect(body.months[0].investedDisplay).toBeCloseTo(80000, 2);
    expect(body.months[1].investedDisplay).toBeCloseTo(85000, 2);
  });

  it("大额出入金月份返回 warning", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    await uploadStatement(ctx, cookie, { asOf: "2026-01-31", cash: 100000 });
    await addCapital(ctx, cookie, "cash_in", "2026-02-05", 50000); // 50% > 20%
    await uploadStatement(ctx, cookie, { asOf: "2026-02-28", cash: 150000 });
    const body = await getPerformance(ctx, cookie);
    expect(body.months[1].warning).toContain("大额出入金");
  });

  it("最大回撤：净值 1 → 1.2 → 0.9 → 1.1 得 -25%", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    await uploadStatement(ctx, cookie, { asOf: "2026-01-31", cash: 100000 });
    await uploadStatement(ctx, cookie, { asOf: "2026-02-28", cash: 120000 });
    await uploadStatement(ctx, cookie, { asOf: "2026-03-31", cash: 90000 });
    await uploadStatement(ctx, cookie, { asOf: "2026-04-30", cash: 110000 });
    const body = await getPerformance(ctx, cookie);
    expect(body.kpi.maxDrawdown).toBeCloseTo(-0.25, 6);
    expect(body.kpi.annualizedPartial).toBe(true); // 仅 3 个月跨度
  });

  it("券商缺月 carry-forward：序列不塌陷且标记 carried", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    await uploadStatement(ctx, cookie, { broker: "IBKR", asOf: "2026-06-30", cash: 100000 });
    await uploadStatement(ctx, cookie, { broker: "Futu", asOf: "2026-06-30", cash: 50000 });
    // 7 月只有 Futu
    await uploadStatement(ctx, cookie, { broker: "Futu", asOf: "2026-07-31", cash: 50000 });
    // 8 月两家齐
    await uploadStatement(ctx, cookie, { broker: "IBKR", asOf: "2026-08-31", cash: 100000 });
    await uploadStatement(ctx, cookie, { broker: "Futu", asOf: "2026-08-31", cash: 50000 });
    const body = await getPerformance(ctx, cookie);
    const july = body.months.find((m: any) => m.month === "2026-07");
    expect(july.netAssetsDisplay).toBeCloseTo(150000, 2);
    expect(july.carried).toBe(true);
    expect(july.carriedBrokers).toEqual(["IBKR"]);
    expect(body.months.find((m: any) => m.month === "2026-08").carried).toBe(false);
  });

  it("scope=self 剔除授予仓持仓与其转仓事件", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    // 标注 BABA 为授予仓
    await ctx.app.request("/api/buckets", authedJson(cookie, { symbol: "BABA", bucket: "grant", market: "US" }, "PUT"));
    await uploadStatement(ctx, cookie, {
      asOf: "2026-01-31",
      positions: [
        { symbol: "VOO", marketValue: 100000 },
        { symbol: "BABA", marketValue: 200000 },
      ],
      cash: 50000,
    });
    // BABA 授予转仓入（不应计入 self 口径外部流入）
    const res = await ctx.app.request(
      "/api/capital-events",
      authedJson(cookie, {
        type: "transfer_in",
        eventDate: "2026-02-03",
        currency: "USD",
        market: "US",
        symbol: "BABA",
        quantity: 100,
        unitCost: 100,
      }),
    );
    expect(res.status).toBe(201);
    await uploadStatement(ctx, cookie, {
      asOf: "2026-02-28",
      positions: [
        { symbol: "VOO", marketValue: 100000 },
        { symbol: "BABA", marketValue: 210000 },
      ],
      cash: 50000,
    });

    const self = await getPerformance(ctx, cookie, "?scope=self");
    expect(self.months[0].netAssetsDisplay).toBeCloseTo(150000, 2);
    expect(self.months[1].flowDisplay).toBeCloseTo(0, 2); // grant 转仓被剔除
    expect(self.months[1].nav).toBeCloseTo(1, 9); // self 口径资产无变化

    const all = await getPerformance(ctx, cookie, "?scope=all");
    expect(all.months[0].netAssetsDisplay).toBeCloseTo(350000, 2);
    expect(all.months[1].flowDisplay).toBeCloseTo(10000, 2);
  });

  it("display=CNY 只换算金额字段，净值与收益率不变", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    await uploadStatement(ctx, cookie, { asOf: "2026-01-31", cash: 100000 });
    await uploadStatement(ctx, cookie, { asOf: "2026-02-28", cash: 105000 });
    const usd = await getPerformance(ctx, cookie, "?display=USD");
    const cny = await getPerformance(ctx, cookie, "?display=CNY");
    expect(cny.months[0].nav).toBe(usd.months[0].nav);
    expect(cny.kpi.cumulativeReturn).toBe(usd.kpi.cumulativeReturn);
    expect(cny.months[0].netAssetsDisplay).toBeCloseTo(100000 / 0.1395, 0);
  });
});

describe("交易原因字段", () => {
  it("录入带 reason 的交易并往返读取；历史交易 reason 为 null", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    const created = await ctx.app.request(
      "/api/trades",
      authedJson(cookie, {
        broker: "IBKR",
        market: "US",
        currency: "USD",
        symbol: "VOO",
        side: "buy",
        tradeDate: "2026-08-14",
        quantity: 5,
        price: 590,
        reason: "阶梯-10%触发加速",
      }),
    );
    expect(created.status).toBe(201);
    const noReason = await ctx.app.request(
      "/api/trades",
      authedJson(cookie, {
        broker: "IBKR",
        market: "US",
        currency: "USD",
        symbol: "QQQM",
        side: "buy",
        tradeDate: "2026-08-13",
        quantity: 11,
        price: 238,
      }),
    );
    expect(noReason.status).toBe(201);

    const list = (await (await ctx.app.request("/api/trades", { headers: { Cookie: cookie } })).json()) as any[];
    expect(list.find((t) => t.symbol === "VOO").reason).toBe("阶梯-10%触发加速");
    expect(list.find((t) => t.symbol === "QQQM").reason).toBeNull();
  });
});
