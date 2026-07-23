import { Component, useCallback, useEffect, useState } from "react";
import type { ErrorInfo, FormEvent, ReactNode } from "react";

import { ApiError, getSignalReport } from "./api";
import { SignalTrendReport } from "./components/SignalTrendReport";
import type { SignalReportResponse } from "./types";

interface ErrorBoundaryState {
  error: Error | null;
}

class AppErrorBoundary extends Component<
  { children: ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error("App crash:", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="app-frame">
          <div className="state-panel danger">
            <h1>页面渲染失败</h1>
            <p>{this.state.error.message}</p>
            <button
              type="button"
              className="primary-button"
              onClick={() => window.location.reload()}
            >
              重新加载
            </button>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}

function AppInner() {
  const [input, setInput] = useState("DEMO");
  const [asOfInput, setAsOfInput] = useState("");
  const [ticker, setTicker] = useState("DEMO");
  const [report, setReport] = useState<SignalReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | Error | null>(null);

  const loadReport = useCallback(
    async (nextTicker: string, asOf?: string | null) => {
      const normalized = nextTicker.trim().toUpperCase();
      if (!normalized) return;
      setTicker(normalized);
      setLoading(true);
      setError(null);
      try {
        const data = await getSignalReport(normalized, {
          demo: normalized === "DEMO",
          asOf: normalized === "DEMO" ? null : asOf ?? null,
        });
        setReport(data);
      } catch (err) {
        setReport(null);
        setError(err instanceof Error ? err : new Error("分析失败"));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void loadReport("DEMO");
  }, [loadReport]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void loadReport(input, asOfInput.trim() || null);
  };

  const handleClearDate = () => {
    setAsOfInput("");
    void loadReport(input, null);
  };

  return (
    <main className="app-frame">
      <header className="topbar">
        <div className="brand-block">
          <span className="brand-mark">SF</span>
          <div>
            <strong>stock-farmer</strong>
            <span>右侧趋势分析</span>
          </div>
        </div>

        <form className="ticker-form" onSubmit={handleSubmit}>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="AAPL 或 0700.HK"
            aria-label="股票代码"
            spellCheck={false}
          />
          <input
            type="date"
            value={asOfInput}
            onChange={(event) => setAsOfInput(event.target.value)}
            aria-label="历史复盘日期"
            title="选择历史日期进行复盘，留空为当前分析"
          />
          <button type="submit" className="primary-button" disabled={loading}>
            分析
          </button>
          {asOfInput ? (
            <button
              type="button"
              className="ghost-button"
              onClick={handleClearDate}
              disabled={loading}
            >
              回到当前
            </button>
          ) : null}
        </form>
      </header>

      {loading ? <ReportSkeleton ticker={ticker} /> : null}
      {!loading && error ? <ReportError error={error} ticker={ticker} /> : null}
      {!loading && !error && report ? <SignalTrendReport report={report} /> : null}
    </main>
  );
}

function ReportSkeleton({ ticker }: { ticker: string }) {
  return (
    <div className="loading-layout" aria-label={`${ticker} 分析加载中`}>
      <div className="loading-title">
        <span className="skeleton-line short" />
        <span className="skeleton-line tiny" />
      </div>
      <div className="loading-grid">
        <span className="skeleton-card tall" />
        <span className="skeleton-card tall wide" />
      </div>
      <div className="loading-grid">
        <span className="skeleton-card" />
        <span className="skeleton-card" />
      </div>
    </div>
  );
}

function ReportError({ error, ticker }: { error: Error; ticker: string }) {
  return (
    <section className="state-panel danger">
      <span className="section-label">Python 后端</span>
      <h1>{ticker} 分析失败</h1>
      <p>{error.message}</p>
      <p className="hint">
        本地运行 `python -m pipeline.server --port 8765` 后再打开前端。
        输入 DEMO 可使用后端演示数据。
      </p>
    </section>
  );
}

export default function App() {
  return (
    <AppErrorBoundary>
      <AppInner />
    </AppErrorBoundary>
  );
}
