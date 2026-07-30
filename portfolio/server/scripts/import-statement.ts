/**
 * 离线导入券商账单到本地数据库（绕过 HTTP 层与登录，直接复用服务层校验逻辑）。
 *
 * 用法（在 portfolio/server 目录下执行）：
 *   npx tsx scripts/import-statement.ts data/statements/ibkr-2026-07-28.json [--db data/local.db] [--email you@example.com]
 *
 * 输入 JSON 结构：
 *   {
 *     "statement":      StatementPayload   // 持仓快照 + 逐笔交易 + 转仓 + 已实现盈亏 + 股息
 *     "capitalEvents":  CapitalEventInput[]  // 可选：入金/出金等资本事件
 *     "cashFlowEvents": CashFlowEventInput[] // 可选：融资利息/托管费等收益费用事件
 *   }
 *
 * 幂等性：
 *   - statement 按 broker + asOf 覆盖旧快照（级联删除其 trades/转仓/已实现/股息后重建）；
 *   - capitalEvents / cashFlowEvents 按 (source, sourceId) 唯一去重，重跑不会重复入账。
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db.js";
import { createLedgerService } from "../src/ledger.js";
import { createPortfolioService } from "../src/portfolio.js";
import type { CapitalEventInput, CashFlowEventInput, StatementPayload } from "../src/types.js";

interface ImportFile {
  statement: StatementPayload;
  capitalEvents?: CapitalEventInput[];
  cashFlowEvents?: CashFlowEventInput[];
}

function parseArgs(argv: string[]) {
  const args = { file: "", db: "", email: "" };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--db") args.db = argv[++i] ?? "";
    else if (argv[i] === "--email") args.email = argv[++i] ?? "";
    else rest.push(argv[i]);
  }
  args.file = rest[0] ?? "";
  return args;
}

function main() {
  const { file, db: dbArg, email } = parseArgs(process.argv.slice(2));
  if (!file) {
    console.error("用法: npx tsx scripts/import-statement.ts <statement.json> [--db <path>] [--email <email>]");
    process.exit(1);
  }
  const filePath = path.resolve(file);
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as ImportFile;
  if (!parsed.statement) {
    console.error("JSON 缺少 statement 字段");
    process.exit(1);
  }

  const config = loadConfig();
  const dbPath = dbArg || process.env.DB_PATH || "./data/local.db";
  const db = openDatabase(dbPath);

  // 定位用户：--email 优先；否则库中唯一用户
  const users = db.prepare("SELECT id, email FROM users ORDER BY id").all() as Array<{ id: number; email: string }>;
  const user = email ? users.find((u) => u.email === email) : users.length === 1 ? users[0] : undefined;
  if (!user) {
    console.error(email ? `找不到用户 ${email}` : `库中有 ${users.length} 个用户，请用 --email 指定`);
    process.exit(1);
  }

  const ledger = createLedgerService(db, config.fxToUsd);
  const portfolio = createPortfolioService(db, config.fxToUsd, ledger);

  const statementId = portfolio.saveStatement(user.id, parsed.statement);

  let capitalCount = 0;
  for (const event of parsed.capitalEvents ?? []) {
    ledger.createCapitalEvent(user.id, event);
    capitalCount++;
  }
  let cashFlowCount = 0;
  for (const event of parsed.cashFlowEvents ?? []) {
    ledger.createCashFlowEvent(user.id, event);
    cashFlowCount++;
  }

  const meta = db.prepare("SELECT parsed_json FROM statements WHERE id = ?").get(statementId) as { parsed_json: string };
  const importIssues: string[] = JSON.parse(meta.parsed_json ?? "{}").importIssues ?? [];

  console.log(`✅ 导入完成（用户 ${user.email}，statement #${statementId}）`);
  console.log(`   快照: ${parsed.statement.broker} @ ${parsed.statement.asOf}`);
  console.log(`   持仓 ${parsed.statement.positions.length} 条，现金 ${parsed.statement.cashBalances.length} 条`);
  console.log(
    `   交易/转仓 ${parsed.statement.tradeActivities?.length ?? 0} 条，已实现 ${parsed.statement.realizedTrades?.length ?? 0} 条，股息 ${parsed.statement.dividends?.length ?? 0} 条`,
  );
  console.log(`   资本事件 ${capitalCount} 条，收益费用事件 ${cashFlowCount} 条`);
  if (importIssues.length) {
    console.log("⚠️  导入提示:");
    for (const issue of importIssues) console.log(`   - ${issue}`);
  }
  db.close();
}

main();
