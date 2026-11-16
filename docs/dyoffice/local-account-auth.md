# DyOffice 本地账号密码认证与用户管理设计

> 决策日期：2026-11-15 · 状态：用户确认的架构方向，**不是已实现或已通过验收**  
> 对应任务：T03（账户/密码/会话）、T04（资源隔离）、T19（外部 API Token）、T22（迁移与交付）。参阅 [architecture.md](architecture.md)、[implementation-plan.md](implementation-plan.md)、[acceptance-matrix.md](acceptance-matrix.md)。

## 1. 核心决策

DyOffice **不引入 OIDC、Keycloak、SAML、LDAP 或第三方身份提供方**。采用自管理的本地用户名与密码，使用 PostgreSQL 存储用户和验证信息，由 Fastify 服务端完成登录、会话和管理员操作。

本次决策仅改变**身份认证实现**，不扩展团队/组织/共享文件权限。每个账号对应一个独立个人工作区；配置管理员可管理账号与全局服务设置，但不因此获得其他用户的文件访问权限。外部 Codex/其他 Harness 使用单独发放、可撤销、按作用域/文件授权的 HTTP Bearer API Token，**不使用用户名密码直连 MCP**。

### 明确不做

- 不引入第三方身份管理平台或企业统一登录，不声称支持 SSO。
- 不允许自行注册成为管理员；首版关闭公开自助注册。
- 不把当前 `DYOFFICE_USER_TOKEN` / `DYOFFICE_ADMIN_TOKEN` 当正式登录方式，开发双 Token 在 production 必须拒绝启动。
- 不用浏览器 localStorage、sessionStorage 或 URL query 持久保存登录会话；不将密码/散列/重置密钥返回浏览器。
- 不让 Admin 的账号管理权限等同于读取/修改其他用户的文档。

## 2. 用户体验和管理员流程

| 功能 | 普通用户 | 账户/配置管理员 |
| --- | --- | --- |
| 登录/登出 | 用户名 + 密码；服务端 Session Cookie | 同样账号密码登录，服务端决定角色 |
| 查看工作区 | 仅自己的文件、对话、数据源、偏好、任务 | **不因管理员身份自动读取**普通用户个人工作区 |
| 修改密码 | 需重新验证当前密码；成功后撤销其他会话 | 修改自己的密码；敏感操作要求短时内再验证 |
| 创建账户 | 无公开注册按钮 | 创建唯一登录名，生成一次性激活链接/临时凭据 |
| 重置密码 | 自助找回可在可信邮件通道上线后另行评审；首版联系管理员 | 生成一次性、短时效重置令牌；不能查看旧密码 |
| 停用/恢复用户 | 无权操作 | 审计记录操作者和原因；停用立即撤销会话、API Token 和活动编辑/Agent 租约 |
| 修改角色 | 无权操作 | 显式配置管理员、运维、审计角色；变更要求再认证并撤销既有会话 |
| 外部 Agent | 在个人设置创建/撤销作用域 Token | 设定允许的全局能力和策略，不能代替用户授权读取私有文件 |

默认账号的创建方式：部署时运行一次性 CLI/bootstrap 操作，由运维人员交互式输入初始管理员密码或生成短期激活凭据。**镜像、示例配置、环境变量、数据库迁移和日志不包含默认管理员密码。** 不提供默认 `admin/admin` 或其他弱凭据。初始化动作必须在数据库事务中仅允许首次操作，后续关闭，重复调用失败。

## 3. 数据库模型（拟建）

| 表 | 关键字段与约束 |
| --- | --- |
| `users` | `id UUID`、`deployment_id`、`username_normalized`、`display_name`、`status`、`password_hash`、`password_changed_at`、`auth_version`、`created_at`、`disabled_at`；`(deployment_id,username_normalized)` 唯一 |
| `user_roles` | `user_id`、受控角色枚举；配置管理员、运维、审计、个人用户，可分离职责；禁止由客户端自行设置 |
| `sessions` | `id`、`user_id`、`session_token_hash`、`created_at`、`last_seen_at`、`expires_at`、`revoked_at`、`auth_version`；仅保存散列，不存原始会话 Token |
| `password_action_tokens` | `user_id`、`purpose=activate|reset`、`token_hash`、`expires_at`、`consumed_at`、`issued_by`；一次性、短时效、与用户绑定 |
| `login_throttles` | 账号与来源维度的失败计数及冷却窗口；可放有原子操作的缓存，失败关闭/降级策略需评估 |
| `audit_events` | 账户创建、登录失败摘要、锁定/解锁、密码变更/重置、角色变更、停用、会话撤销、紧急访问；不记明文凭据 |

