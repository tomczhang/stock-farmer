# 设计原则

## 核心理念

每个页面是**一次性的、独立的 HTML 文件**。不是应用，是高质量可归档的内容单元。

目标是让 AI 生成的内容"真正能被人读进去"——视觉清晰、可交互、可分享。

## 页面生成原则

**单文件自包含**：所有依赖通过 CDN 引入，输出一个完整 HTML 文件，浏览器直接打开即可使用。

**内容驱动**：HTML 负责结构，Tailwind 负责视觉，Alpine.js 负责轻量交互。不引入 React/Vue/构建工具。

**按需引入**：只在需要时引入额外库（ECharts、Mermaid）。不要把页面做成"依赖很多库的小应用"。

## 内置页面类型的生成要点

> 以下是 CLI 包内置的几种模板的生成指导。category 与 template 解耦、可自定义：用户/agent 可基于内容引入新 category（如 `changelog` / `architecture` / `runbook`），选用最接近的内置模板作为容器，对照下方原则填充。

### report / spec / review（文字为主）
使用 `templates/report.html` 模板。关键结构：
- sticky 顶部导航（含返回首页链接）
- 左侧目录（大屏显示，`hidden lg:block`）
- 内容区：摘要（蓝色引用块）→ 核心结论（三列卡片）→ 背景 → 分析 → 建议 → 附录（折叠）
- 宽度 `max-w-4xl`

### dashboard（数据为主）
使用 `templates/dashboard.html` 模板。关键结构：
- 指标卡片（四列）
- 图表区（ECharts 双列）
- 数据表格 + Tab 切换
- 宽度 `max-w-6xl`（数据密集展示）

### tool（交互工具）
使用 `templates/tool.html` 模板。**必须包含**：
- 所有可调控件（滑块、选择器、输入框）加 `data-result="key"` 属性
- 浮动「复制结论给 Agent」按钮，点击后将所有 `data-result` 元素的值序列化为 JSON 复制到剪贴板
- 一定要有 export 出口，否则工具页没有闭环

### showcase（方案对比）
自由生成，常见结构：
- Grid 布局（2-4列）展示多个方案
- 每个方案卡片标注优势和取舍
- 可加对比维度表格

## 视觉规范

- 背景：`bg-gray-50`，内容卡片：`bg-white border border-gray-200 rounded-lg`
- 标题：`text-gray-900`，正文：`text-gray-700`，次要文字：`text-gray-500`
- 强调色：blue 系（主）、green 系（正向/建议）、red 系（警告）
- 分类标签颜色：report=blue、spec=purple、review=yellow、dashboard=green、tool=orange、showcase=pink

## 交互规范

- Alpine.js 用于：折叠/展开、Tab 切换、计数器、本地筛选
- 目录导航用锚点（`href="#section-id"`）
- `html { scroll-behavior: smooth; }` 确保平滑滚动
- 附录等次要内容用 `x-show + x-transition` 折叠
