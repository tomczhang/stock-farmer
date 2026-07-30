import type { AppDatabase } from "./db.js";
import { ValidationError } from "./errors.js";
import { BUCKETS, coverage, instrumentKey, normalizeMarket, requireCurrency } from "./finance.js";
import type { LedgerService } from "./ledger.js";
import type {
  Bucket,
  CashBalanceInput,
  Currency,
  PositionInput,
  StatementPayload,
  SummaryInstrument,
  TradeInput,
} from "./types.js";

export { ValidationError } from "./errors.js";
export const BUCKET_LABELS: Record<string, string> = {
  aggressive: "进取仓",
  defensive: "防守仓",
  stable: "稳健仓",
  grant: "授予仓",
  unassigned: "未分类",
};

function asCurrency(value: unknown): Currency {
  return requireCurrency(value);
}

function validatePayload(payload: StatementPayload) {
  if (!payload.broker?.trim()) throw new ValidationError("缺少券商标识");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.asOf ?? "")) throw new ValidationError("as_of 需为 YYYY-MM-DD");
  if (!Array.isArray(payload.positions)) throw new ValidationError("positions 需为数组");
  if (!Array.isArray(payload.cashBalances)) throw new ValidationError("cashBalances 需为数组");
  for (const p of payload.positions) {
    if (!p.symbol?.trim()) throw new ValidationError("持仓缺少 symbol");
    if (!Number.isFinite(p.quantity) || !Number.isFinite(p.marketValue)) {
      throw new ValidationError(`持仓 ${p.symbol} 的数量/市值非法`);
    }
  }
  for (const c of payload.cashBalances) {
    if (!Number.isFinite(c.amount)) throw new ValidationError("现金金额非法");
  }
}

function validateTrade(trade: TradeInput) {
  if (!trade.symbol?.trim()) throw new ValidationError("交易缺少标的代码");
  if (!["buy", "sell"].includes(trade.side)) throw new ValidationError("交易方向非法");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trade.tradeDate ?? "")) throw new ValidationError("交易日期需为 YYYY-MM-DD");
  if (!(trade.quantity > 0)) throw new ValidationError("交易数量需大于 0");
  if (!(trade.price > 0)) throw new ValidationError("成交价需大于 0");
  if (trade.fee != null && trade.fee < 0) throw new ValidationError("手续费不能为负");
}

interface TradeAgg {
  netCost: number; // 买入净额 − 卖出净额（含手续费，可为负 = 已回本）
  netQty: number;
  lastPrice: number;
  lastDate: string;
  broker: string;
  market: string;
  currency: string;
  name: string;
}