用户名规范：先确定并文档化 Unicode/case-folding 规则；建议首版只接受可打印 ASCII 登录名，`trim` + 小写归一化，长度 3–64，阻止大小写混淆；显示名可国际化。账号内部永远使用不随用户名修改的 UUID。邮箱可作为联系字段，但不自动产生信任关系或账号合并。

数据库密码散列应使用自带随机 Salt 的 **Argon2id**（优先），起步不低于 OWASP 提示的 19 MiB 内存、2 次迭代、并行度 1；上线前在实际主机测算速率和并发资源使用。禁止明文、可逆加密、MD5、快速 SHA-256 或开发用固定盐作为用户密码存储。旧散列迁移时逐账户验证并透明升级，不能静默降级。[参考 OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)

密码策略采用单因素认证建议的最少 **15 字符**，允许长密码短语、空格和 Unicode，不强制大小写/特殊字符组合，不强制无故定期换密；验证常见/泄露密码阻断列表，允许密码管理器粘贴与自动填充。接受至少 64 字符的密码，设置合理字节输入上限以防计算资源耗尽。[参考 NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html)

## 4. 服务端登录和会话

### 4.1 接口（拟建）

| 方法 | 路径 | 主要要求 |
| --- | --- | --- |
| `POST` | `/api/v1/auth/login` | username/password；通用错误、IP+账号限流；成功建立会话 |
| `POST` | `/api/v1/auth/logout` | 撤销当前会话、清除 Cookie；幂等 |
| `GET` | `/api/v1/auth/me` | 当前用户/角色/能力的无秘密 DTO；过期为 401 |
| `POST` | `/api/v1/auth/change-password` | 当前密码 + 新密码；确认后撤销旧会话/Token，重建当前会话 |
| `POST` | `/api/v1/auth/reauth` | 敏感管理员操作要求新近密码验证；服务端记录认证时间 |
| `GET` | `/api/v1/auth/sessions` | 仅本人可见自己的脱敏会话及设备概要 |
| `DELETE` | `/api/v1/auth/sessions/:id` | 本人撤销自己的特定会话；不能撤销他人 |
| `POST` | `/api/v1/admin/users` | 管理员建立账户；不返回密码散列 |
| `GET` | `/api/v1/admin/users` | 脱敏分页、过滤、状态；无个人文档详情 |
| `PATCH` | `/api/v1/admin/users/:id` | 停用、启用、明确的角色修改；审计 + 会话撤销 |
| `POST` | `/api/v1/admin/users/:id/password-reset` | 发放一次性令牌，受管理员新近认证约束 |
| `POST` | `/api/v1/auth/password-action` | 兑换激活或重置令牌并设置新密码；原子消费令牌 |

具体 JSON schema 与限流配置在 T03 冻结，服务端不可接受客户端伪造的 `userId`/`role` 来决定被操作的本人身份。管理员路径的目标用户 ID 在业务逻辑中独立授权。

### 4.2 Cookie / CSRF / 安全属性

- 仅以随机不可预测会话令牌作为浏览器凭据，服务端只存散列；Cookie 使用 `HttpOnly; Secure; SameSite=Lax; Path=/`，不跨可疑子域共享（建议 `__Host-` 前缀）。
- 登录、改密码、切换身份、账户管理和其他写操作启用同源 Origin 检查及服务端 CSRF 令牌校验；跨站请求不能靠 SameSite 一项防护。
- 成功登录后生成**新**会话；权限变化、密码变更、管理员重置、停用、撤销均要让旧会话失效；对长时 SSE/WS 和写事务在敏感步骤重新校验。
- 试点初始建议空闲超时 8 小时、绝对存活 24 小时，管理员高危操作要求 15 分钟内再认证；这仅是可调默认建议，须按客户安全策略验收。
- 登出不仅隐藏页面，服务端撤销会话；所有写请求、文件下载、MCP/WS 指令和后台任务恢复均须重新做授权。
- 浏览器离线草稿的清理和恢复策略要明确；退出/账户停用后不应允许访问先前缓存的敏感内容。

### 4.3 爆破与用户枚举防护

- 登录失败返回统一的错误语义，对不存在/禁用/密码错误账户都不泄露具体原因；不存在账号执行等成本的虚拟散列校验以缩小时序差异。
- 同时限制 **IP / 用户名 / 全局** 速率和并发哈希数量，失败后指数冷却、审计告警；对“被恶意锁死账户”攻击提供管理员安全恢复路径。
- 只有成功登录或合法管理员会话才可访问账户明细；密码重置和激活链接必须一次性、短效、不可预测、仅保存散列、使用后失效，不向日志或第三方分析传播。
- 停用和密码重置应优先撤销用户现有 Web 会话及远程 API Token；正在运行的文档写入在提交前再校验身份/租约。
- 安全事件保留脱敏账户 ID、时间、请求 ID 和原因类别，不记明文密码、完整会话 Cookie、重置令牌或 Provider 密钥。[参考 OWASP Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)

