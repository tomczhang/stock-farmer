# Tasks: portfolio-asset-tracker

## 1. 后端（portfolio/server）

- [x] 1.1 脚手架：package.json / tsconfig / vitest，hono + @hono/node-server + better-sqlite3
- [x] 1.2 SQLite schema（users/auth_codes/sessions/statements/positions/cash_balances/pyramid_plans/plan_tiers/quote_cache）与迁移
- [x] 1.3 认证路由：register → verify（Resend 验证码）→ login / logout / me，session cookie，限频
- [x] 1.4 快照路由：POST/GET/DELETE /api/statements，事务拆解写入
- [x] 1.5 盘点路由：GET /api/portfolio/summary（聚合 + 汇率折算 + 雷达五维）
- [x] 1.6 现金补录：PUT /api/cash（manual 覆盖 parsed）
- [x] 1.7 行情代理：GET /api/quotes（腾讯 HK / Yahoo US，TTL 缓存）
- [x] 1.8 加仓计划：plans CRUD + tiers fill + computePlan 计算与现金校验
- [x] 1.9 静态托管前端产物 + SPA fallback

## 2. 前端（portfolio/web）

- [x] 2.1 脚手架：Vite + React 18 + TS + react-router + echarts，浅色 design token
- [x] 2.2 复制 tax-check 13 家 parser + types + calculator shim，配 @ alias
- [x] 2.3 现金提取 lib/parse/cash.ts（IBKR/长桥/老虎/华泰 best-effort）
- [x] 2.4 登录/注册页（邮箱+密码+验证码）
- [x] 2.5 月结单管理页：上传向导（选券商→解析→预览修正→保存）+ 快照列表
- [x] 2.6 Dashboard：KPI 卡 + 甜甜圈 + 饼图 + 横向渐变柱 + 雷达 + 刷新市值
- [x] 2.7 加仓计划页：计划表单（档位增删/触发/仓位可配）+ 阶梯图 + TradingView + 现金校验提示

## 3. 部署（portfolio/deploy）

- [x] 3.1 多阶段 Dockerfile（web build → server 运行时单镜像）
- [x] 3.2 docker-compose.yml（app + caddy）+ Caddyfile + .env.example
- [x] 3.3 README.md 一页式部署说明（含 Resend 域名验证）

## 4. 验证

- [x] 4.1 后端 vitest：认证流程 / 限频 / 快照聚合 / computePlan / 现金覆盖 / 行情缓存
- [x] 4.2 前端 typecheck + build 通过；现金提取 fixture 测试
- [x] 4.3 端到端浏览器验证：注册→上传→盘点→加仓计划全链路
- [x] 4.4 现有测试回归（pytest pipeline / api vitest / web typecheck 不受影响）
