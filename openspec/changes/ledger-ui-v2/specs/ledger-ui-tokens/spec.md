## ADDED Requirements

### Requirement: 涨跌语义色全站唯一
系统 SHALL 以 `--gain: #0E9F6E`、`--loss: #D84C55` 作为全站唯一涨跌语义色：`.pos/.neg` 文本、总览历史柱状图、绩效净值/月度盈亏/盈亏分布图、表格浮动盈亏均 MUST 引用该组色值。危险操作色 `--danger` SHALL 独立保留，MUST NOT 与涨跌语义混用。

#### Scenario: 涨跌色一致性
- **WHEN** 检查 global.css、DashboardPage、PerformancePage 中的涨跌用色
- **THEN** 全部解析为 #0E9F6E / #D84C55，无 #22c55e、#14b8a6、#b91c1c 涨跌残留

### Requirement: 图表 Lieflat 语法
柱状图 SHALL 使用纯色填充（去渐变）。月度盈亏图 SHALL 将 |盈亏| 最大月渲染为全饱和焦点柱并标注数值，其余柱 38% 不透明度。净值曲线主线 SHALL 使用墨色（--ink），最新有效净值点 SHALL 以品牌黄标记并标注数值。

#### Scenario: 焦点柱
- **WHEN** 月度盈亏存在多个月份数据
- **THEN** 仅 |盈亏| 最大月为全饱和且带数值标签，其余月份柱为半透明

#### Scenario: 净值线端点
- **WHEN** 净值序列渲染
- **THEN** 主线为墨色，最新非空净值点带品牌黄标记与数值标注

### Requirement: KPI 卡与表格排版
KPI 卡 SHALL 移除彩色顶边等装饰性色彩，语义色仅出现在数值文本上。数据表格与 KPI 数值 SHALL 启用 `font-variant-numeric: tabular-nums`；状态 chip SHALL 使用方角（≤6px 圆角）。

#### Scenario: KPI 无装饰色
- **WHEN** 渲染总览/绩效/复盘/持仓 KPI 卡
- **THEN** 卡片边框与背景为中性色，仅数值按涨跌着色

### Requirement: 按钮高优先级层级
按钮体系 SHALL 新增 `.btn.priority`（墨色实底），用于确认类动作（如保存复盘）；主黄 primary 与描边 ghost、危险 danger 保持现状。

#### Scenario: 保存复盘按钮
- **WHEN** 打开复盘页
- **THEN** 保存按钮为墨色高优先级样式

### Requirement: 微交互动效
系统 SHALL 实现：(a) value-flash——受监控数值变化时按方向闪烁涨/跌色约 900ms 后恢复，方向箭头具有固定占位格，布局不因箭头出现/消失位移；(b) loading 按钮——加载态与常态同宽（隐形双胞胎占位），无宽度跳变；(c) scope-toggle——选中态以滑块滑动过渡；(d) 页面入场动画 0.22s（位移+缩放+模糊），任何出场动画 MUST 短于入场。动效 MUST 事件驱动，禁止 idle 循环（spinner 除外）。

#### Scenario: 刷新市值后数值闪色
- **WHEN** 刷新行情导致总净资产数值变化
- **THEN** 数值按变化方向闪烁 gain/loss 色后恢复墨色，页面布局无位移

#### Scenario: 加载按钮宽度稳定
- **WHEN** 点击「刷新市值」进入加载态
- **THEN** 按钮宽度与常态一致

### Requirement: Reduced Motion 降级
在 `prefers-reduced-motion: reduce` 下，系统 SHALL 移除位移/缩放/模糊类动画与滑块过渡，保留颜色变化等信息性反馈。

#### Scenario: 减少动态偏好
- **WHEN** 系统开启减少动态
- **THEN** 入场动画与滑块滑动被禁用，value-flash 颜色反馈仍生效

### Requirement: 图标非 emoji 化
界面图标 MUST NOT 使用 emoji 字符；防窥切换按钮 SHALL 使用线性 SVG 眼睛图标。

#### Scenario: 防窥按钮
- **WHEN** 查看顶栏防窥按钮
- **THEN** 图标为 SVG，开启/关闭两态图形区分
