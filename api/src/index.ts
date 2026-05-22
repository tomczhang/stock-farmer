import { Hono } from "hono";
import type { Env } from "./types";
import { cors } from "./middleware/cors";
import { cacheGetResponses } from "./middleware/cache";
import { errorHandler, notFoundHandler } from "./middleware/error";
import { getPEHistory } from "./handlers/pe_history";
import {
  addWatchlist,
  listWatchlist,
  removeWatchlist,
} from "./handlers/watchlist";
import { getHealth } from "./handlers/health";

/**
 * stock-farmer · Cloudflare Workers 薄 API 层
 *
 * 设计：参见 openspec/changes/add-pe-percentile-viewer/design.md 决策 1 / 9。
 * 所有重活已由 pipeline 离线算完写入 D1；这里只做 SELECT + JSON。
 */
const app = new Hono<{ Bindings: Env }>();

// 全局 middleware（顺序很重要）
app.use("*", cors());
app.use("*", cacheGetResponses());

// 业务路由
app.get("/api/health", getHealth);
app.get("/api/pe-history/:ticker", getPEHistory);
app.get("/api/watchlist", listWatchlist);
app.post("/api/watchlist", addWatchlist);
app.delete("/api/watchlist/:ticker", removeWatchlist);

app.onError(errorHandler);
app.notFound(notFoundHandler);

export default app;
