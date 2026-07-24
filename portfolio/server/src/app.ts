import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { AuthError, createAuthService } from "./auth.js";
import type { AppConfig } from "./config.js";
import type { AppDatabase } from "./db.js";
import type { Mailer } from "./mailer.js";
import { createPlanService } from "./plans.js";
import { createPortfolioService, ValidationError } from "./portfolio.js";
import { createQuoteService, type QuoteFetcher } from "./quotes.js";
import type { CashBalanceInput, Currency, PlanInput, StatementPayload } from "./types.js";

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
  const portfolio = createPortfolioService(db, config.fxToUsd);
  const plans = createPlanService(db, (userId) => portfolio.idleCashUsd(userId));
  const quotes = createQuoteService(db, quoteFetcher);

  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof AuthError) return c.json({ error: err.message }, err.status as 400);
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
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

  // ---------- summary ----------
  app.get("/api/portfolio/summary", async (c) => {
    const display = (["USD", "HKD", "CNY"].find((d) => d === c.req.query("display")) ?? "USD") as Currency;
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
    return c.json(portfolio.summary(c.get("userId"), display, quoteMap));
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

  return app;
}
