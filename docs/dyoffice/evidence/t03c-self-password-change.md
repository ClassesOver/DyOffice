# T03c：用户自行改密、会话轮换与事务验收

> 收口说明见 [t03-closeout.md](t03-closeout.md)。改密路由由 `buildApp({ localAuth })` 注册。

> 日期：2026-11-16。归属：PR #10 / `feat/dyoffice-t03c-account-lifecycle`。
> 本次代码提交：`2d2b3e0e76124c6b07636b9eebb87b9e1ad70640`。
> 状态：独立服务和 HTTP 测试闭环已实现；**未挂载共享 Fastify 服务、未完成管理界面或生产权限验收**。

## 范围和并行开发约束

本轮只新增 `password-change.mjs`、`password-change-http.mjs`、对应测试、`0006_self_password_change.sql` 和独立 CI。三个既有身份/登录/账号生命周期集成测试只更新了一行迁移清单。没有修改旧迁移内容、账号生命周期服务、Session 核心、Fastify 入口、编辑器、文件保存/回收站、数据源、UI、依赖清单或锁文件。

代码以 PR #10 的 `2476c2693b296542d0d9f64603af37a73620497d` 为基线，用 expected SHA 校验后快速前进推送；没有强制推送、修改其他 worker 分支或执行合并。PR #12 的文件回收站不属于本轮范围。

## 实现契约

- `createPasswordChangeService({...}).changePassword(request, {currentPassword,newPassword})` 只接受这两个字段。账号 ID 和部署 ID 来自服务端配置与已认证会话，不接受客户端指定操作对象。
- 在有效会话、CSRF、账号/IP/部署共享限流与旧密码验证之后，使用现有 Argon2id 实现计算新散列。错误旧密码、外部部署主体、弱/过长密码和相同新旧密码均拒绝。
- 密码散列计算在事务外进行；进入事务后获取与管理员账号服务相同的部署级 advisory lock，再锁定用户与当前会话，重新确认状态、认证版本、密码散列、撤销和超时条件。
- 同一事务更新密码和 `auth_version`，撤销该用户全部旧浏览器会话与未消费激活/重置令牌，记录 `password.changed` 审计，并通过现有 Session 服务在**同一个数据库连接/事务内**创建替代当前会话。事务成功之前不返回 Cookie。
- 审计失败或替代会话插入失败，密码、版本、撤销记录和新会话全部回滚。回滚连接失败时丢弃连接，不放回正常池继续使用。
- 不改变其他账号的会话。新会话获得不同的 session ID，因此旧会话绑定的 CSRF 令牌不能复用；客户端应重新获取 `/api/v1/auth/csrf`。

## HTTP 适配器

`createPasswordChangeHttpAdapter({service,trustedOrigin,bodyTimeoutMs})` 提供独立的 `POST /api/v1/auth/change-password` 处理器，不会自行挂载任何路由。

仅接收可信 Origin 的 JSON 请求；拒绝重复 Origin、查询参数、额外字段、非 JSON 内容、超过 8192 字节的正文和超过默认 5 秒的未完成正文。正常输出只有 `{ok:true}`，新会话仅通过 `Set-Cookie` 下发。响应始终 `Cache-Control: no-store`，不会把密码、散列、完整会话信息或数据库错误写进 JSON。

预期状态：成功 200，字段错误 400，未认证/旧密码错误 401，Origin/CSRF 错误 403，认证状态竞争 409，读取超时 408，正文过大 413，媒体类型错误 415，限流 429，依赖/事务不可用 503。

这是 Node HTTP 合同适配器和真实测试服务器，不是已部署的 Fastify 路由或浏览器界面。Fastify 接入应复用服务契约，不能直接复用已被框架消费的原始请求体流。

## 已执行验证

### 本地：先失败再通过

在 Node 22.16.0 的独立源码镜像中，先以尚未实现的方法和路由运行测试：服务测试 7 项失败，HTTP 测试 7 项失败。实现后运行：

```sh
node --test apps/web/test/password-change.test.mjs apps/web/test/password-change-http.test.mjs
# 14 passed, 0 failed
```

另检查了请求体传输中断：服务未被调用、进程没有异常退出。已有 `credential-policy.mjs` 和 `session-core.mjs` 的本地镜像以 Git blob SHA 核对，分别为 `8e9587f3632f157f8a720ec1a291423d7940036d` 和 `dccba626acb07f2090ca6dd693b812312e2eed2b`；新增生产文件和最终测试上传 blob 也与本地一致。

本地没有 PostgreSQL 服务，npm 域名解析不可用，所以**不宣称本地执行过数据库集成或完整仓库构建**。

### GitHub CI：真实 PostgreSQL 16 + Argon2id + HTTP

[改密专项 CI #43779872258](https://github.com/ClassesOver/DyOffice/actions/runs/43779872258) 在上述代码提交上通过。包括 14 项单元/HTTP 测试、6 个数据库场景子测试及父测试、完整 `npm run test:web`、Web 类型检查、Web 构建/HTTP smoke 和 whitespace 检查。

数据库场景涵盖：登录→获取 CSRF→改密→旧会话拒绝→新会话继续工作；错误凭据和对象注入；两个请求在散列阶段同步后并发改密仅一次成功；管理员重置与用户改密交错；审计写入/新会话插入失败的实际事务回滚；审计字段无秘密信息。

同一代码提交的账号生命周期 CI #43779872287、登录 CI #43779872304、身份数据库 CI #43779872196 均通过。额外共享 Web gate #43779872210 的实时结果以 GitHub 检查为准；不要把专项构建通过等同于未结束的所有检查通过。

## 尚未放行

1. 未修改/启用共享服务入口与生产启动守卫；没有上线改密页面。后续需要 Fastify owner 按契约集成，并进行真实浏览器 HTTPS/Cookie 测试。
2. 测试使用一次性数据库及测试角色，**不是生产最小权限角色与 FORCE RLS 证明**。T04 继续阻断跨用户文件访问上线。
3. 本轮撤销浏览器会话和密码操作令牌，不声称已实现外部 API Token、编辑租约、长任务或 MCP 访问的撤销。那些入口必须在提交前重验账号状态/认证版本。
4. Session 超时配置、可信代理 IP、持久 HMAC 密钥、凭据请求日志脱敏、审计保留与通知渠道仍需部署级配置和验收。密码策略仍缺完整离线泄露密码库与目标硬件基准。
5. 网络在数据库提交后中断可能导致客户端未收到新 Cookie；应提示用新密码重新登录，不能自动重试旧密码写入来猜测事务结果。
6. 独立安全审查、管理账号列表/角色管理、完整生产账号和文件工作区联合验收未完成。PR 继续保持 Draft。

## 安全参考

设计核对使用 OWASP [Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)、[Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) 与 PostgreSQL 16 [Explicit Locking](https://www.postgresql.org/docs/16/explicit-locking.html)。这里是对已登录用户验证旧凭据后的会话轮换，不改变管理员重置/找回密码完成后需要重新登录的既有流程。
