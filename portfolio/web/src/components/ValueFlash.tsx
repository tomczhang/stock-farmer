import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * value-flash（interior.dev 语法）：受监控数值变化时按方向闪 涨绿/跌红 900ms 后归位。
 * 事件驱动（数值不变不动）；方向箭头格固定占位 12px，出现/消失不推挤布局。
 */
export function ValueFlash({
  value,
  children,
  className = "",
  hold = 900,
}: {
  value: number | null | undefined;
  children: ReactNode;
  className?: string;
  hold?: number;
}) {
  const prev = useRef(value);
  const timer = useRef<number | null>(null);
  const [direction, setDirection] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    const prior = prev.current;
    prev.current = value;
    if (prior == null || value == null || value === prior) return;
    setDirection(value > prior ? "up" : "down");
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setDirection(null), hold);
  }, [value, hold]);

  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    },
    [],
  );

  return (
    <span className={`vf ${direction ? `vf-${direction}` : ""} ${className}`.trim()}>
      {children}
      <span className="vf-mark" aria-hidden>
        {direction === "up" && (
          <svg viewBox="0 0 256 256" width="12" height="12" fill="currentColor"><path d="M128 68 L210 180 H46 Z" /></svg>
        )}
        {direction === "down" && (
          <svg viewBox="0 0 256 256" width="12" height="12" fill="currentColor"><path d="M128 188 L46 76 H210 Z" /></svg>
        )}
      </span>
    </span>
  );
}
