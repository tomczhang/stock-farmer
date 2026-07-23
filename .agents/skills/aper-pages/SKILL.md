---
name: aper-pages
version: 0.4.0
description: 当用户需要把对话中的分析结论、设计方案、数据看板、工具页面等内容生成为可访问的 HTML 页面，并发布到 Aone Pages 静态站点（<site-name>.io.alibaba-inc.com）时使用。内置常用类型：分析报告(report)、技术方案(spec)、项目复盘(review)、数据看板(dashboard)、一次性工具页面(tool)、方案对比展示(showcase)；也支持任意 kebab-case 自定义类型（如 changelog / architecture / runbook 等），category 与 template 解耦，template 数量也开放（`aper-pages template list` 查看当前可用模板）。本地 ~/.aper-pages 是一个 git 工作区，aper-pages CLI 会自动完成首次初始化（创建仓库 + CI 流水线），后续 publish 子命令把 HTML 写入本地、push 到远端、手动触发 a1 ci pipeline run 部署，并向所有镜像 fan-out。当用户提到「生成报告」「做个页面」「可视化」「出个看板」「发布 pages」「做个工具页面」「方案对比」「HTML 输出」「aper pages」「pages」时触发。
---

# aper-pages Skill

把当前对话的分析结论、数据、设计方案、工具原型等内容，生成为独立可访问的 HTML 页面，本地 commit + push 到用户的 Aone Pages 仓库，通过 a1 CLI 手动触发流水线部署到 `<site-name>.io.alibaba-inc.com`。

## 0. 命令前缀

本 skill 所有 CLI 调用统一前缀。**必须**使用 shell function 定义（兼容 bash/zsh）：

```bash
aper-pages() { npx --registry=https://registry.anpm.alibaba-inc.com -y @ali/aper-pages@latest "$@"; }
```

后续步骤均使用 `aper-pages <command>` 形式调用。

> ⚠️ 不要使用字符串变量 `APER="npx ..."` + `$APER cmd` 的方式——zsh 不对无引号变量做 word splitting，会把整个字符串当作单个可执行文件路径查找。

## 工作流程

### Step 0 — 对话上下文提取

在生成页面前，先扫描当前对话，提取以下内容作为页面素材：

- **核心结论与决策点** — 对话中达成共识或明确拍板的内容
- **关键数据与分析结果** — 统计数据、对比结论、量化指标
- **设计方案或架构描述** — 技术方案、流程图描述、接口定义
- **代码片段** — 对话中产出的关键代码（如有）

提取规则：
1. 优先保留结论性内容，过滤掉探索性讨论和中间废弃方案
2. 如果用户在调用时指定了范围（如"把上面的分析做成页面"），只提取指定范围
3. 如果对话内容不足以生成有价值的页面，主动询问用户需要聚焦哪些内容
4. 提取结果作为 Step 5 生成 HTML 的输入素材，不需要单独输出给用户

### Step 1 — 自动初始化（静默）

每次触发本 skill，**第一步无条件**执行：

```bash
aper-pages doctor --silent || aper-pages init --auto
```

- doctor 退出 0：配置已就绪
- doctor 非 0：自动 `init --auto`，全程使用默认值不交互：
  - group = `a1 auth whoami` 的 account
  - repo = `<account>/pages`
  - site-name = `<account>-pages`（小写化、`.`→`-`）
- 初始化完成后对用户输出一行：
  ```
  已自动初始化 aper-pages：<repo> → <deploy-url>
  ```

如果初始化失败（无权限创建仓库等），把错误原文转给用户并终止流程。

### Step 2 — 确定内容类型 (category)

**推荐类型**（agent 默认从下表选）：

| category | 推荐模板 | 适用场景 |
|---|---|---|
| `report` | `report` | 数据分析、用户洞察、研究报告 |
| `spec` | `report` | 技术设计、架构方案、选型评估 |
| `review` | `report` | 项目复盘、code review、事故复盘 |
| `dashboard` | `dashboard` | 指标监控、数据看板 |
| `tool` | `tool` | 一次性专用交互工具、配置编辑器 |
| `showcase` | `showcase` | 方案对比 grid、原型展示 |

**category 与 template 解耦**：

- **category**：发布时的归档目录名（任意 kebab-case，如 `report` / `changelog` / `runbook`），决定文件存放 `src/reports/<category>/YYYY-MM-DD/...`
- **template**：HTML 骨架文件（`templates/<type>.html`），决定页面布局

