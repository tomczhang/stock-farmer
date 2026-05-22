/**
 * 通用骨架块：占位用，不传业务语义。
 */

import type { CSSProperties } from "react";

export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  style?: CSSProperties;
  className?: string;
}

export function Skeleton({
  width = "100%",
  height = 16,
  radius,
  style,
  className,
}: SkeletonProps) {
  const css: CSSProperties = {
    width,
    height,
    ...(radius !== undefined ? { borderRadius: radius } : {}),
    ...style,
  };
  const cls = className ? `skeleton ${className}` : "skeleton";
  return <div className={cls} style={css} aria-hidden="true" />;
}
