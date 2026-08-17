import type { AppDatabase } from "./db.js";
import { ConflictError, ValidationError } from "./errors.js";
import { normalizeMarket, roundAmount } from "./finance.js";
import type { Quote } from "./quotes.js";
import type { WatchlistInput } from "./types.js";

interface WatchRow {
  id: number;
  market: string;
  symbol: string;
  name: string;
  note: string;
  ref_high: number | null;
  ref_high_date: string | null;
  created_at: string;
}

interface QuoteServiceLike {
  getQuotes(pairs: Array<{ symbol: string; market: string }>): Promise<Quote[]>;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** 观察窗口：watchlist CRUD + 观察高点棘轮（只升不降，可手动重置）+ 高位回撤。 */
export function createWatchlistService(db: AppDatabase, quotes: QuoteServiceLike) {
  function rows(userId: number): WatchRow[] {
    return db
      .prepare("SELECT * FROM watchlist WHERE user_id = ? ORDER BY created_at DESC, id DESC")
      .all(userId) as WatchRow[];
  }

  function serialize(row: WatchRow, price: number | null = null, currency: string | null = null) {
    const drawdown = price != null && row.ref_high != null && row.ref_high > 0 ? roundAmount(price / row.ref_high - 1, 4) : null;
    return {
      id: row.id,
      market: row.market,
      symbol: row.symbol,
      name: row.name,
      note: row.note,
      refHigh: row.ref_high,
      refHighDate: row.ref_high_date,
      createdAt: row.created_at,
      price,
      currency,
      drawdownFromHigh: drawdown,
    };
  }

  function validateInput(input: WatchlistInput) {
    if (!input.symbol?.trim()) throw new ValidationError("缺少标的代码");
    if (!input.market?.trim()) throw new ValidationError("缺少市场");
    if (input.refHigh != null && (!Number.isFinite(input.refHigh) || input.refHigh <= 0)) {
      throw new ValidationError("观察高点需为正数");
    }
  }

  /** 棘轮：现价高于观察高点时上调并记日期；只升不降。 */
  function ratchet(userId: number, row: WatchRow, price: number) {
    if (row.ref_high == null || price > row.ref_high) {
      db.prepare("UPDATE watchlist SET ref_high = ?, ref_high_date = ? WHERE id = ? AND user_id = ?").run(
        price,
        today(),
        row.id,
        userId,
      );
      row.ref_high = price;
      row.ref_high_date = today();
    }
  }

  return {
    list(userId: number) {
      return rows(userId).map((row) => serialize(row));
    },

    async add(userId: number, input: WatchlistInput) {
      validateInput(input);
      const market = normalizeMarket(input.market);
      const symbol = input.symbol.trim().toUpperCase();
      const existing = db
        .prepare("SELECT id FROM watchlist WHERE user_id = ? AND market = ? AND symbol = ?")
        .get(userId, market, symbol);
      if (existing) throw new ConflictError("该标的已在观察列表中", { market, symbol });

      let refHigh = input.refHigh ?? null;
      let refHighDate: string | null = refHigh != null ? today() : null;
      if (refHigh == null) {
        // 未手填观察高点时用当时报价初始化；报价不可得则留空待 refresh 补齐
        const [quote] = await quotes.getQuotes([{ symbol, market }]);
        if (quote) {
          refHigh = quote.price;
          refHighDate = today();
        }
      }
      const result = db
        .prepare(
          `INSERT INTO watchlist (user_id, market, symbol, name, note, ref_high, ref_high_date)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(userId, market, symbol, input.name?.trim() || symbol, input.note?.trim() ?? "", refHigh, refHighDate);
      const row = db.prepare("SELECT * FROM watchlist WHERE id = ?").get(Number(result.lastInsertRowid)) as WatchRow;
      return serialize(row);
    },

    update(userId: number, id: number, input: Partial<WatchlistInput>) {
      const row = db.prepare("SELECT * FROM watchlist WHERE id = ? AND user_id = ?").get(id, userId) as WatchRow | undefined;
      if (!row) return null;
      if (input.refHigh !== undefined && input.refHigh != null && (!Number.isFinite(input.refHigh) || input.refHigh <= 0)) {
        throw new ValidationError("观察高点需为正数");
      }
      db.prepare(
        `UPDATE watchlist SET name = ?, note = ?, ref_high = ?, ref_high_date = ? WHERE id = ? AND user_id = ?`,
      ).run(
        input.name?.trim() || row.name,
        input.note !== undefined ? String(input.note).trim() : row.note,
        input.refHigh !== undefined ? input.refHigh : row.ref_high,
        input.refHigh !== undefined ? (input.refHigh == null ? null : today()) : row.ref_high_date,
        id,
        userId,
      );
      const updated = db.prepare("SELECT * FROM watchlist WHERE id = ?").get(id) as WatchRow;
      return serialize(updated);
    },

    remove(userId: number, id: number) {
      return db.prepare("DELETE FROM watchlist WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
    },

    /** 批量刷新报价：棘轮更新观察高点，返回现价与高位回撤；单标的报价失败降级为 null，不中断整体。 */
    async refresh(userId: number) {
      const items = rows(userId);
      if (items.length === 0) return [];
      const quoteList = await quotes.getQuotes(items.map((row) => ({ symbol: row.symbol, market: row.market })));
      const quoteMap = new Map(quoteList.map((quote) => [`${quote.market}:${quote.symbol}`, quote]));
      return items.map((row) => {
        const quote = quoteMap.get(`${row.market}:${row.symbol}`);
        if (!quote) return serialize(row);
        ratchet(userId, row, quote.price);
        return serialize(row, quote.price, quote.currency);
      });
    },
  };
}
