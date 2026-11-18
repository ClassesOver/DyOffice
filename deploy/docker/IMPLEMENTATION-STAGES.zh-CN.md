# Ubuntu Docker 内文档隔离：分阶段交付

本文是待执行任务与验收门槛，不是已完成能力清单。当前正常 broker 仍退出 78，
`ApprovedRuntime` 不可构造；只读宿主审计仍退出 2，诊断仅运行固定 sleep。
业务输入不得接入诊断 profile，也不得把审计 JSON 当运行授权。

## 0. 只读宿主前提（当前最小改进）

- 执行 `python3 tools/dyoffice/audit-ubuntu-docker.py REPORT.json`；退出 2 是预期 unsupported。
- 核对 Ubuntu/systemd/cgroup v2、控制器、Docker userns、内置 seccomp、AppArmor 或 SELinux 元数据。
- `docker_lsm_observed` 仅接受精确 `name=apparmor` / `name=selinux`；缺失、未知及类似名字拒绝标记完整前提。
- 全部前提被观察到也不能证明实际容器的 LSM profile 正在强制执行。其配置及生效状态仍须实际核验。
- 验收：每项缺失负例、原始敏感输出不泄漏、固定只读命令、超时/输出上限、始终不授予执行能力。

## 1. 获准 Ubuntu 主机上的无害诊断

依赖阶段 0 和操作员核验具体容器的 UID/GID 映射、seccomp/LSM、可写 cgroup 子树委派。
现有 Compose 不制造这些条件。保持私有 namespace，不挂整个宿主 cgroup、Docker socket 或宿主 bus，
不启用 privileged、不关闭安全策略；不满足则记录 unsupported，不能用增权兜底。

验收：审核且固定镜像 digest、完整依赖缓存；构建与启动证据；容器 systemd PID1、私有 bus；
固定 sleep 超时后读取实际单元/ControlGroup 状态。提交后的未知状态保留并人工核对，不自动重试。
此阶段不接用户文档，即使成功也不能宣布四格式隔离可用。

## 2. 受限运行时准入（仍保持生产关闭）

- 给可信来源的只读 rootfs、可执行文件、工具链和格式适配器定义不可由调用方自由填写的审核清单。
- 实现与身份、tenant/file/context、租约时效、完整输入、资源配额绑定的准入证据；
  `BoundInput` 的内容与身份相等不替代认证、授权或防重放。
- 对清单变更、过期、错租户、错误 boot/attempt、伪造报告、未知能力和重复提交逐项负例。
- 未完成来源校验及复核前不得添加生产 `ApprovedRuntime` 构造路径。

## 3. 可信调度与失效恢复

依赖阶段 2。连接经过认证的控制面与容器私有 broker，持久化提交/回执/隔离状态。
先验收拒绝路径，再允许固定审核 runtime 的受限调用。
验收撤权、取消、重复请求、断连、broker SIGKILL、容器重启、未知提交结果；
只有实际子进程/cgroup 清空才释放容量，不以 JobRemoved 成功代替清理证明。

## 4. 四格式与持久保存

依赖阶段 3。分别接通 DOCX/XLSX/PPTX/PDF 的输入→编辑→显式保存→重开→导出。
通过可信保存服务写持久卷/对象存储，不把临时容器层当用户文件存储。
验收并发保存/重试、跨用户/跨租户拒绝、资源耗尽、网络禁止、宿主与broker数据不可访问、
重启后文件可读及版本一致。每种格式单列结果，不以后台单测替代前端真实业务验收。

## 5. 部署整合与发布门禁

业务 API、worker、DB、队列、存储和受限文档 runtime 均在容器内。
现有 #143 仅 Web/DB/setup 基线，不能作为全依赖完成版。
验证华为源完整下载及锁校验、干净机器 build/up、迁移和备份恢复、HTTP显式开发配置与生产TLS边界。
最终按精确提交/镜像 digest 复核，不覆盖外部写入；生产启用需独立安全复审与明确发布决定。
