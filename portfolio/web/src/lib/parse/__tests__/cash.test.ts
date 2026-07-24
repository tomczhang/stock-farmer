import { describe, expect, it } from "vitest";
import { extractCashBalances } from "../cash";
import type { PdfLine } from "../pdfText";

function lines(...texts: string[]): PdfLine[] {
  return texts.map((text, i) => ({ page: 1, text }));
}

describe("extractCashBalances", () => {
  it("IBKR 英文报表：Ending Cash + 行内币种", () => {
    const result = extractCashBalances(
      lines(
        "Cash Report",
        "Base Currency Summary",
        "USD",
        "Starting Cash 1,000.00",
        "Ending Cash 5,432.10",
        "HKD",
        "Starting Cash 0.00",
        "Ending Cash 20,000.00",
      ),
    );
    expect(result).toHaveLength(2);
    expect(result.find((c) => c.currency === "USD")?.amount).toBe(5432.1);
    expect(result.find((c) => c.currency === "HKD")?.amount).toBe(20000.0);
  });

  it("中文月结单：现金结余 + 币种上下文回溯", () => {
    const result = extractCashBalances(
      lines(
        "现金账户 港元",
        "承上结余 8,000.00",
        "现金结余 12,345.67",
        "现金账户 美元",
        "现金结余 999.99",
      ),
    );
    expect(result.find((c) => c.currency === "HKD")?.amount).toBe(12345.67);
    expect(result.find((c) => c.currency === "USD")?.amount).toBe(999.99);
  });

  it("同币种多次命中取最后一次（期末值）", () => {
    const result = extractCashBalances(
      lines("USD Cash Balance 100.00", "USD Cash Balance 250.50"),
    );
    expect(result).toHaveLength(1);
    expect(result[0].amount).toBe(250.5);
  });

  it("负数与括号格式", () => {
    const result = extractCashBalances(lines("USD Ending Cash (1,234.56)"));
    expect(result[0].amount).toBe(-1234.56);
  });

  it("无关键词行不提取", () => {
    const result = extractCashBalances(
      lines("AAPL 100 shares 21,000.00 USD", "Total Portfolio Value 30,000.00"),
    );
    expect(result).toHaveLength(0);
  });

  it("有关键词但无币种上下文时跳过", () => {
    const result = extractCashBalances(lines("Ending Cash 5,000.00"));
    expect(result).toHaveLength(0);
  });
});
