# 筑底结构报告 + 金字塔纪律推演 · VPS 部署

单容器方案：`pipeline/server.py`（Python API + 托管 web 前端静态资源）+ Caddy（HTTPS 反代，Basic Auth 可选、默认关闭）。
与 `portfolio/deploy` 相同模式，更新同样是 `git pull && docker compose up -d --build`。

> 为什么不在 Cloudflare：筑底判读与纪律推演是 Python 实时计算，Workers（TS）跑不了；
> PE 分位产品线继续走 Cloudflare Pages/Workers/D1，互不影响。

## 首次部署（约 10 分钟）

```bash
# 0. VPS 上装好 docker + docker compose plugin

# 1. 拉代码
git clone <你的 repo 地址> stock-farmer && cd stock-farmer/deploy

# 2. 配置环境变量
cp .env.example .env
# 无域名：保持默认 DOMAIN=:80，之后用 http://VPS的IP 访问
# 有域名：改成 DOMAIN=你的域名（DNS A 记录指向 VPS，自动 HTTPS）

# 3. 构建并启动
docker compose up -d --build

# 4. 验证
curl http://你的IP/api/health
# → {"status": "ok", "backend": "python"}
# 浏览器打开 http://你的IP 即为 React 前端
```

## 日常更新

```bash
cd stock-farmer && git pull
cd deploy && docker compose up -d --build
```

## 本地验证镜像（可选）

```bash
cd deploy
docker compose -f docker-compose.yml up --build app
# 无 Caddy 直连：http://127.0.0.1:8765 需要把 app 的 expose 临时改为 ports
```

## 说明与边界

- **访问控制（当前默认关闭）**：服务直接公网可访问。如需加门禁，解开 Caddyfile 里的 basic_auth 注释块并在 .env 填入用户名/密码 hash（见 .env.example 注释），然后 `docker compose restart caddy`
- **无域名模式（DOMAIN=:80）**：仅 HTTP 明文传输，不要在这个模式下开 Basic Auth（密码会明文过网络）；后续想上 HTTPS，换个域名填进 DOMAIN 重启 caddy 即可，免费域名可用 DuckDNS 等
- **数据源**：容器内实时拉取雅虎/东财等免费源，VPS 需要能访问这些站点；无状态、无数据库，容器可随时重建
- **资源占用**：pandas/numpy 镜像约 400MB+，运行内存 ~200MB，1C1G VPS 足够
- **免责**：所有输出为历史模拟与结构判读，仅供研究复盘，不构成投资建议
