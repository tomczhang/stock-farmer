/**
 * 主区域加载态：四张卡片占位 + 图表大块占位。
 */

import { Skeleton } from "./Skeleton";

export function LoadingState() {
  return (
    <div className="loading-state" role="status" aria-live="polite">
      <Skeleton width={180} height={28} />
      <div className="skeleton-cards">
        <Skeleton className="skeleton-card" height={88} />
        <Skeleton className="skeleton-card" height={88} />
        <Skeleton className="skeleton-card" height={88} />
        <Skeleton className="skeleton-card" height={88} />
      </div>
      <Skeleton className="skeleton-chart" height={420} radius={10} />
      <span className="sr-only">加载中</span>
    </div>
  );
}
