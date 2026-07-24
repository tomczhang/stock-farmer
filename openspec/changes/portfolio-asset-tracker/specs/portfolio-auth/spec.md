# portfolio-auth

## ADDED Requirements

### Requirement: 邮箱验证码注册
系统 SHALL 支持邮箱 + 密码注册。注册后系统 SHALL 通过 Resend 向该邮箱发送 6 位数字验证码
（10 分钟有效）；验证成功后账户方可登录。

#### Scenario: 正常注册并验证
- **WHEN** 用户提交合法邮箱与密码（≥8 位）并随后提交正确验证码
- **THEN** 账户被标记为已验证，且可用该邮箱密码登录

#### Scenario: 验证码限频
- **WHEN** 同一邮箱在 60 秒内再次请求验证码，或当日请求超过 10 次
- **THEN** 系统返回 429 且不发送新验证码

#### Scenario: 验证码错误或过期
- **WHEN** 用户提交错误验证码超过 5 次或验证码已过期
- **THEN** 该验证码失效，需重新请求

### Requirement: 会话管理
登录成功 SHALL 颁发随机会话令牌（服务端只存哈希，30 天有效），
通过 HTTP-only、SameSite=Lax 的 Cookie 传递；登出 SHALL 使会话失效。

#### Scenario: 未认证访问受保护接口
- **WHEN** 请求未携带有效会话 Cookie 访问 /api/statements 等受保护接口
- **THEN** 系统返回 401
