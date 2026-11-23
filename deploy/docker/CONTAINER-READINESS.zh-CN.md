# 全容器部署目标、现状和只读预检

此文为 #143 后续实现边界，不是可启用的完整服务定义。当前应用 Compose
仅有 Web、DB、provision/admin，本地对象卷和 DOCX 前端；没有容器业务 broker、
worker 与四格式 runtime 闭环。不能通过宿主 root API/worker、privileged、
host namespace、宿主 D-Bus 或 Docker socket 填补缺口。

## 选定目标与依赖

- Ubuntu 24.04 Docker 测试宿主优先。业务 API、worker、数据库、队列、对象存储
  和受限文档 runtime 均运行在容器，不在宿主安装 API/worker 服务。
- API 和 worker 不拥有 Docker 控制权或 systemd 总线；仅消费经过鉴权、任务身份、
  epoch/取消/期限约束的 broker 协议。broker 的有限运行能力不得变成任意
  unit 属性、命令、路径或环境变量传入接口。
- systemd 是 runtime 容器 PID1，zbus 仅访问该容器私有总线。broker 控制进程
  与不可信处理单元必须具备已验收的文件、凭据、网络和 cgroup 边界。
  对外如何交付输入/回收输出及 broker/watchdog 的进程位置尚需独立实现审查，
  不以当前固定 sleep 的布局暗示已解决。
- DB owner 仅在初始化/迁移容器使用；API auth/business、worker 角色分离。
  业务网络与 runtime 网络隔离。外部 AI 出口由已有受限网关管理，不授予
  文档单元网络；无网络的诊断容器不能直接当远程 broker 服务使用。
- cgroup v2 仅委派容器自己的子树，中间层避免宿主和嵌套 systemd 争写同一根。
  从 D-Bus ControlGroup 获取实际路径，不按名称拼接。UID/GID0映射非host0，
  DynamicUser61184..65519全部可映射；保留 seccomp/LSM 和 namespace 隔离。
  Docker默认配置未必满足，失败应阻断，不修改daemon、不挂整个宿主cgroup目录。

依赖顺序：#147 固定 probe → #149 只读主机事实 → 已落地独立
document-runtime-diagnostic profile 的真实容器测试 → broker/watchdog接口与
清理/撤权/重启测试 → 逐格式处理/编辑保存回读 → 完整 Compose 接线验收。
前两步和静态 profile 绝不构成后续准入。正常 broker 的生产关闭边界不变。

## 华为依赖源

npm 默认华为且保留 lock integrity。应用/PG/队列/对象存储及Ubuntu/Rust builder
都必须先确定真实镜像来源、架构和 digest，再同步到自己的 SWR；不编造公共地址。
Ubuntu apt 使用华为镜像并保留 Ubuntu 签名验证。Rust builder 需要匹配
Cargo.lock 的完整离线缓存，目前不是已交付的公共镜像。构建依赖未全部逐项
固定之前，不声称可重现或“国内源全量可拉取”。不要静默回源或跳过校验。

## 离线配置预检

已有 Docker Compose 工具的授权环境可以只做 config 渲染；不要接 up/build：

    (
      umask 077
      private_dir=$(mktemp -d "${TMPDIR:-/tmp}/dyoffice-compose.XXXXXXXX") || exit 1
      trap 'rm -rf -- "$private_dir"' EXIT
      trap 'exit 130' INT
      trap 'exit 143' TERM HUP
      docker compose -f compose.yaml config --format json > "$private_dir/config.json" || exit 1
      python3 container-preflight.py "$private_dir/config.json"
    )

config 可能包含插值后的密钥，应保存在私有位置，不上传原文件或写入日志。
预检不调用 Docker，不访问网络，不修改配置，不启动服务；输出固定字段和服务序号，
不回显服务名、环境、镜像或路径。检查显式 host namespace、privileged、
额外capability/device、未审查安全选项、bind/继承卷及外部volume driver、
未digest固定镜像和未经验证的build。当前基线的init脚本bind和本地build也会报需审查，
不是要求删除安全配置，而是不能把通用预检当作自动豁免工具。

这是有限静态风险筛查，不是完整 Compose schema/策略解释器，也不验证声明真实性、
镜像内容、挂载来源、端口范围、资源上限或凭据权限。即使没有发现已知风险，
仍输出unsupported、execution_available=false、isolation_certified=false，退出2；
有发现则rejected，同样退出2。不能据此自动启动容器、接收文档或宣布通过。
不要通过忽略exit2把结果变成成功。

## 必须补足的实际验收

先使用独立固定无害probe检查真实PID1、私有总线、UID/GID、委派路径和单元期限；
随后验证禁止网络/敏感文件访问、CPU/内存/PID耗尽、后代清理、broker SIGKILL、
独立watchdog、容器重启后的身份与receipt恢复。任何不确定提交禁止自动重放。
最后逐一验收DOCX/XLSX/PPTX/PDF读取、编辑、显式保存、回读，以及跨用户/撤权、
取消和配额；当前PPTX/PDF或其他unsupported能力保持关闭。

本次仅提供离线预检和文档候选。没有Docker工具，未执行Compose config/build/up，
未验证真实浏览器登录、私有D-Bus单元或完整四格式链路。预检单元测试不替代这些验收。
