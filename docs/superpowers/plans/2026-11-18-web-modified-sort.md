# Web 修改时间分页排序实施计划

> **For agentic workers:** 使用 superpowers:subagent-driven-development 或 superpowers:executing-plans 逐项执行；本轮后端与前端并行，集成验证后统一提交。

**Goal:** 修复修改时间菜单错误反转最近打开顺序的问题，并保持分页正确。

**Architecture:** 缺省 recent 请求保持最近打开顺序。用户显式选修改时间后，Web 通过可选严格枚举 sort 请求服务端稳定分页；共享桌面组件由显式 capability 保持原行为。目录已有完整且有界的列表，在该列表内按 mtimeMs 排序。

**Tech Stack:** React、TypeScript、Fastify、PostgreSQL、Vitest、Node test、Chromium。

**Spec:** docs/dyoffice/evidence/ui-entry-audit-2026-11-18.md 中“窄屏排序入口与排序字段审计”。

## 全局约束

- 保留主页布局、默认最近打开顺序及桌面端行为。
- sort 仅允许 modified-asc/modified-desc；SQL 只使用固定映射。
- 不修改用户部署数据，真实业务验证使用隔离 PG fixture；浏览器业务请求 mock。
- 显式排序切换清空第一页并隔离旧响应；不为最早排序主动读取全部 Web 文件。

## 任务 1：后端契约与稳定分页

文件：packages/web-contracts/src/workspace.ts；apps/web/server/src/modules/workspace/routes.ts、service.ts；新增 apps/web/test/local-integration/workspace-sort.test.mjs。

接口：WorkspaceFileQuery.sort?: 'modified-asc' | 'modified-desc'。缺省保持现有 view 顺序。

- [x] 写红测：真实隔离文件打开与修改时间逆序，GET recent 缺省按打开时间，显式 asc/desc 分别按修改时间；55条分页与同时间id稳定顺序；非法字段被 HTTP 和 service 拒绝。
- [x] 运行定向 Node integration，确认当前 sort 请求400导致红测。
- [x] 在共享类型和HTTP schema加入枚举，service allowlist验证并固定映射 SQL：
  ```ts
  const order = input.sort === 'modified-asc' ? 'updated_at ASC,id' : input.sort === 'modified-desc' ? 'updated_at DESC,id' : view === 'recent' ? 'last_opened_at DESC,id' : 'updated_at DESC,id'
  ```
- [x] 定向集成绿测，保留租户、最近列表成员和过滤约束。

## 任务 2：Web bridge 与工作区交互

文件：apps/shell/src/shared/home-api.ts；apps/web/src/shell/local-home-bridge.ts、local-main.tsx；apps/shell/src/renderer/src/Home.tsx；apps/web/test/unit/local-home-bridge.test.mjs；apps/web/test/shell/home-workspace.test.ts。

接口：RecentQuery.sort 可选枚举同上；Home capabilities.serverFileSort 为true时采用服务端排序。

- [x] 先写红测：bridge 150条 refresh 每次请求保持同sort；Home 默认不传sort，显式 asc/desc 重置第一页、响应原样显示，不为oldest拉全；持有旧尾页后切排序，旧响应不得混入新序或清新锁。
- [x] 运行 Node bridge 与 Vitest 定向测试确认失败。
- [x] bridge 两处分页 query 都传sort；Home Web 初始 fileSort=undefined，显式选择映射serverSort，reload依赖serverSort；Web按响应顺序渲染且禁用旧拉全effect。桌面保持原reverse逻辑。
- [x] 目录Web显式排序在已完整加载的folderFiles内按mtimeMs及稳定path升序；默认目录顺序保持。
- [x] 全 Shell、bridge 与类型验证通过。

## 任务 3：集成复验与交付

文件：docs/dyoffice/evidence/ui-entry-audit-2026-11-18.md；本计划；PR #151。

- [x] 构建shell并重启HTTP200，真实Chromium验证打开/修改逆序、55条首50/尾5、sort切换及迟到尾页、目录、320/1440入口；业务全mock。
- [x] 执行前后端类型、Web相关测试、边界与清单检查，检查所有输出与失败。
- [ ] 记录真实覆盖和限制；git diff --check；提交、通过gh发布并更新现有PR，不声明完整UI穷举已完成。

## 实施补充

- 新增排序菜单 Escape 关闭并恢复触发器焦点，独立 DOM 回归先红后绿；最终 Shell 440 项通过。
- 全量单元发现既有 Node 无扩展名导入与纯内联 DOM fixture 的端口 guard 误报，最小修复后 702 项通过、4 项条件跳过；真实服务 fixture 的端口隔离检查保留。
- 真实隔离 PG 后端与原工作区回归19项通过，前后端类型、最终构建及边界检查通过。最后浏览器补验包含 Escape。

最终两尺寸 Chromium 包含真实 Escape、默认最近打开与显式排序、旧响应竞态、55条分页、收藏及目录，全部通过。提交与发布状态以 PR #151 及审计记录对应提交为准。
