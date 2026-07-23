# CDN 依赖

内部 unpkg 镜像：`unpkg.alibaba-inc.com`

## 必用依赖（每个页面都要）

```html
<script src="https://unpkg.alibaba-inc.com/@tailwindcss/browser@4"></script>
<script src="https://unpkg.alibaba-inc.com/alpinejs@3/dist/cdn.min.js" defer></script>
```

## 踩坑记录（务必注意）

### Tailwind CSS
- ❌ 错误：`unpkg.alibaba-inc.com/tailwindcss/index.css` — 这是 Tailwind v4 源文件，只有主题变量，工具类不会被编译
- ✅ 正确：`unpkg.alibaba-inc.com/@tailwindcss/browser@4` — 浏览器端 JIT 编译器，实时扫描 HTML class 并生成 CSS

### Alpine.js
- ❌ 错误：`unpkg.alibaba-inc.com/alpinejs` — 内部 unpkg 默认解析到 `dist/module.cjs.js`（CommonJS），浏览器无法执行，`x-data` 完全失效
- ✅ 正确：`unpkg.alibaba-inc.com/alpinejs@3/dist/cdn.min.js` — 浏览器专用构建，必须加 `defer`

## 按需引入

```html
<!-- 图表 -->
<script src="https://unpkg.alibaba-inc.com/echarts/dist/echarts.min.js"></script>

<!-- 流程图 -->
<script src="https://unpkg.alibaba-inc.com/mermaid/dist/mermaid.min.js"></script>

<!-- 代码高亮 -->
<script src="https://unpkg.alibaba-inc.com/highlight.js/lib/highlight.min.js"></script>
<link rel="stylesheet" href="https://unpkg.alibaba-inc.com/highlight.js/styles/github.min.css">
```

按需引入原则：只在确实需要时加，不要预引入所有库。
