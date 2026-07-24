# Design: portfolio 模块

## 架构决策

### D1 浏览器端解析（隐私优先）
月结单 PDF/Excel 与 PDF 密码只在浏览器内使用（pdfjs-dist / xlsx），
服务端只接收解析后的结构化 JSON 快照。理由：
- 财务数据敏感，原件不出本地是最强隐私承诺；
- tax-check 的 13 家 parser 本就是浏览器端实现，零改造复用；
- 服务端省去文件存储 / 杀毒 / 解密等复杂度。

### D2 现金缺口处理
tax-check 的 `ParsedInput` 无现金字段。方案：
- 前端新增独立的 `extractCashBalances()`（`lib/parse/cash.ts`），对 PDF 文本做
  broker-specific 的现金结余 best-effort 提取（优先 IBKR / 长桥 / 老虎 / 华泰）；
- 提取不到时预览界面标黄，用户手动填写；手动补录（source=manual）是全券商兜底路径，
  并且优先级高于解析值（同 as_of + broker + currency 覆盖）。

### D3 金字塔模型参数化
每档触发方式二选一：`pct_drop`（相对基准价跌幅%）或 `price`（绝对价格）；
每档仓位二选一：`pct`（占总预算%）或 `amount`（绝对金额）。
服务端 `computePlan()` 统一折算出每档：买入价、金额、股数、累计投入、摊薄成本。
总投入超过闲置现金时仅返回 warning，不阻断保存（用户可能有场外资金）。

### D4 估值口径
持仓市值 = 月结单月末市值打底；用户点击"刷新市值"后，用最新收盘价 × 数量覆盖
（腾讯 qt.gtimg.cn 港股、Yahoo chart API 美股，服务端代理 + SQLite TTL 缓存 10 分钟）。
多币种统一按即期汇率（服务端常量，可 env 覆盖）折算到展示币种（默认 USD，可切 HKD/CNY）。

### D5 认证
邮箱+密码注册 → Resend 发 6 位验证码（10 分钟有效，60s 限频，每邮箱每日 10 次上限）
→ 验证后激活。登录返回随机 session token（服务端存 sha256 哈希，30 天有效），
HTTP-only + SameSite=Lax cookie。密码 bcryptjs 哈希。无 RESEND_API_KEY 时验证码打印到
服务端日志（本地开发模式）。

### D6 单容器部署
多阶段 Dockerfile：`web` build → 产物拷入 server 镜像，hono `serveStatic` 托管前端 +
`/api/*`。docker-compose = app + caddy（`{$DOMAIN}` 自动 HTTPS）。SQLite 文件挂 volume。

## 数据流

```
上传向导(选券商→文件+密码→本地解析→预览修正→确认)
  → POST /api/statements {broker, asOf, positions[], cashBalances[], parsedMeta}
  → 服务端事务写入 statements / positions / cash_balances
Dashboard → GET /api/portfolio/summary?display=USD
  → 取每个 broker 最新 as_of 的 positions + cash（manual 覆盖 parsed）
  → 聚合 KPI / 分布 / TopN / 雷达五维
加仓计划 → POST /api/plans {basePrice, totalBudget, tiers[]}
  → computePlan() 校验 + 折算 → 前端阶梯图 + TradingView widget
```

## UI 设计 token（浅色系，源自熊本 HTML 移植）

- 背景 `#f8fafc`、卡片 `#ffffff` + `1px #e2e8f0` 边框 + `0 8px 28px rgba(15,23,42,.06)` 阴影
- 品牌金黄 `#eab308`（hover `#fbbf24`）、辅助 `#f97316 / #22c55e / #3b82f6 / #8b5cf6 / #ef4444`
- 正文 `#0f172a`、次级 `#475569`、弱化 `#94a3b8`
- 图表工艺：渐变柱（半透明→实色 LinearGradient）、甜甜圈圆角扇区 + 中心富文本、
  雷达径向渐变面 + 发光描边、`elasticOut` / 逐项 80ms 延迟入场动效
