/**
 * Watchlist 面板：列出 ticker、支持添加 / 删除 / 切换。
 *
 * - 添加表单：单个输入框，自动识别 `.HK` 后缀 → market='HK'，否则 'US'。
 * - 每行徽章用颜色区分市场；右侧删除按钮在 hover / active 时浮现。
 * - 空列表显示引导文案。
 */

import { useState } from "react";
import type { FormEvent } from "react";

import type { WatchlistItem, Market } from "../types";

export interface WatchlistPanelProps {
  items: WatchlistItem[];
  selectedTicker: string | null;
  loading?: boolean;
  errorMessage?: string | null;
  busy?: boolean;
  onSelect: (ticker: string) => void;
  onAdd: (ticker: string, market: Market) => Promise<void> | void;
  onRemove: (ticker: string) => Promise<void> | void;
}

function detectMarket(rawTicker: string): Market {
  return /\.HK$/i.test(rawTicker.trim()) ? "HK" : "US";
}

function normalizeTicker(raw: string): string {
  return raw.trim().toUpperCase();
}

function formatRelative(addedAtIso: string): string {
  const ts = Date.parse(addedAtIso);
  if (Number.isNaN(ts)) return "";
  const diffMs = Date.now() - ts;
  if (diffMs < 0) return "刚刚";
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diffMs < minute) return "刚刚";
  if (diffMs < hour) return `${Math.floor(diffMs / minute)} 分钟前`;
  if (diffMs < day) return `${Math.floor(diffMs / hour)} 小时前`;
  if (diffMs < 30 * day) return `${Math.floor(diffMs / day)} 天前`;
  if (diffMs < 365 * day)
    return `${Math.floor(diffMs / (30 * day))} 个月前`;
  return `${Math.floor(diffMs / (365 * day))} 年前`;
}

export function WatchlistPanel(props: WatchlistPanelProps) {
  const {
    items,
    selectedTicker,
    loading,
    errorMessage,
    busy,
    onSelect,
    onAdd,
    onRemove,
  } = props;

  const [input, setInput] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const ticker = normalizeTicker(input);
    if (!ticker) return;
    const market = detectMarket(ticker);
    setLocalError(null);
    setSubmitting(true);
    try {
      await onAdd(ticker, market);
      setInput("");
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "添加失败");
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemove = async (
    event: React.MouseEvent<HTMLButtonElement>,
    ticker: string,
  ) => {
    event.stopPropagation();
    if (
      typeof window !== "undefined" &&
      !window.confirm(`从 watchlist 中移除 ${ticker}？`)
    ) {
      return;
    }
    try {
      await onRemove(ticker);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "删除失败");
    }
  };

  const disableForm = submitting || busy === true;

  return (
    <aside className="watchlist" aria-label="watchlist">
      <div className="watchlist-header">
        <h2>Watchlist</h2>
        <form className="watchlist-add-form" onSubmit={handleSubmit}>
          <input
            type="text"
            placeholder="例如 AAPL 或 0700.HK"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={disableForm}
            aria-label="股票 ticker"
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={disableForm || input.trim().length === 0}
          >
            添加
          </button>
        </form>
      </div>

      {(errorMessage || localError) && (
        <div className="watchlist-error" role="alert">
          {errorMessage ?? localError}
        </div>
      )}

      <ul className="watchlist-list">
        {loading && items.length === 0 ? (
          <li className="watchlist-empty">加载中…</li>
        ) : items.length === 0 ? (
          <li className="watchlist-empty">请添加股票到 watchlist</li>
        ) : (
          items.map((item) => {
            const active = item.ticker === selectedTicker;
            return (
              <li key={item.ticker}>
                <button
                  type="button"
                  className={`watchlist-item${active ? " active" : ""}`}
                  onClick={() => onSelect(item.ticker)}
                  aria-current={active ? "true" : undefined}
                >
                  <div className="watchlist-item-main">
                    <span className="watchlist-item-ticker">
                      <span
                        className={`market-badge ${item.market.toLowerCase()}`}
                        aria-label={
                          item.market === "HK" ? "港股" : "美股"
                        }
                      >
                        {item.market}
                      </span>
                      {item.ticker}
                    </span>
                    <span className="watchlist-item-meta">
                      {formatRelative(item.added_at)}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon watchlist-delete"
                    aria-label={`删除 ${item.ticker}`}
                    onClick={(e) => handleRemove(e, item.ticker)}
                    title="删除"
                  >
                    ×
                  </button>
                </button>
              </li>
            );
          })
        )}
      </ul>
    </aside>
  );
}
