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
      unrealizedGl: 3000,
    },
    {
      broker: "ibkr",
      market: "HK",
      currency: "HKD",
      symbol: "09988",
      name: "阿里巴巴-W",
      quantity: 500,
      marketValue: 59250,
      costBasis: 65000,
      unrealizedGl: -5750,
    },
  ],
  cashBalances: [
    { broker: "ibkr", currency: "USD", amount: 5000 },
    { broker: "ibkr", currency: "HKD", amount: 20000 },
  ],
};

describe("statements & summary", () => {
  it("保存快照并聚合 summary（USD 折算）", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);

    const save = await ctx.app.request("/api/statements", authedJson(cookie, STATEMENT));
    expect(save.status).toBe(201);

    const list = await ctx.app.request("/api/statements", { headers: { Cookie: cookie } });
    const rows = (await list.json()) as Array<{ broker: string; positionCount: number; cashCount: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].positionCount).toBe(2);
    expect(rows[0].cashCount).toBe(2);

    const res = await ctx.app.request("/api/portfolio/summary?display=USD", {
      headers: { Cookie: cookie },
    });
    const summary = (await res.json()) as {
      kpi: { totalAssets: number; positionsValue: number; idleCash: number; positionRatio: number };
      allocation: { byCurrency: Array<{ name: string; value: number }> };
      positions: Array<{ symbol: string }>;
      radar: Array<{ name: string; value: number }>;
    };
    // 持仓: 21000 + 59250*0.1282 = 21000 + 7595.85 = 28595.85
    expect(summary.kpi.positionsValue).toBeCloseTo(28595.85, 1);
    // 现金: 5000 + 20000*0.1282 = 7564
    expect(summary.kpi.idleCash).toBeCloseTo(7564, 1);
    expect(summary.kpi.totalAssets).toBeCloseTo(36159.85, 1);
    expect(summary.kpi.positionRatio).toBeGreaterThan(0.7);
    expect(summary.positions[0].symbol).toBe("AAPL");
    expect(summary.radar).toHaveLength(5);
  });

  it("同券商同 as_of 重复上传覆盖旧快照", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    await ctx.app.request("/api/statements", authedJson(cookie, STATEMENT));
    await ctx.app.request("/api/statements", authedJson(cookie, STATEMENT));
    const list = await ctx.app.request("/api/statements", { headers: { Cookie: cookie } });
    expect((await list.json()) as unknown[]).toHaveLength(1);
  });

  it("多券商各取最新 as_of", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    await ctx.app.request("/api/statements", authedJson(cookie, STATEMENT));
    // ibkr 更早月份的快照不应影响聚合
    await ctx.app.request(
      "/api/statements",
      authedJson(cookie, {
        ...STATEMENT,
        asOf: "2026-05-31",
        positions: [{ ...STATEMENT.positions[0], marketValue: 999999 }],
        cashBalances: [],
      }),
    );
    // futu 的最新快照应并入
    await ctx.app.request(
      "/api/statements",
      authedJson(cookie, {
        broker: "futu",
        fileName: "futu.xlsx",
        asOf: "2026-06-30",
        positions: [
          {
            broker: "futu",
            market: "US",
            currency: "USD",
            symbol: "TSLA",
            name: "Tesla",
            quantity: 10,
            marketValue: 3000,
          },
        ],
        cashBalances: [{ broker: "futu", currency: "USD", amount: 1000 }],
      }),
    );
    const res = await ctx.app.request("/api/portfolio/summary?display=USD", {
      headers: { Cookie: cookie },
    });
    const summary = (await res.json()) as {
      kpi: { positionsValue: number; idleCash: number };
      positions: Array<{ symbol: string }>;
    };
    expect(summary.positions.map((p) => p.symbol).sort()).toEqual(["09988", "AAPL", "TSLA"]);
    expect(summary.kpi.positionsValue).toBeCloseTo(28595.85 + 3000, 1);
    expect(summary.kpi.idleCash).toBeCloseTo(7564 + 1000, 1);
  });

  it("手动现金覆盖解析现金", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    await ctx.app.request("/api/statements", authedJson(cookie, STATEMENT));
    const put = await ctx.app.request(
      "/api/cash",
      authedJson(cookie, { broker: "ibkr", currency: "USD", amount: 8888 }, "PUT"),
    );
    expect(put.status).toBe(200);
    const res = await ctx.app.request("/api/portfolio/summary?display=USD", {
      headers: { Cookie: cookie },
    });
    const summary = (await res.json()) as {
      kpi: { idleCash: number };
      cash: Array<{ broker: string; currency: string; amount: number; source: string }>;
    };
    const usd = summary.cash.find((c) => c.broker === "ibkr" && c.currency === "USD");
    expect(usd?.amount).toBe(8888);
    expect(usd?.source).toBe("manual");
    expect(summary.kpi.idleCash).toBeCloseTo(8888 + 2564, 1);
  });

  it("refresh=1 用行情覆盖市值并缓存", async () => {
    const ctx = createTestApp(300); // 所有 quote 均返回 300
    const { cookie } = await registerAndLogin(ctx);
    await ctx.app.request("/api/statements", authedJson(cookie, STATEMENT));
    const res = await ctx.app.request("/api/portfolio/summary?display=USD&refresh=1", {
      headers: { Cookie: cookie },
    });
    const summary = (await res.json()) as {
      positions: Array<{ symbol: string; marketValue: number; quoteApplied: boolean }>;
    };
    const aapl = summary.positions.find((p) => p.symbol === "AAPL")!;
    expect(aapl.quoteApplied).toBe(true);
    expect(aapl.marketValue).toBe(300 * 100);
    expect(ctx.quoteCalls.length).toBe(2);

    // 第二次 refresh 命中缓存，不再调 fetcher
    await ctx.app.request("/api/portfolio/summary?display=USD&refresh=1", {
      headers: { Cookie: cookie },
    });
    expect(ctx.quoteCalls.length).toBe(2);
  });

  it("删除快照后盘点为空", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    await ctx.app.request("/api/statements", authedJson(cookie, STATEMENT));
    const list = (await (
      await ctx.app.request("/api/statements", { headers: { Cookie: cookie } })
    ).json()) as Array<{ id: number }>;
    const del = await ctx.app.request(`/api/statements/${list[0].id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(del.status).toBe(200);
    const summary = (await (
      await ctx.app.request("/api/portfolio/summary", { headers: { Cookie: cookie } })
    ).json()) as { kpi: { totalAssets: number } };
    expect(summary.kpi.totalAssets).toBe(0);
  });

  it("非法 payload 返回 400；用户数据隔离", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx, "u1@example.com");
    const bad = await ctx.app.request(
      "/api/statements",
      authedJson(cookie, { ...STATEMENT, asOf: "bad-date" }),
    );
    expect(bad.status).toBe(400);

    await ctx.app.request("/api/statements", authedJson(cookie, STATEMENT));
    const { cookie: cookie2 } = await registerAndLogin(ctx, "u2@example.com");
    const other = (await (
      await ctx.app.request("/api/statements", { headers: { Cookie: cookie2 } })
    ).json()) as unknown[];
    expect(other).toHaveLength(0);
  });
});
