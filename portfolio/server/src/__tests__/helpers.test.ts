import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db.js";
import type { Mailer } from "../mailer.js";
import type { QuoteFetcher } from "../quotes.js";

export interface TestContext {
  app: ReturnType<typeof createApp>;
  db: ReturnType<typeof openDatabase>;
  sentCodes: Array<{ to: string; code: string }>;
  quoteCalls: Array<{ symbol: string; market: string }>;
}

export function createTestApp(quotePrice = 100): TestContext {
  const db = openDatabase(":memory:");
  const sentCodes: Array<{ to: string; code: string }> = [];
  const quoteCalls: Array<{ symbol: string; market: string }> = [];
  const mailer: Mailer = {
    async sendCode(to, code) {
      sentCodes.push({ to, code });
    },
  };
  const quoteFetcher: QuoteFetcher = async (symbol, market) => {
    quoteCalls.push({ symbol, market });
    return { price: quotePrice, currency: market === "HK" ? "HKD" : "USD" };
  };
  const config = loadConfig({} as NodeJS.ProcessEnv);
  const app = createApp({ db, config, mailer, quoteFetcher, secureCookie: false });
  return { app, db, sentCodes, quoteCalls };
}

export async function registerAndLogin(ctx: TestContext, email = "user@example.com") {
  await ctx.app.request("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  const code = ctx.sentCodes.at(-1)!.code;
  await ctx.app.request("/api/auth/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code }),
  });
  const login = await ctx.app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  const setCookie = login.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0];
  return { cookie };
}

export function authedJson(cookie: string, body?: unknown, method = "POST") {
  return {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

describe("helpers", () => {
  it("registerAndLogin returns a session cookie", async () => {
    const ctx = createTestApp();
    const { cookie } = await registerAndLogin(ctx);
    expect(cookie).toContain("sf_session=");
  });
});
