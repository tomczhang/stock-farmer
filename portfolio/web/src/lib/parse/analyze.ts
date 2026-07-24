import { mergeParsedInputs } from "@/lib/tax/calculator";
import { parseBociPdfs } from "@/lib/parsers/boci";
import { parseChiefPdfs } from "@/lib/parsers/chief";
import { parseCmbWingLungPdfs } from "@/lib/parsers/cmbWingLung";
import { parseFutuWorkbooks } from "@/lib/parsers/futu";
import { parseHuashengWorkbooks } from "@/lib/parsers/huasheng";
import { parseHuataiPdfs } from "@/lib/parsers/huatai";
import { parseIbkrPdfs } from "@/lib/parsers/ibkr";
import { parseLongbridgeFiles } from "@/lib/parsers/longbridge";
import { parsePandaPdfs } from "@/lib/parsers/panda";
import { parseTigerPdfs } from "@/lib/parsers/tiger";
import { parseUsmartPdfs } from "@/lib/parsers/usmart";
import { parseZirconPdfs } from "@/lib/parsers/zircon";
import { ParserValidationError } from "@/lib/parsers/common";
import type { OpenPosition, ParsedInput, ReviewIssue } from "@/lib/tax/types";
import { extractCashBalances, type ExtractedCash } from "./cash";
import { extractPdfLines } from "./pdfText";

export type BrokerId =
  | "ibkr"
  | "futu"
  | "tiger"
  | "longbridge"
  | "huasheng"
  | "huatai"
  | "usmart"
  | "boci"
  | "cmbWingLung"
  | "chief"
  | "panda"
  | "zircon";

export interface BrokerMeta {
  id: BrokerId;
  label: string;
  accept: string;
  needsPassword: boolean;
  hint: string;
}

export const BROKERS: BrokerMeta[] = [
  { id: "ibkr", label: "盈透 IBKR", accept: ".pdf", needsPassword: false, hint: "Activity Statement PDF" },
  { id: "futu", label: "富途", accept: ".xlsx,.xls", needsPassword: false, hint: "年度/月度报表 Excel" },
  { id: "tiger", label: "老虎", accept: ".pdf", needsPassword: false, hint: "活动报表 PDF" },
  { id: "longbridge", label: "长桥", accept: ".pdf,.xlsx,.xls", needsPassword: true, hint: "月结单 PDF（需密码）或明细 Excel" },
  { id: "huasheng", label: "华盛", accept: ".xlsx,.xls", needsPassword: false, hint: "交易/公司行动记录表 Excel" },
  { id: "huatai", label: "华泰国际", accept: ".pdf", needsPassword: false, hint: "月结单 PDF" },
  { id: "usmart", label: "uSMART 盈立", accept: ".pdf", needsPassword: true, hint: "月结单 PDF" },
  { id: "boci", label: "中银国际", accept: ".pdf", needsPassword: false, hint: "账户月结单 PDF" },
  { id: "cmbWingLung", label: "招商永隆", accept: ".pdf", needsPassword: false, hint: "月结单/收入报告 PDF" },
  { id: "chief", label: "致富", accept: ".pdf", needsPassword: true, hint: "月结单 PDF（需密码）" },
  { id: "panda", label: "熊猫", accept: ".pdf", needsPassword: true, hint: "月结单 PDF（需密码）" },
  { id: "zircon", label: "卓锐", accept: ".pdf", needsPassword: true, hint: "月结单 PDF（需密码）" },
];

export interface AnalyzeResult {
  positions: OpenPosition[];
  cashBalances: ExtractedCash[];
  issues: ReviewIssue[];
  asOf: string;
}

async function toNamedBuffers(files: File[]) {
  return Promise.all(files.map(async (file) => ({ name: file.name, data: await file.arrayBuffer() })));
}

async function dispatchParse(
  broker: BrokerId,
  files: Array<{ name: string; data: ArrayBuffer }>,
  password: string | undefined,
  targetYear: number,
): Promise<ParsedInput> {
  const opts = { targetYear, manualCosts: [] };
  switch (broker) {
    case "futu":
      return parseFutuWorkbooks(files, [], targetYear);
    case "huasheng":
      return parseHuashengWorkbooks(files, [], targetYear);
    case "huatai":
      return parseHuataiPdfs(files, opts);
    case "longbridge":
      return parseLongbridgeFiles(files, password, { ...opts, securityAliases: [] });
    case "panda": {
      if (!password?.trim()) throw new ParserValidationError("熊猫 PDF 需要填写密码");
      return parsePandaPdfs(files, password, { ...opts, securityAliases: [] });
    }
    case "boci":
      return parseBociPdfs(files, opts);
    case "cmbWingLung":
      return parseCmbWingLungPdfs(files, opts);
    case "chief": {
      if (!password?.trim()) throw new ParserValidationError("致富 PDF 需要填写密码");
      return parseChiefPdfs(files, password, opts);
    }
    case "zircon": {
      if (!password?.trim()) throw new ParserValidationError("卓锐 PDF 需要填写密码");
      return parseZirconPdfs(files, password, opts);
    }
    case "tiger":
      return parseTigerPdfs(files);
    case "ibkr":
      return parseIbkrPdfs(files);
    case "usmart":
      return parseUsmartPdfs(files, password, opts);
    default:
      throw new ParserValidationError(`未知券商：${broker}`);
  }
}

/** 浏览器端解析月结单：持仓 + 现金（文件与密码不出本地）。 */
export async function analyzeStatementFiles(options: {
  broker: BrokerId;
  files: File[];
  password?: string;
}): Promise<AnalyzeResult> {
  const { broker, files, password } = options;
  if (files.length === 0) throw new ParserValidationError("请先选择月结单文件");
  const meta = BROKERS.find((b) => b.id === broker);
  if (!meta) throw new ParserValidationError(`未知券商：${broker}`);
  const allowed = meta.accept.split(",");
  for (const file of files) {
    if (!allowed.some((ext) => file.name.toLowerCase().endsWith(ext.trim()))) {
      throw new ParserValidationError(`${file.name} 不是 ${meta.label} 支持的文件类型（${meta.accept}）`);
    }
  }

  const buffers = await toNamedBuffers(files);
  const targetYear = new Date().getFullYear();
  const parsed = mergeParsedInputs([await dispatchParse(broker, buffers, password, targetYear)]);
  const blocking = parsed.issues.find((issue) => issue.severity === "blocking");
  if (blocking) {
    throw new ParserValidationError(`${blocking.title}：${blocking.detail}`, blocking.source);
  }

  // 现金：对 PDF 文件做 best-effort 提取（Excel 类由用户手动补录）
  const cashBalances: ExtractedCash[] = [];
  for (const buffer of buffers) {
    if (!buffer.name.toLowerCase().endsWith(".pdf")) continue;
    try {
      const lines = await extractPdfLines(buffer.data, password);
      for (const cash of extractCashBalances(lines)) {
        const existing = cashBalances.find((c) => c.currency === cash.currency);
        if (existing) {
          existing.amount = cash.amount; // 后出现者（通常为更近期文件）覆盖
        } else {
          cashBalances.push(cash);
        }
      }
    } catch {
      // 现金提取失败不阻塞持仓解析，走手动补录
    }
  }

  const asOfDates = parsed.openPositions.map((p) => p.asOf).filter(Boolean).sort();
  const asOf = asOfDates.at(-1) ?? new Date().toISOString().slice(0, 10);

  return {
    positions: parsed.openPositions,
    cashBalances,
    issues: parsed.issues,
    asOf,
  };
}
