import type { ParsedInput } from "@/lib/tax/types";

// tax-check calculator 的最小 shim：parser 只依赖这两个纯函数。
export function emptyParsedInput(): ParsedInput {
  return {
    realizedTrades: [],
    tradeActivities: [],
    dividends: [],
    openPositions: [],
    issues: [],
    costBasisRequests: [],
    taxStatementSummaries: [],
  };
}

export function mergeParsedInputs(inputs: ParsedInput[]): ParsedInput {
  return inputs.reduce<ParsedInput>(
    (merged, current) => ({
      realizedTrades: [...merged.realizedTrades, ...current.realizedTrades],
      tradeActivities: [...merged.tradeActivities, ...current.tradeActivities],
      dividends: [...merged.dividends, ...current.dividends],
      openPositions: [...merged.openPositions, ...current.openPositions],
      issues: [...merged.issues, ...current.issues],
      costBasisRequests: [...merged.costBasisRequests, ...current.costBasisRequests],
      taxStatementSummaries: [...merged.taxStatementSummaries, ...(current.taxStatementSummaries ?? [])],
    }),
    emptyParsedInput(),
  );
}
