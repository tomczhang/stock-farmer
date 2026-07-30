import type { AppDatabase } from "./db.js";
import { ValidationError } from "./errors.js";
import {
  coverage,
  fromUsd,
  instrumentKey,
  normalizeMarket,
  requireCurrency,
  roundAmount,
  toUsd,
  validateDate,
} from "./finance.js";
import type {
  CapitalEventInput,
  CapitalEventType,
  CashFlowEventInput,
  CashFlowEventType,
  Currency,
  StatementPayload,
} from "./types.js";

const CAPITAL_TYPES: CapitalEventType[] = ["cash_in", "cash_out", "transfer_in", "transfer_out", "adjustment"];
const CASH_FLOW_TYPES: CashFlowEventType[] = ["dividend", "realized_gain", "trade_fee", "financing_fee"];

interface CapitalRow {
  id: number;
  statement_id: number | null;
  event_type: CapitalEventType;
  event_date: string;
  broker: string | null;
  market: string | null;
  currency: string;
  symbol: string | null;
  name: string | null;
  amount: number | null;
  quantity: number | null;
  unit_cost: number | null;
  fx_to_usd: number | null;
  bucket: string | null;
  source: string;
  source_id: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

interface CashFlowRow {
  id: number;
  statement_id: number | null;
  event_type: CashFlowEventType;
  event_date: string;
  broker: string | null;
  market: string | null;
  currency: string;
  symbol: string | null;
  name: string | null;
  gross_amount: number;
  tax_amount: number;
  fee_amount: number;
  fx_to_usd: number | null;
  bucket: string | null;
  source: string;
  source_id: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

interface TradeRow {
  id: number;
  statement_id: number | null;
  broker: string;
  market: string;
  currency: string;
  symbol: string;
  name: string;
  side: "buy" | "sell";
  trade_date: string;
  quantity: number;
  price: number;
  fee: number;
  gross_amount: number | null;
  bucket: string | null;
  fx_to_usd: number | null;
  source: string;
  source_id: string | null;
  created_at: string;
}

function capitalAmount(row: Pick<CapitalRow, "event_type" | "amount" | "quantity" | "unit_cost">) {
  if (row.event_type === "transfer_in" || row.event_type === "transfer_out") {
    if (row.quantity == null || row.unit_cost == null) return null;
    return row.quantity * row.unit_cost;
  }
  return row.amount;
}

function capitalImpact(type: CapitalEventType, amount: number) {
  if (type === "cash_out" || type === "transfer_out") return -Math.abs(amount);
  if (type === "cash_in" || type === "transfer_in") return Math.abs(amount);
  return amount;
}

function cashFlowAmounts(row: Pick<CashFlowRow, "event_type" | "gross_amount" | "tax_amount" | "fee_amount">) {
  const { event_type: type, gross_amount: gross, tax_amount: tax, fee_amount: fee } = row;
  if (type === "dividend") {
    const net = gross - tax - fee;
    return { net, cashImpact: net, pnlImpact: net };
  }
  if (type === "realized_gain") return { net: gross, cashImpact: 0, pnlImpact: gross };
  return { net: -Math.abs(gross), cashImpact: -Math.abs(gross), pnlImpact: -Math.abs(gross) };
}

function validateCapital(input: CapitalEventInput) {
  if (!CAPITAL_TYPES.includes(input.type)) throw new ValidationError("资本事件类型非法");
  validateDate(input.eventDate, "资本事件日期");
  requireCurrency(input.currency);
  if (input.type === "transfer_in" || input.type === "transfer_out") {
    if (!input.symbol?.trim()) throw new ValidationError("转仓事件缺少标的代码");
    if (!(Number(input.quantity) > 0) || !(Number(input.unitCost) > 0)) {
      throw new ValidationError("转仓事件需提供正数数量和用户确认单位成本");
    }
  } else if (!Number.isFinite(input.amount) || input.amount === 0) {
    throw new ValidationError("资本事件金额需为非零数字");
  } else if (input.type !== "adjustment" && Number(input.amount) < 0) {
    throw new ValidationError("现金增减金额请使用正数，并通过事件类型表示方向");
  }
  if (input.symbol?.trim() && !input.market?.trim()) throw new ValidationError("标的资本事件需提供市场");
}

function validateCashFlow(input: CashFlowEventInput) {
  if (!CASH_FLOW_TYPES.includes(input.type)) throw new ValidationError("收益费用事件类型非法");
  validateDate(input.eventDate, "收益费用日期");
  requireCurrency(input.currency);
  if (!Number.isFinite(input.grossAmount)) throw new ValidationError("收益费用金额非法");
  if (input.type !== "realized_gain" && !(input.grossAmount > 0)) {
    throw new ValidationError("股息和费用金额需为正数");
  }
  if ((input.taxAmount ?? 0) < 0 || (input.feeAmount ?? 0) < 0) throw new ValidationError("税费不能为负");
  if (input.type === "dividend" && (input.taxAmount ?? 0) + (input.feeAmount ?? 0) > input.grossAmount) {
    throw new ValidationError("股息税费不能超过毛额");
  }
  if (input.symbol?.trim() && !input.market?.trim()) throw new ValidationError("标的收益费用事件需提供市场");
}

export function createLedgerService(db: AppDatabase, fxToUsd: Record<string, number>) {
  function bucketFor(userId: number, market: string | null | undefined, symbol: string | null | undefined) {
    if (!symbol) return null;
    const normalizedMarket = normalizeMarket(market);
    const normalizedSymbol = symbol.trim().toUpperCase();
    const exact = db
      .prepare("SELECT bucket FROM instrument_buckets WHERE user_id = ? AND market = ? AND symbol = ?")
      .get(userId, normalizedMarket, normalizedSymbol) as { bucket: string } | undefined;
    if (exact) return exact.bucket;
    const legacy = db.prepare("SELECT bucket FROM symbol_buckets WHERE user_id = ? AND symbol = ?").get(userId, normalizedSymbol) as
      | { bucket: string }
      | undefined;
    return legacy?.bucket ?? null;
  }

  function capitalRows(userId: number) {
    return db
      .prepare("SELECT * FROM capital_events WHERE user_id = ? ORDER BY event_date DESC, id DESC")
      .all(userId) as CapitalRow[];
  }

  function cashFlowRows(userId: number) {
    return db
      .prepare("SELECT * FROM cash_flow_events WHERE user_id = ? ORDER BY event_date DESC, id DESC")
      .all(userId) as CashFlowRow[];
  }

  function tradeRows(userId: number) {
    return db.prepare("SELECT * FROM trades WHERE user_id = ? ORDER BY trade_date DESC, id DESC").all(userId) as TradeRow[];
  }

  function serializeCapital(row: CapitalRow, display: Currency = "USD") {
    const amount = capitalAmount(row);
    const rate = row.fx_to_usd && row.fx_to_usd > 0 ? row.fx_to_usd : fxToUsd[row.currency] ?? 1;
    const amountUsd = amount == null ? null : amount * rate;
    const impact = amount == null ? null : capitalImpact(row.event_type, amount);
    const impactUsd = impact == null ? null : impact * rate;
    return {
      id: row.id,
      statementId: row.statement_id,
      type: row.event_type,
      eventDate: row.event_date,
      broker: row.broker,
      market: row.market,
      currency: row.currency,
      symbol: row.symbol,
      name: row.name,
      amount: row.amount,
      quantity: row.quantity,
      unitCost: row.unit_cost,
      capitalAmount: amount == null ? null : roundAmount(amount),
      capitalAmountUsd: amountUsd == null ? null : roundAmount(amountUsd),
      capitalAmountDisplay: amountUsd == null ? null : roundAmount(fromUsd(amountUsd, display, fxToUsd)),
      netInvestedImpact: impact == null ? null : roundAmount(impact),
      netInvestedImpactUsd: impactUsd == null ? null : roundAmount(impactUsd),
      netInvestedImpactDisplay: impactUsd == null ? null : roundAmount(fromUsd(impactUsd, display, fxToUsd)),
      fxRate: rate,
      bucket: row.bucket,
      source: row.source,
      sourceId: row.source_id,
      note: row.note,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      coverage: amount == null ? coverage(1, 0, ["transfer_cost"]) : coverage(1, 1),
    };
  }

  function serializeCashFlow(row: CashFlowRow, display: Currency = "USD") {
    const amounts = cashFlowAmounts(row);
    const rate = row.fx_to_usd && row.fx_to_usd > 0 ? row.fx_to_usd : fxToUsd[row.currency] ?? 1;
    const convert = (value: number) => ({
      original: roundAmount(value),
      usd: roundAmount(value * rate),
      display: roundAmount(fromUsd(value * rate, display, fxToUsd)),
    });
    return {
      id: row.id,
      statementId: row.statement_id,
      type: row.event_type,
      eventDate: row.event_date,
      broker: row.broker,
      market: row.market,
      currency: row.currency,
      symbol: row.symbol,
      name: row.name,
      grossAmount: roundAmount(row.gross_amount),
      taxAmount: roundAmount(row.tax_amount),
      feeAmount: roundAmount(row.fee_amount),
      netAmount: roundAmount(amounts.net),
      grossAmountUsd: convert(row.gross_amount).usd,
      grossAmountDisplay: convert(row.gross_amount).display,
      taxAmountUsd: convert(row.tax_amount).usd,
      taxAmountDisplay: convert(row.tax_amount).display,
      feeAmountUsd: convert(row.fee_amount).usd,
      feeAmountDisplay: convert(row.fee_amount).display,
      netAmountUsd: convert(amounts.net).usd,
      netAmountDisplay: convert(amounts.net).display,
      cashImpact: convert(amounts.cashImpact).original,
      cashImpactUsd: convert(amounts.cashImpact).usd,
      cashImpactDisplay: convert(amounts.cashImpact).display,
      pnlImpact: convert(amounts.pnlImpact).original,
      pnlImpactUsd: convert(amounts.pnlImpact).usd,
      pnlImpactDisplay: convert(amounts.pnlImpact).display,
      fxRate: rate,
      bucket: row.bucket,
      source: row.source,
      sourceId: row.source_id,
      note: row.note,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      coverage: coverage(1, 1, [], row.fx_to_usd ? [] : ["historical_fx_estimated"]),
    };
  }

  function insertCapital(userId: number, input: CapitalEventInput, statementId: number | null = null, allowIncomplete = false) {
    if (!allowIncomplete) validateCapital(input);
    const currency = requireCurrency(input.currency);
    const market = input.market ? normalizeMarket(input.market) : null;
    const symbol = input.symbol?.trim().toUpperCase() || null;
    const params = [
      userId,
      statementId,
      input.type,
      input.eventDate,
      input.broker?.trim() || null,
      market,
      currency,
      symbol,
      input.name?.trim() || symbol,
      input.amount ?? null,
      input.quantity ?? null,
      input.unitCost ?? null,
      fxToUsd[currency] ?? 1,
      bucketFor(userId, market, symbol),
      input.source?.trim() || "manual",
      input.sourceId?.trim() || null,
      input.note?.trim() || null,
    ];
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO capital_events
         (user_id, statement_id, event_type, event_date, broker, market, currency, symbol, name, amount,
          quantity, unit_cost, fx_to_usd, bucket, source, source_id, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(...params);
    if (result.changes > 0) return Number(result.lastInsertRowid);
    if (input.sourceId) {
      const existing = db
        .prepare("SELECT id FROM capital_events WHERE user_id = ? AND source = ? AND source_id = ?")
        .get(userId, input.source?.trim() || "manual", input.sourceId.trim()) as { id: number } | undefined;
      if (existing) return existing.id;
    }
    throw new ValidationError("资本事件保存失败");
  }

  function insertCashFlow(userId: number, input: CashFlowEventInput, statementId: number | null = null) {
    validateCashFlow(input);
    const currency = requireCurrency(input.currency);
    const market = input.market ? normalizeMarket(input.market) : null;
    const symbol = input.symbol?.trim().toUpperCase() || null;
    const source = input.source?.trim() || "manual";
    const sourceId = input.sourceId?.trim() || null;
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO cash_flow_events
         (user_id, statement_id, event_type, event_date, broker, market, currency, symbol, name, gross_amount,
          tax_amount, fee_amount, fx_to_usd, bucket, source, source_id, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        userId,
        statementId,
        input.type,
        input.eventDate,
        input.broker?.trim() || null,
        market,
        currency,
        symbol,
        input.name?.trim() || symbol,
        input.grossAmount,
        input.taxAmount ?? 0,
        input.feeAmount ?? 0,
        fxToUsd[currency] ?? 1,
        bucketFor(userId, market, symbol),
        source,
        sourceId,
        input.note?.trim() || null,
      );
    if (result.changes > 0) return Number(result.lastInsertRowid);
    if (sourceId) {
      const existing = db
        .prepare("SELECT id FROM cash_flow_events WHERE user_id = ? AND source = ? AND source_id = ?")
        .get(userId, source, sourceId) as { id: number } | undefined;
      if (existing) return existing.id;
    }
    throw new ValidationError("收益费用事件保存失败");
  }

  function importStatementEvents(userId: number, statementId: number, payload: StatementPayload) {
    const issues: string[] = [];
    const insertTrade = db.prepare(
      `INSERT OR IGNORE INTO trades
       (user_id, statement_id, broker, market, currency, symbol, name, side, trade_date, quantity, price, fee,
        source, source_id, gross_amount, bucket, fx_to_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const activity of payload.tradeActivities ?? []) {
      const market = normalizeMarket(activity.market);
      const symbol = activity.symbol.trim().toUpperCase();
      const broker = activity.broker?.trim() || payload.broker;
      const fee = Math.max(0, activity.fee ?? 0);
      if (["buy", "long_open", "acquire", "sell"].includes(activity.side)) {
        const side = activity.side === "sell" ? "sell" : "buy";
        const gross = activity.grossAmount ?? (activity.unitPrice ? activity.unitPrice * activity.quantity : Math.max(0, Math.abs(activity.amount) - fee));
        const price = activity.unitPrice ?? (activity.quantity > 0 ? gross / activity.quantity : 0);
        if (!(activity.quantity > 0) || !(price > 0)) {
          issues.push(`交易 ${activity.id} 缺少可验证数量或成交价`);
          continue;
        }
        insertTrade.run(
          userId,
          statementId,
          broker,
          market,
          requireCurrency(activity.currency),
          symbol,
          activity.securityName || symbol,
          side,
          activity.date,
          activity.quantity,
          price,
          fee,
          activity.source || payload.fileName,
          activity.id,
          gross,
          bucketFor(userId, market, symbol),
          fxToUsd[activity.currency] ?? 1,
        );
      } else if (activity.side === "transfer_in" || activity.side === "transfer_out") {
        if (!activity.capitalConfirmed || !(activity.quantity > 0) || !(Number(activity.unitPrice) > 0)) {
          issues.push(`转仓 ${activity.id} 尚未确认单位成本，未计入外部净投入`);
          continue;
        }
        insertCapital(
          userId,
          {
            type: activity.side,
            eventDate: activity.date,
            broker,
            market,
            currency: activity.currency,
            symbol,
            name: activity.securityName,
            quantity: activity.quantity,
            unitCost: activity.unitPrice,
            source: activity.source || payload.fileName,
            sourceId: activity.id,
            note: activity.note,
          },
          statementId,
        );
      }
    }
    for (const realized of payload.realizedTrades ?? []) {
      insertCashFlow(
        userId,
        {
          type: "realized_gain",
          eventDate: realized.sellDate,
          broker: realized.broker || payload.broker,
          market: realized.market,
          currency: realized.currency,
          symbol: realized.symbol,
          name: realized.securityName,
          grossAmount: realized.gainLoss,
          source: realized.source || payload.fileName,
          sourceId: realized.id,
          note: realized.note,
        },
        statementId,
      );
    }
    for (const dividend of payload.dividends ?? []) {
      const matchingMarkets = Array.from(
        new Set(
          payload.positions
            .filter((position) => position.symbol.trim().toUpperCase() === dividend.symbol.trim().toUpperCase())
            .map((position) => normalizeMarket(position.market)),
        ),
      );
      const dividendMarket = dividend.market ? normalizeMarket(dividend.market) : matchingMarkets.length === 1 ? matchingMarkets[0] : undefined;
      if (!dividendMarket) issues.push(`股息 ${dividend.id} 缺少市场，仅计入整体收益`);
      insertCashFlow(
        userId,
        {
          type: "dividend",
          eventDate: dividend.date,
          broker: dividend.broker || payload.broker,
          market: dividendMarket,
          currency: dividend.currency,
          symbol: dividendMarket ? dividend.symbol : undefined,
          name: dividend.securityName,
          grossAmount: dividend.grossAmount,
          taxAmount: dividend.taxWithheld,
          feeAmount: dividend.fee,
          source: dividend.source || payload.fileName,
          sourceId: dividend.id,
          note: [dividend.note, dividendMarket ? null : `原标的 ${dividend.symbol}，因缺少市场仅计整体`]
            .filter(Boolean)
            .join("；") || undefined,
        },
        statementId,
      );
    }
    return issues;
  }

  function capitalSummary(userId: number) {
    const rows = capitalRows(userId);
    const missing: string[] = [];
    let knownUsd = 0;
    let known = 0;
    const byInstrument = new Map<string, { knownUsd: number; complete: boolean }>();
    for (const row of rows) {
      const amount = capitalAmount(row);
      const key = row.symbol && row.market ? instrumentKey(row.market, row.symbol) : null;
      if (row.symbol && !row.market) missing.push(`capital_event:${row.id}:market`);
      if (amount == null) {
        missing.push(`capital_event:${row.id}:transfer_cost`);
        if (key) byInstrument.set(key, { knownUsd: byInstrument.get(key)?.knownUsd ?? 0, complete: false });
        continue;
      }
      const impactUsd = toUsd(capitalImpact(row.event_type, amount), row.currency, fxToUsd, row.fx_to_usd);
      knownUsd += impactUsd;
      known += 1;
      if (key) {
        const item = byInstrument.get(key) ?? { knownUsd: 0, complete: true };
        item.knownUsd += impactUsd;
        byInstrument.set(key, item);
      }
    }
    if (rows.length === 0) missing.push("external_capital_events");
    const resultCoverage = coverage(Math.max(rows.length, 1), known, missing);
    return {
      valueUsd: resultCoverage.status === "complete" ? roundAmount(knownUsd) : null,
      knownUsd: roundAmount(knownUsd),
      coverage: resultCoverage,
      byInstrument,
    };
  }

  function performanceSummary(userId: number) {
    let realizedCapitalGainUsd = 0;
    let dividendsGrossUsd = 0;
    let dividendsNetUsd = 0;
    let tradingFeesUsd = 0;
    let financingFeesUsd = 0;
    const byInstrument = new Map<
      string,
      {
        realizedCapitalGainUsd: number;
        dividendsGrossUsd: number;
        dividendsNetUsd: number;
        tradingFeesUsd: number;
        financingFeesUsd: number;
      }
    >();
    const issues: string[] = [];
    for (const row of cashFlowRows(userId)) {
      const rate = row.fx_to_usd && row.fx_to_usd > 0 ? row.fx_to_usd : fxToUsd[row.currency] ?? 1;
      if (!row.fx_to_usd) issues.push(`cash_flow:${row.id}:historical_fx_estimated`);
      const amounts = cashFlowAmounts(row);
      const key = row.symbol && row.market ? instrumentKey(row.market, row.symbol) : null;
      if (row.symbol && !row.market) issues.push(`cash_flow:${row.id}:market`);
      const item = key
        ? byInstrument.get(key) ?? {
            realizedCapitalGainUsd: 0,
            dividendsGrossUsd: 0,
            dividendsNetUsd: 0,
            tradingFeesUsd: 0,
            financingFeesUsd: 0,
          }
        : null;
      if (row.event_type === "realized_gain") {
        realizedCapitalGainUsd += row.gross_amount * rate;
        if (item) item.realizedCapitalGainUsd += row.gross_amount * rate;
      } else if (row.event_type === "dividend") {
        dividendsGrossUsd += row.gross_amount * rate;
        dividendsNetUsd += amounts.net * rate;
        if (item) {
          item.dividendsGrossUsd += row.gross_amount * rate;
          item.dividendsNetUsd += amounts.net * rate;
        }
      } else if (row.event_type === "trade_fee") {
        tradingFeesUsd += Math.abs(row.gross_amount) * rate;
        if (item) item.tradingFeesUsd += Math.abs(row.gross_amount) * rate;
      } else if (row.event_type === "financing_fee") {
        financingFeesUsd += Math.abs(row.gross_amount) * rate;
        if (item) item.financingFeesUsd += Math.abs(row.gross_amount) * rate;
      }
      if (key && item) byInstrument.set(key, item);
    }
    for (const trade of tradeRows(userId)) {
      const feeUsd = toUsd(Math.abs(trade.fee), trade.currency, fxToUsd, trade.fx_to_usd);
      tradingFeesUsd += feeUsd;
      const key = instrumentKey(trade.market, trade.symbol);
      const item = byInstrument.get(key) ?? {
        realizedCapitalGainUsd: 0,
        dividendsGrossUsd: 0,
        dividendsNetUsd: 0,
        tradingFeesUsd: 0,
        financingFeesUsd: 0,
      };
      item.tradingFeesUsd += feeUsd;
      byInstrument.set(key, item);
      if (!trade.fx_to_usd) issues.push(`trade:${trade.id}:historical_fx_estimated`);
    }
    return {
      realizedCapitalGainUsd: roundAmount(realizedCapitalGainUsd),
      dividendsGrossUsd: roundAmount(dividendsGrossUsd),
      dividendsNetUsd: roundAmount(dividendsNetUsd),
      tradingFeesUsd: roundAmount(tradingFeesUsd),
      financingFeesUsd: roundAmount(financingFeesUsd),
      byInstrument,
      issues,
    };
  }

  function budgetUsage(userId: number, bucket: string) {
    let rawUsd = 0;
    let total = 0;
    let known = 0;
    const missing: string[] = [];
    for (const row of tradeRows(userId)) {
      if (!row.bucket) {
        total += 1;
        missing.push(`trade:${row.id}:bucket`);
        continue;
      }
      if (row.bucket !== bucket) continue;
      total += 1;
      known += 1;
      const gross = row.gross_amount ?? row.quantity * row.price;
      const amount = row.side === "buy" ? gross + row.fee : -(gross - row.fee);
      rawUsd += toUsd(amount, row.currency, fxToUsd, row.fx_to_usd);
    }
    for (const row of capitalRows(userId)) {
      if (row.event_type !== "transfer_in" && row.event_type !== "transfer_out") continue;
      const eventBucket = row.bucket;
      if (!eventBucket) {
        total += 1;
        missing.push(`capital_event:${row.id}:bucket`);
        continue;
      }
      if (eventBucket !== bucket) continue;
      total += 1;
      const amount = capitalAmount(row);
      if (amount == null) {
        missing.push(`capital_event:${row.id}:transfer_cost`);
        continue;
      }
      known += 1;
      const signed = row.event_type === "transfer_in" ? amount : -amount;
      rawUsd += toUsd(signed, row.currency, fxToUsd, row.fx_to_usd);
    }
    for (const row of cashFlowRows(userId)) {
      if (row.event_type !== "dividend") continue;
      if (!row.bucket) {
        total += 1;
        missing.push(`cash_flow:${row.id}:bucket`);
        continue;
      }
      if (row.bucket !== bucket) continue;
      total += 1;
      known += 1;
      rawUsd -= toUsd(cashFlowAmounts(row).net, row.currency, fxToUsd, row.fx_to_usd);
    }
    return {
      rawUsd: roundAmount(rawUsd),
      usedUsd: roundAmount(Math.max(0, rawUsd)),
      recoveredSurplusUsd: roundAmount(Math.max(0, -rawUsd)),
      coverage: coverage(total, known, missing),
    };
  }

  function unifiedCashFlows(
    userId: number,
    filters: { from?: string; to?: string; category?: string; market?: string; symbol?: string; display?: Currency },
  ) {
    const display = filters.display ?? "USD";
    const items: Array<Record<string, unknown> & { eventDate: string; category: string; market: string | null; symbol: string | null; cashImpactUsd: number; pnlImpactUsd: number }> = [];
    for (const row of capitalRows(userId)) {
      const serialized = serializeCapital(row, display);
      const amount = capitalAmount(row);
      const rate = row.fx_to_usd && row.fx_to_usd > 0 ? row.fx_to_usd : fxToUsd[row.currency] ?? 1;
      const isCash = row.event_type === "cash_in" || row.event_type === "cash_out" || row.event_type === "adjustment";
      const impact = amount == null ? 0 : capitalImpact(row.event_type, amount);
      items.push({
        ...serialized,
        id: `capital:${row.id}`,
        category: "capital",
        market: row.market,
        symbol: row.symbol,
        eventDate: row.event_date,
        grossAmount: amount,
        grossAmountUsd: amount == null ? null : roundAmount(amount * rate),
        grossAmountDisplay: amount == null ? null : roundAmount(fromUsd(amount * rate, display, fxToUsd)),
        feeAmount: 0,
        feeAmountUsd: 0,
        feeAmountDisplay: 0,
        taxAmount: 0,
        taxAmountUsd: 0,
        taxAmountDisplay: 0,
        cashImpact: isCash ? roundAmount(impact) : 0,
        cashImpactUsd: isCash ? roundAmount(impact * rate) : 0,
        cashImpactDisplay: isCash ? roundAmount(fromUsd(impact * rate, display, fxToUsd)) : 0,
        pnlImpactUsd: 0,
        pnlImpact: 0,
        pnlImpactDisplay: 0,
      });
    }
    for (const row of cashFlowRows(userId)) {
      const serialized = serializeCashFlow(row, display);
      const amounts = cashFlowAmounts(row);
      const rate = row.fx_to_usd && row.fx_to_usd > 0 ? row.fx_to_usd : fxToUsd[row.currency] ?? 1;
      items.push({
        ...serialized,
        id: `cash:${row.id}`,
        category: row.event_type === "dividend" ? "dividend" : row.event_type === "realized_gain" ? "realized_gain" : "fee",
        market: row.market,
        symbol: row.symbol,
        eventDate: row.event_date,
        cashImpactUsd: roundAmount(amounts.cashImpact * rate),
        pnlImpactUsd: roundAmount(amounts.pnlImpact * rate),
      });
    }
    for (const row of tradeRows(userId)) {
      const rate = row.fx_to_usd && row.fx_to_usd > 0 ? row.fx_to_usd : fxToUsd[row.currency] ?? 1;
      const gross = row.gross_amount ?? row.quantity * row.price;
      const cashImpact = row.side === "buy" ? -(gross + row.fee) : gross - row.fee;
      items.push({
        id: `trade:${row.id}`,
        eventDate: row.trade_date,
        category: "trade",
        type: row.side,
        broker: row.broker,
        market: row.market,
        currency: row.currency,
        symbol: row.symbol,
        name: row.name,
        grossAmount: roundAmount(gross),
        grossAmountUsd: roundAmount(gross * rate),
        grossAmountDisplay: roundAmount(fromUsd(gross * rate, display, fxToUsd)),
        feeAmount: roundAmount(row.fee),
        feeAmountUsd: roundAmount(row.fee * rate),
        feeAmountDisplay: roundAmount(fromUsd(row.fee * rate, display, fxToUsd)),
        taxAmount: 0,
        taxAmountUsd: 0,
        taxAmountDisplay: 0,
        cashImpact: roundAmount(cashImpact),
        cashImpactUsd: roundAmount(cashImpact * rate),
        cashImpactDisplay: roundAmount(fromUsd(cashImpact * rate, display, fxToUsd)),
        pnlImpact: roundAmount(-row.fee),
        pnlImpactUsd: roundAmount(-row.fee * rate),
        pnlImpactDisplay: roundAmount(fromUsd(-row.fee * rate, display, fxToUsd)),
        fxRate: rate,
        source: row.source,
        sourceId: row.source_id,
        coverage: coverage(1, 1, [], row.fx_to_usd ? [] : ["historical_fx_estimated"]),
      });
    }
    const normalizedMarket = filters.market ? normalizeMarket(filters.market) : null;
    const symbol = filters.symbol?.trim().toUpperCase();
    const filtered = items
      .filter((item) => !filters.from || item.eventDate >= filters.from)
      .filter((item) => !filters.to || item.eventDate <= filters.to)
      .filter((item) => !filters.category || item.category === filters.category)
      .filter((item) => !normalizedMarket || item.market === normalizedMarket)
      .filter((item) => !symbol || item.symbol === symbol)
      .sort((a, b) => (a.eventDate === b.eventDate ? String(b.id).localeCompare(String(a.id)) : b.eventDate.localeCompare(a.eventDate)));
    const summaryUsd = {
      buy: 0,
      sell: 0,
      dividend: 0,
      fees: 0,
      externalIn: 0,
      externalOut: 0,
      netCash: 0,
    };
    for (const item of filtered) {
      const cash = Number(item.cashImpactUsd ?? 0);
      const gross = Number(item.grossAmountUsd ?? 0);
      const fee = Number(item.feeAmountUsd ?? 0);
      summaryUsd.netCash += cash;
      if (item.category === "trade" && item.type === "buy") summaryUsd.buy += gross;
      if (item.category === "trade" && item.type === "sell") summaryUsd.sell += gross;
      if (item.category === "trade") summaryUsd.fees += fee;
      if (item.category === "dividend") summaryUsd.dividend += cash;
      if (item.category === "fee") summaryUsd.fees += -cash;
      if (item.category === "capital" && cash > 0) summaryUsd.externalIn += cash;
      if (item.category === "capital" && cash < 0) summaryUsd.externalOut += -cash;
    }
    const summary = Object.fromEntries(
      Object.entries(summaryUsd).map(([key, value]) => [key, roundAmount(fromUsd(value, display, fxToUsd))]),
    );
    return { display, baseCurrency: "USD", items: filtered, summary, summaryUsd: Object.fromEntries(Object.entries(summaryUsd).map(([k, v]) => [k, roundAmount(v)])) };
  }

  return {
    bucketFor,
    importStatementEvents,
    capitalSummary,
    performanceSummary,
    budgetUsage,
    unifiedCashFlows,

    listCapitalEvents(userId: number, display: Currency = "USD") {
      return capitalRows(userId).map((row) => serializeCapital(row, display));
    },
    createCapitalEvent(userId: number, input: CapitalEventInput, display: Currency = "USD") {
      const id = insertCapital(userId, input);
      const row = db.prepare("SELECT * FROM capital_events WHERE id = ? AND user_id = ?").get(id, userId) as CapitalRow;
      return serializeCapital(row, display);
    },
    updateCapitalEvent(userId: number, id: number, input: CapitalEventInput, display: Currency = "USD") {
      validateCapital(input);
      const existing = db.prepare("SELECT id FROM capital_events WHERE id = ? AND user_id = ?").get(id, userId);
      if (!existing) return null;
      const currency = requireCurrency(input.currency);
      const market = input.market ? normalizeMarket(input.market) : null;
      const symbol = input.symbol?.trim().toUpperCase() || null;
      db.prepare(
        `UPDATE capital_events SET event_type = ?, event_date = ?, broker = ?, market = ?, currency = ?, symbol = ?, name = ?,
         amount = ?, quantity = ?, unit_cost = ?, fx_to_usd = ?, bucket = ?, source = ?, source_id = ?, note = ?, updated_at = datetime('now')
         WHERE id = ? AND user_id = ?`,
      ).run(
        input.type,
        input.eventDate,
        input.broker?.trim() || null,
        market,
        currency,
        symbol,
        input.name?.trim() || symbol,
        input.amount ?? null,
        input.quantity ?? null,
        input.unitCost ?? null,
        fxToUsd[currency] ?? 1,
        bucketFor(userId, market, symbol),
        input.source?.trim() || "manual",
        input.sourceId?.trim() || null,
        input.note?.trim() || null,
        id,
        userId,
      );
      return serializeCapital(db.prepare("SELECT * FROM capital_events WHERE id = ?").get(id) as CapitalRow, display);
    },
    deleteCapitalEvent(userId: number, id: number) {
      return db.prepare("DELETE FROM capital_events WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
    },

    listCashFlowEvents(userId: number, display: Currency = "USD") {
      return cashFlowRows(userId).map((row) => serializeCashFlow(row, display));
    },
    createCashFlowEvent(userId: number, input: CashFlowEventInput, display: Currency = "USD") {
      const id = insertCashFlow(userId, input);
      return serializeCashFlow(db.prepare("SELECT * FROM cash_flow_events WHERE id = ?").get(id) as CashFlowRow, display);
    },
    updateCashFlowEvent(userId: number, id: number, input: CashFlowEventInput, display: Currency = "USD") {
      validateCashFlow(input);
      const existing = db.prepare("SELECT id FROM cash_flow_events WHERE id = ? AND user_id = ?").get(id, userId);
      if (!existing) return null;
      const currency = requireCurrency(input.currency);
      const market = input.market ? normalizeMarket(input.market) : null;
      const symbol = input.symbol?.trim().toUpperCase() || null;
      db.prepare(
        `UPDATE cash_flow_events SET event_type = ?, event_date = ?, broker = ?, market = ?, currency = ?, symbol = ?, name = ?,
         gross_amount = ?, tax_amount = ?, fee_amount = ?, fx_to_usd = ?, bucket = ?, source = ?, source_id = ?, note = ?,
         updated_at = datetime('now') WHERE id = ? AND user_id = ?`,
      ).run(
        input.type,
        input.eventDate,
        input.broker?.trim() || null,
        market,
        currency,
        symbol,
        input.name?.trim() || symbol,
        input.grossAmount,
        input.taxAmount ?? 0,
        input.feeAmount ?? 0,
        fxToUsd[currency] ?? 1,
        bucketFor(userId, market, symbol),
        input.source?.trim() || "manual",
        input.sourceId?.trim() || null,
        input.note?.trim() || null,
        id,
        userId,
      );
      return serializeCashFlow(db.prepare("SELECT * FROM cash_flow_events WHERE id = ?").get(id) as CashFlowRow, display);
    },
    deleteCashFlowEvent(userId: number, id: number) {
      return db.prepare("DELETE FROM cash_flow_events WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
    },
  };
}

export type LedgerService = ReturnType<typeof createLedgerService>;
