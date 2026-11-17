# ADR-0001: 使用本地账号密码与服务端会话认证

- 日期：2026-11-15
- 状态：Accepted（用户在对话中明确指定）
- 适用：DyOffice Web、管理员后台、HTTP 文件 API、AI Agent、外部 MCP 权限绑定
- 关联：[本地账户专项设计](../local-account-auth.md)、[架构](../architecture.md)、[实施任务](../implementation-plan.md)、[验收](../acceptance-matrix.md)

## 背景

DyOffice 由 DyOffice Web 改造而来，需提供多用户的独立个人工作区，企业内部可自部署。既有开发原型采用共享的个人/Admin Bearer Token，这不是生产用户身份；旧计划提出外部 OIDC/IdP 对接，但用户明确要求不引入 OIDC，改为账号密码管理。

## 决定

1. **Web 登录：** 仅支持 DyOffice 自建的本地用户名+密码。Fastify 认证服务、PostgreSQL 账号/会话数据库；浏览器使用服务器签发的 Secure + HttpOnly + SameSite Cookie，服务端校验 CSRF/Origin。
2. **用户生命周期：** 管理员通过后台创建、停用、恢复用户，发放单次激活/密码重置凭据；用户可修改自己的密码和撤销自己的会话；首个管理员由一次性安全初始化流程创建，无默认弱密码，公开注册默认关闭。
3. **口令安全：** Argon2id 带独立盐，首版单因素至少 15 字符，允许密码短语；登录限流、同形错误消息、短时重置 Token、日志脱敏、账号/权限变化后会话与外部 Token 撤销。
4. **资源隔离：** 仍按服务端认证主体执行 owner 授权与 PostgreSQL RLS；管理员维护账号不等于拥有私人文件读取权。
5. **外部 Agent：** 由已登录用户独立发放和撤销 scoped Bearer API Token，不允许用账户密码或 Cookie 替代机器访问令牌。
6. **禁用的替代方案：** 本阶段不接 OIDC、Keycloak、SSO、SAML、LDAP 或其他外部身份平台；不将开发双 Token 扩展为生产单账号。
7. **发布门槛：** T03 真实账号密码/会话验证、T04 跨用户隔离、T22 管理员初始化/数据迁移及 [验收矩阵 I01–I20](../acceptance-matrix.md) 全部达标，方可对外宣称生产账号登录可用。

## 影响

- 不需要部署 Keycloak 等身份服务，降低首版接入成本，但 DyOffice 自身必须承担密码保护、登录安全、账户恢复、管理审计和会话失效责任。
- 现有 `apps/web` 开发 Token 应保留为本地兼容入口且 **production fail-closed**；不得误认已经实现了本决策。
- 将来增加多因素认证或第三方统一登录必须另外做决策和安全评审，不能默默恢复旧方案。

## 实施与验证状态

目前为**方案和文档更新**，不是 T03 实现。正式用户数据库、Argon2id 散列、登录页面、管理员开户/停用和会话管理均未在本 ADR 中完成；回归/压测结果需由对应代码 PR 和实际 CI 证明。
