# Proposal: 账户资产盘点 + 金字塔加仓计划（portfolio 模块）

## Why

stock-farmer 正从"单票分析工具"演进为"完整股票账户资产分析平台"。本期落地第一块拼图：
用户上传券商月结单，即可盘点当前仓位与闲置现金（仓位现金比），并据此制定参数化的
金字塔加仓计划。未来的现金流盘点、风险预警、AI 巴菲特等能力将复用本期建立的
用户体系与数据底座。

## What Changes

- 新增独立模块 `portfolio/`（`server/` + `web/` + `deploy/`），不改动现有 pipeline / api / web。
- 后端：Node 20 + hono + better-sqlite3（SQLite），邮箱验证码注册（Resend）、
  会话认证、月结单解析快照存储、资产盘点聚合、零密钥行情代理、金字塔加仓计划 CRUD 与计算。
- 前端：React 18 + Vite + TS + ECharts 浅色系（移植熊本方案的渐变/动效图表工艺），
  K 线使用 TradingView 嵌入 widget。
- 解析层：复用 tax-check 项目全部 13 家券商月结单解析器（浏览器端解析，
  PDF 与密码不出本地），扩展现金余额提取 + 手动补录兜底。
- 部署：Docker Compose 单体（app + Caddy 自动 HTTPS）部署到用户 VPS。

## Non-goals

- 现金流盘点、右侧信号整合、风险预警、AI 巴菲特（后续变更）。
- 原始月结单文件的服务端存储（隐私优先，仅存解析后结构化 JSON）。
- 历史汇率精确核算（展示层用即期汇率折算）。
- 交易执行 / 券商 API 对接。

## Capabilities

- `portfolio-auth`: 邮箱+密码注册、Resend 验证码确认、会话管理。
- `portfolio-snapshot`: 月结单浏览器端解析、持仓/现金快照存储与盘点聚合。
- `pyramid-plan`: 参数化金字塔加仓计划（每档触发/仓位全可配）与闲置现金校验。

## Impact

- 新增目录 `portfolio/`；现有代码零改动，现有测试回归不受影响。
- 生产部署形态从 "Cloudflare 免费层" 扩展出 "VPS Docker 单体" 第二形态（仅 portfolio 模块）。
