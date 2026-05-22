/**
 * 雪球 quote 接口的 Cloudflare Workers 版客户端。
 *
 * 用于实时 PE 展示：在 PE history 响应里附加最新 quote（不写入 D1）。
 *
 * 设计要点：
 * - 雪球 v5 接口需要先访问首页拿 cookie，再带 cookie 请求 quote。
 * - Workers 环境无持久状态，用 module-level 变量做最小 cookie 缓存（5 分钟）。
 *   Worker 实例之间不共享，每个实例首次冷启动会重拉一次 cookie，可接受。
 * - 仅暴露 `fetchQuote(ticker)`，调用方拿到失败一律 catch → live=null。
 *
 * Python 版逻辑参见 pipeline/fetcher/xueqiu.py。
 */

const XUEQIU_HOME = "https://xueqiu.com";
const XUEQIU_QUOTE = "https://stock.xueqiu.com/v5/stock/quote.json";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/130.0.0.0 Safari/537.36";

const COOKIE_TTL_MS = 5 * 60 * 1000;

interface CookieCache {
  value: string;
  fetchedAt: number;
}

let cookieCache: CookieCache | null = null;

export class XueqiuError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "XueqiuError";
  }
}

/** 测试用：清掉 module-level cookie 缓存。 */
export function _resetCookieCache(): void {
  cookieCache = null;
}

export interface XueqiuQuote {
  current: number;
  current_ext: number | null;
  pe_ttm: number;
  eps: number;
  last_close: number;
}

/**
 * ticker → 雪球 symbol。
 * - 港股 0700.HK → 00700（5 位数字，无后缀）
 * - 美股 AAPL → AAPL（原样大写）
 */
export function symbolForXueqiu(ticker: string): string {
  const upper = ticker.toUpperCase();
  if (upper.endsWith(".HK")) {
    const digits = upper.slice(0, -3).replace(/^0+/, "");
    return digits.padStart(5, "0");
  }
  return upper;
}

async function fetchCookie(): Promise<string> {
  const res = await fetch(XUEQIU_HOME, {
    headers: {
      "User-Agent": UA,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!res.ok) {
    throw new XueqiuError(`fetch cookie failed: HTTP ${res.status}`);
  }

  // workerd 的 Headers 实现了 getSetCookie()（Workers Types 暂未声明，做 runtime check）
  const headers = res.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const setCookies: string[] =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : (() => {
          const single = headers.get("Set-Cookie");
          return single ? [single] : [];
        })();

  const cookies = setCookies
    .map((c) => c.split(";")[0]?.trim())
    .filter((c): c is string => Boolean(c))
    .join("; ");

  if (!cookies) {
    throw new XueqiuError("no cookies returned from xueqiu home");
  }
  return cookies;
}

async function ensureCookie(forceRefresh = false): Promise<string> {
  const now = Date.now();
  if (
    !forceRefresh &&
    cookieCache &&
    now - cookieCache.fetchedAt < COOKIE_TTL_MS
  ) {
    return cookieCache.value;
  }
  const value = await fetchCookie();
  cookieCache = { value, fetchedAt: now };
  return value;
}

interface XueqiuQuoteEnvelope {
  error_code?: number;
  error_description?: string;
  data?: {
    quote?: Record<string, unknown>;
  };
}

async function quoteOnce(
  symbol: string,
  cookie: string,
): Promise<XueqiuQuoteEnvelope> {
  const url = `${XUEQIU_QUOTE}?symbol=${encodeURIComponent(symbol)}&extend=detail`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Referer: `${XUEQIU_HOME}/S/${symbol}`,
      Cookie: cookie,
      Accept: "application/json, text/plain, */*",
    },
  });

  if (res.status === 401 || res.status === 403) {
    throw new XueqiuError(`quote auth failed: HTTP ${res.status}`);
  }
  if (!res.ok) {
    throw new XueqiuError(`quote HTTP ${res.status}`);
  }

  const data = (await res.json()) as XueqiuQuoteEnvelope;
  if (typeof data.error_code === "number" && data.error_code !== 0) {
    throw new XueqiuError(
      `xueqiu error_code=${data.error_code}: ${data.error_description ?? ""}`,
    );
  }
  return data;
}

function projectQuote(envelope: XueqiuQuoteEnvelope): XueqiuQuote {
  const quote = envelope.data?.quote;
  if (!quote || typeof quote !== "object") {
    throw new XueqiuError("missing quote in response");
  }
  const current = quote.current;
  const peTtm = quote.pe_ttm;
  const eps = quote.eps;
  if (
    typeof current !== "number" ||
    typeof peTtm !== "number" ||
    typeof eps !== "number"
  ) {
    throw new XueqiuError("missing required numeric fields in quote");
  }
  const currentExt =
    typeof quote.current_ext === "number" ? quote.current_ext : null;
  const lastClose =
    typeof quote.last_close === "number" ? quote.last_close : current;
  return {
    current,
    current_ext: currentExt,
    pe_ttm: peTtm,
    eps,
    last_close: lastClose,
  };
}

/**
 * 拉取一只股票的实时 quote（含 pe_ttm / current / current_ext / eps）。
 *
 * 失败模式（cookie 失效 / 401 / 403 / error_code）会重置 cookie 缓存重试一次；
 * 仍失败则抛 `XueqiuError`，调用方负责降级。
 */
export async function fetchQuote(ticker: string): Promise<XueqiuQuote> {
  const symbol = symbolForXueqiu(ticker);

  const attempt = async (): Promise<XueqiuQuote> => {
    const cookie = await ensureCookie();
    const envelope = await quoteOnce(symbol, cookie);
    return projectQuote(envelope);
  };

  try {
    return await attempt();
  } catch (e) {
    if (!(e instanceof XueqiuError)) throw e;
    // cookie 可能过期或被风控：清缓存重试一次
    cookieCache = null;
    return await attempt();
  }
}
