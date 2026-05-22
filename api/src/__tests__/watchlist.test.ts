import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetAndSeed } from "./setup";
import type { WatchlistItem } from "../types";

beforeEach(async () => {
  await resetAndSeed();
});

describe("GET /api/watchlist", () => {
  it("returns all watchlist rows ordered by added_at DESC", async () => {
    const res = await SELF.fetch("https://api.test/api/watchlist");
    expect(res.status).toBe(200);
    const body = (await res.json()) as WatchlistItem[];
    expect(body.map((r) => r.ticker)).toEqual(["0700.HK", "AAPL"]);
    expect(body[0]!.market).toBe("HK");
    expect(body[1]!.market).toBe("US");
  });
});

describe("POST /api/watchlist", () => {
  it("creates a new ticker with 201", async () => {
    const res = await SELF.fetch("https://api.test/api/watchlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker: "MSFT", market: "US" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as WatchlistItem;
    expect(body.ticker).toBe("MSFT");
    expect(body.market).toBe("US");
  });

  it("is idempotent: existing ticker returns 200", async () => {
    const res = await SELF.fetch("https://api.test/api/watchlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker: "AAPL", market: "US" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as WatchlistItem;
    expect(body.ticker).toBe("AAPL");
  });

  it("rejects invalid market with 400", async () => {
    const res = await SELF.fetch("https://api.test/api/watchlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker: "MSFT", market: "JP" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_market");
  });

  it("rejects missing ticker with 400", async () => {
    const res = await SELF.fetch("https://api.test/api/watchlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ market: "US" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_ticker");
  });

  it("rejects invalid JSON with 400", async () => {
    const res = await SELF.fetch("https://api.test/api/watchlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_json");
  });

  it("does not set Cache-Control header on POST", async () => {
    const res = await SELF.fetch("https://api.test/api/watchlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker: "NVDA", market: "US" }),
    });
    expect(res.headers.has("Cache-Control")).toBe(false);
  });
});

describe("DELETE /api/watchlist/:ticker", () => {
  it("removes existing ticker with 204", async () => {
    const res = await SELF.fetch("https://api.test/api/watchlist/AAPL", {
      method: "DELETE",
    });
    expect(res.status).toBe(204);

    const list = (await (
      await SELF.fetch("https://api.test/api/watchlist")
    ).json()) as WatchlistItem[];
    expect(list.find((r) => r.ticker === "AAPL")).toBeUndefined();
  });

  it("returns 404 for unknown ticker", async () => {
    const res = await SELF.fetch("https://api.test/api/watchlist/UNKNOWN", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ticker_not_in_watchlist");
  });
});
