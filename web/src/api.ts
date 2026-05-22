/**
 * 后端 API 的薄封装。base URL 由 VITE_API_BASE_URL 注入；
 * 任何 non-2xx 响应都抛出 `ApiError`，由上层 UI 统一展示。
 */

import type {
  HealthResponse,
  Market,
  PEHistoryResponse,
  TimeRange,
  WatchlistItem,
  ApiErrorBody,
} from "./types";

const BASE_URL: string = (import.meta.env.VITE_API_BASE_URL ?? "").replace(
  /\/$/,
  "",
);

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const url = `${BASE_URL}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    throw new ApiError(
      0,
      "network_error",
      err instanceof Error ? err.message : "网络请求失败",
    );
  }

  if (!response.ok) {
    let code = `http_${response.status}`;
    let message = response.statusText || "请求失败";
    try {
      const body = (await response.json()) as ApiErrorBody;
      if (body && typeof body === "object") {
        if (typeof body.error === "string" && body.error.length > 0) {
          code = body.error;
        }
        if (typeof body.message === "string" && body.message.length > 0) {
          message = body.message;
        }
      }
    } catch {
      // 响应体可能不是 JSON，忽略解析错误。
    }
    throw new ApiError(response.status, code, message);
  }

  // 204 / 空 body 容错
  const text = await response.text();
  if (text.length === 0) {
    return undefined as unknown as T;
  }
  return JSON.parse(text) as T;
}

export function getPEHistory(
  ticker: string,
  range: TimeRange,
): Promise<PEHistoryResponse> {
  const encoded = encodeURIComponent(ticker);
  return request<PEHistoryResponse>(
    `/api/pe-history/${encoded}?range=${range}`,
  );
}

export function getWatchlist(): Promise<WatchlistItem[]> {
  return request<WatchlistItem[]>(`/api/watchlist`);
}

export function addToWatchlist(
  ticker: string,
  market: Market,
): Promise<WatchlistItem> {
  return request<WatchlistItem>(`/api/watchlist`, {
    method: "POST",
    body: JSON.stringify({ ticker, market }),
  });
}

export function removeFromWatchlist(ticker: string): Promise<void> {
  const encoded = encodeURIComponent(ticker);
  return request<void>(`/api/watchlist/${encoded}`, {
    method: "DELETE",
  });
}

export function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>(`/api/health`);
}
