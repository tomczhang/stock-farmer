# portfolio 部署指南（VPS + Docker Compose）

单容器架构：hono 同时提供 `/api/*` 与前端静态页面，SQLite 落在 Docker volume；
Caddy 负责域名自动 HTTPS。更新只需 `git pull && docker compose up -d --build`。

## 前置条件

1. VPS 已安装 Docker（含 compose 插件）：`docker compose version` 能输出版本号
2. 域名 A 记录已指向 VPS 公网 IP（Caddy 自动签发 Let's Encrypt 证书）
3. Resend 账号 + 已验证的发信域名（见下文）

## 首次部署

```bash
git clone <你的仓库地址> && cd stock-farmer/portfolio/deploy
cp .env.example .env
vim .env        # 填 DOMAIN / RESEND_API_KEY / MAIL_FROM / SESSION_SECRET
docker compose up -d --build
```

完成后访问 `https://<DOMAIN>` 即可注册使用。

## 日常更新

```bash
cd stock-farmer && git pull
cd portfolio/deploy && docker compose up -d --build
```

数据（SQLite）在 `app-data` volume 中，重建容器不丢数据。

## 备份

```bash
docker compose cp app:/data/portfolio.db ./backup-$(date +%F).db
```

## Resend 域名验证步骤

1. 注册 https://resend.com（免费额度 100 封/天，足够验证码场景）
2. Dashboard → Domains → Add Domain，填你的域名（如 `example.com`）
3. 按提示在 DNS 服务商处添加 3 条记录（SPF TXT / DKIM TXT / MX 可选）
4. 等待验证通过（通常几分钟），Dashboard → API Keys 创建 key 填入 `.env` 的 `RESEND_API_KEY`
5. `MAIL_FROM` 使用该域名下的地址，如 `Stock Farmer <noreply@example.com>`

> 未配置 `RESEND_API_KEY` 时验证码会打印在容器日志里（`docker compose logs -f app`），
> 仅适合本地调试，不要在生产这样用。

## 本地开发（不需要 Docker）

```bash
# 终端 1：后端（无 Resend key 时验证码打印在控制台）
cd portfolio/server && npm install
COOKIE_SECURE=0 npm run dev          # http://127.0.0.1:8790

# 终端 2：前端（vite 代理 /api 到 8790）
cd portfolio/web && npm install
npm run dev                          # http://127.0.0.1:5173
```

## 常见问题

- **收不到验证码**：确认 Resend 域名已验证、`MAIL_FROM` 域名一致；查 `docker compose logs app`
- **HTTPS 证书失败**：确认 80/443 未被占用、DNS 已生效（`dig <DOMAIN>`）
- **行情刷新失败**：腾讯/雅虎接口偶发限流，稍后重试即可，不影响月结单口径数据
