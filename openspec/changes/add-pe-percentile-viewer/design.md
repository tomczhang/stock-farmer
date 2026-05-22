## Context

价值投资里"现在贵不贵"最常用的量化锚，是把当前 PE 放回它自己的历史区间，看处于哪个分位。A 股有理杏仁、果仁等成熟工具，港美股要么靠 Wind / 雪球付费会员，要么手工去 Yahoo Finance 一格一格抄。我们想要一个**自用**、**零月成本**、**零运维**的港美股 PE 历史分位观察站。

约束条件：

- **预算 = 0**：不能上付费数据源（Wind、Bloomberg、彭博、IB），也不能上常驻的 VPS / 容器服务。
- **流量极低**：只服务自己（外加少量朋友），峰值 QPS 远小于 1，没必要为吞吐做架构。
- **数据更新频率低**：港美股一天一根 K 线，季报每季度一次，离线日更足够覆盖所有场景。
- **可用现成能力**：仓库内已经有 `global-stock-data` skill，提供 5 个零密钥 HTTP 数据源（东财、雅虎、新浪、腾讯、SEC EDGAR），能直接复用其港美股价格 / 财务接口，避免自己手撕爬虫。
- **数据准确性是次要目标**：用途是"判断贵贱"，不是回测交易策略。可以接受一些已知失真（restatement、PIT 偏差），但要在 UI 上写清楚边界。

这份设计文档记录我们在探索阶段做出的 10 个关键取舍，以及它们背后的理由。

## Goals / Non-Goals

**Goals:**

- 输入一个港股 / 美股 ticker，给出 PE-TTM 的历史曲线 + 当前所处的 5 年 / 10 年 / 上市以来分位。
- 全栈跑在 Cloudflare 免费层 + GitHub Actions 免费额度上，月度账单 $0。
- 离线批处理把"重活"算完，在线 API 退化成"读 D1 转 JSON"的薄层，p95 响应时间在百毫秒级别。
- 正确处理复权、TTM 阶梯函数、负 EPS、拆股 / 并股这些已知坑，结果与雪球 / Wind 的港美股 PE 序列在量级上一致。
- 提供 watchlist 管理：用户可以维护自己关注的股票池。
- 任何"数据口径不完美"的地方都在 UI 上挂角标说明，不让用户被静默误导。

**Non-Goals:**

- **不**支持 A 股（理杏仁等已经做得很好，没必要重复造）。
- **不**做 Point-in-Time 数据还原（理由见决策 4）。
- **不**支持开放式 ticker 查询（MVP 限定在 watchlist 内，v2 再说）。
- **不**做用户系统 / 多租户 / 鉴权（MVP 默认单用户场景）。
- **不**做交易信号、买卖建议、组合管理 —— 这是一个观察工具，不是策略工具。
- **不**实时（intraday）—— 一天一更，盘后跑批。

## Decisions

### 1. 整体架构：拆法 B + 全 Cloudflare

**决定**：

- 离线批处理：Python（pandas / numpy + `global-stock-data` skill），由 GitHub Actions 每天盘后调度一次。
- 在线 API：Cloudflare Workers（TypeScript）薄层，只做"读 D1 → 转 JSON"。
- 前端：React + Vite + ECharts，部署在 Cloudflare Pages。
- 数据库：Cloudflare D1（SQLite 边缘副本）。

**为什么**：

拆法 B 的本质是**按"读 / 写延迟敏感度"分层**：

- 写路径（每日盘后批处理）：延迟无所谓，跑 10 分钟还是 30 分钟都不影响用户体验。Python + pandas 是数据清洗 / TTM 拼接 / 分位预计算的最佳工具，调用 `global-stock-data` skill 直接拿到现成能力。
- 读路径（用户打开页面）：延迟敏感，需要边缘网络分发 + 快速读 DB。Workers + D1 在同一地域内能做到个位数毫秒的查询，套上 CDN 后冷启动也基本无感。

**为什么不选替代方案**：

- **全 Python FastAPI + 本地 SQLite + Docker**：要自己运维 VPS、Cloudflare Tunnel 或域名，月成本 $5-10；机器宕了要自己重启；不能享受 Cloudflare 的 anycast + DDoS 防护。零运维诉求直接否决。
- **Docker (FastAPI) + D1**：D1 对外只有 HTTPS REST API，每次 SQL 查询都要走一次跨网络 HTTPS 往返，实测 50-200ms。本地 SQLite 一次查询 0.1-1ms，差 40-200 倍。把 D1 配在远端 Docker 容器是"两边都拿不到便宜"的反模式。
- **全 Cloudflare Workers（无 Python）**：意味着要用 TypeScript 重写所有数据处理逻辑（pandas 的 forward-fill、分位、复权对齐），丢掉 `global-stock-data` skill 现成的港美股数据源封装，工作量翻 3-5 倍，还要在 Workers 的 CPU 时间限额内挤进去。**Python 生态在数据处理上的领先非 Workers 一朝一夕能追上**。
- **Supabase / Neon Postgres**：免费层够用，但相对 D1 多一层网络跳数、多一个供应商账号要管，没有差异化收益。

