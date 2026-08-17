import * as echarts from "echarts";
import { useEffect, useRef } from "react";

/** ECharts React 封装：自动 init / setOption / resize / dispose。 */
export function Chart({ option, height = 280 }: { option: echarts.EChartsOption; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current, null, { renderer: "canvas" });
    chartRef.current = chart;
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, true);
  }, [option]);

  return <div ref={ref} style={{ height, width: "100%" }} />;
}

// 浅色系图表 token（源自熊本方案移植）
export const PALETTE = ["#eab308", "#f97316", "#22c55e", "#3b82f6", "#8b5cf6", "#ec4899", "#14b8a6", "#ef4444"];

/* 涨跌语义色（全站唯一，与 global.css --gain/--loss 同源）；图表内用字面量，ECharts 不读 CSS 变量 */
export const GAIN = "#0E9F6E";
export const LOSS = "#D84C55";
/* Lieflat 语法：非焦点柱降饱和，只给最值柱全饱和 + 标数（一图一个视线落点） */
export const MUTED_BAR_OPACITY = 0.38;
/* 发丝线网格色 */
export const HAIRLINE = "#eef2f6";

export const LIGHT_TOOLTIP = {
  trigger: "item" as const,
  backgroundColor: "rgba(255,255,255,.98)",
  borderColor: "#e2e8f0",
  textStyle: { color: "#334155", fontSize: 12 },
  extraCssText: "box-shadow:0 8px 28px rgba(15,23,42,.12);border-radius:8px;",
};

export function gradientBar(color: string) {
  return new echarts.graphic.LinearGradient(0, 0, 1, 0, [
    { offset: 0, color: hexToRgba(color, 0.25) },
    { offset: 1, color },
  ]);
}

export function gradientBarVertical(color: string) {
  return new echarts.graphic.LinearGradient(0, 1, 0, 0, [
    { offset: 0, color: hexToRgba(color, 0.25) },
    { offset: 1, color },
  ]);
}

function hexToRgba(hex: string, alpha: number) {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ---------- 防窥模式：隐藏具体金额，保留百分比 ----------
const PRIVACY_KEY = "sf_privacy";
let privacyHidden = typeof localStorage !== "undefined" && localStorage.getItem(PRIVACY_KEY) === "1";

export function isPrivacyOn() {
  return privacyHidden;
}

export function setPrivacy(value: boolean) {
  privacyHidden = value;
  localStorage.setItem(PRIVACY_KEY, value ? "1" : "0");
}

const MASK = "∗∗∗∗";

export function fmtMoney(value: number, digits = 2) {
  if (privacyHidden) return MASK;
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtCompact(value: number) {
  if (privacyHidden) return MASK;
  const abs = Math.abs(value);
  if (abs >= 1e8) return `${(value / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${(value / 1e4).toFixed(1)}万`;
  return fmtMoney(value, 0);
}
