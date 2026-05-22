import { SELF, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetAndSeed, resetSchema } from "./setup";
import type { PEHistoryResponse } from "../types";
import { _resetCookieCache } from "../lib/xueqiu";

beforeAll(() => {
  // 拦截所有 outbound fetch（雪球实时 PE）；未 mock 的请求会抛错。
  // 主流程对 live 的失败已经做了 catch → null，所以未 mock 时也不会破坏既有用例。
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

beforeEach(async () => {
  await resetAndSeed();
  _resetCookieCache();
});

afterEach(() => {
  // 确保每个用例自己 mock 的 interceptor 都被消费。
  fetchMock.assertNoPendingInterceptors();
});

/** 模拟一次成功的雪球 cookie + quote 调用。 */
function mockXueqiu(symbol: string, quote: Record<string, unknown>): void {
  fetchMock
    .get("https://xueqiu.com")
    .intercept({ path: "/", method: "GET" })
    .reply(200, "<html></html>", {
      headers: { "set-cookie": "xq_a_token=test_token; Path=/; HttpOnly" },
    });

  fetchMock
    .get("https://stock.xueqiu.com")
    .intercept({
      path: `/v5/stock/quote.json?symbol=${encodeURIComponent(symbol)}&extend=detail`,
      method: "GET",
    })
    .reply(
      200,
      JSON.stringify({ error_code: 0, data: { quote } }),
      { headers: { "content-type": "application/json" } },
    );
}

describe("GET /api/pe-history/:ticker", () => {
  it("returns series + metrics for ticker in watchlist (default range=5y)", async () => {
    const res = await SELF.fetch("https://api.test/api/pe-history/AAPL");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toMatch(/max-age=\d+/);

    const body = (await res.json()) as PEHistoryResponse;
    expect(body.ticker).toBe("AAPL");
    expect(body.range).toBe("5y");
    expect(body.series).toHaveLength(3);

    // 亏损点 pe_ttm null + is_loss true
    const lossPoint = body.series.find((p) => p.date === "2024-01-02")!;
    expect(lossPoint.pe_ttm).toBeNull();
    expect(lossPoint.is_loss).toBe(true);

    // metrics（基于 fixture 数据手算）
    // valid pe = [20, 30]；最新一行 pe=30，percentile_5y=80
    expect(body.metrics.current_pe).toBe(30);
    expect(body.metrics.current_percentile).toBe(80);
    expect(body.metrics.median_pe).toBe(25);
    expect(body.metrics.min_pe).toBe(20);
    expect(body.metrics.max_pe).toBe(30);
    // 3 行里 1 行亏损 → 0.3333...
    expect(body.metrics.loss_ratio).toBeCloseTo(0.3333, 4);

    expect(body.metadata.data_source).toBe("latest_filings");
    expect(body.metadata.last_updated).toBe("2024-01-03");
    expect(body.metadata.caveats.length).toBeGreaterThan(0);
  });

  it("uses percentile_10y when range=10y", async () => {
    const res = await SELF.fetch(
      "https://api.test/api/pe-history/AAPL?range=10y",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as PEHistoryResponse;
    expect(body.range).toBe("10y");
    expect(body.metrics.current_percentile).toBe(75);
  });

  it("uses percentile_all when range=all", async () => {
    const res = await SELF.fetch(
      "https://api.test/api/pe-history/AAPL?range=all",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as PEHistoryResponse;
    expect(body.range).toBe("all");
    expect(body.metrics.current_percentile).toBe(70);
  });

  it("returns 400 when range is invalid", async () => {
    const res = await SELF.fetch(
      "https://api.test/api/pe-history/AAPL?range=bogus",
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_range");
    expect(body.message).toBeTypeOf("string");
  });

  it("returns 404 when ticker is not in watchlist", async () => {
    const res = await SELF.fetch("https://api.test/api/pe-history/MSFT");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ticker_not_in_watchlist");
  });

  it("returns empty series + zero-loss metrics when watchlist ticker has no pe rows", async () => {
    // 0700.HK 在 watchlist 但没有 pe_series 行
    const res = await SELF.fetch("https://api.test/api/pe-history/0700.HK");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PEHistoryResponse;
    expect(body.series).toEqual([]);
    expect(body.metrics.current_pe).toBeNull();
    expect(body.metrics.median_pe).toBeNull();
    expect(body.metrics.loss_ratio).toBe(0);
    expect(body.metadata.last_updated).toBeNull();
  });

  it("does not touch external network when ticker missing (404 path)", async () => {
    // schema 清掉后 watchlist 校验直接 404，handler 不会走到 live fetch。
    // 也就不会有未消费的 fetch interceptor。
    await resetSchema();
    const res = await SELF.fetch("https://api.test/api/pe-history/AAPL");
    expect(res.status).toBe(404);
  });
});

describe("GET /api/pe-history/:ticker live quote", () => {
  it("attaches live field when xueqiu returns successfully", async () => {
    mockXueqiu("AAPL", {
      current: 200.0,
      current_ext: null,
      pe_ttm: 25.0,
      eps: 8.0,
      last_close: 200.0,
    });

    const res = await SELF.fetch("https://api.test/api/pe-history/AAPL");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PEHistoryResponse;
    expect(body.live).not.toBeNull();
    expect(body.live!.pe_ttm).toBe(25.0);
    expect(body.live!.pe_ttm_ext).toBeNull();
    expect(body.live!.current_price).toBe(200.0);
    expect(body.live!.current_ext).toBeNull();
    expect(body.live!.is_extended_hours).toBe(false);
    expect(body.live!.source).toBe("xueqiu");
    expect(body.live!.snapshot_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
    // 主响应不受影响
    expect(body.metrics.current_pe).toBe(30);
  });

  it("computes pe_ttm_ext and is_extended_hours when current_ext differs", async () => {
    mockXueqiu("AAPL", {
      current: 200.0,
      current_ext: 210.0,
      pe_ttm: 25.0,
      eps: 8.0,
      last_close: 200.0,
    });

    const res = await SELF.fetch("https://api.test/api/pe-history/AAPL");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PEHistoryResponse;
    expect(body.live).not.toBeNull();
    // 210 / 8 = 26.25
    expect(body.live!.pe_ttm_ext).toBeCloseTo(26.25, 4);
    expect(body.live!.current_ext).toBe(210.0);
    expect(body.live!.is_extended_hours).toBe(true);
  });

  it("converts 0700.HK → 00700 when calling xueqiu", async () => {
    mockXueqiu("00700", {
      current: 500.0,
      current_ext: null,
      pe_ttm: 18.5,
      eps: 27.0,
      last_close: 500.0,
    });

    // 0700.HK 已在 watchlist 但没有 pe_series，主响应 series 为空，
    // 但 live 仍应拉成功。
    const res = await SELF.fetch("https://api.test/api/pe-history/0700.HK");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PEHistoryResponse;
    expect(body.series).toEqual([]);
    expect(body.live).not.toBeNull();
    expect(body.live!.pe_ttm).toBe(18.5);
    expect(body.live!.current_price).toBe(500.0);
  });

  it("sets live=null when xueqiu cookie fetch fails", async () => {
    // cookie 端 500 → 重试一次后仍 500 → fetchQuote 抛 → handler 兜底 null
    fetchMock
      .get("https://xueqiu.com")
      .intercept({ path: "/", method: "GET" })
      .reply(500, "boom")
      .times(2);

    const res = await SELF.fetch("https://api.test/api/pe-history/AAPL");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PEHistoryResponse;
    expect(body.live).toBeNull();
    // 主响应仍正常
    expect(body.metrics.current_pe).toBe(30);
    expect(body.series).toHaveLength(3);
  });

  it("sets live=null when xueqiu quote returns error_code", async () => {
    // cookie 成功，quote 端返回业务错误：触发重试（再次成功 cookie + 再次错误 quote）
    fetchMock
      .get("https://xueqiu.com")
      .intercept({ path: "/", method: "GET" })
      .reply(200, "<html></html>", {
        headers: { "set-cookie": "xq_a_token=test_token; Path=/" },
      })
      .times(2);
    fetchMock
      .get("https://stock.xueqiu.com")
      .intercept({
        path: "/v5/stock/quote.json?symbol=AAPL&extend=detail",
        method: "GET",
      })
      .reply(
        200,
        JSON.stringify({ error_code: 400016, error_description: "认证失败" }),
        { headers: { "content-type": "application/json" } },
      )
      .times(2);

    const res = await SELF.fetch("https://api.test/api/pe-history/AAPL");
    expect(res.status).toBe(200);
    const body = (await res.json()) as PEHistoryResponse;
    expect(body.live).toBeNull();
  });

  it("uses short Cache-Control TTL on pe-history responses", async () => {
    mockXueqiu("AAPL", {
      current: 200.0,
      current_ext: null,
      pe_ttm: 25.0,
      eps: 8.0,
      last_close: 200.0,
    });

    const res = await SELF.fetch("https://api.test/api/pe-history/AAPL");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
  });
});