结论：**Python 留在离线（发挥数据处理强项）+ Workers 留在在线（发挥边缘读取强项）+ 全 Cloudflare 锁定生态（统一控制台、统一计费、统一域名）**，月成本 $0、零运维、自带 D1 Time Travel 30 天作为兜底备份。

### 2. 数据源：`global-stock-data` skill 的 5 源组合

**决定**：

- **价格**：主用 Yahoo Finance（`stock_kline_yahoo`），港美股都覆盖、复权（adjusted close）完整、历史够长；美股可选叠加 Sina 作为深历史补充（Sina 美股能回到 1984 年）。
- **EPS**：主用 East Money（`key_indicators_eastmoney`），港股 75 个字段、美股 49 个字段，含 `BASIC_EPS` 和 `DILUTED_EPS`；美股可选叠加 SEC EDGAR XBRL Facts (`sec_xbrl_facts`) 做交叉校验。
- **当前 PE 快照**：东财 `pe_snapshot_eastmoney` 用于侧 sanity check（"我们算出来的当前 PE 和东财显示的值应该接近"）。

**为什么**：

- **零密钥**：5 个数据源全部无需 API key，部署门槛降到 0。
- **多源冗余**：东财 / 雅虎 / 新浪 / 腾讯 / SEC 不会同时挂，pipeline 内置 fallback 顺序，单源故障不阻塞整批。
- **港美股都强**：很多免费源（Tushare 社区版、akshare 部分接口）只在 A 股上强。Yahoo + East Money 是公认的港美股最稳的免费组合。

**为什么不选替代方案**：

- **Financial Modeling Prep / Polygon / Alpha Vantage**：免费层都有限制（FMP 250 次/天，Polygon 5 次/分钟），watchlist 一旦超过 50 只股票 + 历史回填一次，单日就会跑爆。
- **Tushare Pro**：A 股的事实标准，但港美股覆盖弱、且需要积分 / 付费。
- **自己写爬虫**：维护成本高、抗变更能力差。`global-stock-data` skill 已经吃掉这些维护负担，没必要重复造。

### 3. PE-TTM 计算口径

**决定**：

```
PE_ttm(t) = 复权Close(t) / TTM_EPS(t)
TTM_EPS(t) = Σ 最近 4 个已发布季度的复权 EPS
EPS 来源：diluted 优先，缺失时回退到 basic
```

约束：

- **复权口径前后一致**：分子（价格）和分母（EPS）都用复权值。Yahoo 的 adjusted close 已经处理拆股 / 并股 / 分红除权；East Money 的 EPS 在拆股后也会回溯调整。两边只要都"用复权值"就能对得上。**严禁价格用复权、EPS 用原始**（或反之），那样拆股日 PE 会出现假跳变。
- **TTM 是阶梯函数**：在两份季报之间，TTM EPS 保持不变，PE 只由价格变动驱动；新财报发布日，TTM EPS 跳到新值，PE 出现一段台阶。**这是真实的信息事件，不是 bug**，不要平滑掉。
- **新上市公司**：不到 4 个季度可用 EPS 的时段，该日 `pe_ttm` 留空（NULL），UI 显示"数据不足"。

**为什么**：

- TTM 是业内标准（跨过季节性），其他口径（forward PE、static PE）依赖预测 / 切片，引入额外不确定性。
- Diluted 优先是因为它反映完全摊薄后的"真实"每股盈余，对应市值口径才一致。
- 阶梯函数虽然视觉上不"平滑"，但它真实反映"市场知道新业绩后估值锚的瞬时切换"，平滑反而欺骗用户。

### 4. 不做 Point-in-Time（PIT）数据还原

**决定**：所有 EPS 一律使用**最新版**财报数据，不还原"当时市场知道什么"的快照。UI 加角标："基于最新可得财报，不还原历史时点数据。"

**为什么**：

