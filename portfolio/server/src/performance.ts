import type { AppDatabase } from "./db.js";
import { ValidationError } from "./errors.js";
import { fromUsd, normalizeMarket, roundAmount, toUsd } from "./finance.js";
import type { Currency } from "./types.js";

/** 绩效口径：self = 剔除授予仓（grant）；all = 含授予仓。 */
export type PerformanceScope = "self" | "all";

/** 单月出入金占上月净资产比例超过该阈值时，标记净值受大额出入金影响。 */
const LARGE_FLOW_RATIO = 0.2;

interface LedgerLike {
  bucketFor(userId: number, market: string | null | undefined, symbol: string | null | undefined): string | null;
  performanceSummary(userId: number): {
    realizedCapitalGainUsd: number;
    dividendsNetUsd: number;
    tradingFeesUsd: number;
    financingFeesUsd: number;
  };
}

interface MonthPoint {
  month: string;
  netAssetsUsd: number;
  cashUsd: number;
  flowUsd: number;
  carriedBrokers: string[];
}

export function createPerformanceService(
  db: AppDatabase,
  fxToUsd: Record<string, number>,
  ledger: LedgerLike,
) {
  const usd = (amount: number, currency: string, captured?: number | null) => toUsd(amount, currency, fxToUsd, captured);

  function isGrant(userId: number, market: string | null | undefined, symbol: string | null | undefined) {
    return ledger.bucketFor(userId, market, symbol) === "grant";
  }

  /**
   * 月度净资产序列（USD）：每月每券商取当月最新月结单快照，净资产 = 持仓市值（含货币基金）+ 已解析现金。
   * 券商缺月时沿用其最近一期快照值（carry-forward），并记录 carried 券商列表。
   * 手动现金覆盖不入历史序列（无可靠的历史语义），只影响当前时点的 summary 口径。
   */
  function monthlyNetAssets(userId: number, scope: PerformanceScope): MonthPoint[] {
    const statements = db
      .prepare("SELECT id, broker, as_of FROM statements WHERE user_id = ? ORDER BY as_of")
      .all(userId) as Array<{ id: number; broker: string; as_of: string }>;
    if (statements.length === 0) return [];

    // 每月每券商最新一份月结单
    const latestPerBrokerMonth = new Map<string, { id: number; as_of: string }>();
    for (const s of statements) {
      const key = `${s.as_of.slice(0, 7)}|${s.broker}`;
      const current = latestPerBrokerMonth.get(key);
      if (!current || s.as_of > current.as_of) latestPerBrokerMonth.set(key, { id: s.id, as_of: s.as_of });
    }

    const firstMonth = statements[0].as_of.slice(0, 7);
    const lastMonth = statements[statements.length - 1].as_of.slice(0, 7);
    const months: string[] = [];
    for (let m = firstMonth; m <= lastMonth; m = nextMonth(m)) months.push(m);

    const positionsStmt = db.prepare(
      "SELECT market, currency, symbol, market_value FROM positions WHERE user_id = ? AND statement_id = ?",
    );
    const cashStmt = db.prepare(
      "SELECT currency, amount FROM cash_balances WHERE user_id = ? AND statement_id = ? AND source = 'parsed'",
    );

    // statement -> 该券商该期净资产 USD（货币基金 market=FUND 视同现金等价物）
    function statementValueUsd(statementId: number): { totalUsd: number; cashUsd: number } {
      let invested = 0;
      let cash = 0;
      const positions = positionsStmt.all(userId, statementId) as Array<{
        market: string;
        currency: string;
        symbol: string;
        market_value: number;
      }>;
      for (const p of positions) {
        if (p.market === "FUND") {
          cash += usd(p.market_value, p.currency);
          continue;
        }
        if (scope === "self" && isGrant(userId, normalizeMarket(p.market), p.symbol)) continue;
        invested += usd(p.market_value, p.currency);
      }
      const cashRows = cashStmt.all(userId, statementId) as Array<{ currency: string; amount: number }>;
      for (const c of cashRows) cash += usd(c.amount, c.currency);
      return { totalUsd: invested + cash, cashUsd: cash };
    }

    const brokers = Array.from(new Set(statements.map((s) => s.broker)));
    const lastKnown = new Map<string, { totalUsd: number; cashUsd: number }>(); // broker -> 最近一期
    const firstSeen = new Map<string, string>(); // broker -> 首个有快照的月份
    for (const s of statements) {
      const month = s.as_of.slice(0, 7);
      if (!firstSeen.has(s.broker)) firstSeen.set(s.broker, month);
    }

    const series: MonthPoint[] = [];
    for (const month of months) {
      let netAssetsUsd = 0;
      let cashUsd = 0;
      const carriedBrokers: string[] = [];
      for (const broker of brokers) {
        const started = firstSeen.get(broker);
        if (started == null || month < started) continue; // 该券商尚未开户/入库
        const snapshot = latestPerBrokerMonth.get(`${month}|${broker}`);
        if (snapshot) {
          const value = statementValueUsd(snapshot.id);
          lastKnown.set(broker, value);
          netAssetsUsd += value.totalUsd;
          cashUsd += value.cashUsd;
        } else {
          const carried = lastKnown.get(broker);
          netAssetsUsd += carried?.totalUsd ?? 0;
          cashUsd += carried?.cashUsd ?? 0;
          carriedBrokers.push(broker);
        }
      }
      series.push({ month, netAssetsUsd, cashUsd, flowUsd: 0, carriedBrokers });
    }
    return series;
  }

  /** 月度外部净流入（USD）：capital_events 聚合；scope=self 时剔除 grant 标的的转仓事件。 */
  function monthlyFlows(userId: number, scope: PerformanceScope): Map<string, number> {
    const rows = db
      .prepare(
        `SELECT event_type, event_date, market, currency, symbol, amount, quantity, unit_cost, fx_to_usd, bucket
         FROM capital_events WHERE user_id = ?`,
      )
      .all(userId) as Array<{
      event_type: string;
      event_date: string;
      market: string | null;
      currency: string;
      symbol: string | null;
      amount: number | null;
      quantity: number | null;
      unit_cost: number | null;
      fx_to_usd: number | null;
      bucket: string | null;
    }>;
    const flows = new Map<string, number>();
    for (const row of rows) {
      const impact = capitalImpactUsd(row);
      if (impact == null) continue;
      if (scope === "self" && rowIsGrant(userId, row)) continue;
      const month = row.event_date.slice(0, 7);
      flows.set(month, (flows.get(month) ?? 0) + impact);
    }
    return flows;
  }

  function rowIsGrant(
    userId: number,
    row: { symbol: string | null; market: string | null; bucket: string | null },
  ): boolean {
    if (row.bucket) return row.bucket === "grant";
    if (!row.symbol) return false;
    return isGrant(userId, row.market, row.symbol);
  }

  function capitalImpactUsd(row: {
    event_type: string;
    currency: string;
    amount: number | null;
    quantity: number | null;
    unit_cost: number | null;
    fx_to_usd: number | null;
  }): number | null {
    let amount: number | null;
    if (row.event_type === "transfer_in" || row.event_type === "transfer_out") {
      amount = row.quantity != null && row.unit_cost != null ? row.quantity * row.unit_cost : null;
    } else {
      amount = row.amount;
    }
    if (amount == null) return null;
    const signed =
      row.event_type === "cash_out" || row.event_type === "transfer_out"
        ? -Math.abs(amount)
        : row.event_type === "cash_in" || row.event_type === "transfer_in"
          ? Math.abs(amount)
          : amount; // adjustment 保留符号
    return usd(signed, row.currency, row.fx_to_usd);
  }

  /** 累计入金/出金/净投入（USD）：cash_in+transfer_in 为入，cash_out+transfer_out 为出，adjustment 仅入净额。 */
  function cumulativeCapital(userId: number, scope: PerformanceScope) {
    const rows = db
      .prepare(
        `SELECT event_type, market, currency, symbol, amount, quantity, unit_cost, fx_to_usd, bucket
         FROM capital_events WHERE user_id = ?`,
      )
      .all(userId) as Array<{
      event_type: string;
      market: string | null;
      currency: string;
      symbol: string | null;
      amount: number | null;
      quantity: number | null;
      unit_cost: number | null;
      fx_to_usd: number | null;
      bucket: string | null;
    }>;
    let totalIn = 0;
    let totalOut = 0;
    let net = 0;
    for (const row of rows) {
      const impact = capitalImpactUsd(row);
      if (impact == null) continue;
      if (scope === "self" && rowIsGrant(userId, row)) continue;
      net += impact;
      if (row.event_type === "cash_in" || row.event_type === "transfer_in") totalIn += impact;
      else if (row.event_type === "cash_out" || row.event_type === "transfer_out") totalOut += -impact;
    }
    return { totalInUsd: totalIn, totalOutUsd: totalOut, netInvestedUsd: net };
  }

  /**
   * 份额法单位净值：NAV_0 = 1，shares_0 = V_0；
   * 第 t 月 shares_t = shares_{t-1} + F_t / NAV_{t-1}，NAV_t = V_t / shares_t。
   * 出入金只改变份额、不直接改变净值。首月流入已反映在 V_0 中，不重复计。
   */
  function buildNavSeries(points: MonthPoint[]) {
    const result: Array<{
      month: string;
      netAssetsUsd: number;
      flowUsd: number;
      pnlUsd: number | null;
      nav: number | null;
      drawdown: number | null;
      carriedBrokers: string[];
      largeFlow: boolean;
    }> = [];
    let nav: number | null = null;
    let shares = 0;
    let peak = 0;
    let prevAssets: number | null = null;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const flow = i === 0 ? 0 : p.flowUsd;
      let pnl: number | null = null;
      let largeFlow = false;
      if (i === 0) {
        if (p.netAssetsUsd > 0) {
          nav = 1;
          shares = p.netAssetsUsd;
          peak = 1;
        }
      } else if (nav != null && prevAssets != null) {
        if (prevAssets > 0) {
          pnl = p.netAssetsUsd - prevAssets - flow;
          largeFlow = Math.abs(flow) / prevAssets > LARGE_FLOW_RATIO;
        }
        shares += nav > 0 ? flow / nav : 0;
        nav = shares > 0 ? p.netAssetsUsd / shares : nav;
        if (nav != null && nav > peak) peak = nav;
      }
      const drawdown = nav != null && peak > 0 ? nav / peak - 1 : null;
      result.push({
        month: p.month,
        netAssetsUsd: p.netAssetsUsd,
        flowUsd: flow,
        pnlUsd: pnl,
        nav: nav == null ? null : roundAmount(nav, 6),
        drawdown: drawdown == null ? null : roundAmount(drawdown, 6),
        carriedBrokers: p.carriedBrokers,
        largeFlow,
      });
      prevAssets = p.netAssetsUsd;
    }
    return result;
  }

  function performance(userId: number, scope: PerformanceScope = "self", display: Currency = "USD") {
    const points = monthlyNetAssets(userId, scope);
    const flows = monthlyFlows(userId, scope);
    for (const p of points) p.flowUsd = flows.get(p.month) ?? 0;
    const series = buildNavSeries(points);
    const capital = cumulativeCapital(userId, scope);
    const cvt = (amountUsd: number) => roundAmount(fromUsd(amountUsd, display, fxToUsd));

    const navPoints = series.filter((s) => s.nav != null);
    const lastNav = navPoints.at(-1)?.nav ?? null;
    const monthsSpan = navPoints.length - 1;
    const cumulativeReturn = lastNav == null ? null : roundAmount(lastNav - 1, 6);
    const annualizedReturn =
      lastNav == null || monthsSpan < 1 || lastNav <= 0
        ? null
        : roundAmount(Math.pow(lastNav, 12 / monthsSpan) - 1, 6);
    const maxDrawdown = navPoints.length
      ? roundAmount(Math.min(...navPoints.map((s) => s.drawdown ?? 0)), 6)
      : null;
    const monthlyPnls = series.filter((s) => s.pnlUsd != null).map((s) => s.pnlUsd as number);
    const avgMonthlyPnlUsd = monthlyPnls.length
      ? monthlyPnls.reduce((sum, v) => sum + v, 0) / monthlyPnls.length
      : null;

    return {
      display,
      scope,
      months: series.map((s) => ({
        month: s.month,
        netAssetsDisplay: cvt(s.netAssetsUsd),
        flowDisplay: cvt(s.flowUsd),
        pnlDisplay: s.pnlUsd == null ? null : cvt(s.pnlUsd),
        nav: s.nav,
        cumulativeReturn: s.nav == null ? null : roundAmount(s.nav - 1, 6),
        drawdown: s.drawdown,
        carried: s.carriedBrokers.length > 0,
        carriedBrokers: s.carriedBrokers,
        warning: s.largeFlow ? "本月净值受大额出入金影响" : null,
      })),
      kpi: {
        cumulativeReturn,
        annualizedReturn,
        annualizedPartial: annualizedReturn != null && monthsSpan < 12,
        maxDrawdown,
        cumulativeInDisplay: cvt(capital.totalInUsd),
        cumulativeOutDisplay: cvt(capital.totalOutUsd),
        netInvestedDisplay: cvt(capital.netInvestedUsd),
        latestMonthPnlDisplay: series.at(-1)?.pnlUsd == null ? null : cvt(series.at(-1)!.pnlUsd!),
        avgMonthlyPnlDisplay: avgMonthlyPnlUsd == null ? null : cvt(avgMonthlyPnlUsd),
        monthCount: navPoints.length,
      },
    };
  }

  /** 已平仓统计：仅 side='sell' 且 realized_gain_loss 非空的交易，浮盈不计入。 */
  function closedStats(userId: number, display: Currency = "USD") {
    const rows = db
      .prepare(
        `SELECT id, market, currency, symbol, name, side, trade_date, quantity, fee, realized_gain_loss, fx_to_usd, reason
         FROM trades WHERE user_id = ? ORDER BY trade_date, id`,
      )
      .all(userId) as Array<{
      id: number;
      market: string;
      currency: string;
      symbol: string;
      name: string;
      side: "buy" | "sell";
      trade_date: string;
      quantity: number;
      fee: number;
      realized_gain_loss: number | null;
      fx_to_usd: number | null;
      reason: string | null;
    }>;
    const cvt = (amountUsd: number) => roundAmount(fromUsd(amountUsd, display, fxToUsd));

    const holding = holdingDays(rows);
    const closed: Array<{ id: number; symbol: string; market: string; tradeDate: string; pnlUsd: number; reason: string | null; holdingDays: number | null }> = [];
    let unknownCount = 0;
    for (const row of rows) {
      if (row.side !== "sell") continue;
      if (row.realized_gain_loss == null) {
        unknownCount += 1;
        continue;
      }
      closed.push({
        id: row.id,
        symbol: row.symbol,
        market: normalizeMarket(row.market),
        tradeDate: row.trade_date,
        pnlUsd: usd(row.realized_gain_loss, row.currency, row.fx_to_usd),
        reason: row.reason,
        holdingDays: holding.get(row.id) ?? null,
      });
    }

    const wins = closed.filter((t) => t.pnlUsd > 0);
    const losses = closed.filter((t) => t.pnlUsd < 0);
    const avgWinUsd = wins.length ? wins.reduce((s, t) => s + t.pnlUsd, 0) / wins.length : null;
    const avgLossUsd = losses.length ? losses.reduce((s, t) => s + t.pnlUsd, 0) / losses.length : null;
    const knownHold = closed.filter((t) => t.holdingDays != null).map((t) => t.holdingDays as number);
    const perf = ledger.performanceSummary(userId);
    // 已实现口径经济盈亏：已实现资本利得 + 净股息 − 交易/融资费用（不含浮盈，与胜率同口径）
    const economicUsd = perf.realizedCapitalGainUsd + perf.dividendsNetUsd - perf.tradingFeesUsd - perf.financingFeesUsd;

    return {
      display,
      closedCount: closed.length,
      unknownCount,
      winCount: wins.length,
      lossCount: losses.length,
      winRate: closed.length ? roundAmount(wins.length / closed.length, 4) : null,
      avgWinDisplay: avgWinUsd == null ? null : cvt(avgWinUsd),
      avgLossDisplay: avgLossUsd == null ? null : cvt(avgLossUsd),
      payoffRatio: avgWinUsd != null && avgLossUsd != null && avgLossUsd !== 0 ? roundAmount(avgWinUsd / Math.abs(avgLossUsd), 4) : null,
      maxWinDisplay: wins.length ? cvt(Math.max(...wins.map((t) => t.pnlUsd))) : null,
      maxLossDisplay: losses.length ? cvt(Math.min(...losses.map((t) => t.pnlUsd))) : null,
      avgHoldingDays: knownHold.length ? roundAmount(knownHold.reduce((s, v) => s + v, 0) / knownHold.length, 1) : null,
      totalFeesDisplay: cvt(perf.tradingFeesUsd + perf.financingFeesUsd),
      feeRatio: economicUsd !== 0 ? roundAmount((perf.tradingFeesUsd + perf.financingFeesUsd) / Math.abs(economicUsd), 4) : null,
      histogram: buildHistogram(closed.map((t) => t.pnlUsd), display),
      openHoldingAges: openHoldingAges(rows),
    };

    function buildHistogram(pnls: number[], displayCcy: Currency) {
      const BUCKETS = 11;
      const half = (BUCKETS - 1) / 2; // 5
      if (pnls.length === 0) return { bucketWidthDisplay: 0, buckets: [] as Array<{ from: number | null; to: number | null; count: number }> };
      const sortedAbs = pnls.map((v) => Math.abs(v)).sort((a, b) => a - b);
      const p95 = sortedAbs[Math.min(sortedAbs.length - 1, Math.floor(sortedAbs.length * 0.95))] || 1;
      const widthUsd = Math.max(p95 / half, 1e-9);
      const counts = new Array(BUCKETS).fill(0) as number[];
      for (const v of pnls) {
        // 中心桶跨 (-w/2, w/2]，两翼逐桶外推；超出范围 clamp 到边缘桶
        const index = Math.max(0, Math.min(BUCKETS - 1, Math.round(v / widthUsd) + half));
        counts[index] += 1;
      }
      const widthDisplay = roundAmount(fromUsd(widthUsd, displayCcy, fxToUsd));
      return {
        bucketWidthDisplay: widthDisplay,
        buckets: counts.map((count, i) => ({
          from: i === 0 ? null : roundAmount((i - half - 0.5) * widthDisplay),
          to: i === BUCKETS - 1 ? null : roundAmount((i - half + 0.5) * widthDisplay),
          count,
        })),
      };
    }
  }

  /** FIFO 近似：平仓单 id -> 持有天数；无法配对（如转仓入后卖出）为缺失。 */
  function holdingDays(
    rows: Array<{ id: number; market: string; symbol: string; side: "buy" | "sell"; trade_date: string; quantity: number }>,
  ): Map<number, number> {
    const result = new Map<number, number>();
    const bySymbol = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = `${normalizeMarket(row.market)}:${row.symbol}`;
      const list = bySymbol.get(key) ?? [];
      list.push(row);
      bySymbol.set(key, list);
    }
    for (const list of bySymbol.values()) {
      const buys = list.filter((r) => r.side === "buy");
      let soldCum = 0;
      for (const sell of list.filter((r) => r.side === "sell")) {
        soldCum += sell.quantity;
        let buyCum = 0;
        let matched: string | null = null;
        for (const buy of buys) {
          buyCum += buy.quantity;
          if (buyCum >= soldCum - 1e-9) {
            matched = buy.trade_date;
            break;
          }
        }
        if (matched != null) result.set(sell.id, diffDays(matched, sell.trade_date));
      }
    }
    return result;
  }

  /** 当前仍持有（净数量 > 0）标的的首次买入日与持有天数（无买入记录的持仓不在列）。 */
  function openHoldingAges(
    rows: Array<{ market: string; symbol: string; side: "buy" | "sell"; trade_date: string; quantity: number }>,
  ) {
    const agg = new Map<string, { firstBuy: string | null; net: number }>();
    for (const row of rows) {
      const key = `${normalizeMarket(row.market)}:${row.symbol}`;
      const item = agg.get(key) ?? { firstBuy: null, net: 0 };
      if (row.side === "buy") {
        item.net += row.quantity;
        if (item.firstBuy == null || row.trade_date < item.firstBuy) item.firstBuy = row.trade_date;
      } else {
        item.net -= row.quantity;
      }
      agg.set(key, item);
    }
    const today = new Date().toISOString().slice(0, 10);
    return Array.from(agg.entries())
      .filter(([, item]) => item.net > 1e-9 && item.firstBuy != null)
      .map(([key, item]) => ({ key, firstBuyDate: item.firstBuy as string, days: diffDays(item.firstBuy as string, today) }));
  }

  const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

  function requireMonth(value: unknown): string {
    const text = String(value ?? "");
    if (!MONTH_RE.test(text)) throw new ValidationError("月份需为 YYYY-MM");
    return text;
  }

  /** 月度复盘：自动块即时计算 + 手填块读库。 */
  function review(userId: number, month: string, scope: PerformanceScope = "self", display: Currency = "USD") {
    requireMonth(month);
    const cvt = (amountUsd: number) => roundAmount(fromUsd(amountUsd, display, fxToUsd));
    const points = monthlyNetAssets(userId, scope);
    const flows = monthlyFlows(userId, scope);
    for (const p of points) p.flowUsd = flows.get(p.month) ?? 0;
    const series = buildNavSeries(points);
    const index = series.findIndex((s) => s.month === month);
    const current = index >= 0 ? series[index] : null;
    const prev = index > 0 ? series[index - 1] : null;
    const upTo = index >= 0 ? series.slice(0, index + 1) : [];
    const maxDrawdownToDate = upTo.length ? roundAmount(Math.min(...upTo.map((s) => s.drawdown ?? 0)), 6) : null;
    const monthlyReturn =
      current?.nav != null && prev?.nav != null && prev.nav > 0 ? roundAmount(current.nav / prev.nav - 1, 6) : null;

    // 当月平仓交易 TOP3（USD 排序，展示经 display 换算）
    const closedRows = db
      .prepare(
        `SELECT id, market, currency, symbol, name, trade_date, quantity, realized_gain_loss, fx_to_usd, reason
         FROM trades
         WHERE user_id = ? AND side = 'sell' AND realized_gain_loss IS NOT NULL AND substr(trade_date, 1, 7) = ?`,
      )
      .all(userId, month) as Array<{
      id: number;
      market: string;
      currency: string;
      symbol: string;
      name: string;
      trade_date: string;
      quantity: number;
      realized_gain_loss: number;
      fx_to_usd: number | null;
      reason: string | null;
    }>;
    const closed = closedRows.map((row) => ({
      id: row.id,
      symbol: row.symbol,
      market: normalizeMarket(row.market),
      name: row.name,
      tradeDate: row.trade_date,
      pnlUsd: usd(row.realized_gain_loss, row.currency, row.fx_to_usd),
      reason: row.reason,
    }));
    const topWins = closed.filter((t) => t.pnlUsd > 0).sort((a, b) => b.pnlUsd - a.pnlUsd).slice(0, 3);
    const topLosses = closed.filter((t) => t.pnlUsd < 0).sort((a, b) => a.pnlUsd - b.pnlUsd).slice(0, 3);

    const feeRow = db
      .prepare(
        `SELECT COALESCE(SUM(ABS(fee) * COALESCE(fx_to_usd, 1)), 0) AS fees FROM trades
         WHERE user_id = ? AND substr(trade_date, 1, 7) = ?`,
      )
      .get(userId, month) as { fees: number };

    // 纪律审计 (a)：当月是否存在稳健仓买入（定投执行）
    const stableBuys = db
      .prepare(
        `SELECT COUNT(*) AS n FROM trades WHERE user_id = ? AND side = 'buy' AND bucket = 'stable' AND substr(trade_date, 1, 7) = ?`,
      )
      .get(userId, month) as { n: number };
    // 纪律审计 (b)：月末现金率 ≥ cashFloor
    const riskRow = db.prepare("SELECT cash_floor FROM risk_settings WHERE user_id = ?").get(userId) as
      | { cash_floor: number }
      | undefined;
    const cashFloor = riskRow?.cash_floor ?? 0.3;
    const cashRatio = current && current.netAssetsUsd > 0 ? points[index].cashUsd / current.netAssetsUsd : null;

    const manual = db
      .prepare(
        `SELECT month, attribution, mistakes, improvements, macro_note AS macroNote, created_at AS createdAt, updated_at AS updatedAt
         FROM monthly_reviews WHERE user_id = ? AND month = ?`,
      )
      .get(userId, month) as
      | { month: string; attribution: string; mistakes: string; improvements: string; macroNote: string; createdAt: string; updatedAt: string }
      | undefined;

    return {
      month,
      display,
      scope,
      auto: current == null
        ? null
        : {
            startAssetsDisplay: prev == null ? null : cvt(prev.netAssetsUsd),
            endAssetsDisplay: cvt(current.netAssetsUsd),
            assetsChangeDisplay: prev == null ? null : cvt(current.netAssetsUsd - prev.netAssetsUsd),
            flowDisplay: cvt(current.flowUsd),
            pnlDisplay: current.pnlUsd == null ? null : cvt(current.pnlUsd),
            monthlyReturn,
            maxDrawdownToDate,
            topWins: topWins.map((t) => ({ ...t, pnlDisplay: cvt(t.pnlUsd), pnlUsd: undefined })),
            topLosses: topLosses.map((t) => ({ ...t, pnlDisplay: cvt(t.pnlUsd), pnlUsd: undefined })),
            closedCount: closed.length,
            feesDisplay: cvt(feeRow.fees),
            discipline: [
              {
                key: "stable_dca",
                ok: stableBuys.n > 0,
                note: stableBuys.n > 0 ? `本月稳健仓买入 ${stableBuys.n} 笔，定投已执行` : "本月未见稳健仓定投买入",
              },
              {
                key: "cash_floor",
                ok: cashRatio != null && cashRatio >= cashFloor,
                note:
                  cashRatio == null
                    ? "缺月末现金数据，无法审计现金底线"
                    : `月末现金率 ${(cashRatio * 100).toFixed(1)}%，底线 ${(cashFloor * 100).toFixed(0)}%`,
              },
            ],
          },
      manual: manual ?? { month, attribution: "", mistakes: "", improvements: "", macroNote: "", createdAt: null, updatedAt: null },
    };
  }

  function saveReview(userId: number, month: string, input: { attribution?: string; mistakes?: string; improvements?: string; macroNote?: string }) {
    requireMonth(month);
    db.prepare(
      `INSERT INTO monthly_reviews (user_id, month, attribution, mistakes, improvements, macro_note)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, month) DO UPDATE SET
         attribution = excluded.attribution,
         mistakes = excluded.mistakes,
         improvements = excluded.improvements,
         macro_note = excluded.macro_note,
         updated_at = datetime('now')`,
    ).run(
      userId,
      month,
      String(input.attribution ?? ""),
      String(input.mistakes ?? ""),
      String(input.improvements ?? ""),
      String(input.macroNote ?? ""),
    );
  }

  function listReviews(userId: number) {
    return db
      .prepare(
        `SELECT month, attribution, mistakes, improvements, macro_note AS macroNote, updated_at AS updatedAt
         FROM monthly_reviews WHERE user_id = ? ORDER BY month DESC`,
      )
      .all(userId);
  }

  return { performance, closedStats, review, saveReview, listReviews };
}

export function parseScope(value: unknown): PerformanceScope {
  const text = String(value ?? "self");
  if (text !== "self" && text !== "all") throw new ValidationError("scope 仅支持 self/all");
  return text;
}

function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

function diffDays(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}
