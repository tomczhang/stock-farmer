import { describe, expect, it } from "vitest";
import { authedJson, createTestApp, registerAndLogin, type TestContext } from "./helpers.test.js";

/** 直接向 trades 表注入带已实现盈亏的交易（模拟券商月结单导入结果）。 */
function insertTrade(
  ctx: TestContext,
  opts: {
    symbol: string;
    side: "buy" | "sell";
    tradeDate: string;
    quantity: number;
    price?: number;
    fee?: number;
    realized?: number | null;
    bucket?: string | null;
    reason?: string | null;
  },
) {
  ctx.db
    .prepare(
      `INSERT INTO trades (user_id, broker, market, currency, symbol, name, side, trade_date, quantity, price, fee, gross_amount, bucket, fx_to_usd, realized_gain_loss, reason)
       VALUES (1, 'IBKR', 'US', 'USD', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(
      opts.symbol,
      opts.symbol,
      opts.side,
      opts.tradeDate,
      opts.quantity,
      opts.price ?? 100,
      opts.fee ?? 0,
      opts.quantity * (opts.price ?? 100),
      opts.bucket ?? null,
      opts.realized ?? null,
      opts.reason ?? null,
    );
}

async function getJson(ctx: TestContext, cookie: string, path: string) {
  const res = await ctx.app.request(path, { headers: { Cookie: cookie } });
  expect(res.status).toBe(200);
  return (await res.json()) as any;
}

describe("已平仓交易统计", () => {
  it("无平仓交易返回全零统计", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    const body = await getJson(ctx, cookie, "/api/trades/closed-stats");
    expect(body.closedCount).toBe(0);
    expect(body.winRate).toBeNull();
    expect(body.histogram.buckets).toEqual([]);
  });

  it("基础统计：+300/+100/−200 → 胜率 2/3、盈亏比 1.0", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    insertTrade(ctx, { symbol: "AAPL", side: "sell", tradeDate: "2026-03-01", quantity: 1, realized: 300 });
    insertTrade(ctx, { symbol: "MSFT", side: "sell", tradeDate: "2026-04-01", quantity: 1, realized: 100 });
    insertTrade(ctx, { symbol: "NVDA", side: "sell", tradeDate: "2026-05-01", quantity: 1, realized: -200 });
    const body = await getJson(ctx, cookie, "/api/trades/closed-stats");
    expect(body.closedCount).toBe(3);
    expect(body.winCount).toBe(2);
    expect(body.lossCount).toBe(1);
    expect(body.winRate).toBeCloseTo(2 / 3, 4);
    expect(body.avgWinDisplay).toBeCloseTo(200, 2);
    expect(body.avgLossDisplay).toBeCloseTo(-200, 2);
    expect(body.payoffRatio).toBeCloseTo(1.0, 4);
    expect(body.maxWinDisplay).toBeCloseTo(300, 2);
    expect(body.maxLossDisplay).toBeCloseTo(-200, 2);
  });

  it("realized 缺失的卖出单进 unknownCount，不影响胜率", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    insertTrade(ctx, { symbol: "AAPL", side: "sell", tradeDate: "2026-03-01", quantity: 1, realized: 300 });
    insertTrade(ctx, { symbol: "TSLA", side: "sell", tradeDate: "2026-03-02", quantity: 1, realized: null });
    const body = await getJson(ctx, cookie, "/api/trades/closed-stats");
    expect(body.closedCount).toBe(1);
    expect(body.unknownCount).toBe(1);
    expect(body.winRate).toBe(1);
  });

  it("直方图 11 桶且总数守恒（不含 unknown）", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    for (const pnl of [500, 300, 120, 40, -30, -90, -260, 900, -700]) {
      insertTrade(ctx, { symbol: "X", side: "sell", tradeDate: "2026-03-01", quantity: 1, realized: pnl });
    }
    insertTrade(ctx, { symbol: "Y", side: "sell", tradeDate: "2026-03-02", quantity: 1, realized: null });
    const body = await getJson(ctx, cookie, "/api/trades/closed-stats");
    expect(body.histogram.buckets).toHaveLength(11);
    const total = body.histogram.buckets.reduce((sum: number, b: any) => sum + b.count, 0);
    expect(total).toBe(9);
  });

  it("持有时长：01-10 买入、03-10 卖出 = 59 天；转仓入无买入记录为 unknown", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    insertTrade(ctx, { symbol: "VOO", side: "buy", tradeDate: "2026-01-10", quantity: 10 });
    insertTrade(ctx, { symbol: "VOO", side: "sell", tradeDate: "2026-03-10", quantity: 10, realized: 50 });
    // 无买入记录的卖出（转仓入后卖出）
    insertTrade(ctx, { symbol: "BABA", side: "sell", tradeDate: "2026-03-15", quantity: 5, realized: 80 });
    const body = await getJson(ctx, cookie, "/api/trades/closed-stats");
    expect(body.avgHoldingDays).toBeCloseTo(59, 1); // 仅 VOO 计入平均
  });

  it("openHoldingAges 返回仍持有标的的首次买入日", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    insertTrade(ctx, { symbol: "QQQM", side: "buy", tradeDate: "2026-01-14", quantity: 2 });
    insertTrade(ctx, { symbol: "QQQM", side: "buy", tradeDate: "2026-02-18", quantity: 2 });
    insertTrade(ctx, { symbol: "SOLD", side: "buy", tradeDate: "2026-01-01", quantity: 1 });
    insertTrade(ctx, { symbol: "SOLD", side: "sell", tradeDate: "2026-02-01", quantity: 1, realized: 10 });
    const body = await getJson(ctx, cookie, "/api/trades/closed-stats");
    const qqqm = body.openHoldingAges.find((h: any) => h.key === "US:QQQM");
    expect(qqqm.firstBuyDate).toBe("2026-01-14");
    expect(body.openHoldingAges.find((h: any) => h.key === "US:SOLD")).toBeUndefined();
  });
});

describe("月度复盘", () => {
  async function uploadCash(ctx: TestContext, cookie: string, asOf: string, cash: number, stockValue = 0) {
    const res = await ctx.app.request(
      "/api/statements",
      authedJson(cookie, {
        broker: "IBKR",
        fileName: `stmt-${asOf}.pdf`,
        asOf,
        positions: stockValue > 0
          ? [{ broker: "IBKR", market: "US", currency: "USD", symbol: "VOO", name: "VOO", quantity: 1, marketValue: stockValue, costBasis: null }]
          : [],
        cashBalances: [{ broker: "IBKR", currency: "USD", amount: cash }],
      }),
    );
    expect(res.status).toBe(201);
  }

  it("月份格式非法返回 400", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    const res = await ctx.app.request("/api/reviews/2026-13", { headers: { Cookie: cookie } });
    expect(res.status).toBe(400);
  });

  it("无数据月份自动块为 null，手填块照常返回", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    const body = await getJson(ctx, cookie, "/api/reviews/2026-01");
    expect(body.auto).toBeNull();
    expect(body.manual.attribution).toBe("");
  });

  it("自动块：资产变化、当月盈亏、TOP3 含 reason、纪律审计", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    // 现金底线 30%（默认）：8 月末现金 40,000 / 总 100,000 = 40% 达标
    await uploadCash(ctx, cookie, "2026-07-31", 50000, 48000);
    await uploadCash(ctx, cookie, "2026-08-31", 40000, 60000);
    // 稳健仓定投买入 + 平仓交易
    insertTrade(ctx, { symbol: "VOO", side: "buy", tradeDate: "2026-08-30", quantity: 5, bucket: "stable" });
    insertTrade(ctx, { symbol: "AAPL", side: "sell", tradeDate: "2026-08-10", quantity: 1, realized: 500, reason: "达到目标价" });
    insertTrade(ctx, { symbol: "MSFT", side: "sell", tradeDate: "2026-08-12", quantity: 1, realized: -120, reason: "止损" });

    const body = await getJson(ctx, cookie, "/api/reviews/2026-08");
    expect(body.auto.startAssetsDisplay).toBeCloseTo(98000, 2);
    expect(body.auto.endAssetsDisplay).toBeCloseTo(100000, 2);
    expect(body.auto.pnlDisplay).toBeCloseTo(2000, 2);
    expect(body.auto.topWins[0].reason).toBe("达到目标价");
    expect(body.auto.topLosses[0].reason).toBe("止损");
    const dca = body.auto.discipline.find((d: any) => d.key === "stable_dca");
    const floor = body.auto.discipline.find((d: any) => d.key === "cash_floor");
    expect(dca.ok).toBe(true);
    expect(floor.ok).toBe(true);
  });

  it("定投缺席时审计为 false", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    await uploadCash(ctx, cookie, "2026-08-31", 100000);
    const body = await getJson(ctx, cookie, "/api/reviews/2026-08");
    expect(body.auto.discipline.find((d: any) => d.key === "stable_dca").ok).toBe(false);
  });

  it("手填块 upsert：首存创建、再存更新", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    const put1 = await ctx.app.request(
      "/api/reviews/2026-08",
      authedJson(cookie, { attribution: "宽指定投贡献为主", mistakes: "无", improvements: "无", macroNote: "美联储按兵不动" }, "PUT"),
    );
    expect(put1.status).toBe(200);
    let body = await getJson(ctx, cookie, "/api/reviews/2026-08");
    expect(body.manual.attribution).toBe("宽指定投贡献为主");

    const put2 = await ctx.app.request(
      "/api/reviews/2026-08",
      authedJson(cookie, { attribution: "宽指定投贡献为主", mistakes: "追高一笔", improvements: "严格限价", macroNote: "" }, "PUT"),
    );
    expect(put2.status).toBe(200);
    body = await getJson(ctx, cookie, "/api/reviews/2026-08");
    expect(body.manual.mistakes).toBe("追高一笔");

    const list = await getJson(ctx, cookie, "/api/reviews");
    expect(list).toHaveLength(1);
    expect(list[0].month).toBe("2026-08");
  });
});
