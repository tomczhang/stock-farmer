import { describe, expect, it } from "vitest";
import { authedJson, createTestApp, registerAndLogin } from "./helpers.test.js";

describe("auth", () => {
  it("完整注册-验证-登录流程", async () => {
    const ctx = createTestApp();
    const reg = await ctx.app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@b.com", password: "password123" }),
    });
    expect(reg.status).toBe(200);
    expect(ctx.sentCodes).toHaveLength(1);
    expect(ctx.sentCodes[0].code).toMatch(/^\d{6}$/);

    // 未验证不能登录
    const earlyLogin = await ctx.app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@b.com", password: "password123" }),
    });
    expect(earlyLogin.status).toBe(403);

    const verify = await ctx.app.request("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@b.com", code: ctx.sentCodes[0].code }),
    });
    expect(verify.status).toBe(200);

    const login = await ctx.app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@b.com", password: "password123" }),
    });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

    const me = await ctx.app.request("/api/auth/me", { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { email: string }).email).toBe("a@b.com");
  });

  it("密码错误返回 401，弱密码/坏邮箱返回 400", async () => {
    const ctx = createTestApp();
    await registerAndLogin(ctx, "a@b.com");
    const bad = await ctx.app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@b.com", password: "wrong-pass" }),
    });
    expect(bad.status).toBe(401);

    const weak = await ctx.app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "c@d.com", password: "short" }),
    });
    expect(weak.status).toBe(400);

    const badEmail = await ctx.app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email", password: "password123" }),
    });
    expect(badEmail.status).toBe(400);
  });

  it("验证码 60 秒限频返回 429", async () => {
    const ctx = createTestApp();
    await ctx.app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@b.com", password: "password123" }),
    });
    const resend = await ctx.app.request("/api/auth/resend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@b.com" }),
    });
    expect(resend.status).toBe(429);
  });

  it("验证码错误 5 次后失效", async () => {
    const ctx = createTestApp();
    await ctx.app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@b.com", password: "password123" }),
    });
    const wrongCode = ctx.sentCodes[0].code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      const res = await ctx.app.request("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "a@b.com", code: wrongCode }),
      });
      expect(res.status).toBe(400);
    }
    // 第 6 次即使用对的验证码也应失效
    const res = await ctx.app.request("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@b.com", code: ctx.sentCodes[0].code }),
    });
    expect(res.status).toBe(400);
  });

  it("未登录访问受保护接口返回 401；登出后会话失效", async () => {
    const ctx = createTestApp();
    const noAuth = await ctx.app.request("/api/statements");
    expect(noAuth.status).toBe(401);

    const { cookie } = await registerAndLogin(ctx);
    const ok = await ctx.app.request("/api/statements", { headers: { Cookie: cookie } });
    expect(ok.status).toBe(200);

    await ctx.app.request("/api/auth/logout", authedJson(cookie, {}));
    const after = await ctx.app.request("/api/statements", { headers: { Cookie: cookie } });
    expect(after.status).toBe(401);
  });

  it("已验证邮箱重复注册返回 409", async () => {
    const ctx = createTestApp();
    await registerAndLogin(ctx, "a@b.com");
    const res = await ctx.app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@b.com", password: "password456" }),
    });
    expect(res.status).toBe(409);
  });
});