两者**不是一一对应**，可一对多：表中 `spec` / `review` 都用 `report` 模板。

**可自定义**：category 不限于上表，agent 可基于对话内容引入新类型。例：

- `changelog` → 沿用 `report` 模板
- `architecture` → 沿用 `report` 模板
- `runbook` → 沿用 `tool` 模板

**先查看可用模板**：

```bash
aper-pages template list
```

CLI 仅校验 category 是 kebab-case（首字母小写、a-z 0-9 -），不维护字面白名单。

### Step 3 — 拿模板（双路）

确定模板 type（参考 Step 2 推荐表，或基于内容选用其他模板）。**优先级**：

1. 用户工作区：`~/.aper-pages/templates/<type>.html`（用户自定义，存在则用这份）
2. CLI 内嵌：`aper-pages template show <type>` 输出到 stdout（永远是 CLI 最新版）

伪代码：

```bash
TYPE=report  # 根据 Step 2 选定（如 report / dashboard / tool 等）
TPL_LOCAL="$HOME/.aper-pages/templates/${TYPE}.html"
if [ -f "$TPL_LOCAL" ]; then
  TPL_CONTENT=$(cat "$TPL_LOCAL")
else
  TPL_CONTENT=$(aper-pages template show $TYPE)
fi
```

### Step 4 — 阅读设计原则

**必须**通过 Read 工具阅读本 skill 同目录下的两份文档（相对路径，跟安装位置解耦）：

- `references/design-principles.md` — 设计原则
- `references/cdn-dependencies.md` — 正确的 CDN 地址（有踩坑记录）

### Step 5 — 生成 + 发布

填充模板，写入临时文件：

```bash
TMP_HTML="$(mktemp -t aper-pages.XXXXXX).html"
# 把填充后的 HTML 写到 $TMP_HTML
```

发布：

```bash
aper-pages publish "$TMP_HTML" \
  --title "页面标题" \
  --category report \
  --summary "一句话摘要"
```

参数细节参考 `aper-pages publish --help`。publish 会：

1. 复制 HTML 到 `~/.aper-pages/src/reports/<category>/<YYYY-MM-DD>/<HHmm>-<hash>.html`
2. unshift 新条目到 `src/pages.json`
3. `git add -A && git commit && git push`（默认主远端 + 所有 enabled mirrors）
4. 对每个远端执行 `a1 ci pipeline run <pipeline-id> --branch <branch>` 手动触发部署
5. 输出公网 URL（每个远端一条）+ 触发钉钉通知（如配置）

### Step 6 — 清理 + 告知

```bash
rm -f "$TMP_HTML"
```

**告知用户访问 URL**：

- publish 输出的 `✓ https://<site>.io.alibaba-inc.com/<category>/<YYYY-MM-DD>/<HHmm>-<hash>.html` 就是**真实页面 URL**，**直接原样转告用户**
- **不要**回复站点根（`https://<site>.io.alibaba-inc.com/`）—— 用户打开会落到首页，找不到本次发布
- **不要**自己拼接路径 —— 路径规则只有 publish 知道（HHmm-hash 是运行时生成）
- 多镜像场景 publish 会输出多行 URL，**全部列给用户**
- Aone Pages 异步部署，pipeline 跑完后 1-3 分钟可访问；用户如果立刻打开 404，让他稍等再刷新
- 回复 URL 时**必须**使用标准 Markdown 链接格式 `[链接文字](url)`，**不要**用加粗包裹（禁止 `**[文字](url)**` 形式）—— 加粗链接在部分解析器中会导致渲染异常

## 命令参考

完整命令请查 `aper-pages help` 或 `aper-pages <cmd> --help`。常用：

```
aper-pages init [--auto]              # 首次初始化
aper-pages publish <html> --title ... --category ... --summary ...
aper-pages template list              # 列可用模板
aper-pages template show <type>       # 输出模板 stdout
aper-pages template eject <type>      # 拷贝到 ~/.aper-pages/templates 供自定义
aper-pages serve <start|stop|status>  # 本地预览守护（默认 :1700）
aper-pages mirror <add|rm|list>       # 镜像远端管理
aper-pages doctor [--silent]          # 配置 / 依赖体检
aper-pages sync                       # 同步 build/site 到所有远端 pipeline
```

## 故障兜底

- 命令失败先跑 `aper-pages doctor` 看具体诊断
- 可用命令清单：`aper-pages help`
- 某条命令参数：`aper-pages <cmd> --help`