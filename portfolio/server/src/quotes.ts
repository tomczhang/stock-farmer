import type { AppDatabase } from "./db.js";

const CACHE_TTL_MINUTES = 10;

export interface Quote {
  symbol: string;
  market: string;
  price: number;
  currency: string;
  cached: boolean;
}

export type QuoteFetcher = (symbol: string, market: string) => Promise<{ price: number; currency: string } | null>;

/** 腾讯行情（港股）：https://qt.gtimg.cn/q=hk09988 */
async function fetchTencentHk(symbol: string): Promise<{ price: number; currency: string } | null> {
  const code = symbol.replace(/\D/g, "").padStart(5, "0");
  const res = await fetch(`https://qt.gtimg.cn/q=hk${code}`, {
    headers: { Referer: "https://gu.qq.com/" },
  });
  if (!res.ok) return null;
  const text = await res.text();
  // v_hk09988="100~阿里巴巴-W~09988~118.50~..."; 第 4 个字段（索引 3）为最新价
  const fields = text.split("~");
  const price = Number(fields[3]);
  if (!Number.isFinite(price) || price <= 0) return null;
  return { price, currency: "HKD" };
}

/** Yahoo chart API（美股）：https://query1.finance.yahoo.com/v8/finance/chart/AAPL */
async function fetchYahooUs(symbol: string): Promise<{ price: number; currency: string } | null> {
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`,
    { headers: { "User-Agent": "Mozilla/5.0" } },
  );
  if (!res.ok) return null;
  const data = (await res.json()) as {
    chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; currency?: string } }> };
  };
  const meta = data.chart?.result?.[0]?.meta;
  const price = Number(meta?.regularMarketPrice);
  if (!Number.isFinite(price) || price <= 0) return null;
  return { price, currency: meta?.currency ?? "USD" };
}

export const defaultQuoteFetcher: QuoteFetcher = async (symbol, market) => {
  try {
    if (market === "HK") return await fetchTencentHk(symbol);
    if (market === "US") return await fetchYahooUs(symbol);
    return null;
  } catch {
    return null;
  }
};

export function createQuoteService(db: AppDatabase, fetcher: QuoteFetcher = defaultQuoteFetcher) {
  return {
    async getQuotes(pairs: Array<{ symbol: string; market: string }>): Promise<Quote[]> {
      const quotes: Quote[] = [];
      for (const { symbol, market } of pairs) {
        const cached = db
          .prepare(
            "SELECT price, currency FROM quote_cache WHERE symbol = ? AND market = ? AND fetched_at > datetime('now', ?)",
          )
          .get(symbol, market, `-${CACHE_TTL_MINUTES} minutes`) as
          | { price: number; currency: string }
          | undefined;
        if (cached) {
          quotes.push({ symbol, market, price: cached.price, currency: cached.currency, cached: true });
          continue;
        }
        const fresh = await fetcher(symbol, market);
        if (fresh) {
          db.prepare(
            "INSERT OR REPLACE INTO quote_cache (symbol, market, price, currency, fetched_at) VALUES (?, ?, ?, ?, datetime('now'))",
          ).run(symbol, market, fresh.price, fresh.currency);
          quotes.push({ symbol, market, price: fresh.price, currency: fresh.currency, cached: false });
        }
      }
      return quotes;
    },
  };
}