export function createPortfolioService(db: AppDatabase, fxToUsd: Record<string, number>, ledger?: LedgerService) {
  const insertStatement = db.prepare(
    "INSERT INTO statements (user_id, broker, file_name, as_of, parsed_json) VALUES (?, ?, ?, ?, ?)",
  );
  const insertPosition = db.prepare(
    `INSERT INTO positions (user_id, statement_id, as_of, broker, market, currency, symbol, name, quantity, market_value, cost_basis, unrealized_gl)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertCash = db.prepare(
    `INSERT INTO cash_balances (user_id, statement_id, as_of, broker, currency, amount, source)
     VALUES (?, ?, ?, ?, ?, ?, 'parsed')`,
  );

  const saveStatementTx = db.transaction((userId: number, payload: StatementPayload) => {
    // 同券商同 as_of 覆盖旧快照，避免重复上传叠加
    const stale = db
      .prepare("SELECT id FROM statements WHERE user_id = ? AND broker = ? AND as_of = ?")
      .all(userId, payload.broker, payload.asOf) as Array<{ id: number }>;
    for (const row of stale) {
      db.prepare("DELETE FROM statements WHERE id = ?").run(row.id);
    }
    const result = insertStatement.run(
      userId,
      payload.broker,
      payload.fileName ?? "",
      payload.asOf,
      JSON.stringify(payload.parsedMeta ?? {}),
    );
    const statementId = Number(result.lastInsertRowid);
    for (const p of payload.positions) {
      insertPosition.run(
        userId,
        statementId,
        payload.asOf,
        payload.broker,
        normalizeMarket(p.market),
        asCurrency(p.currency),
        p.symbol.trim().toUpperCase(),
        p.name ?? p.symbol,
        p.quantity,
        p.marketValue,
        p.costBasis ?? null,
        p.unrealizedGl ?? null,
      );
    }
    for (const c of payload.cashBalances) {
      insertCash.run(userId, statementId, payload.asOf, payload.broker, asCurrency(c.currency), c.amount);
    }
    if (ledger) {
      const importIssues = ledger.importStatementEvents(userId, statementId, payload);
      db.prepare("UPDATE statements SET parsed_json = ? WHERE id = ?").run(
        JSON.stringify({ ...(payload.parsedMeta ?? {}), importIssues }),
        statementId,
      );
    }
    return statementId;
  });

  function toUsd(amount: number, currency: string) {
    return amount * (fxToUsd[currency] ?? 1);
  }

  function fromUsd(amount: number, currency: string) {
    return amount / (fxToUsd[currency] ?? 1);
  }

  /** 每个券商取最新 as_of 的持仓与现金；manual 现金覆盖 parsed。 */
  function latestHoldings(userId: number) {
    const brokers = db
      .prepare("SELECT broker, MAX(as_of) AS as_of FROM statements WHERE user_id = ? GROUP BY broker")
      .all(userId) as Array<{ broker: string; as_of: string }>;

    const positions: Array<{
      broker: string;
      market: string;
      currency: string;
      symbol: string;
      name: string;
      quantity: number;
      market_value: number;
      cost_basis: number | null;
      unrealized_gl: number | null;
      as_of: string;
    }> = [];
    for (const b of brokers) {
      const stored = db
        .prepare("SELECT * FROM positions WHERE user_id = ? AND broker = ? AND as_of = ?")
        .all(userId, b.broker, b.as_of) as typeof positions;
      positions.push(...stored.map((row) => ({ ...row, market: normalizeMarket(row.market) })));
    }

    const cashMap = new Map<string, { broker: string; currency: string; amount: number; source: string; as_of: string }>();
    for (const b of brokers) {
      const rows = db
        .prepare(
          "SELECT broker, currency, amount, source, as_of FROM cash_balances WHERE user_id = ? AND broker = ? AND as_of = ? AND source = 'parsed'",
        )
        .all(userId, b.broker, b.as_of) as Array<{ broker: string; currency: string; amount: number; source: string; as_of: string }>;
      for (const row of rows) cashMap.set(`${row.broker}|${row.currency}`, row);
    }
    const manualRows = db
      .prepare(
        `SELECT broker, currency, amount, source, as_of FROM cash_balances
         WHERE user_id = ? AND source = 'manual'
         AND id IN (SELECT MAX(id) FROM cash_balances WHERE user_id = ? AND source = 'manual' GROUP BY broker, currency)`,
      )
      .all(userId, userId) as Array<{ broker: string; currency: string; amount: number; source: string; as_of: string }>;
    for (const row of manualRows) cashMap.set(`${row.broker}|${row.currency}`, row);

    // 货币基金（market=FUND）视同现金等价物：从持仓拆出并入现金，参与闲置现金与加仓安全线；
    // 其利息分红已作为收益事件入账，因此本金口径 = 当前价值 − 累计股息，外部净投入不受影响。
    const fundPositions = positions.filter((p) => p.market === "FUND");
    const investPositions = positions.filter((p) => p.market !== "FUND");
    const cash: Array<{ broker: string; currency: string; amount: number; source: string; as_of: string; label?: string }> = [
      ...Array.from(cashMap.values()),
      ...fundPositions.map((p) => ({
        broker: p.broker,
        currency: p.currency,
        amount: p.market_value,
        source: "money_fund",
        as_of: p.as_of,
        label: p.name && p.name !== p.symbol ? `${p.symbol} ${p.name}` : p.symbol,
      })),
    ];

    return { brokers, positions: investPositions, cash };
  }

  /** 交易流水按 broker+symbol 聚合净成本/净数量。 */
  function tradeAggregates(userId: number): Map<string, TradeAgg> {
    const rows = db
      .prepare("SELECT * FROM trades WHERE user_id = ? ORDER BY trade_date, id")
      .all(userId) as Array<{
      broker: string;
      market: string;
      currency: string;
      symbol: string;
      name: string;
      side: string;
      trade_date: string;
      quantity: number;
      price: number;
      fee: number;
    }>;
    const map = new Map<string, TradeAgg>();
    for (const t of rows) {
      const key = `${t.broker}|${t.symbol}`;
      const agg = map.get(key) ?? {
        netCost: 0,
        netQty: 0,
        lastPrice: t.price,
        lastDate: t.trade_date,
        broker: t.broker,
        market: normalizeMarket(t.market),
        currency: t.currency,
        name: t.name,
      };
      if (t.side === "buy") {
        agg.netCost += t.quantity * t.price + t.fee;
        agg.netQty += t.quantity;
      } else {
        agg.netCost -= t.quantity * t.price - t.fee;
        agg.netQty -= t.quantity;
      }
      agg.lastPrice = t.price;
      agg.lastDate = t.trade_date;
      map.set(key, agg);
    }
    return map;
  }

  function bucketMap(userId: number): Map<string, string> {
    const rows = db.prepare("SELECT symbol, bucket FROM symbol_buckets WHERE user_id = ?").all(userId) as Array<{
      symbol: string;
      bucket: string;
    }>;
    return new Map(rows.map((r) => [r.symbol, r.bucket]));
  }

  function overrideMap(userId: number): Map<string, number> {
    const rows = db
      .prepare("SELECT broker, symbol, cost_basis FROM cost_overrides WHERE user_id = ?")
      .all(userId) as Array<{ broker: string; symbol: string; cost_basis: number }>;
    return new Map(rows.map((r) => [`${r.broker}|${r.symbol}`, r.cost_basis]));
  }

  /** 近 1 年按月聚合：每月每券商取当月最新快照，汇总市值/成本/标的数（USD 口径；货币基金视同现金不计入）。 */
  function history(userId: number) {
    const rows = db
      .prepare(
        `SELECT p.* FROM positions p
         WHERE p.user_id = ? AND p.market != 'FUND' AND p.as_of >= date('now', '-1 year', 'start of month')`,
      )
      .all(userId) as Array<{
      broker: string;
      currency: string;
      as_of: string;
      market: string;
      market_value: number;
      cost_basis: number | null;
      symbol: string;
    }>;
    // 每月每券商最新 as_of
    const latestPerBrokerMonth = new Map<string, string>();
    for (const row of rows) {
      const key = `${row.as_of.slice(0, 7)}|${row.broker}`;
      const current = latestPerBrokerMonth.get(key);
      if (!current || row.as_of > current) latestPerBrokerMonth.set(key, row.as_of);
    }
    const byMonth = new Map<
      string,
      { valueUsd: number; knownCostUsd: number; knownCosts: number; totalCosts: number; missing: string[]; symbols: Set<string> }
    >();
    for (const row of rows) {
      const month = row.as_of.slice(0, 7);
      if (latestPerBrokerMonth.get(`${month}|${row.broker}`) !== row.as_of) continue;
      const entry = byMonth.get(month) ?? {
        valueUsd: 0,
        knownCostUsd: 0,
        knownCosts: 0,
        totalCosts: 0,
        missing: [],
        symbols: new Set<string>(),
      };
      entry.valueUsd += toUsd(row.market_value, row.currency);
      entry.totalCosts += 1;
      if (row.cost_basis != null) {
        entry.knownCostUsd += toUsd(row.cost_basis, row.currency);
        entry.knownCosts += 1;
      } else {
        entry.missing.push(`book_cost:${normalizeMarket(row.market)}:${row.symbol}`);
      }
      entry.symbols.add(row.symbol);
      byMonth.set(month, entry);
    }
    return Array.from(byMonth.entries())
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([month, e]) => {
        const complete = e.knownCosts === e.totalCosts;
        return {
          month,
          valueUsd: e.valueUsd,
          costUsd: complete ? e.knownCostUsd : null,
          knownCostUsd: e.knownCostUsd,
          gainLossUsd: complete ? e.valueUsd - e.knownCostUsd : null,
          symbolCount: e.symbols.size,
          coverage: coverage(e.totalCosts, e.knownCosts, e.missing),
        };
      });
  }

  return {
    saveStatement(userId: number, payload: StatementPayload) {
      validatePayload(payload);
      return saveStatementTx(userId, payload);
    },

    listStatements(userId: number) {
      return db
        .prepare(
          `SELECT s.id, s.broker, s.file_name AS fileName, s.as_of AS asOf, s.uploaded_at AS uploadedAt,
                  (SELECT COUNT(*) FROM positions p WHERE p.statement_id = s.id) AS positionCount,
                  (SELECT COUNT(*) FROM cash_balances c WHERE c.statement_id = s.id) AS cashCount
           FROM statements s WHERE s.user_id = ? ORDER BY s.as_of DESC, s.broker`,
        )
        .all(userId);
    },

    deleteStatement(userId: number, statementId: number) {
      const result = db
        .prepare("DELETE FROM statements WHERE id = ? AND user_id = ?")
        .run(statementId, userId);
      return result.changes > 0;
    },

    upsertManualCash(userId: number, cash: CashBalanceInput & { asOf?: string }) {
      if (!Number.isFinite(cash.amount)) throw new ValidationError("现金金额非法");
      if (!cash.broker?.trim()) throw new ValidationError("缺少券商标识");
      const asOf = cash.asOf ?? new Date().toISOString().slice(0, 10);
      db.prepare(
        `INSERT INTO cash_balances (user_id, statement_id, as_of, broker, currency, amount, source)
         VALUES (?, NULL, ?, ?, ?, ?, 'manual')`,
      ).run(userId, asOf, cash.broker, asCurrency(cash.currency), cash.amount);
    },

    /** 清除某券商+币种的手动现金覆盖，恢复月结单解析口径。 */
    clearManualCash(userId: number, broker: string, currency: string) {
      if (!broker?.trim()) throw new ValidationError("缺少券商标识");
      return db
        .prepare("DELETE FROM cash_balances WHERE user_id = ? AND broker = ? AND currency = ? AND source = 'manual'")
        .run(userId, broker.trim(), asCurrency(currency)).changes > 0;
    },

    addTrade(userId: number, trade: TradeInput) {
      validateTrade(trade);
      const result = db
        .prepare(
          `INSERT INTO trades
           (user_id, broker, market, currency, symbol, name, side, trade_date, quantity, price, fee, gross_amount, bucket, fx_to_usd)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          userId,
          trade.broker?.trim() || "manual",
          normalizeMarket(trade.market),
          asCurrency(trade.currency),
          trade.symbol.trim().toUpperCase(),
          trade.name?.trim() || trade.symbol.trim().toUpperCase(),
          trade.side,
          trade.tradeDate,
          trade.quantity,
          trade.price,
          trade.fee ?? 0,
          trade.quantity * trade.price,
          ledger?.bucketFor(userId, trade.market, trade.symbol) ?? null,
          fxToUsd[asCurrency(trade.currency)] ?? 1,
        );
      return Number(result.lastInsertRowid);
    },

    listTrades(userId: number) {
      return db
        .prepare(
          `SELECT id, broker, market, currency, symbol, name, side, trade_date AS tradeDate,
                  quantity, price, fee, source, created_at AS createdAt
           FROM trades WHERE user_id = ? ORDER BY trade_date DESC, id DESC`,
        )
        .all(userId);
    },

    deleteTrade(userId: number, tradeId: number) {
      return db.prepare("DELETE FROM trades WHERE id = ? AND user_id = ?").run(tradeId, userId).changes > 0;
    },

    setBucket(userId: number, symbol: string, bucket: Bucket | null, market?: string) {
      const sym = String(symbol ?? "").trim().toUpperCase();
      if (!sym) throw new ValidationError("缺少标的代码");
      if (bucket === null) {
        db.prepare("DELETE FROM symbol_buckets WHERE user_id = ? AND symbol = ?").run(userId, sym);
        if (market) {
          db.prepare("DELETE FROM instrument_buckets WHERE user_id = ? AND market = ? AND symbol = ?").run(
            userId,
            normalizeMarket(market),
            sym,
          );
        } else {
          db.prepare("DELETE FROM instrument_buckets WHERE user_id = ? AND symbol = ?").run(userId, sym);
        }
        return;
      }
      if (!BUCKETS.includes(bucket)) throw new ValidationError("仓别非法（aggressive/defensive/stable/grant）");
      db.prepare(
        "INSERT INTO symbol_buckets (user_id, symbol, bucket) VALUES (?, ?, ?) ON CONFLICT(user_id, symbol) DO UPDATE SET bucket = excluded.bucket",
      ).run(userId, sym, bucket);
      const markets = market
        ? [normalizeMarket(market)]
        : (db.prepare("SELECT DISTINCT market FROM positions WHERE user_id = ? AND symbol = ?").all(userId, sym) as Array<{ market: string }>).map(
            (row) => row.market,
          );
      for (const itemMarket of markets) {
        db.prepare(
          `INSERT INTO instrument_buckets (user_id, market, symbol, bucket) VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id, market, symbol) DO UPDATE SET bucket = excluded.bucket, updated_at = datetime('now')`,
        ).run(userId, itemMarket, sym, bucket);
      }
    },

    setCostOverride(userId: number, broker: string, symbol: string, costBasis: number | null) {
      const sym = String(symbol ?? "").trim().toUpperCase();
      if (!broker?.trim() || !sym) throw new ValidationError("缺少券商或标的");
      if (costBasis === null) {
        db.prepare("DELETE FROM cost_overrides WHERE user_id = ? AND broker = ? AND symbol = ?").run(userId, broker, sym);
        return;
      }
      if (!Number.isFinite(costBasis) || costBasis < 0) throw new ValidationError("成本非法");
      db.prepare(
        `INSERT INTO cost_overrides (user_id, broker, symbol, cost_basis) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, broker, symbol) DO UPDATE SET cost_basis = excluded.cost_basis, updated_at = datetime('now')`,
      ).run(userId, broker, sym, costBasis);
    },

    /** 闲置现金合计（USD 口径），供加仓计划校验用。 */
    idleCashUsd(userId: number) {
      const { cash } = latestHoldings(userId);
      return cash.reduce((sum, c) => sum + toUsd(c.amount, c.currency), 0);
    },

    /** scope=self 时剔除授予仓（RSU），只看自主投资组合；grant 块始终返回授予资产概况。 */
    summary(userId: number, display: Currency, quotes?: Map<string, number>, scope: "all" | "self" = "all") {
      const { brokers, positions, cash } = latestHoldings(userId);
      const trades = tradeAggregates(userId);
      const buckets = bucketMap(userId);
      const overrides = overrideMap(userId);
      const cvt = (amountUsd: number) => fromUsd(amountUsd, display);
      const capital = ledger?.capitalSummary(userId);
      const performance = ledger?.performanceSummary(userId);

      const staleQuotes: string[] = [];
      const seenKeys = new Set(positions.map((p) => `${p.broker}|${p.symbol}`));

      // 纯手动交易建立的持仓（快照中不存在且净数量 > 0）
      const synthetic = Array.from(trades.entries())
        .filter(([key, agg]) => !seenKeys.has(key) && agg.netQty > 0.000001)
        .map(([key, agg]) => ({
          broker: agg.broker,
          market: agg.market,
          currency: agg.currency,
          symbol: key.split("|")[1],
          name: agg.name,
          quantity: agg.netQty,
          market_value: agg.netQty * agg.lastPrice,
          cost_basis: null as number | null,
          unrealized_gl: null as number | null,
          as_of: agg.lastDate,
        }));

      const preparedPositions = [...positions, ...synthetic].map((p) => {
        const market = normalizeMarket(p.market);
        let marketValue = p.market_value;
        let quoteApplied = false;
        const quote = quotes?.get(`${market}:${p.symbol}`);
        if (quote && quote > 0 && p.quantity > 0) {
          marketValue = quote * p.quantity;
          quoteApplied = true;
        } else if (quotes) {
          staleQuotes.push(p.symbol);
        }
        return {
          position: { ...p, market },
          marketValue,
          quoteApplied,
          quote: quoteApplied ? quote! : null,
          valueUsd: toUsd(marketValue, p.currency),
        };
      });
      const allPositionRows = preparedPositions.map(({ position: p, marketValue, quoteApplied, quote, valueUsd }) => {
        const key = `${p.broker}|${p.symbol}`;
        // 账面成本只能来自人工确认或券商快照；交易净额绝不覆盖。
        const effectiveCost = overrides.get(key) ?? p.cost_basis ?? null;
        const costSource = overrides.has(key) ? "manual" : p.cost_basis != null ? "statement" : "none";
        const currentPrice = quoteApplied ? quote : p.quantity > 0 ? marketValue / p.quantity : null;
        const costUsd = effectiveCost != null ? toUsd(effectiveCost, p.currency) : null;
        const instrument = instrumentKey(p.market, p.symbol);
        const unrealizedUsd = costUsd == null ? null : valueUsd - costUsd;
        const rowMissing = costUsd == null ? ["book_cost"] : [];
        return {
          broker: p.broker,
          market: p.market,
          currency: p.currency,
          symbol: p.symbol,
          name: p.name,
          quantity: p.quantity,
          asOf: p.as_of,
          marketValue,
          currentPrice,
          quoteApplied,
          bucket: ledger?.bucketFor(userId, p.market, p.symbol) ?? buckets.get(p.symbol) ?? "unassigned",
          effectiveCost,
          costSource,
          valueDisplay: cvt(valueUsd),
          costDisplay: costUsd != null ? cvt(costUsd) : null,
          gainLossDisplay: unrealizedUsd != null ? cvt(unrealizedUsd) : null,
          bookCost: effectiveCost,
          bookCostDisplay: costUsd != null ? cvt(costUsd) : null,
          bookCostSource: costSource,
          instrumentKey: instrument,
          externalNetInvested: null,
          knownExternalNetInvested: null,
          externalNetInvestedScope: "instrument_only",
          holdingRatio: 0,
          rowHoldingRatio: 0,
          pnl: {
            realizedCapitalGain: null,
            unrealizedCapitalGain: unrealizedUsd == null ? null : cvt(unrealizedUsd),
            capitalGain: null,
            dividendsGross: null,
            dividendsNet: null,
            tradingFees: null,
            financingFees: null,
            knownTotal: unrealizedUsd == null ? null : cvt(unrealizedUsd),
            total: null,
            explainedTotal: null,
            economicTotal: null,
            unexplained: null,
            scope: "broker_position_only",
            instrumentKey: instrument,
            financingScope: "instrument_only",
          },
          coverage: coverage(
            1,
            costUsd == null ? 0 : 1,
            rowMissing,
            ["instrument_level_events_are_reported_in_instruments"],
          ),
        };
      });

      // 授予仓（RSU 等公司授予资产）概况：两种 scope 下都返回，供前端展示隐藏提示
      const grantRows = allPositionRows.filter((row) => row.bucket === "grant");
      const grantValueUsd = grantRows.reduce((sum, row) => sum + toUsd(row.marketValue, row.currency), 0);
      const grantInfo = {
        count: new Set(grantRows.map((row) => instrumentKey(row.market, row.symbol))).size,
        symbols: Array.from(new Set(grantRows.map((row) => row.symbol))).sort(),
        valueDisplay: Math.round(cvt(grantValueUsd) * 100) / 100,
      };
      const positionRows = scope === "self" ? allPositionRows.filter((row) => row.bucket !== "grant") : allPositionRows;

      const positionsValueUsd = positionRows.reduce(
        (sum, p) => sum + toUsd(p.marketValue, p.currency),
        0,
      );
      const totalCostUsd = positionRows.reduce(
        (sum, p) => sum + (p.effectiveCost != null ? toUsd(p.effectiveCost, p.currency) : 0),
        0,
      );
      const cashUsd = cash.reduce((sum, c) => sum + toUsd(c.amount, c.currency), 0);
      const totalUsd = positionsValueUsd + cashUsd;
      const instrumentValues = new Map<string, number>();
      const instrumentGroups = new Map<
        string,
        {
          key: string;
          market: string;
          symbol: string;
          name: string;
          brokers: Set<string>;
          currencies: Set<string>;
          buckets: Set<string>;
          costSources: Set<string>;
          quantity: number;
          valueUsd: number;
          knownCostUsd: number;
          knownCosts: number;
          positionCount: number;
          missingCosts: string[];
          asOf: string;
          quoteApplied: number;
        }
      >();
      const symbolMarkets = new Map<string, Set<string>>();
      for (const row of positionRows) {
        const key = instrumentKey(row.market, row.symbol);
        const valueUsd = toUsd(row.marketValue, row.currency);
        instrumentValues.set(key, (instrumentValues.get(key) ?? 0) + valueUsd);
        const group = instrumentGroups.get(key) ?? {
          key,
          market: row.market,
          symbol: row.symbol,
          name: row.name,
          brokers: new Set<string>(),
          currencies: new Set<string>(),
          buckets: new Set<string>(),
          costSources: new Set<string>(),
          quantity: 0,
          valueUsd: 0,
          knownCostUsd: 0,
          knownCosts: 0,
          positionCount: 0,
          missingCosts: [],
          asOf: row.asOf,
          quoteApplied: 0,
        };
        group.brokers.add(row.broker);
        group.currencies.add(row.currency);
        group.buckets.add(row.bucket);
        group.costSources.add(row.costSource);
        group.quantity += row.quantity;
        group.valueUsd += valueUsd;
        group.positionCount += 1;
        group.asOf = row.asOf > group.asOf ? row.asOf : group.asOf;
        if (row.quoteApplied) group.quoteApplied += 1;
        if (row.effectiveCost == null) {
          group.missingCosts.push(`book_cost:${row.broker}`);
        } else {
          group.knownCostUsd += toUsd(row.effectiveCost, row.currency);
          group.knownCosts += 1;
        }
        instrumentGroups.set(key, group);
        const markets = symbolMarkets.get(row.symbol) ?? new Set<string>();
        markets.add(row.market);
        symbolMarkets.set(row.symbol, markets);
      }
      for (const row of positionRows) {
        row.rowHoldingRatio = positionsValueUsd > 0 ? toUsd(row.marketValue, row.currency) / positionsValueUsd : 0;
        row.holdingRatio = positionsValueUsd > 0 ? (instrumentValues.get(instrumentKey(row.market, row.symbol)) ?? 0) / positionsValueUsd : 0;
      }
      const instrumentRows = Array.from(instrumentGroups.values())
        .map((group): SummaryInstrument => {
          const attributed = performance?.byInstrument.get(group.key);
          const capitalItem = capital?.byInstrument.get(group.key);
          const costComplete = group.knownCosts === group.positionCount;
          const unrealizedUsd = costComplete ? group.valueUsd - group.knownCostUsd : null;
          const realizedCapitalGainUsd = attributed?.realizedCapitalGainUsd ?? 0;
          const dividendsGrossUsd = attributed?.dividendsGrossUsd ?? 0;
          const dividendsNetUsd = attributed?.dividendsNetUsd ?? 0;
          const tradingFeesUsd = attributed?.tradingFeesUsd ?? 0;
          const financingFeesUsd = attributed?.financingFeesUsd ?? 0;
          const ledgerPnlUsd = realizedCapitalGainUsd + dividendsNetUsd - tradingFeesUsd - financingFeesUsd;
          const explainedPnl = unrealizedUsd == null ? null : unrealizedUsd + ledgerPnlUsd;
          // 无标的级资本事件 = 场内现金买入，外部净投入默认 0（完整）；
          // 仅当存在转仓事件但单位成本未确认时才提示待补录。
          const externalNetInvested = capitalItem == null
            ? 0
            : capitalItem.complete
              ? cvt(capitalItem.knownUsd)
              : null;
          const capitalMissing = capitalItem && !capitalItem.complete ? ["instrument_external_net_invested"] : [];
          const bucketValues = Array.from(group.buckets);
          const costSourceValues = Array.from(group.costSources);
          const valueDisplay = cvt(group.valueUsd);
          const knownCostDisplay = cvt(group.knownCostUsd);
          return {
            key: group.key,
            market: group.market,
            symbol: group.symbol,
            name: group.name,
            brokers: Array.from(group.brokers).sort(),
            currencies: Array.from(group.currencies).sort(),
            currency: display,
            positionCount: group.positionCount,
            quantity: group.quantity,
            asOf: group.asOf,
            bucket: bucketValues.length === 1 ? bucketValues[0] : "mixed",
            marketValue: valueDisplay,
            marketValueDisplay: valueDisplay,
            valueDisplay,
            currentPrice: group.quantity > 0 ? valueDisplay / group.quantity : null,
            currentPriceDisplay: group.quantity > 0 ? valueDisplay / group.quantity : null,
            quoteApplied: group.quoteApplied === group.positionCount,
            effectiveCost: costComplete ? knownCostDisplay : null,
            costDisplay: costComplete ? knownCostDisplay : null,
            bookCost: costComplete ? knownCostDisplay : null,
            bookCostDisplay: costComplete ? knownCostDisplay : null,
            knownBookCost: knownCostDisplay,
            knownBookCostDisplay: knownCostDisplay,
            bookCostSource: (costSourceValues.length === 1 ? costSourceValues[0] : "mixed") as SummaryInstrument["bookCostSource"],
            gainLossDisplay: unrealizedUsd == null ? null : cvt(unrealizedUsd),
            holdingRatio: positionsValueUsd > 0 ? group.valueUsd / positionsValueUsd : 0,
            externalNetInvested,
            knownExternalNetInvested: cvt(capitalItem?.knownUsd ?? 0),
            externalNetInvestedScope: "instrument_direct_events",
            capitalCoverage: coverage(1, capitalMissing.length === 0 ? 1 : 0, capitalMissing),
            pnl: {
              realizedCapitalGain: cvt(realizedCapitalGainUsd),
              unrealizedCapitalGain: unrealizedUsd == null ? null : cvt(unrealizedUsd),
              capitalGain: unrealizedUsd == null ? null : cvt(unrealizedUsd + realizedCapitalGainUsd),
              dividendsGross: cvt(dividendsGrossUsd),
              dividendsNet: cvt(dividendsNetUsd),
              tradingFees: cvt(tradingFeesUsd),
              financingFees: cvt(financingFeesUsd),
              knownTotal: cvt((unrealizedUsd ?? 0) + ledgerPnlUsd),
              total: explainedPnl == null ? null : cvt(explainedPnl),
              explainedTotal: explainedPnl == null ? null : cvt(explainedPnl),
              economicTotal: null,
              unexplained: null,
              scope: "instrument",
              financingScope: financingFeesUsd ? "instrument" : "portfolio_only_if_unassigned",
            },
            coverage: coverage(group.positionCount, group.knownCosts, group.missingCosts),
          };
        })
        .sort((a, b) => b.valueDisplay - a.valueDisplay);
      const missingBookCosts = positionRows.filter((p) => p.effectiveCost == null);
      const unrealizedCapitalGainUsd = positionRows.reduce(
        (sum, p) => sum + (p.effectiveCost == null ? 0 : toUsd(p.marketValue - p.effectiveCost, p.currency)),
        0,
      );
      const explainedPnlUsd =
        (performance?.realizedCapitalGainUsd ?? 0) +
        unrealizedCapitalGainUsd +
        (performance?.dividendsNetUsd ?? 0) -
        (performance?.tradingFeesUsd ?? 0) -
        (performance?.financingFeesUsd ?? 0);
      const economicPnlUsd = capital?.valueUsd == null ? null : totalUsd - capital.valueUsd;
      const explainedComplete = missingBookCosts.length === 0;
      const unexplainedPnlUsd = economicPnlUsd != null && explainedComplete ? economicPnlUsd - explainedPnlUsd : null;
      const missing = [
        ...missingBookCosts.map((p) => `book_cost:${p.market}:${p.symbol}`),
        ...(capital?.coverage.missing ?? ["external_capital_events"]),
      ];
      const overallCoverage = coverage(
        positionRows.length + 1,
        positionRows.length - missingBookCosts.length + (capital?.coverage.status === "complete" ? 1 : 0),
        missing,
        performance?.issues ?? [],
      );

      const groupBy = (key: (p: (typeof positionRows)[number]) => string) => {
        const map = new Map<string, number>();
        for (const p of positionRows) {
          map.set(key(p), (map.get(key(p)) ?? 0) + p.valueDisplay);
        }
        return Array.from(map.entries())
          .map(([name, value]) => ({ name, value: Math.round(value * 100) / 100 }))
          .sort((a, b) => b.value - a.value);
      };

      // 雷达五维（0-100，结构描述）
      const cashRatio = totalUsd > 0 ? cashUsd / totalUsd : 0;
      const topShare =
        positionsValueUsd > 0
          ? Math.max(...instrumentValues.values(), 0) / positionsValueUsd
          : 0;
      const marketsCount = new Set(positionRows.map((p) => p.market)).size;
      const brokersCount = new Set([...positionRows.map((p) => p.broker), ...cash.map((c) => c.broker)]).size;
      const withCost = positionRows.filter((p) => p.costDisplay != null && p.costDisplay > 0);
      const gainRatioHealthy =
        withCost.length > 0
          ? withCost.filter((p) => (p.gainLossDisplay ?? 0) >= 0).length / withCost.length
          : 0.5;
      const radar = [
        { name: "现金充足度", value: Math.round(Math.min(cashRatio / 0.5, 1) * 100) },
        { name: "个股分散度", value: Math.round((1 - topShare) * 100) },
        { name: "市场分散度", value: Math.round(Math.min(marketsCount / 3, 1) * 100) },
        { name: "券商分散度", value: Math.round(Math.min(brokersCount / 3, 1) * 100) },
        { name: "盈亏健康度", value: Math.round(gainRatioHealthy * 100) },
      ];

      const historyRows = history(userId).map((h) => ({
        month: h.month,
        valueDisplay: Math.round(cvt(h.valueUsd) * 100) / 100,
        costDisplay: h.costUsd == null ? null : Math.round(cvt(h.costUsd) * 100) / 100,
        knownCostDisplay: Math.round(cvt(h.knownCostUsd) * 100) / 100,
        gainLossDisplay: h.gainLossUsd == null ? null : Math.round(cvt(h.gainLossUsd) * 100) / 100,
        symbolCount: h.symbolCount,
        coverage: h.coverage,
      }));

      return {
        display,
        scope,
        grant: grantInfo,
        asOf: brokers.map((b) => ({ broker: b.broker, asOf: b.as_of })),
        kpi: {
          totalAssets: cvt(totalUsd),
          positionsValue: cvt(positionsValueUsd),
          totalCost: cvt(totalCostUsd),
          // 旧字段兼容：gainLoss 继续表示已知账面未实现盈亏，不混入外部净投入。
          gainLoss: cvt(unrealizedCapitalGainUsd),
          gainLossRatio: totalCostUsd > 0 ? unrealizedCapitalGainUsd / totalCostUsd : null,
          idleCash: cvt(cashUsd),
          positionRatio: totalUsd > 0 ? positionsValueUsd / totalUsd : 0,
          cashRatio: totalUsd > 0 ? cashUsd / totalUsd : 0,
        },
        costs: {
          bookCost: cvt(totalCostUsd),
          knownBookCost: cvt(totalCostUsd),
          externalNetInvested: capital?.valueUsd == null ? null : cvt(capital.valueUsd),
          knownExternalNetInvested: cvt(capital?.knownUsd ?? 0),
        },
        pnl: {
          realizedCapitalGain: cvt(performance?.realizedCapitalGainUsd ?? 0),
          unrealizedCapitalGain: cvt(unrealizedCapitalGainUsd),
          capitalGain: cvt((performance?.realizedCapitalGainUsd ?? 0) + unrealizedCapitalGainUsd),
          dividendsGross: cvt(performance?.dividendsGrossUsd ?? 0),
          dividendsNet: cvt(performance?.dividendsNetUsd ?? 0),
          tradingFees: cvt(performance?.tradingFeesUsd ?? 0),
          financingFees: cvt(performance?.financingFeesUsd ?? 0),
          explainedTotal: cvt(explainedPnlUsd),
          economicTotal: economicPnlUsd == null ? null : cvt(economicPnlUsd),
          unexplained: unexplainedPnlUsd == null ? null : cvt(unexplainedPnlUsd),
        },
        coverage: overallCoverage,
        allocation: {
          positionVsCash: [
            { name: "持仓", value: Math.round(cvt(positionsValueUsd) * 100) / 100 },
            { name: "现金", value: Math.round(cvt(cashUsd) * 100) / 100 },
          ],
          bySymbol: groupBy((p) => (symbolMarkets.get(p.symbol)?.size === 1 ? p.symbol : `${p.market}:${p.symbol}`)),
          byBucket: groupBy((p) => BUCKET_LABELS[p.bucket] ?? p.bucket),
          byMarket: groupBy((p) => p.market),
        },
        instruments: instrumentRows,
        positions: positionRows.sort((a, b) => b.valueDisplay - a.valueDisplay),
        cash: cash.map((c) => ({
          broker: c.broker,
          currency: c.currency,
          amount: c.amount,
          source: c.source,
          asOf: c.as_of,
          label: c.label,
          amountDisplay: cvt(toUsd(c.amount, c.currency)),
        })),
        radar,
        history: historyRows,
        staleQuotes,
      };
    },

    riskContext(userId: number, market: string, symbol: string, requestedBucket?: Bucket) {
      const normalizedMarket = normalizeMarket(market);
      const normalizedSymbol = String(symbol ?? "").trim().toUpperCase();
      const { positions, cash, brokers } = latestHoldings(userId);
      const trades = tradeAggregates(userId);
      const overrides = overrideMap(userId);
      const seenKeys = new Set(positions.map((p) => `${p.broker}|${p.symbol}`));
      const synthetic = Array.from(trades.entries())
        .filter(([key, agg]) => !seenKeys.has(key) && agg.netQty > 0.000001)
        .map(([key, agg]) => ({
          broker: agg.broker,
          market: agg.market,
          currency: agg.currency,
          symbol: key.split("|")[1],
          name: agg.name,
          quantity: agg.netQty,
          market_value: agg.netQty * agg.lastPrice,
          cost_basis: null as number | null,
          unrealized_gl: null as number | null,
          as_of: agg.lastDate,
        }));
      const rows = [...positions, ...synthetic].map((p) => {
        const key = `${p.broker}|${p.symbol}`;
        const bookCost = overrides.get(key) ?? p.cost_basis ?? null;
        const normalizedPositionMarket = normalizeMarket(p.market);
        return {
          ...p,
          market: normalizedPositionMarket,
          valueUsd: toUsd(p.market_value, p.currency),
          bookCostUsd: bookCost == null ? null : toUsd(bookCost, p.currency),
          bucket: ledger?.bucketFor(userId, normalizedPositionMarket, p.symbol) ?? "unassigned",
        };
      });
      const target = rows.filter((p) => p.market === normalizedMarket && p.symbol === normalizedSymbol);
      const bucket = requestedBucket ?? (target[0]?.bucket !== "unassigned" ? (target[0]?.bucket as Bucket | undefined) : undefined);
      const positionsValueUsd = rows.reduce((sum, p) => sum + p.valueUsd, 0);
      const symbolValueUsd = target.reduce((sum, p) => sum + p.valueUsd, 0);
      const bucketValueUsd = bucket ? rows.filter((p) => p.bucket === bucket).reduce((sum, p) => sum + p.valueUsd, 0) : null;
      const cashUsd = cash.reduce((sum, item) => sum + toUsd(item.amount, item.currency), 0);
      const bookCostKnown = target.length === 0 || target.every((p) => p.bookCostUsd != null);
      return {
        market: normalizedMarket,
        symbol: normalizedSymbol,
        bucket: bucket ?? null,
        currentQuantity: target.reduce((sum, p) => sum + p.quantity, 0),
        currentBookCostUsd: bookCostKnown ? target.reduce((sum, p) => sum + (p.bookCostUsd ?? 0), 0) : null,
        positionsValueUsd,
        symbolValueUsd,
        bucketValueUsd,
        cashUsd,
        netAssetsUsd: positionsValueUsd + cashUsd,
        asOf: brokers.map((row) => row.as_of).sort().at(-1) ?? null,
        hasValuation: brokers.length > 0 || trades.size > 0,
        hasCash: cash.length > 0,
      };
    },
  };
}
