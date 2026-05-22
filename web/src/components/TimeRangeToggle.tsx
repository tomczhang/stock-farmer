/**
 * 5Y / 10Y / 全部 三按钮 toggle。
 */

import type { TimeRange } from "../types";
import { TIME_RANGES } from "../types";

export interface TimeRangeToggleProps {
  value: TimeRange;
  onChange: (next: TimeRange) => void;
  disabled?: boolean;
}

const LABELS: Record<TimeRange, string> = {
  "5y": "5Y",
  "10y": "10Y",
  all: "全部",
};

export function TimeRangeToggle({
  value,
  onChange,
  disabled,
}: TimeRangeToggleProps) {
  return (
    <div
      className="range-toggle"
      role="tablist"
      aria-label="时间窗切换"
    >
      {TIME_RANGES.map((range) => {
        const active = range === value;
        return (
          <button
            key={range}
            type="button"
            role="tab"
            aria-selected={active}
            className={active ? "active" : ""}
            disabled={disabled}
            onClick={() => {
              if (!active) onChange(range);
            }}
          >
            {LABELS[range]}
          </button>
        );
      })}
    </div>
  );
}
