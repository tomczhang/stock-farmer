import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import fs from "node:fs";
import path from "node:path";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { createMailer } from "./mailer.js";

const config = loadConfig();
const db = openDatabase(config.dbPath);
const mailer = createMailer(config.resendApiKey, config.mailFrom);
// 本地 http 开发时 cookie 不能带 Secure；生产由 Caddy 终结 TLS
const secureCookie = process.env.COOKIE_SECURE !== "0";
const app = createApp({ db, config, mailer, secureCookie });

// 前端静态托管 + SPA fallback
const staticRoot = path.resolve(config.staticDir);
if (fs.existsSync(staticRoot)) {
  const relativeRoot = path.relative(process.cwd(), staticRoot) || ".";
  app.use("/*", serveStatic({ root: relativeRoot }));
  app.get("*", (c) => {
    if (c.req.path.startsWith("/api/")) return c.json({ error: "接口不存在" }, 404);
    const indexHtml = fs.readFileSync(path.join(staticRoot, "index.html"), "utf-8");
    return c.html(indexHtml);
  });
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`portfolio-server listening on http://127.0.0.1:${info.port}`);
});
