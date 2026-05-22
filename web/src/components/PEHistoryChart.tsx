/**
 * PE-TTM 历史折线图（ECharts）。
 *
 * 视觉元素：
 *   - 折线：日期 → pe_ttm（null 自动断开）
 *   - markPoint：最新一个非空点突出显示
 *   - markLine：25 / 50 / 75 百分位横线（在前端从非空序列计算）
 *   - markArea：连续 is_loss=true 的日期段灰色阴影
 *   - tooltip：日期、PE、当前分位（按 hover 点在非空序列中的分位算）
 *
 * 不引入额外 ECharts 主题，沿用默认；颜色与全局 CSS 变量手动保持一致。
 */

import { useMemo } from "react";
import ReactECharts from "echarts-for-react";

import type { PEHistoryPoint } from "../types";

export interface PEHistoryChartProps {
  series: PEHistoryPoint[];
}

interface LossSpan {
  start: string;
  end: string;
}

/** 计算线性插值分位（数组需已排序） */
function quantileSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[Math.min(base + 1, sorted.length - 1)];
  return sorted[base] + rest * (next - sorted[base]);
}

/** 返回 v 在已排序数组中的百分位排名（0-1） */
function percentileRank(sorted: number[], v: number): number {
  if (sorted.length === 0) return Number.NaN;
  // 二分查左侧 / 右侧位置，取中点作为常见 ranking 定义
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  const left = lo;
  lo = 0;
  hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  const right = lo;
  const rank = (left + right) / 2 / sorted.length;
  return rank;
}

/** 把连续 is_loss=true 的日期合并成区间 */
function buildLossSpans(series: PEHistoryPoint[]): LossSpan[] {
  const spans: LossSpan[] = [];
  let start: string | null = null;
  let prev: string | null = null;
  for (const p of series) {
    if (p.is_loss) {
      if (start === null) start = p.date;
      prev = p.date;
    } else {
      if (start !== null && prev !== null) {
        spans.push({ start, end: prev });
        start = null;
        prev = null;
      }
    }
  }
  if (start !== null && prev !== null) {
    spans.push({ start, end: prev });
  }
  return spans;
}

