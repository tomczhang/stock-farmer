## ADDED Requirements

### Requirement: Single Page Application Structure

系统 SHALL 提供单页面应用结构，主区域用于展示 PE 历史图表，侧边或底部区域用于展示 watchlist 列表和指标卡片，确保用户在单一界面内完成所有查看操作。

#### Scenario: 用户访问根 URL 加载应用

- **WHEN** 用户在浏览器中访问根 URL `/`
- **THEN** 应用 SHALL 加载单页应用骨架，并默认显示 watchlist 中第一只股票的 PE 历史图表和指标卡片

### Requirement: Stock Selection from Watchlist

系统 SHALL 提供从 watchlist 中选择股票的交互方式，用户可通过点击列表项或下拉切换的方式切换当前查看的股票。

#### Scenario: 用户点击 watchlist 中的股票

- **WHEN** 用户点击 watchlist 中的某只股票条目
- **THEN** 主图和指标卡片 SHALL 切换为该股票对应的数据

#### Scenario: watchlist 为空时的引导

- **WHEN** watchlist 中没有任何股票
- **THEN** 应用 SHALL 在主区域显示引导提示 "请先添加股票到 watchlist"

### Requirement: Time Window Toggle

系统 SHALL 提供 5y / 10y / 全部 三档时间窗切换按钮，切换后主图与指标卡片均 MUST 同步更新。

#### Scenario: 用户从 5y 切换到 10y

- **WHEN** 用户点击 10y 时间窗按钮
- **THEN** 应用 SHALL 调用对应窗口的 API 接口拉取数据，并重新渲染主图与指标卡片

### Requirement: PE History Line Chart

系统 SHALL 使用 ECharts 渲染 PE-TTM 历史折线图，当前日期对应的点 MUST 以醒目方式高亮标记（如较大圆点与对比色）。

#### Scenario: 图表加载完成后高亮今日点

- **WHEN** 图表完成首次渲染
- **THEN** 折线最右侧的今日数据点 SHALL 以视觉高亮（大圆点 + 颜色对比）显示

#### Scenario: 用户悬停查看某日数据

- **WHEN** 用户将鼠标悬停在折线上的某个日期点
- **THEN** 应用 SHALL 显示 tooltip，内容包含该日期、PE 值以及当时的历史分位

### Requirement: Percentile Reference Lines

系统 SHALL 在 PE 历史图表上叠加 25%、50%、75% 三条百分位水平参考线，便于用户直观判断当前 PE 所处分位区间。

#### Scenario: 图表渲染时显示分位参考线

- **WHEN** PE 历史图表完成渲染
- **THEN** 图表上 SHALL 显示 3 条横向虚线，分别标注 25%、50%、75% 分位

### Requirement: Loss Period Shading

系统 SHALL 使用阴影遮罩或不同背景色标出 `is_loss=true` 的日期段，并在图例中说明该视觉编码的含义。

#### Scenario: 股票历史中存在亏损期

- **WHEN** 当前股票的历史数据中包含 `is_loss=true` 的日期段
- **THEN** 这些日期段 SHALL 在图表中以阴影或不同背景色显示，并在图例中标注 "亏损期"

#### Scenario: 所有日期都盈利

- **WHEN** 当前股票的历史数据中没有任何 `is_loss=true` 的日期
- **THEN** 图表 SHALL 不显示任何阴影遮罩

### Requirement: Metrics Cards Display

系统 SHALL 在主图下方或旁边显示 4 张指标卡片：当前 PE、历史中位、当前分位百分比、历史极值（min/max）。

#### Scenario: 股票切换时卡片同步刷新

- **WHEN** 用户切换查看的股票或时间窗
- **THEN** 4 张指标卡片 SHALL 同步刷新为新数据

#### Scenario: 当前处于亏损时的卡片显示

- **WHEN** 当前股票最新状态为亏损（is_loss=true）
- **THEN** 当前 PE 卡片 SHALL 显示 "亏损中"，历史中位、分位、极值卡片 SHALL 仍正常显示历史数据

### Requirement: Watchlist Management UI

系统 SHALL 提供添加和移除 watchlist 股票的 UI：输入框接受 ticker，配合 US/HK 选择器或自动识别 `.HK` 后缀，列表项 MUST 包含删除按钮。

#### Scenario: 用户添加港股到 watchlist

- **WHEN** 用户在输入框中输入 `0700.HK` 并点击添加按钮
- **THEN** 应用 SHALL 调用 `POST /api/watchlist` 接口，并在请求成功后刷新 watchlist 列表

#### Scenario: 用户从 watchlist 删除股票

- **WHEN** 用户点击 watchlist 某个列表项的删除按钮
- **THEN** 应用 SHALL 调用 `DELETE /api/watchlist/{ticker}` 接口，并在请求成功后从列表中移除该项

### Requirement: Data Disclaimer Footer

系统 SHALL 在页面角落始终显示数据口径免责说明："基于最新可得财报数据，不还原历史时点；亏损期已从分位计算中剔除。"

#### Scenario: 任何页面状态下角标可见

- **WHEN** 用户处于应用的任何页面状态（加载中、正常显示、错误态）
- **THEN** 数据口径免责角标 SHALL 始终在页面角落可见

### Requirement: Loading and Error States

系统 SHALL 在 API 请求期间显示加载状态，在请求失败时显示明确的错误信息并提供重试按钮。

#### Scenario: API 请求进行中

- **WHEN** 应用正在等待 API 响应
- **THEN** 应用 SHALL 显示加载骨架屏或 spinner 提示用户

#### Scenario: API 返回错误

- **WHEN** API 请求失败或返回错误状态
- **THEN** 应用 SHALL 显示错误消息说明失败原因，并提供一个重试按钮

### Requirement: Responsive Layout

系统 SHALL 在桌面端（≥1024px）和移动端（<768px）均可正常使用，移动端的 watchlist MUST 折叠为抽屉式交互。

#### Scenario: 移动端访问

- **WHEN** 用户在视口宽度小于 768px 的设备上访问应用
- **THEN** watchlist SHALL 折叠在汉堡菜单或抽屉中，主图占据屏幕主要区域

#### Scenario: 桌面端访问

- **WHEN** 用户在视口宽度大于等于 1024px 的设备上访问应用
- **THEN** watchlist SHALL 常驻在侧边栏中持续可见

### Requirement: API Endpoint Configuration

系统 SHALL 通过环境变量配置后端 API base URL，开发环境指向本地 workers 地址，生产环境指向 Cloudflare Workers 域名。

#### Scenario: 构建时注入 API 地址

- **WHEN** 前端项目执行构建
- **THEN** 应用 SHALL 根据环境变量 `VITE_API_BASE_URL` 注入对应的后端 API 基础地址
