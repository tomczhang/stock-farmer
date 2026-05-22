/**
 * 根组件：组合 Layout / WatchlistPanel / MetricsCards / PEHistoryChart。
 *
 * 维护三个本地 state：
 *   - watchlist (来自 /api/watchlist，新增/删除后 refetch)
 *   - selectedTicker (默认指向 watchlist 第一项)
 *   - timeRange (默认 '5y')
 *
 * PE 历史数据通过 useApiQuery 在 (selectedTicker, timeRange) 变化时拉取。
 */

import { Component, useCallback, useEffect, useMemo, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";

import {
  ApiError,
  addToWatchlist,
  getPEHistory,
  getWatchlist,
  removeFromWatchlist,
} from "./api";
import { useApiQuery } from "./hooks/useApiQuery";
import type { Market, TimeRange, WatchlistItem } from "./types";

import { ErrorState } from "./components/ErrorState";
import { Layout } from "./components/Layout";
import { LoadingState } from "./components/LoadingState";
import { MetricsCards } from "./components/MetricsCards";
import { PEHistoryChart } from "./components/PEHistoryChart";
import { TimeRangeToggle } from "./components/TimeRangeToggle";
import { WatchlistPanel } from "./components/WatchlistPanel";

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
        <div style={{ padding: 32 }}>
          <ErrorState
            error={this.state.error}
            onRetry={() => {
              this.setState({ error: null });
              window.location.reload();
            }}
          />
        </div>
      );
    }
    return this.props.children;
  }
}

function AppInner() {
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>("5y");
  const [drawerOpen, setDrawerOpen] = useState<boolean>(false);
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);
  const [watchlistLoading, setWatchlistLoading] = useState<boolean>(true);
  const [watchlistError, setWatchlistError] = useState<string | null>(null);
  const [watchlistBusy, setWatchlistBusy] = useState<boolean>(false);

  const refreshWatchlist = useCallback(
    async (preserveSelection: string | null = selectedTicker) => {
      setWatchlistLoading(true);
      setWatchlistError(null);
      try {
        const items = await getWatchlist();
        setWatchlist(items);
        if (items.length === 0) {
          setSelectedTicker(null);
        } else {
          const stillExists =
            preserveSelection !== null &&
            items.some((it) => it.ticker === preserveSelection);
          if (!stillExists) {
            setSelectedTicker(items[0].ticker);
          }
        }
      } catch (err) {
        const msg =
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        setWatchlistError(msg);
      } finally {
        setWatchlistLoading(false);
      }
    },
    [selectedTicker],
  );

  // 初次加载
  useEffect(() => {
    void refreshWatchlist(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const peQuery = useApiQuery(
    () => getPEHistory(selectedTicker as string, timeRange),
    [selectedTicker, timeRange],
    { enabled: selectedTicker !== null },
  );

  const handleAdd = useCallback(
    async (ticker: string, market: Market) => {
      setWatchlistBusy(true);
      try {
        await addToWatchlist(ticker, market);
        await refreshWatchlist(ticker);
      } finally {
        setWatchlistBusy(false);
      }
    },
    [refreshWatchlist],
  );

  const handleRemove = useCallback(
    async (ticker: string) => {
      setWatchlistBusy(true);
      try {
        await removeFromWatchlist(ticker);
        // 若删的是当前选中，强制重选第一项
        const next =
          ticker === selectedTicker ? null : selectedTicker;
        await refreshWatchlist(next);
      } finally {
        setWatchlistBusy(false);
      }
    },
    [refreshWatchlist, selectedTicker],
  );

  const handleSelect = useCallback((ticker: string) => {
    setSelectedTicker(ticker);
    setDrawerOpen(false);
  }, []);

  const currentIsLoss = useMemo<boolean>(() => {
    const series = peQuery.data?.series;
    if (!series || series.length === 0) return false;
    return series[series.length - 1].is_loss === true;
  }, [peQuery.data]);

  const latestSeriesDate = useMemo<string | null>(() => {
    const series = peQuery.data?.series;
    if (!series || series.length === 0) return null;
    return series[series.length - 1].date ?? null;
  }, [peQuery.data]);

  const selectedItem = useMemo(
    () => watchlist.find((it) => it.ticker === selectedTicker) ?? null,
    [watchlist, selectedTicker],
  );

  const sidebar = (
    <WatchlistPanel
      items={watchlist}
      selectedTicker={selectedTicker}
      loading={watchlistLoading}
      errorMessage={watchlistError}
      busy={watchlistBusy}
      onSelect={handleSelect}
      onAdd={handleAdd}
      onRemove={handleRemove}
    />
  );

  let mainContent: ReactNode;
  if (selectedTicker === null) {
    mainContent = (
      <div className="empty-state">
        <h3>请添加股票到 watchlist</h3>
        <p>在左侧输入框中输入 ticker（例如 AAPL、0700.HK）开始观察。</p>
      </div>
    );
  } else if (peQuery.loading && !peQuery.data) {
    mainContent = (
      <>
        <PageHeader
          ticker={selectedTicker}
          market={selectedItem?.market ?? null}
          timeRange={timeRange}
          onChangeRange={setTimeRange}
          disabled
        />
        <LoadingState />
      </>
    );
  } else if (peQuery.error) {
    mainContent = (
      <>
        <PageHeader
          ticker={selectedTicker}
          market={selectedItem?.market ?? null}
          timeRange={timeRange}
          onChangeRange={setTimeRange}
        />
        <ErrorState error={peQuery.error} onRetry={peQuery.refetch} />
      </>
    );
  } else if (peQuery.data) {
    mainContent = (
      <>
        <PageHeader
          ticker={selectedTicker}
          market={selectedItem?.market ?? null}
          timeRange={timeRange}
          onChangeRange={setTimeRange}
        />
        <MetricsCards
          metrics={peQuery.data.metrics}
          currentIsLoss={currentIsLoss}
          latestSeriesDate={latestSeriesDate}
          live={peQuery.data.live ?? null}
        />
        <PEHistoryChart series={peQuery.data.series} />
        {peQuery.data.metadata.last_updated ? (
          <p className="muted" style={{ fontSize: 12 }}>
            数据更新于 {formatLastUpdated(peQuery.data.metadata.last_updated)}
          </p>
        ) : null}
      </>
    );
  } else {
    mainContent = <LoadingState />;
  }

  return (
    <Layout
      sidebar={sidebar}
      main={mainContent}
      drawerOpen={drawerOpen}
      onDrawerToggle={setDrawerOpen}
    />
  );
}

interface PageHeaderProps {
  ticker: string;
  market: Market | null;
  timeRange: TimeRange;
  onChangeRange: (r: TimeRange) => void;
  disabled?: boolean;
}

function PageHeader({
  ticker,
  market,
  timeRange,
  onChangeRange,
  disabled,
}: PageHeaderProps) {
  return (
    <div className="page-header">
      <h2 className="page-title">
        {market ? (
          <span className={`market-badge ${market.toLowerCase()}`}>
            {market}
          </span>
        ) : null}
        <span className="ticker-symbol">{ticker}</span>
        <span className="muted" style={{ fontSize: 14 }}>
          PE-TTM 历史分位
        </span>
      </h2>
      <TimeRangeToggle
        value={timeRange}
        onChange={onChangeRange}
        disabled={disabled}
      />
    </div>
  );
}

function formatLastUpdated(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export default function App() {
  return (
    <AppErrorBoundary>
      <AppInner />
    </AppErrorBoundary>
  );
}