- **本工具用途是"判断当前贵不贵"**，不是回测交易策略。当前判断只看当下 PE 落在历史分布的哪里，PIT 与 latest 的差异通常 < 3 个百分位，不影响"贵 / 中性 / 便宜"的定性结论。
- **PIT 还原成本极高**：需要订阅 Compustat Snapshot / Refinitiv Point-in-Time，年费数万美元。零成本目标下不可能做到。
- **造假公司的 PIT 反而是"错觉"**：瑞幸咖啡造假期间的 PIT EPS 是虚高的，还原 PIT 等于把当时的骗局当真。用 restate 后的真实数据反而更接近"事后看清楚的事实"。
- **季报修订（restatement）极少发生**：除了财务造假 / 重组 / 准则切换，绝大多数公司的历史 EPS 在初次发布后不再变化。

**为什么不选替代方案**：

- **半 PIT（只在拉取当日冻结）**：实现复杂度暴增、收益不明显、维护负担大。
- **保留多版本 EPS**：D1 表结构会膨胀 3-5 倍，查询 / 计算逻辑都要带版本字段，得不偿失。

### 5. 负 EPS 处理

**决定**：

- **UI**：把亏损期间（TTM EPS ≤ 0 的日期）用灰色阴影遮罩在主图上标出。
- **分位计算**：剔除负 EPS 的日期后再算分位（5y / 10y / all）。`pe_series` 表里这些日期保留 `is_loss = TRUE` 但 `pe_ttm` 写 NULL。
- **指标卡片**：额外显示 "历史 X% 时间在亏损"。

**为什么**：

- **负 PE 没意义**：PE = 价格 / 负盈余 = 负数，把"负 PE"和"正 PE"混在一起算分位，巨亏的公司会被算出"PE 极低，处于历史 0% 分位 = 极度便宜"，结论荒谬。
- **完全删掉又会丢信息**：用户需要知道"这家公司历史上经常亏损"，所以 UI 上保留阴影遮罩 + 显式百分比。
- **"剔除出分位 + UI 标出"**是兼顾两边的折中：算分位时干净，看图时不丢信息。

### 6. 拆股 / 并股处理

**决定**：

- 价格用 Yahoo adjusted close（自带复权），EPS 用 East Money 复权口径，两边一致。
- 增量更新策略：**每月**全量重拉一次完整价格表（覆盖拆股事件回溯），日常每天只拉"最新一天"。

**为什么选"每月全量重拉"**：

- 拆股是稀有事件（一只股票一年 0-1 次），但发生时 Yahoo 会把**所有历史价格**回溯调整。
- 增量逻辑很难精准检测"今天发生了拆股"这种状态变化（要监听公司行动数据源）。
- 每月全量重拉 = 用一点带宽（一只股票 10 年日线大约 50 KB）换 100% 正确性。GitHub Actions 跑批 200 只股票 = 10 MB 数据，几十秒内完成，完全不是瓶颈。

**为什么不选替代方案**：

- **检测拆股事件后增量修正**：要么订阅公司行动数据源（付费）、要么自己 diff 价格序列检测异常跳变（脆弱、易误判）。复杂度高、收益小。

### 7. 增量拉取策略

**决定**：

- **价格历史**：首次拉取覆盖全历史 / 至少 10 年；之后每天只拉"最新一根 K 线"；每月 1 号全量重拉做对齐。
- **EPS 季报**：每天检查"上次拉取日期之后是否有新季报发布"，没有就跳过；有就拉对应季度并写入。
- **状态跟踪**：`fetch_log` 表记录每只股票 × 每种数据类型的 `last_fetched_at` 和 `last_data_date`，作为下次增量起点。

**为什么**：

- 历史价格永远不变（拆股回溯由月度全量兜底），每天重拉是浪费。
- 季报是离散事件，季度间没有新数据可拉，每天 4 次 HTTP 调用 × 200 只 = 800 次 = 浪费 800 个 HTTP 配额。
- `fetch_log` 是单一信息源（single source of truth），出问题排查时只看一张表即可。

### 8. D1 表结构

**决定**（最终 schema 见 `db/schema.sql`，下表为口径说明）：

| 表 | 关键字段 | 主键 | 用途 |
|---|---|---|---|
| `prices` | ticker, date, close_adj | (ticker, date) | 复权后价格时间序列 |
| `eps_quarterly` | ticker, period_end, eps_basic, eps_diluted, fetched_at | (ticker, period_end) | 季度 EPS（最新版） |
| `pe_series` | ticker, date, pe_ttm, percentile_5y, percentile_10y, percentile_all, is_loss | (ticker, date) | **预计算好供 API 直读** |
| `watchlist` | ticker, market, added_at | ticker | 用户关注列表 |
| `fetch_log` | ticker, data_type, last_fetched_at, last_data_date | (ticker, data_type) | 增量拉取断点 |

