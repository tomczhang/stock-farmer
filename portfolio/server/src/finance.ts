import { ValidationError } from "./errors.js";
import type { Bucket, Coverage, Currency } from "./types.js";

export const CURRENCIES: Currency[] = ["USD", "HKD", "CNY"];
export const BUCKETS: Bucket[] = ["aggressive", "defensive", "stable", "grant"];

export function normalizeCurrency(value: unknown, fallback: Currency = "HKD"): Currency {
  const text = String(value ?? "").toUpperCase();
  return CURRENCIES.includes(text as Currency) ? (text as Currency) : fallback;
}

export function requireCurrency(value: unknown): Currency {
  const text = String(value ?? "").toUpperCase();
  if (!CURRENCIES.includes(text as Currency)) throw new ValidationError("币种仅支持 USD/HKD/CNY");
  return text as Currency;
}

export function normalizeMarket(value: unknown): string {
  const text = String(value ?? "").trim().toUpperCase();
  if (["US", "USA", "NASDAQ", "NYSE", "AMEX", "美股", "美国"].some((m) => text.includes(m))) return "US";
  if (["HK", "HKEX", "SEHK", "港股", "香港"].some((m) => text.includes(m))) return "HK";
  if (["SH", "SZ", "CN", "A股", "沪", "深"].some((m) => text.includes(m))) return "CN";
  return text || "OTHER";
}

export function validateDate(value: unknown, label = "日期"): string {
  const text = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new ValidationError(`${label}需为 YYYY-MM-DD`);
  return text;
}

export function validateQuarter(value: unknown): string {
  const text = String(value ?? "").toUpperCase();
  if (!/^\d{4}-Q[1-4]$/.test(text)) throw new ValidationError("季度需为 YYYY-Q1 至 YYYY-Q4");
  return text;
}

export function quarterForDate(date = new Date()): string {
  return `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
}

export function nextQuarter(quarter: string): string {
  const valid = validateQuarter(quarter);
  const year = Number(valid.slice(0, 4));
  const q = Number(valid.at(-1));
  return q === 4 ? `${year + 1}-Q1` : `${year}-Q${q + 1}`;
}

export function requireBucket(value: unknown): Bucket {
  if (!BUCKETS.includes(value as Bucket)) throw new ValidationError("仓别非法（aggressive/defensive/stable/grant）");
  return value as Bucket;
}

export function fxRate(fxToUsd: Record<string, number>, currency: string): number {
  const rate = fxToUsd[currency];
  if (!(rate > 0)) throw new ValidationError(`缺少 ${currency} 汇率`);
  return rate;
}

export function toUsd(amount: number, currency: string, fxToUsd: Record<string, number>, capturedRate?: number | null) {
  return amount * (capturedRate && capturedRate > 0 ? capturedRate : fxRate(fxToUsd, currency));
}

export function fromUsd(amount: number, currency: string, fxToUsd: Record<string, number>) {
  return amount / fxRate(fxToUsd, currency);
}

export function roundAmount(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function coverage(total: number, known: number, missing: string[] = [], issues: string[] = []): Coverage {
  const uniqueMissing = Array.from(new Set(missing));
  const uniqueIssues = Array.from(new Set(issues));
  const ratio = total <= 0 ? (uniqueMissing.length ? 0 : 1) : Math.max(0, Math.min(1, known / total));
  return {
    status: uniqueMissing.length === 0 && ratio === 1 ? "complete" : known === 0 ? "missing" : "partial",
    ratio: roundAmount(ratio, 4),
    missing: uniqueMissing,
    issues: uniqueIssues,
  };
}

export function instrumentKey(market: string | null | undefined, symbol: string | null | undefined) {
  return `${normalizeMarket(market)}:${String(symbol ?? "").trim().toUpperCase()}`;
}
