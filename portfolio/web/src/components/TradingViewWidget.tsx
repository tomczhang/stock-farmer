import { useEffect, useRef } from "react";

function tvSymbol(symbol: string, market: string) {
  // 白名单清洗，避免任意内容注入 embed 脚本配置
  const safe = symbol.replace(/[^A-Za-z0-9.\-]/g, "").toUpperCase();
  if (market === "HK") return `HKEX:${String(Number(safe.replace(/\D/g, "") || 0))}`;
  return safe;
}

/** TradingView 嵌入式高级 K 线 widget（官方 embed 脚本）。 */
export function TradingViewWidget({ symbol, market, height = 420 }: { symbol: string; market: string; height?: number }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    el.innerHTML = "";
    const widgetDiv = document.createElement("div");
    widgetDiv.className = "tradingview-widget-container__widget";
    widgetDiv.style.height = "100%";
    el.appendChild(widgetDiv);
    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.async = true;
    script.text = JSON.stringify({
      symbol: tvSymbol(symbol, market),
      interval: "D",
      timezone: "Asia/Hong_Kong",
      theme: "light",
      style: "1",
      locale: "zh_CN",
      hide_top_toolbar: false,
      hide_legend: false,
      allow_symbol_change: false,
      save_image: false,
      autosize: true,
    });
    el.appendChild(script);
    return () => {
      el.innerHTML = "";
    };
  }, [symbol, market]);

  return <div ref={container} className="tradingview-widget-container" style={{ height, width: "100%" }} />;
}