**为什么**：

- **预计算 `pe_series`**：API 层完全不需要 join / 计算分位，一句 `SELECT * FROM pe_series WHERE ticker = ? AND date >= ?` 直接返回。把所有复杂度推到离线层，符合"拆法 B"的核心思想。
- **`prices` 和 `eps_quarterly` 分开存**：两者更新频率完全不同（日 vs 季），分开存利于增量更新和未来扩展（v2 加 PB / PS / 股息率都基于这两张表）。
- **`is_loss` 标志独立列**：方便 UI 渲染遮罩，不用每次都重新判断 `pe_ttm IS NULL`（NULL 可能是数据缺失也可能是亏损，语义要分开）。
- **D1 行数 / 大小**：200 只股票 × 10 年 × 250 交易日 ≈ 50 万行 `prices`、50 万行 `pe_series`。D1 免费层支持 5 GB 存储 / 5M 行读 / 100K 行写每天，绰绰有余。

### 9. API 设计

**决定**：

```
GET    /api/pe-history/{ticker}?range=5y|10y|all
GET    /api/watchlist
POST   /api/watchlist          { ticker, market }
DELETE /api/watchlist/{ticker}
```

约束：

- MVP 阶段，`/api/pe-history` **仅接受 watchlist 内的 ticker**，未在 watchlist 的请求返回 404。
- Workers 层不做任何重计算，纯 SQL 查询 + JSON 序列化。
- 响应中包含 `metadata`：`{ data_source: "latest_filings", last_updated: "...", caveats: [...] }`，前端用于渲染免责角标。

**为什么**：

- RESTful 资源风格直观、缓存友好（GET 可以加 Cache-Control）。
- MVP 限定 watchlist 范围，避免开放式查询触发"冷启动 Python 抓取"的复杂问题（见决策 10）。

### 10. MVP 范围限制 & v2 规划

**v1（本次变更）**：

- Watchlist 模式：用户先添加 ticker → pipeline 在下一次盘后批处理时拉取并入库 → 用户可以查询。
- 首次添加到能查询有 12-24 小时的延迟（等下一次 GitHub Actions 触发）。
- 整个数据池封闭，pipeline 知道要拉哪些 ticker。

**v2（后续变更）**：

- 开放式查询：用户输入任意 ticker，立即查询；后端发现 D1 里没有就触发**实时 Python 抓取**（通过 GitHub Actions 的 `workflow_dispatch` 或迁移到 Modal / Cloud Run 的按需任务）。
- 主要待解决：冷启动延迟（用户要等几十秒）、并发抓取的速率限制、可能的滥用防护（rate limit / token）。

**为什么先 v1**：

- 自用场景下，watchlist 模式就够了 —— 价值投资关注的标的本来就有限（几十到一两百只），不会天天换。
- 把"实时抓取"留到 v2，能让 v1 快速上线验证整体架构，避免一上来就被冷启动问题拖住。

## Risks / Trade-offs

| 风险 | 缓解措施 |
|---|---|
| 数据源不稳定（东财 / 新浪偶发返回空 / 403） | `global-stock-data` 内置多源 fallback；pipeline 跑批时单只失败只跳过该只、不阻塞整批；`fetch_log` 记录失败，下次自动重试 |
| D1 写入跨网络慢（每批 200 只 × 多张表 = 上千次 INSERT） | 离线批处理对延迟不敏感，能跑完就行；用 D1 batch API（一次 HTTPS 批量提交 N 条 SQL）压缩往返；最坏情况整批 30 分钟以内，仍远低于 GitHub Actions 6 小时超时 |
| 季报修订（restatement）导致历史 PE 与当时市场看到的不同 | 已在决策 4 中接受这一失真；UI 角标说明；定性结论（贵 / 中性 / 便宜）不受影响 |
| GitHub Actions 时区漂移 / 调度延迟 | cron 设置在港股收盘后 + 美股收盘后两个窗口（如 UTC 09:00 港股 + UTC 22:00 美股）；pipeline 启动时检查 `fetch_log` 上次更新时间，超过 36 小时未更新则告警（issue / 邮件） |
| Cloudflare 平台锁定（vendor lock-in） | D1 是标准 SQLite，可以 `wrangler d1 export` 一键导出；Workers 代码本质是 fetch handler，可迁移到 Deno Deploy / Vercel Edge / 自建 Node；Pages 是纯静态文件，到处都能托管。锁定风险低 |
| Watchlist 单用户场景没有鉴权 | MVP 限定单用户使用（私域分享 URL），不暴露给互联网搜索引擎；v2 公开部署时加入 token / Cloudflare Access |
| 计算口径与雪球 / Wind 不完全一致（diluted vs basic、复权方式细节） | 接受小幅差异；指标卡片对照"东财 PE 快照"做 sanity check（差异 > 10% 在 pipeline 日志中告警） |
| Python 端 numpy / pandas 与 East Money 字段口径变化 | `global-stock-data` skill 升级时跑一次完整 backfill 验证；pipeline 加单元测试覆盖典型 ticker（如 AAPL、0700.HK） |

