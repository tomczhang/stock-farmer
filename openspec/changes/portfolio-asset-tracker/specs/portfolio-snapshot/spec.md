# portfolio-snapshot

## ADDED Requirements

### Requirement: 月结单浏览器端解析
系统 SHALL 复用 tax-check 的 13 家券商解析器在浏览器端解析月结单，
原始文件与 PDF 密码 SHALL NOT 上传到服务端；服务端只接收解析后的结构化快照
（持仓 OpenPosition[] + 现金 CashBalance[]）。

#### Scenario: 上传并保存快照
- **WHEN** 用户选择券商、上传月结单并在预览中确认
- **THEN** 快照（as_of、持仓明细、现金余额）写入该用户名下，可在快照列表中查看与删除

### Requirement: 现金余额提取与补录
系统 SHALL 对月结单做 best-effort 现金余额提取；提取不到时 SHALL 在预览界面提示，
并允许用户手动补录。手动补录（source=manual）SHALL 覆盖同券商同币种的解析值。

#### Scenario: 手动补录覆盖
- **WHEN** 用户对某券商某币种手动填写现金金额
- **THEN** 盘点聚合使用手动值而非解析值

### Requirement: 资产盘点聚合
系统 SHALL 按每个券商最新 as_of 的快照聚合：总资产、持仓市值、闲置现金、仓位现金比、
按券商/币种/市场/个股分布，统一折算到用户选定的展示币种（USD/HKD/CNY）。

#### Scenario: 多券商多币种聚合
- **WHEN** 用户拥有多个券商、多币种的快照与现金
- **THEN** summary 返回统一币种的 KPI 与分布数据，并标注数据 as_of

### Requirement: 最新收盘价刷新
系统 SHALL 提供零密钥行情代理（腾讯港股 / Yahoo 美股，缓存 10 分钟）；
用户触发刷新后，持仓市值 SHALL 以最新收盘价 × 数量覆盖月结单口径。

#### Scenario: 行情不可用降级
- **WHEN** 行情源请求失败
- **THEN** 该标的继续使用月结单市值并在响应中标注 stale
