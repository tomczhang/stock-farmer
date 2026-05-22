import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";

/**
 * 给成功的 GET 响应统一加 `Cache-Control: public, max-age=3600`。
 *
 * - 数据由 pipeline 每日批量刷新，1 小时 CDN 缓存足够。
 * - POST / DELETE 等写操作不缓存。
 * - 4xx/5xx 响应不缓存（避免错误被边缘节点钉住）。
 */
export function cacheGetResponses(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    await next();
    if (
      c.req.method === "GET" &&
      c.res.status >= 200 &&
      c.res.status < 300 &&
      !c.res.headers.has("Cache-Control")
    ) {
      c.res.headers.set("Cache-Control", "public, max-age=3600");
    }
  };
}
