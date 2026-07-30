const COVERAGE_LABELS: Record<string, string> = {
  bucket_budget: "未设置该仓季度资金预算",
  bucket: "尚未为标的分配仓别",
  cash: "尚无可用现金余额",
  valuation: "持仓估值数据不完整",
  current_book_cost: "尚未确认当前账面成本",
  external_capital_events: "尚未初始化外部净投入",
  instrument_external_net_invested: "尚未初始化该标的外部净投入",
  native_currency_aggregation: "券商持仓币种不一致，无法确认原币成本与价格",
  book_cost: "尚未确认账面成本",
};

function stripScope(code: string) {
  let value = code.trim();
  while (value.startsWith("budget:")) value = value.slice("budget:".length);
  return value;
}

export function describeCoverageCode(code: string) {
  const normalized = stripScope(code);
  if (/[一-鿿]/.test(normalized)) return normalized;

  const [kind, market, symbol] = normalized.split(":");
  if (kind === "book_cost" && symbol) return `${market ? `${market}:${symbol}` : symbol} 尚未确认账面成本`;
  return COVERAGE_LABELS[kind] ?? "存在待补录的数据，请前往数据管理核对";
}

export function describeCoverageItems(items: Array<string | null | undefined>) {
  return Array.from(new Set(items.filter((item): item is string => !!item?.trim()).map(describeCoverageCode)));
}
