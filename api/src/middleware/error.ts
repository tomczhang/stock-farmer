import type { ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Env, ErrorResponse } from "../types";

/**
 * 统一错误处理：
 * - 业务侧抛 `HTTPException` 时，从 `res.body` 中带出 `{ error, message }`。
 *   若 handler 没有显式包装，则用默认 code（如 `http_error`）和原 message 拼回。
 * - 未捕获异常一律 500，避免向客户端泄露堆栈。
 */
export const errorHandler: ErrorHandler<{ Bindings: Env }> = (err, c) => {
  if (err instanceof HTTPException) {
    const res = err.getResponse();
    // 如果 handler 已经在 throw 时挂了 JSON body，就直接转发
    const contentType = res.headers.get("Content-Type") ?? "";
    if (contentType.includes("application/json")) {
      return res;
    }
    const body: ErrorResponse = {
      error: defaultErrorCodeForStatus(err.status),
      message: err.message || res.statusText || "HTTP error",
    };
    return c.json(body, err.status);
  }

  console.error("[stock-farmer-api] uncaught", err);
  const body: ErrorResponse = {
    error: "internal_error",
    message: err instanceof Error ? err.message : String(err),
  };
  return c.json(body, 500);
};

export const notFoundHandler: NotFoundHandler<{ Bindings: Env }> = (c) => {
  const body: ErrorResponse = {
    error: "not_found",
    message: `route not found: ${c.req.method} ${c.req.path}`,
  };
  return c.json(body, 404);
};

function defaultErrorCodeForStatus(status: ContentfulStatusCode): string {
  switch (status) {
    case 400:
      return "bad_request";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 422:
      return "unprocessable_entity";
    default:
      return status >= 500 ? "internal_error" : "http_error";
  }
}
