import type { PdfLine } from "./pdfText";

export interface ExtractedCash {
  currency: "USD" | "HKD" | "CNY";
  amount: number;
  evidence: string;
}

// 现金结余行关键词（跨券商 best-effort；提取不到由用户手动补录兜底）
const BALANCE_KEYWORDS = [
  /ending\s+(settled\s+)?cash/i,
  /cash\s+balance/i,
  /closing\s+(cash\s+)?balance/i,
  /期末结余/,
  /期末结馀/,
  /期末现金/,
  /现金结余/,
  /現金結餘/,
  /可用现金/,
  /可用結餘/,
  /结余金额/,
  /本期结余/,
  /承下结余/,
  /現金結存/,
  /现金结存/,
];

const CURRENCY_HINTS: Array<{ pattern: RegExp; currency: ExtractedCash["currency"] }> = [
  { pattern: /\b(USD|US\$)\b|美元|美金/, currency: "USD" },
  { pattern: /\b(HKD|HK\$)\b|港元|港币|港幣/, currency: "HKD" },
  { pattern: /\b(CNH|CNY|RMB)\b|人民币|人民幣|离岸人民币/, currency: "CNY" },
];

function currencyInText(text: string): ExtractedCash["currency"] | null {
  for (const hint of CURRENCY_HINTS) {
    if (hint.pattern.test(text)) return hint.currency;
  }
  return null;
}

function lastNumber(text: string): number | null {
  // 匹配 1,234.56 / -1,234.56 / (1,234.56) 形式，取行内最后一个
  const matches = text.match(/\(?-?[\d,]+\.\d{2}\)?/g);
  if (!matches || matches.length === 0) return null;
  const raw = matches[matches.length - 1];
  const negative = raw.startsWith("(") || raw.startsWith("-");
  const value = Number(raw.replace(/[(),]/g, ""));
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

/**
 * 从月结单 PDF 文本行中 best-effort 提取各币种现金结余。
 * 策略：命中结余关键词的行，取行内币种 + 最后一个金额；
 * 行内无币种时回溯最近 5 行内的币种上下文（月结单常按币种分节）。
 * 同币种多次命中取最后一次（通常为期末值）。
 */
export function extractCashBalances(lines: PdfLine[]): ExtractedCash[] {
  const found = new Map<ExtractedCash["currency"], ExtractedCash>();
  for (let i = 0; i < lines.length; i += 1) {
    const { text } = lines[i];
    if (!BALANCE_KEYWORDS.some((keyword) => keyword.test(text))) continue;
    const amount = lastNumber(text);
    if (amount === null) continue;
    let currency = currencyInText(text);
    if (!currency) {
      for (let back = i - 1; back >= Math.max(0, i - 5); back -= 1) {
        currency = currencyInText(lines[back].text);
        if (currency) break;
      }
    }
    if (!currency) continue;
    found.set(currency, { currency, amount, evidence: text.slice(0, 120) });
  }
  return Array.from(found.values()).filter((c) => c.amount !== 0 || found.size === 1);
}
