import type { AppDatabase } from "./db.js";
import type { CashBalanceInput, Currency, PositionInput, StatementPayload } from "./types.js";

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

const CURRENCIES: Currency[] = ["USD", "HKD", "CNY"];

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

    // 现金：parsed 取每券商最新 as_of；manual 直接按 broker+currency 最新一条覆盖
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

    /** 闲置现金合计（USD 口径），供加仓计划校验用。 */
    idleCashUsd(userId: number) {
      const { cash } = latestHoldings(userId);
      return cash.reduce((sum, c) => sum + toUsd(c.amount, c.currency), 0);
    },

    summary(userId: number, display: Currency, quotes?: Map<string, number>) {
      const { brokers, positions, cash } = latestHoldings(userId);
      const cvt = (amountUsd: number) => fromUsd(amountUsd, display);

      let staleQuotes: string[] = [];
      const positionRows = positions.map((p) => {
        let marketValue = p.market_value;
        let quoteApplied = false;
        const quote = quotes?.get(`${p.market}:${p.symbol}`);
        if (quote && quote > 0 && p.quantity > 0) {
          marketValue = quote * p.quantity;
          quoteApplied = true;
        } else if (quotes) {
          staleQuotes.push(p.symbol);
        }
        const valueUsd = toUsd(marketValue, p.currency);
        const costUsd = p.cost_basis != null ? toUsd(p.cost_basis, p.currency) : null;
        return {
          broker: p.broker,
          market: p.market,
          currency: p.currency,
          symbol: p.symbol,
          name: p.name,
          quantity: p.quantity,
          asOf: p.as_of,
          marketValue,
          quoteApplied,
          valueDisplay: cvt(valueUsd),
          costDisplay: costUsd != null ? cvt(costUsd) : null,
          gainLossDisplay: costUsd != null ? cvt(valueUsd - costUsd) : null,
        };
      });

      const positionsValueUsd = positionRows.reduce(
        (sum, p) => sum + toUsd(p.marketValue, p.currency),
        0,
      );
      const cashUsd = cash.reduce((sum, c) => sum + toUsd(c.amount, c.currency), 0);
      const totalUsd = positionsValueUsd + cashUsd;

      const groupBy = (key: (p: (typeof positionRows)[number]) => string) => {
        const map = new Map<string, number>();
        for (const p of positionRows) {
          map.set(key(p), (map.get(key(p)) ?? 0) + p.valueDisplay);
        }
        return Array.from(map.entries())
          .map(([name, value]) => ({ name, value: Math.round(value * 100) / 100 }))
          .sort((a, b) => b.value - a.value);
      };

      // 券商分布把现金也计入（资产视角）
      const brokerDist = new Map<string, number>();
      for (const p of positionRows) {
        brokerDist.set(p.broker, (brokerDist.get(p.broker) ?? 0) + p.valueDisplay);
      }
      for (const c of cash) {
        brokerDist.set(c.broker, (brokerDist.get(c.broker) ?? 0) + cvt(toUsd(c.amount, c.currency)));
      }

      // 雷达五维（0-100，结构描述）：现金充足度 / 个股分散度 / 市场分散度 / 券商分散度 / 盈亏健康度
      const cashRatio = totalUsd > 0 ? cashUsd / totalUsd : 0;
      const topShare =
        positionsValueUsd > 0
          ? Math.max(...positionRows.map((p) => toUsd(p.marketValue, p.currency))) / positionsValueUsd
          : 0;
      const marketsCount = new Set(positionRows.map((p) => p.market)).size;
      const brokersCount = new Set([...positionRows.map((p) => p.broker), ...cash.map((c) => c.broker)]).size;
      const withCost = positionRows.filter((p) => p.costDisplay != null && p.costDisplay > 0);
      const gainRatio =
        withCost.length > 0
          ? withCost.filter((p) => (p.gainLossDisplay ?? 0) >= 0).length / withCost.length
          : 0.5;
      const radar = [
        { name: "现金充足度", value: Math.round(Math.min(cashRatio / 0.5, 1) * 100) },
        { name: "个股分散度", value: Math.round((1 - topShare) * 100) },
        { name: "市场分散度", value: Math.round(Math.min(marketsCount / 3, 1) * 100) },
        { name: "券商分散度", value: Math.round(Math.min(brokersCount / 3, 1) * 100) },
        { name: "盈亏健康度", value: Math.round(gainRatio * 100) },
      ];

      return {
        display,
        asOf: brokers.map((b) => ({ broker: b.broker, asOf: b.as_of })),
        kpi: {
          totalAssets: cvt(totalUsd),
          positionsValue: cvt(positionsValueUsd),
          idleCash: cvt(cashUsd),
          positionRatio: totalUsd > 0 ? positionsValueUsd / totalUsd : 0,
        },
        allocation: {
          positionVsCash: [
            { name: "持仓", value: Math.round(cvt(positionsValueUsd) * 100) / 100 },
            { name: "现金", value: Math.round(cvt(cashUsd) * 100) / 100 },
          ],
          byBroker: Array.from(brokerDist.entries())
            .map(([name, value]) => ({ name, value: Math.round(value * 100) / 100 }))
            .sort((a, b) => b.value - a.value),
          byCurrency: groupBy((p) => p.currency),
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
        staleQuotes,
      };
    },
  };
}
