/**
 * 错误态：展示原因并提供重试按钮。重试入口由调用方传入。
 */

import type { ApiError } from "../api";

export interface ErrorStateProps {
  error: ApiError | Error;
  onRetry?: () => void;
}

export function ErrorState({ error, onRetry }: ErrorStateProps) {
  const status = "status" in error ? (error as ApiError).status : undefined;
  const code = "code" in error ? (error as ApiError).code : undefined;

  let title = "加载失败";
  if (status === 404) {
    title = "未找到数据";
  } else if (status === 0 || code === "network_error") {
    title = "网络异常";
  } else if (status && status >= 500) {
    title = "服务暂时不可用";
  }

  return (
    <div className="error-state" role="alert">
      <div className="error-title">{title}</div>
      <div className="error-message">{error.message || "未知错误"}</div>
      {onRetry ? (
        <button className="btn" onClick={onRetry} type="button">
          重试
        </button>
      ) : null}
    </div>
  );
}
