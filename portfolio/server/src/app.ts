import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { AuthError, createAuthService } from "./auth.js";
import type { AppConfig } from "./config.js";
import type { AppDatabase } from "./db.js";
import { ConflictError, ValidationError } from "./errors.js";
import { createLedgerService } from "./ledger.js";
import type { Mailer } from "./mailer.js";
import { createPlanService } from "./plans.js";
import { createPortfolioService } from "./portfolio.js";
import { createQuoteService, type QuoteFetcher } from "./quotes.js";
import { createRiskService } from "./risk.js";
import type {
  Bucket,
  BucketBudgetInput,
  CapitalEventInput,
  CashBalanceInput,
  CashFlowEventInput,
  Currency,
  PlanInput,
  RiskSettingsInput,
  SafeAddInput,
  StatementPayload,
  TradeInput,
} from "./types.js";

const SESSION_COOKIE = "sf_session";

export interface AppOptions {
  db: AppDatabase;
  config: AppConfig;
  mailer: Mailer;
  quoteFetcher?: QuoteFetcher;
  secureCookie?: boolean;
}

type Env = { Variables: { userId: number } };

export function createApp({ db, config, mailer, quoteFetcher, secureCookie = true }: AppOptions) {
  const auth = createAuthService(db, mailer);
  const ledger = createLedgerService(db, config.fxToUsd);
  const portfolio = createPortfolioService(db, config.fxToUsd, ledger);
  const risk = createRiskService(db, config.fxToUsd, ledger, (userId, market, symbol, bucket) =>
    portfolio.riskContext(userId, market, symbol, bucket),
  );
  const plans = createPlanService(db, config.fxToUsd, risk);
  const quotes = createQuoteService(db, quoteFetcher);

  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof AuthError) return c.json({ error: err.message }, err.status as 400);
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    if (err instanceof ConflictError) return c.json({ error: err.message, ...err.details }, 409);
    console.error(err);
    return c.json({ error: "服务器内部错误" }, 500);
  });

  app.get("/api/health", (c) => c.json({ status: "ok" }));

  // ---------- auth ----------
  app.post("/api/auth/register", async (c) => {
    const { email, password } = await c.req.json();
    await auth.register(email, password);
    return c.json({ ok: true, message: "验证码已发送至邮箱" });
  });

  app.post("/api/auth/resend", async (c) => {
    const { email } = await c.req.json();
    await auth.resendCode(email);
    return c.json({ ok: true, message: "验证码已重新发送" });
  });

  app.post("/api/auth/verify", async (c) => {
    const { email, code } = await c.req.json();
    auth.verify(email, code);
    return c.json({ ok: true, message: "邮箱验证成功，请登录" });
  });

  app.post("/api/auth/login", async (c) => {
    const { email, password } = await c.req.json();
    const token = auth.login(email, password);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "Lax",
      secure: secureCookie,
      path: "/",
      maxAge: 30 * 24 * 3600,
    });
    return c.json({ ok: true });
  });

  app.post("/api/auth/logout", (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) auth.logout(token);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // ---------- 受保护路由 ----------
  app.use("/api/*", async (c, next) => {
    if (c.req.path.startsWith("/api/auth/") || c.req.path === "/api/health") return next();
    const token = getCookie(c, SESSION_COOKIE);
    const userId = token ? auth.userIdForToken(token) : null;
    if (!userId) return c.json({ error: "未登录" }, 401);
    c.set("userId", userId);
    return next();
  });

  app.get("/api/auth/me", (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    const userId = token ? auth.userIdForToken(token) : null;
    if (!userId) return c.json({ error: "未登录" }, 401);
    return c.json({ id: userId, email: auth.userEmail(userId) });
  });

  // ---------- statements ----------
  app.post("/api/statements", async (c) => {
    const payload = (await c.req.json()) as StatementPayload;
    const id = portfolio.saveStatement(c.get("userId"), payload);
    return c.json({ ok: true, id }, 201);
  });

  app.get("/api/statements", (c) => c.json(portfolio.listStatements(c.get("userId"))));

  app.delete("/api/statements/:id", (c) => {
    const ok = portfolio.deleteStatement(c.get("userId"), Number(c.req.param("id")));
    return ok ? c.json({ ok: true }) : c.json({ error: "快照不存在" }, 404);
  });

  // ---------- cash ----------
  app.put("/api/cash", async (c) => {
    const body = (await c.req.json()) as CashBalanceInput & { asOf?: string };
    portfolio.upsertManualCash(c.get("userId"), body);
    return c.json({ ok: true });
  });

  app.delete("/api/cash", (c) => {
    const broker = c.req.query("broker") ?? "";
    const currency = c.req.query("currency") ?? "";
    const ok = portfolio.clearManualCash(c.get("userId"), broker, currency);
    return ok ? c.json({ ok: true }) : c.json({ error: "没有可清除的手动现金记录" }, 404);
  });

  // ---------- capital ledger ----------
  app.get("/api/capital-events", (c) => {
    const display = (["USD", "HKD", "CNY"].find((item) => item === c.req.query("display")) ?? "USD") as Currency;
    return c.json(ledger.listCapitalEvents(c.get("userId"), display));
  });

  app.post("/api/capital-events", async (c) => {
    const input = (await c.req.json()) as CapitalEventInput;
    return c.json(ledger.createCapitalEvent(c.get("userId"), input), 201);
  });

  app.put("/api/capital-events/:id", async (c) => {
    const input = (await c.req.json()) as CapitalEventInput;
    const event = ledger.updateCapitalEvent(c.get("userId"), Number(c.req.param("id")), input);
    return event ? c.json(event) : c.json({ error: "资本事件不存在" }, 404);
  });

  app.delete("/api/capital-events/:id", (c) => {
    const ok = ledger.deleteCapitalEvent(c.get("userId"), Number(c.req.param("id")));
    return ok ? c.json({ ok: true }) : c.json({ error: "资本事件不存在" }, 404);
  });

  // ---------- income / expense ledger ----------
  app.get("/api/cash-flow-events", (c) => {
    const display = (["USD", "HKD", "CNY"].find((item) => item === c.req.query("display")) ?? "USD") as Currency;
    return c.json(ledger.listCashFlowEvents(c.get("userId"), display));
  });

  app.post("/api/cash-flow-events", async (c) => {
    const input = (await c.req.json()) as CashFlowEventInput;
    return c.json(ledger.createCashFlowEvent(c.get("userId"), input), 201);
  });

  app.put("/api/cash-flow-events/:id", async (c) => {
    const input = (await c.req.json()) as CashFlowEventInput;
    const event = ledger.updateCashFlowEvent(c.get("userId"), Number(c.req.param("id")), input);
    return event ? c.json(event) : c.json({ error: "收益费用事件不存在" }, 404);
  });

  app.delete("/api/cash-flow-events/:id", (c) => {
    const ok = ledger.deleteCashFlowEvent(c.get("userId"), Number(c.req.param("id")));
    return ok ? c.json({ ok: true }) : c.json({ error: "收益费用事件不存在" }, 404);
  });

  app.get("/api/cash-flows", (c) => {
    const display = (["USD", "HKD", "CNY"].find((item) => item === c.req.query("display")) ?? "USD") as Currency;
    return c.json(
      ledger.unifiedCashFlows(c.get("userId"), {
        from: c.req.query("from"),
        to: c.req.query("to"),
        category: c.req.query("category"),
        market: c.req.query("market"),
        symbol: c.req.query("symbol"),
        display,
      }),
    );
  });

  // ---------- trades（手动录入交易） ----------
  app.get("/api/trades", (c) => c.json(portfolio.listTrades(c.get("userId"))));

  app.post("/api/trades", async (c) => {
    const trade = (await c.req.json()) as TradeInput;
    const id = portfolio.addTrade(c.get("userId"), trade);
    return c.json({ ok: true, id }, 201);
  });

  app.delete("/api/trades/:id", (c) => {
    const ok = portfolio.deleteTrade(c.get("userId"), Number(c.req.param("id")));
    return ok ? c.json({ ok: true }) : c.json({ error: "交易不存在" }, 404);
  });

  // ---------- 仓别标注 ----------
  app.put("/api/buckets", async (c) => {
    const { symbol, bucket, market } = (await c.req.json()) as { symbol: string; bucket: Bucket | null; market?: string };
    portfolio.setBucket(c.get("userId"), symbol, bucket ?? null, market);
    return c.json({ ok: true });
  });

  // ---------- 成本编辑 ----------
  app.put("/api/positions/cost", async (c) => {
    const { broker, symbol, costBasis } = (await c.req.json()) as {
      broker: string;
      symbol: string;
      costBasis: number | null;
    };
    portfolio.setCostOverride(c.get("userId"), broker, symbol, costBasis ?? null);
    return c.json({ ok: true });
  });

  // ---------- summary ----------
  app.get("/api/portfolio/summary", async (c) => {
    const display = (["USD", "HKD", "CNY"].find((d) => d === c.req.query("display")) ?? "USD") as Currency;
    const scope = c.req.query("scope") === "self" ? ("self" as const) : ("all" as const);
    const refresh = c.req.query("refresh") === "1";
    let quoteMap: Map<string, number> | undefined;
    if (refresh) {
      const base = portfolio.summary(c.get("userId"), display);
      const pairs = base.positions
        .filter((p) => ["US", "HK"].includes(p.market))
        .map((p) => ({ symbol: p.symbol, market: p.market }));
      const fetched = await quotes.getQuotes(pairs);
      quoteMap = new Map(fetched.map((q) => [`${q.market}:${q.symbol}`, q.price]));
    }
    return c.json(portfolio.summary(c.get("userId"), display, quoteMap, scope));
  });

  // ---------- risk and bucket budgets ----------
  app.get("/api/risk-settings", (c) => c.json(risk.getSettings(c.get("userId"))));

  app.put("/api/risk-settings", async (c) => {
    const input = (await c.req.json()) as RiskSettingsInput;
    return c.json(risk.updateSettings(c.get("userId"), input));
  });

  app.get("/api/bucket-budgets", (c) => c.json(risk.listBudgets(c.get("userId"), c.req.query("quarter"))));

  app.put("/api/bucket-budgets", async (c) => {
    const input = (await c.req.json()) as BucketBudgetInput;
    return c.json(risk.setBudget(c.get("userId"), input));
  });

  app.post("/api/portfolio/safe-add", async (c) => {
    const input = (await c.req.json()) as SafeAddInput;
    return c.json(risk.safeAdd(c.get("userId"), input));
  });

  // ---------- quotes ----------
  app.get("/api/quotes", async (c) => {
    const raw = c.req.query("symbols") ?? ""; // 形如 US:AAPL,HK:09988
    const pairs = raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const [market, symbol] = item.includes(":") ? item.split(":") : ["US", item];
        return { market: market.toUpperCase(), symbol: symbol.toUpperCase() };
      });
    return c.json(await quotes.getQuotes(pairs));
  });

  // ---------- plans ----------
  app.get("/api/plans", (c) => c.json(plans.list(c.get("userId"))));

  app.post("/api/plans/preview", async (c) => {
    const input = (await c.req.json()) as PlanInput;
    return c.json(plans.preview(c.get("userId"), input));
  });

  app.post("/api/plans/compare", async (c) => {
    const input = (await c.req.json()) as { planIds?: number[]; scenarios?: PlanInput[] };
    return c.json(plans.compare(c.get("userId"), input));
  });

  app.post("/api/plans", async (c) => {
    const input = (await c.req.json()) as PlanInput;
    return c.json(plans.create(c.get("userId"), input), 201);
  });

  app.put("/api/plans/:id", async (c) => {
    const input = (await c.req.json()) as PlanInput;
    const plan = plans.update(c.get("userId"), Number(c.req.param("id")), input);
    return plan ? c.json(plan) : c.json({ error: "计划不存在" }, 404);
  });

  app.delete("/api/plans/:id", (c) => {
    const ok = plans.remove(c.get("userId"), Number(c.req.param("id")));
    return ok ? c.json({ ok: true }) : c.json({ error: "计划不存在" }, 404);
  });

  app.put("/api/plans/:id/tiers/:tierId/fill", async (c) => {
    const { filled } = (await c.req.json().catch(() => ({ filled: true }))) as { filled?: boolean };
    const plan = plans.setTierFilled(
      c.get("userId"),
      Number(c.req.param("id")),
      Number(c.req.param("tierId")),
      filled !== false,
    );
    return plan ? c.json(plan) : c.json({ error: "计划或档位不存在" }, 404);
  });

  // ---------- notes（个人笔记本） ----------
  const noteRow = (row: Record<string, unknown>) => ({
    id: row.id,
    title: row.title,
    content: row.content,
    pinned: !!row.pinned,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  app.get("/api/notes", (c) => {
    const rows = db
      .prepare("SELECT * FROM notes WHERE user_id = ? ORDER BY pinned DESC, updated_at DESC")
      .all(c.get("userId")) as Array<Record<string, unknown>>;
    return c.json(rows.map(noteRow));
  });

  app.post("/api/notes", async (c) => {
    const { title, content, pinned } = (await c.req.json()) as { title?: string; content?: string; pinned?: boolean };
    if (!title?.trim()) return c.json({ error: "笔记标题不能为空" }, 400);
    const result = db
      .prepare("INSERT INTO notes (user_id, title, content, pinned) VALUES (?, ?, ?, ?)")
      .run(c.get("userId"), title.trim(), content ?? "", pinned ? 1 : 0);
    const row = db.prepare("SELECT * FROM notes WHERE id = ?").get(Number(result.lastInsertRowid)) as Record<string, unknown>;
    return c.json(noteRow(row), 201);
  });

  app.put("/api/notes/:id", async (c) => {
    const { title, content, pinned } = (await c.req.json()) as { title?: string; content?: string; pinned?: boolean };
    if (!title?.trim()) return c.json({ error: "笔记标题不能为空" }, 400);
    const result = db
      .prepare("UPDATE notes SET title = ?, content = ?, pinned = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
      .run(title.trim(), content ?? "", pinned ? 1 : 0, Number(c.req.param("id")), c.get("userId"));
    if (result.changes === 0) return c.json({ error: "笔记不存在" }, 404);
    const row = db.prepare("SELECT * FROM notes WHERE id = ?").get(Number(c.req.param("id"))) as Record<string, unknown>;
    return c.json(noteRow(row));
  });

  app.delete("/api/notes/:id", (c) => {
    const ok = db.prepare("DELETE FROM notes WHERE id = ? AND user_id = ?").run(Number(c.req.param("id")), c.get("userId")).changes > 0;
    return ok ? c.json({ ok: true }) : c.json({ error: "笔记不存在" }, 404);
  });

  return app;
}
