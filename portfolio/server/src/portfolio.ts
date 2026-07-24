import type { AppDatabase } from "./db.js";
import type { Bucket, CashBalanceInput, Currency, PositionInput, StatementPayload, TradeInput } from "./types.js";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

const CURRENCIES: Currency[] = ["USD", "HKD", "CNY"];
const BUCKETS: Bucket[] = ["aggressive", "defensive", "stable"];
export const BUCKET_LABELS: Record<string, string> = {
  aggressive: "进取仓",
  defensive: "防守仓",
  stable: "稳健仓",
  unassigned: "未分类",
};

function asCurrency(value: unknown): Currency {
  const text = String(value ?? "").toUpperCase();
  return (CURRENCIES.find((c) => c === text) ?? "HKD") as Currency;
}

export function normalizeMarket(value: unknown): string {
  const text = String(value ?? "").trim().toUpperCase();
  if (["US", "USA", "NASDAQ", "NYSE", "AMEX", "美股"].some((m) => text.includes(m))) return "US";
  if (["HK", "HKEX", "SEHK", "港股", "香港"].some((m) => text.includes(m))) return "HK";
  if (["SH", "SZ", "CN", "A股", "沪", "深"].some((m) => text.includes(m))) return "CN";
  return text || "OTHER";
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

export function createPortfolioService(db: AppDatabase, fxToUsd: Record<string, number>) {
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
      positions.push(
        ...(db
          .prepare("SELECT * FROM positions WHERE user_id = ? AND broker = ? AND as_of = ?")
          .all(userId, b.broker, b.as_of) as typeof positions),
      );
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

    return { brokers, positions, cash: Array.from(cashMap.values()) };
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
        market: t.market,
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

  /** 近 1 年按月聚合：每月每券商取当月最新快照，汇总市值/成本/标的数（USD 口径）。 */
  function history(userId: number) {
    const rows = db
      .prepare(
        `SELECT p.* FROM positions p
         WHERE p.user_id = ? AND p.as_of >= date('now', '-1 year', 'start of month')`,
      )
      .all(userId) as Array<{
      broker: string;
      currency: string;
      as_of: string;
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
    const byMonth = new Map<string, { valueUsd: number; costUsd: number; symbols: Set<string> }>();
    for (const row of rows) {
      const month = row.as_of.slice(0, 7);
      if (latestPerBrokerMonth.get(`${month}|${row.broker}`) !== row.as_of) continue;
      const entry = byMonth.get(month) ?? { valueUsd: 0, costUsd: 0, symbols: new Set<string>() };
      entry.valueUsd += toUsd(row.market_value, row.currency);
      if (row.cost_basis != null) entry.costUsd += toUsd(row.cost_basis, row.currency);
      entry.symbols.add(row.symbol);
      byMonth.set(month, entry);
    }
    return Array.from(byMonth.entries())
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([month, e]) => ({
        month,
        valueUsd: e.valueUsd,
        costUsd: e.costUsd,
        gainLossUsd: e.valueUsd - e.costUsd,
        symbolCount: e.symbols.size,
      }));
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
      if (!Number.isFinite(cash.amount) || cash.amount < 0) throw new ValidationError("现金金额非法");
      if (!cash.broker?.trim()) throw new ValidationError("缺少券商标识");
      const asOf = cash.asOf ?? new Date().toISOString().slice(0, 10);
      db.prepare(
        `INSERT INTO cash_balances (user_id, statement_id, as_of, broker, currency, amount, source)
         VALUES (?, NULL, ?, ?, ?, ?, 'manual')`,
      ).run(userId, asOf, cash.broker, asCurrency(cash.currency), cash.amount);
    },

    addTrade(userId: number, trade: TradeInput) {
      validateTrade(trade);
      const result = db
        .prepare(
          `INSERT INTO trades (user_id, broker, market, currency, symbol, name, side, trade_date, quantity, price, fee)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

    setBucket(userId: number, symbol: string, bucket: Bucket | null) {
      const sym = String(symbol ?? "").trim().toUpperCase();
      if (!sym) throw new ValidationError("缺少标的代码");
      if (bucket === null) {
        db.prepare("DELETE FROM symbol_buckets WHERE user_id = ? AND symbol = ?").run(userId, sym);
        return;
      }
      if (!BUCKETS.includes(bucket)) throw new ValidationError("仓别非法（aggressive/defensive/stable）");
      db.prepare(
        "INSERT INTO symbol_buckets (user_id, symbol, bucket) VALUES (?, ?, ?) ON CONFLICT(user_id, symbol) DO UPDATE SET bucket = excluded.bucket",
      ).run(userId, sym, bucket);
    },

    setCostOverride(userId: number, broker: string, symbol: string, costBasis: number | null) {
      const sym = String(symbol ?? "").trim().toUpperCase();
      if (!broker?.trim() || !sym) throw new ValidationError("缺少券商或标的");
      if (costBasis === null) {
        db.prepare("DELETE FROM cost_overrides WHERE user_id = ? AND broker = ? AND symbol = ?").run(userId, broker, sym);
        return;
      }
      if (!Number.isFinite(costBasis)) throw new ValidationError("成本非法");
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

    summary(userId: number, display: Currency, quotes?: Map<string, number>) {
      const { brokers, positions, cash } = latestHoldings(userId);
      const trades = tradeAggregates(userId);
      const buckets = bucketMap(userId);
      const overrides = overrideMap(userId);
      const cvt = (amountUsd: number) => fromUsd(amountUsd, display);

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
          cost_basis: agg.netCost,
          unrealized_gl: null as number | null,
          as_of: agg.lastDate,
        }));

      const positionRows = [...positions, ...synthetic].map((p) => {
        const key = `${p.broker}|${p.symbol}`;
        let marketValue = p.market_value;
        let quoteApplied = false;
        const quote = quotes?.get(`${p.market}:${p.symbol}`);
        if (quote && quote > 0 && p.quantity > 0) {
          marketValue = quote * p.quantity;
          quoteApplied = true;
        } else if (quotes) {
          staleQuotes.push(p.symbol);
        }
        // 实际成本优先级：手动编辑 > 交易流水净成本 > 月结单成本
        const tradeAgg = trades.get(key);
        const effectiveCost = overrides.get(key) ?? tradeAgg?.netCost ?? p.cost_basis ?? null;
        const costSource = overrides.has(key) ? "manual" : tradeAgg ? "trades" : p.cost_basis != null ? "statement" : "none";
        const currentPrice = quoteApplied ? quote! : p.quantity > 0 ? marketValue / p.quantity : null;
        const valueUsd = toUsd(marketValue, p.currency);
        const costUsd = effectiveCost != null ? toUsd(effectiveCost, p.currency) : null;
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
          bucket: buckets.get(p.symbol) ?? "unassigned",
          effectiveCost,
          costSource,
          valueDisplay: cvt(valueUsd),
          costDisplay: costUsd != null ? cvt(costUsd) : null,
          gainLossDisplay: costUsd != null ? cvt(valueUsd - costUsd) : null,
        };
      });

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
      const gainLossUsd = positionsValueUsd - totalCostUsd;

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
          ? Math.max(...positionRows.map((p) => toUsd(p.marketValue, p.currency)), 0) / positionsValueUsd
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
        costDisplay: Math.round(cvt(h.costUsd) * 100) / 100,
        gainLossDisplay: Math.round(cvt(h.gainLossUsd) * 100) / 100,
        symbolCount: h.symbolCount,
      }));

      return {
        display,
        asOf: brokers.map((b) => ({ broker: b.broker, asOf: b.as_of })),
        kpi: {
          totalAssets: cvt(totalUsd),
          positionsValue: cvt(positionsValueUsd),
          totalCost: cvt(totalCostUsd),
          gainLoss: cvt(gainLossUsd),
          gainLossRatio: totalCostUsd > 0 ? gainLossUsd / totalCostUsd : null,
          idleCash: cvt(cashUsd),
          positionRatio: totalUsd > 0 ? positionsValueUsd / totalUsd : 0,
        },
        allocation: {
          positionVsCash: [
            { name: "持仓", value: Math.round(cvt(positionsValueUsd) * 100) / 100 },
            { name: "现金", value: Math.round(cvt(cashUsd) * 100) / 100 },
          ],
          bySymbol: groupBy((p) => p.symbol),
          byBucket: groupBy((p) => BUCKET_LABELS[p.bucket] ?? p.bucket),
          byMarket: groupBy((p) => p.market),
        },
        positions: positionRows.sort((a, b) => b.valueDisplay - a.valueDisplay),
        cash: cash.map((c) => ({
          broker: c.broker,
          currency: c.currency,
          amount: c.amount,
          source: c.source,
          asOf: c.as_of,
          amountDisplay: cvt(toUsd(c.amount, c.currency)),
        })),
        radar,
        history: historyRows,
        staleQuotes,
      };
    },
  };
}
