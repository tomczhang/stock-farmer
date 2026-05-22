import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";

/**
 * CORS middleware。
 *
 * 设计要点：
 * - 白名单从 `c.env.ALLOWED_ORIGINS`（逗号分隔）读取，避免硬编码。
 * - 只有当请求 Origin 命中白名单时才回 `Access-Control-Allow-Origin`，
 *   否则不附加任何 CORS 头（浏览器自然拒绝）。这比回 `*` 更安全。
 * - 处理 OPTIONS preflight：直接 204 返回。
 */
export function cors(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const origin = c.req.header("Origin");
    const allowed = (c.env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const isAllowed = origin && allowed.includes(origin);

    if (c.req.method === "OPTIONS") {
      const headers = new Headers();
      if (isAllowed && origin) {
        headers.set("Access-Control-Allow-Origin", origin);
        headers.set("Vary", "Origin");
        headers.set(
          "Access-Control-Allow-Methods",
          "GET, POST, DELETE, OPTIONS",
        );
        headers.set("Access-Control-Allow-Headers", "Content-Type");
        headers.set("Access-Control-Max-Age", "86400");
      }
      return new Response(null, { status: 204, headers });
    }

    await next();

    if (isAllowed && origin) {
      c.res.headers.set("Access-Control-Allow-Origin", origin);
      const vary = c.res.headers.get("Vary");
      c.res.headers.set("Vary", vary ? `${vary}, Origin` : "Origin");
    }
  };
}
