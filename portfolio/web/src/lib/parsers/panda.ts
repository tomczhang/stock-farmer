import { parseLongbridgePdfs, type ManualCostInput, type ManualSecurityAliasInput } from "@/lib/parsers/longbridge";
import type { ParsedInput } from "@/lib/tax/types";

interface PandaFileInput {
  name: string;
  data: ArrayBuffer;
}

function relabelText(value: string | undefined) {
  return value?.replaceAll("长桥", "熊猫").replaceAll("longbridge", "panda") ?? value;
}

function relabelId(value: string) {
  return value.replaceAll("longbridge", "panda");
}

function relabelBroker(value: string) {
  return value === "长桥" ? "熊猫" : value;
}

function longbridgeManualCosts(manualCosts: ManualCostInput[] = []): ManualCostInput[] {
  return manualCosts.map((item) => ({
    ...item,
    id: item.id.replaceAll("panda", "longbridge"),
  }));
}

function relabelParsedInput(input: ParsedInput): ParsedInput {
  return {
    ...input,
    realizedTrades: input.realizedTrades.map((trade) => ({
      ...trade,
      id: relabelId(trade.id),
      broker: relabelBroker(trade.broker),
      source: relabelText(trade.source) ?? trade.source,
      note: relabelText(trade.note),
    })),
    tradeActivities: input.tradeActivities.map((activity) => ({
      ...activity,
      id: relabelId(activity.id),
      broker: relabelBroker(activity.broker),
      source: relabelText(activity.source) ?? activity.source,
      note: relabelText(activity.note),
    })),
    dividends: input.dividends.map((dividend) => ({
      ...dividend,
      id: relabelId(dividend.id),
      broker: relabelBroker(dividend.broker),
      source: relabelText(dividend.source) ?? dividend.source,
      note: relabelText(dividend.note),
    })),
    openPositions: input.openPositions.map((position) => ({
      ...position,
      id: relabelId(position.id),
      broker: relabelBroker(position.broker),
      source: relabelText(position.source) ?? position.source,
      note: relabelText(position.note),
    })),
    issues: input.issues.map((issue) => ({
      ...issue,
      id: relabelId(issue.id),
      title: relabelText(issue.title) ?? issue.title,
      detail: relabelText(issue.detail) ?? issue.detail,
      source: relabelText(issue.source),
    })),
    costBasisRequests: input.costBasisRequests.map((request) => ({
      ...request,
      id: relabelId(request.id),
      broker: relabelBroker(request.broker),
      source: relabelText(request.source) ?? request.source,
      note: relabelText(request.note),
    })),
    taxStatementSummaries: input.taxStatementSummaries.map((summary) => ({
      ...summary,
      id: relabelId(summary.id),
      broker: relabelBroker(summary.broker),
      source: relabelText(summary.source) ?? summary.source,
    })),
  };
}

export async function parsePandaPdfs(
  files: PandaFileInput[],
  password?: string,
  options: { targetYear?: number; manualCosts?: ManualCostInput[]; securityAliases?: ManualSecurityAliasInput[] } = {},
): Promise<ParsedInput> {
  const parsed = await parseLongbridgePdfs(files, password, {
    ...options,
    manualCosts: longbridgeManualCosts(options.manualCosts ?? []),
  });
  return relabelParsedInput(parsed);
}