## 5. 个人隔离和 API Token

本地登录仅用于确认用户身份。登录成功后，服务端创建 `Principal={deploymentId,userId,roles,scopes,sessionId}`；数据库对所有私有文件、索引、AI 对话、数据源、任务、版本继续按 owner 隔离，并使用 PostgreSQL RLS 纵深保护。**管理员不能仅凭角色读取任意用户文档**。

外部 Harness 仍采用 `Authorization: Bearer <API token>`。Token 与用户绑定，支持 `read:files`、`write:files` 等最小 scopes、文件范围、到期和撤销；只存 Token 哈希与前缀，发放时显示明文一次。Token 不得放 URL 参数，非标准 URL Token 测试能力仍仅限隔离开发环境。API Token 权限与登录密码绝不混用。

## 6. 迁移与可执行工作拆分

1. **T03a 账户存储与密码服务**：数据库迁移、用户名归一化、Argon2id、一次性 Admin bootstrap、密码策略/黑名单、密码验证与锁定状态；先写失败测试。
2. **T03b 登录会话**：login/logout/me、随机会话、Cookie + CSRF、统一错误与限流、会话轮换和多端注销；跑 PostgreSQL + 浏览器 HTTP 集成测试。
3. **T03c 管理员账号管理**：用户 CRUD（不提供硬删除默认操作）、停用/恢复、角色分配、临时激活、管理员重置、再认证与脱敏审计；一律保留归属数据。
4. **T03d 用户自助安全操作**：密码修改、查看/撤销自己的登录会话、登录历史摘要；禁止账户互查。
5. **T04 资源授权/RLS**：继续原计划的跨用户、连接池与管理员无文档权限测试；不可因为改用密码登录而跳过。
6. **T19 外部 MCP Token**：由已登录用户发放，唯一用户归属和 scope，不得复用登录会话 Cookie 为第三方持久令牌。
7. **T22 老系统迁移/企业交付**：开发双 Token 不自动转换成真实账号；指定管理员和用户归属，迁移前确认身份映射、数据库和密钥备份，dry-run 报告数量/哈希/权限；禁止产生默认密码。

## 7. 必须通过的失败场景（P0）

- 用户名不存在、密码错误、账号已停用：统一响应，均不能登录；频次/时序和服务资源可控。
- 重复 Authorization、恶意 Cookie、跨站 CSRF、并发登录/登出与会话固定：不得建立/复用越权会话。
- A 登录后猜 B 的 fileId、revision、conversation、sourceId、jobId：HTTP、SSE、WS、MCP 和索引均无数据泄漏。
- 配置 Admin 操作账号后，不因后台管理权限获得用户文件读取权。
- 管理员停用用户、重置密码、调整角色时：旧会话、API Token、活动编辑写权限失效，任务提交前重验。
- 重置令牌被复制、复用、并发兑换、过期或针对其他账户兑换：只能成功一次，且不会改变错误的账号。
- 初始化管理员重复执行或空管理员凭据：失败；生产环境不允许 `DYOFFICE_USER_TOKEN` / `DYOFFICE_ADMIN_TOKEN` 登录。
- 账号表泄露/日志导出：不含明文密码、可逆密钥、会话 Token 或重置凭据；散列格式/参数可被验证。

## 8. 变更控制和实际状态

本文件是**新决策的唯一认证专项设计入口**。若未来考虑多因素认证，应单独批准为本地账号的可选第二因素，不应以此自动引回 OIDC/外部身份平台。需要新增 SSO 必须经过范围变更，不属于当前需求。

**截至 2026-11-16：** T03a 已提交 PostgreSQL 身份表迁移、真实 Argon2id 哈希/验证、数据库迁移事务执行器和一次性管理员初始化 CLI。T04 已对所有者表启用 `FORCE ROW LEVEL SECURITY`，证据见 [t04-row-level-security.md](evidence/t04-row-level-security.md)。这**不代表**已实现账号密码网页登录挂载、Admin 用户管理、完整泄露密码黑名单或已通过生产安全评审。现有 `apps/web` 开发 Token 服务仍保持不变，并继续拒绝 production 启动。会话查找仍使用迁移连接，直到 T03 改走 `dyoffice_auth`。
