import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type {
  Env,
  ErrorResponse,
  LiveQuote,
  MetricsCard,
  PEHistoryPoint,
  PEHistoryResponse,
  PERange,
} from "../types";
import { VALID_RANGES } from "../types";
import { fetchQuote } from "../lib/xueqiu";

/** pe_ttm_ext 与 pe_ttm 相对差异 > 0.05% 视为有效的盘前/盘后行情。 */
const EXTENDED_HOURS_REL_THRESHOLD = 0.0005;

/** D1 行投影 */
interface PESeriesRow {
  date: string;
  pe_ttm: number | null;
  is_loss: number;
  percentile_5y: number | null;
  percentile_10y: number | null;
  percentile_all: number | null;
}

/**
 * GET /api/pe-history/:ticker?range=5y|10y|all
 *
 * 见 specs/pe-analytics-api/spec.md：
 * - ticker 必须在 watchlist 内（否则 404）。
 * - 默认 range=5y。
 * - 响应包含 series + metrics card + metadata。
 */
export async function getPEHistory(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  const ticker = c.req.param("ticker");
  if (!ticker) {
    throwJSON(400, { error: "missing_ticker", message: "ticker is required" });
  }

  const rangeRaw = c.req.query("range") ?? "5y";
  if (!VALID_RANGES.includes(rangeRaw as PERange)) {
    throwJSON(400, {
      error: "invalid_range",
      message: `range must be one of: ${VALID_RANGES.join(", ")}`,
    });
  }
  const range = rangeRaw as PERange;

  // 1) watchlist 校验
  const wl = await c.env.DB.prepare(
    "SELECT 1 AS ok FROM watchlist WHERE ticker = ? LIMIT 1",
  )
    .bind(ticker)
    .first<{ ok: number }>();

  if (!wl) {
    throwJSON(404, {
      error: "ticker_not_in_watchlist",
      message: `ticker ${ticker} is not in the watchlist; add it via POST /api/watchlist first`,
    });
  }

  // 2) 计算 cutoff
  const cutoff = computeCutoff(range);

  // 3) 拉序列
  const sql =
    cutoff === null
      ? "SELECT date, pe_ttm, is_loss, percentile_5y, percentile_10y, percentile_all FROM pe_series WHERE ticker = ? ORDER BY date ASC"
      : "SELECT date, pe_ttm, is_loss, percentile_5y, percentile_10y, percentile_all FROM pe_series WHERE ticker = ? AND date >= ? ORDER BY date ASC";

  const stmt =
    cutoff === null
      ? c.env.DB.prepare(sql).bind(ticker)
      : c.env.DB.prepare(sql).bind(ticker, cutoff);

  const { results } = await stmt.all<PESeriesRow>();
  const rows = results ?? [];

  // 4) series 投影
  const series: PEHistoryPoint[] = rows.map((r) => ({
    date: r.date,
    pe_ttm: r.is_loss === 1 ? null : r.pe_ttm,
    is_loss: r.is_loss === 1,
  }));

  // 5) metrics card
  const metrics = computeMetrics(rows, range);

  // 6) last_updated = MAX(date) for this ticker（独立查询，避免被 range 截断影响）
  const meta = await c.env.DB.prepare(
    "SELECT MAX(date) AS max_date FROM pe_series WHERE ticker = ?",
  )
    .bind(ticker)
    .first<{ max_date: string | null }>();

  // 7) 实时 quote（雪球，best-effort，失败不影响主响应）
  const live = await fetchLivePE(ticker);

  const body: PEHistoryResponse = {
    ticker,
    range,
    series,
    metrics,
    metadata: {
      data_source: "latest_filings",
      last_updated: meta?.max_date ?? null,
      caveats: [
        "基于最新可得财报，不还原历史时点数据",
        "亏损期已从分位计算中剔除",
      ],
    },
    live,
  };

  // 实时 PE 需要更短 TTL，覆盖全局 max-age=3600
  c.header("Cache-Control", "public, max-age=60");
  return c.json(body, 200);
}

/**
 * 从雪球拉一次实时 quote 并映射成 LiveQuote。
 * 任何异常（网络 / cookie 失效 / 字段缺失）都返回 null，调用方继续返回主响应。
 */
async function fetchLivePE(ticker: string): Promise<LiveQuote | null> {
  try {
    const quote = await fetchQuote(ticker);
    const peTtmExt =
      quote.current_ext !== null && quote.eps !== 0
        ? quote.current_ext / quote.eps
        : null;
    const isExtendedHours =
      peTtmExt !== null &&
      quote.pe_ttm !== 0 &&
      Math.abs(peTtmExt - quote.pe_ttm) / Math.abs(quote.pe_ttm) >
        EXTENDED_HOURS_REL_THRESHOLD;

    return {
      pe_ttm: quote.pe_ttm,
      pe_ttm_ext: peTtmExt,
      current_price: quote.current,
      current_ext: quote.current_ext,
      is_extended_hours: isExtendedHours,
      snapshot_at: new Date().toISOString(),
      source: "xueqiu",
    };
  } catch {
    return null;
  }
}

function computeCutoff(range: PERange): string | null {
  if (range === "all") return null;
  const years = range === "5y" ? 5 : 10;
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  // YYYY-MM-DD
  return d.toISOString().slice(0, 10);
}

function computeMetrics(rows: PESeriesRow[], range: PERange): MetricsCard {
  if (rows.length === 0) {
    return {
      current_pe: null,
      median_pe: null,
      current_percentile: null,
      min_pe: null,
      max_pe: null,
      loss_ratio: 0,
    };
  }

  // 非亏损、pe_ttm 不为 null 的样本
  const validPes: number[] = [];
  let lossCount = 0;
  for (const r of rows) {
    if (r.is_loss === 1) {
      lossCount += 1;
      continue;
    }
    if (r.pe_ttm !== null && r.pe_ttm !== undefined) {
      validPes.push(r.pe_ttm);
    }
  }

  // 最新一行（rows 是 ASC）
  const last = rows[rows.length - 1]!;
  const currentPe = last.is_loss === 1 ? null : last.pe_ttm;
  const currentPercentile =
    last.is_loss === 1
      ? null
      : range === "5y"
        ? last.percentile_5y
        : range === "10y"
          ? last.percentile_10y
          : last.percentile_all;

  return {
    current_pe: currentPe,
    median_pe: median(validPes),
    current_percentile: currentPercentile,
    min_pe: validPes.length ? minOf(validPes) : null,
    max_pe: validPes.length ? maxOf(validPes) : null,
    loss_ratio: Math.round((lossCount / rows.length) * 10000) / 10000,
  };
}

function minOf(xs: number[]): number {
  let m = xs[0]!;
  for (let i = 1; i < xs.length; i++) {
    const v = xs[i]!;
    if (v < m) m = v;
  }
  return m;
}

function maxOf(xs: number[]): number {
  let m = xs[0]!;
  for (let i = 1; i < xs.length; i++) {
    const v = xs[i]!;
    if (v > m) m = v;
  }
  return m;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * 抛一个 body 已经塞好的 JSON HTTPException，
 * 让 error middleware 直接转发。
 */
function throwJSON(status: ContentfulStatusCode, body: ErrorResponse): never {
  throw new HTTPException(status, {
    res: new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    }),
  });
}