## Migration Plan

这是全新项目，没有历史用户和已有数据，"迁移"主要是首次部署流程：

**部署步骤**：

1. **Cloudflare 账号准备**
   - 注册 Cloudflare 免费账号
   - 创建 D1 数据库（`wrangler d1 create stock-farmer`）
   - 创建 Pages 项目（绑定 GitHub 仓库自动部署）
   - 创建 Workers 服务（用 `wrangler deploy`）
2. **数据库初始化**
   - 执行 `db/schema.sql` 创建 5 张表
   - 用 `wrangler d1 execute` 跑 schema 迁移
3. **Pipeline 初始化**
   - 配置 GitHub Secrets（`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`D1_DATABASE_ID`）
   - 手动触发一次 `workflow_dispatch` 跑全量回填（200 只股票 × 10 年价格 + EPS + PE 序列）
   - 验证 `pe_series` 表行数符合预期
4. **API 部署**
   - `wrangler deploy` 推送 Workers
   - 用 curl 验证 `/api/pe-history/AAPL?range=5y` 返回非空 JSON
5. **前端部署**
   - 推送到 GitHub main 分支，Cloudflare Pages 自动构建并发布
   - 在浏览器中验证图表渲染
6. **开启定时调度**
   - 启用 GitHub Actions 的两个 cron（港股 / 美股盘后）
   - 第一次 cron 触发后检查日志，确认增量更新成功

**回滚策略**：

- **数据回滚**：D1 自带 Time Travel，可一键还原到最近 30 天内任意时间点（`wrangler d1 time-travel restore`）。
- **代码回滚**：Workers 和 Pages 都支持版本切换（dashboard 上一键 rollback 到上一个 deploy）。
- **整体回滚**：GitHub Actions 关闭、Pages 下线，零状态需要清理。

**首次回填时间预估**：

- 200 只股票 × 5 个数据源平均 1.5 秒 / 请求 × ~10 次拉取（价格年份 + 季度 EPS）≈ 50 分钟。
- 在 GitHub Actions 6 小时上限内非常宽松。

## Resolved Decisions (was: Open Questions)

以下决策已在实施前确定，按推荐方案执行：

1. **Watchlist 存储 → D1 表**
   统一存储在 D1，便于与 fetch_log / pe_series 做关联和事务。MVP 阶段操作频次极低（用户偶尔增删），无需 KV。

2. **港股代码格式 → 对外 `0700.HK`，内部映射**
   存储与 API 暴露统一用 4 位前缀 `0700.HK`（与 Yahoo 一致）；pipeline 调东财时由 `ticker_normalize.py` 补成 5 位 `00700.HK`。ST 股/红筹股遇到时按需扩展映射表。

3. **GitHub Actions 调度 → 拆成两个 cron**
   港股 cron：`30 8 * * 1-5`（HKT 16:30，盘后半小时给数据源刷新缓冲）；美股 cron：`30 21 * * 1-5`（EST 16:30 标准时；夏令时差 1 小时但单日影响可忽略）。
   理由：港股结果在工作日下午就能用，不必等到次日；分开调度也方便单独排错。

4. **错误恢复 → 跳过 + 记日志 + 失败率超 10% 整体告警**
   单只失败：写 `fetch_log.last_error`，job 继续，退出码 0。
   汇总：失败率 > 10% 时 job 退出码 1，触发 GitHub Actions 邮件通知。
   阈值可在运行 1-2 周后根据实际错误率调整。

5. **快照对照校验 → 加，阈值 10%**
   pipeline 结尾 step：对每只股票，比较 `自己算的当前 PE` vs `Yahoo key_statistics.trailing_pe`，差异 > 10% 写入 `fetch_log.last_warning`，不阻塞但可观察。1-2 周后根据噪声分布收紧到 5%。

6. **图表性能 → 不优化，发现问题再加降采样**
   v1 直接全量渲染；如果 30 年老股移动端实测掉帧再引入 LTTB（Largest Triangle Three Buckets）算法。后端 API 可预留 `?downsample=N` 参数位但 v1 不实现。
