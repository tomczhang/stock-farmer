/**
 * 极简请求 hook：data / loading / error / refetch。
 * 故意不引入 react-query —— MVP 的请求量与缓存需求都很低。
 *
 * 用法：
 *   const { data, loading, error, refetch } = useApiQuery(
 *     () => getPEHistory(ticker, range),
 *     [ticker, range],
 *     { enabled: ticker !== null }
 *   );
 *
 * 注意：`fetcher` 在依赖变化时被重新调用；用 `enabled=false` 推迟请求。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError } from "../api";

export interface ApiQueryState<T> {
  data: T | null;
  loading: boolean;
  error: ApiError | null;
  refetch: () => void;
}

export interface ApiQueryOptions {
  /** 为 false 时 hook 不会调用 fetcher（保持 idle 状态）。默认 true。 */
  enabled?: boolean;
}

export function useApiQuery<T>(
  fetcher: () => Promise<T>,
  deps: ReadonlyArray<unknown>,
  options: ApiQueryOptions = {},
): ApiQueryState<T> {
  const { enabled = true } = options;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [reloadTick, setReloadTick] = useState<number>(0);

  // 用 ref 持有最新 fetcher，避免把它放进依赖触发死循环。
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetcherRef
      .current()
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const apiErr =
          err instanceof ApiError
            ? err
            : new ApiError(
                0,
                "unknown",
                err instanceof Error ? err.message : String(err),
              );
        setError(apiErr);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, reloadTick, ...deps]);

  const refetch = useCallback(() => {
    setReloadTick((tick) => tick + 1);
  }, []);

  return { data, loading, error, refetch };
}