export function PEHistoryChart({ series }: PEHistoryChartProps) {
  const option = useMemo(() => {
    const xData: string[] = new Array(series.length);
    const yData: Array<number | null> = new Array(series.length);
    const valid: number[] = [];

    for (let i = 0; i < series.length; i += 1) {
      const p = series[i];
      xData[i] = p.date;
      const v =
        p.pe_ttm !== null && Number.isFinite(p.pe_ttm) ? p.pe_ttm : null;
      yData[i] = v;
      if (v !== null) valid.push(v);
    }

    const sorted = valid.slice().sort((a, b) => a - b);
    const p25 = quantileSorted(sorted, 0.25);
    const p50 = quantileSorted(sorted, 0.5);
    const p75 = quantileSorted(sorted, 0.75);

    // 找到最新一个非空 PE 点用作 markPoint
    let lastIdx = -1;
    for (let i = series.length - 1; i >= 0; i -= 1) {
      if (yData[i] !== null) {
        lastIdx = i;
        break;
      }
    }
    const latestPoint =
      lastIdx >= 0
        ? { date: xData[lastIdx], pe: yData[lastIdx] as number }
        : null;

    const lossSpans = buildLossSpans(series);

    const markLineData =
      sorted.length > 0
        ? [
            {
              name: "75% 分位",
              yAxis: p75,
              lineStyle: { color: "#dc2626", type: "dashed" as const },
              label: {
                formatter: `75% (${p75.toFixed(2)})`,
                position: "insideEndTop" as const,
                color: "#dc2626",
              },
            },
            {
              name: "50% 分位",
              yAxis: p50,
              lineStyle: { color: "#6b7280", type: "dashed" as const },
              label: {
                formatter: `50% (${p50.toFixed(2)})`,
                position: "insideEndTop" as const,
                color: "#6b7280",
              },
            },
            {
              name: "25% 分位",
              yAxis: p25,
              lineStyle: { color: "#16a34a", type: "dashed" as const },
              label: {
                formatter: `25% (${p25.toFixed(2)})`,
                position: "insideEndBottom" as const,
                color: "#16a34a",
              },
            },
          ]
        : [];

    const markAreaData =
      lossSpans.length > 0
        ? lossSpans.map((span) => [
            { xAxis: span.start, name: "亏损期" },
            { xAxis: span.end },
          ])
        : [];

    const markPointData =
      latestPoint !== null
        ? [
            {
              name: "最新",
              coord: [latestPoint.date, latestPoint.pe],
              value: latestPoint.pe.toFixed(2),
              symbol: "circle" as const,
              symbolSize: 14,
              itemStyle: { color: "#dc2626" },
              label: {
                color: "#dc2626",
                fontWeight: "bold" as const,
                position: "top" as const,
              },
            },
          ]
        : [];

    return {
      animation: false,
      grid: {
        left: 56,
        right: 24,
        top: 32,
        bottom: 48,
      },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "line" },
        formatter: (params: unknown) => {
          if (!Array.isArray(params) || params.length === 0) return "";
          const first = params[0] as {
            axisValue: string;
            data: number | null;
          };
          const date = first.axisValue;
          const value = first.data;
          let valueText = "—";
          let percentileText = "—";
          if (value !== null && Number.isFinite(value)) {
            valueText = (value as number).toFixed(2);
            if (sorted.length > 0) {
              const r = percentileRank(sorted, value as number);
              if (Number.isFinite(r)) {
                percentileText = `${(r * 100).toFixed(1)}%`;
              }
            }
          } else {
            valueText = "亏损 / 数据缺失";
          }
          return [
            `<div style="font-size:12px;line-height:1.5">`,
            `<div style="color:#6b7280">${date}</div>`,
            `<div><b>PE-TTM:</b> ${valueText}</div>`,
            `<div><b>历史分位:</b> ${percentileText}</div>`,
            `</div>`,
          ].join("");
        },
      },
      legend: {
        show: true,
        bottom: 0,
        left: "center",
        data: ["PE-TTM", ...(lossSpans.length > 0 ? ["亏损期"] : [])],
        textStyle: { color: "#6b7280", fontSize: 12 },
        icon: "roundRect",
      },
      xAxis: {
        type: "category",
        data: xData,
        boundaryGap: false,
        axisLine: { lineStyle: { color: "#d1d5db" } },
        axisLabel: { color: "#6b7280", fontSize: 11 },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        scale: true,
        axisLine: { show: false },
        axisLabel: { color: "#6b7280", fontSize: 11 },
        splitLine: { lineStyle: { color: "#f3f4f6" } },
      },
      series: [
        {
          name: "PE-TTM",
          type: "line",
          data: yData,
          showSymbol: false,
          smooth: false,
          connectNulls: false,
          lineStyle: { color: "#1f2937", width: 1.5 },
          itemStyle: { color: "#1f2937" },
          markPoint:
            markPointData.length > 0 ? { data: markPointData } : undefined,
          markLine:
            markLineData.length > 0
              ? {
                  symbol: "none",
                  silent: true,
                  data: markLineData,
                }
              : undefined,
          markArea:
            markAreaData.length > 0
              ? {
                  silent: true,
                  itemStyle: {
                    color: "rgba(0,0,0,0.06)",
                  },
                  label: {
                    show: false,
                  },
                  data: markAreaData,
                }
              : undefined,
        },
        // 一个不可见 series 仅用于在 legend 中显示"亏损期"图例
        ...(lossSpans.length > 0
          ? [
              {
                name: "亏损期",
                type: "line" as const,
                data: [] as Array<number | null>,
                itemStyle: { color: "rgba(0,0,0,0.2)" },
              },
            ]
          : []),
      ],
    };
  }, [series]);

  if (series.length === 0) {
    return (
      <div className="empty-state">
        <h3>暂无 PE 数据</h3>
        <p>该股票尚未由 pipeline 入库，或当前时间窗内无数据。</p>
      </div>
    );
  }

  return (
    <div className="chart-wrap">
      <ReactECharts
        option={option}
        style={{ width: "100%", height: "420px" }}
        notMerge={true}
        lazyUpdate={true}
      />
    </div>
  );
}
