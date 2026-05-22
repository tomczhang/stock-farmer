import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Env, ErrorResponse, WatchlistItem } from "../types";
import { VALID_MARKETS } from "../types";

/**
 * GET /api/watchlist
 *
 * 返回 watchlist 全部 ticker（按 added_at DESC，最近添加在前）。
 */
export async function listWatchlist(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  const { results } = await c.env.DB.prepare(
    "SELECT ticker, market, added_at FROM watchlist ORDER BY added_at DESC",
  ).all<WatchlistItem>();

  return c.json(results ?? [], 200);
}

interface AddWatchlistBody {
  ticker?: unknown;
  market?: unknown;
}

/**
 * POST /api/watchlist
 *
 * 幂等：已存在 → 200，新增 → 201。
 * 用 `INSERT OR IGNORE` 然后通过 `changes()` 区分是否真正插入。
 * D1 不直接暴露 changes()，但 D1Result.meta.changes 可达。
 */
export async function addWatchlist(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  let body: AddWatchlistBody;
  try {
    body = (await c.req.json()) as AddWatchlistBody;
  } catch {
    throwJSON(400, {
      error: "invalid_json",
      message: "request body must be valid JSON",
    });
  }

  const ticker = typeof body.ticker === "string" ? body.ticker.trim() : "";
  const market = typeof body.market === "string" ? body.market : "";

  if (!ticker) {
    throwJSON(400, {
      error: "missing_ticker",
      message: "field 'ticker' is required",
    });
  }
  if (!VALID_MARKETS.includes(market as "US" | "HK")) {
    throwJSON(400, {
      error: "invalid_market",
      message: `field 'market' must be one of: ${VALID_MARKETS.join(", ")}`,
    });
  }

  // INSERT OR IGNORE：已存在则不动；用 meta.changes 区分插入/幂等
  const result = await c.env.DB.prepare(
    "INSERT OR IGNORE INTO watchlist (ticker, market, added_at) VALUES (?, ?, datetime('now'))",
  )
    .bind(ticker, market)
    .run();

  const inserted = (result.meta?.changes ?? 0) > 0;
  const row = await c.env.DB.prepare(
    "SELECT ticker, market, added_at FROM watchlist WHERE ticker = ?",
  )
    .bind(ticker)
    .first<WatchlistItem>();

  return c.json(row ?? { ticker, market, added_at: null }, inserted ? 201 : 200);
}

/**
 * DELETE /api/watchlist/:ticker
 *
 * 不存在 → 404；存在 → 204。
 */
export async function removeWatchlist(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  const ticker = c.req.param("ticker");
  if (!ticker) {
    throwJSON(400, {
      error: "missing_ticker",
      message: "ticker path parameter is required",
    });
  }

  const exists = await c.env.DB.prepare(
    "SELECT 1 AS ok FROM watchlist WHERE ticker = ? LIMIT 1",
  )
    .bind(ticker)
    .first<{ ok: number }>();

  if (!exists) {
    throwJSON(404, {
      error: "ticker_not_in_watchlist",
      message: `ticker ${ticker} is not in the watchlist`,
    });
  }

  await c.env.DB.prepare("DELETE FROM watchlist WHERE ticker = ?")
    .bind(ticker)
    .run();

  return new Response(null, { status: 204 });
}

function throwJSON(status: ContentfulStatusCode, body: ErrorResponse): never {
  throw new HTTPException(status, {
    res: new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    }),
  });
}
