# SSH / IPC Remote Host

远程默认关闭。当前代码提供真实 SSH stdio 载体、用户级 IPC、有限协议、持久回执和跨 Host 迁移。Windows 双端点测试不能替代 Linux SSH 实机验收。

## 运维配置

每个 Host 使用独立 `hostId` 和本地已存在的控制会话。桥接身份来自运维配置，协议请求不能自报 `caller`。控制器必须在 Host 中存活并拥有目标任务。

```yaml
config:
  crossHostEnabled: true
  bridge:
    hostId: workstation
    controllerSessionId: <existing-local-controller-session>
    runtimeRoot: <private-absolute-runtime-directory>
    profileId: development
    workspaceRoots:
      - <allowed-absolute-workspace-root>
  remoteConnections:
    - hostId: linux-worker
      sshAlias: <existing-ssh-config-alias>
      nodePath: /usr/bin/node
      bridgePath: <installed-plugin>/lib/bridge/stdio.js
      descriptorPath: <remote-runtime-root>/conductor-ipc-development/endpoint.json
```

尖括号是必须由运维填写的占位值，不是本机已配置的连接。远端配置自己的 `bridge`、必要模型路由和 workspaceRoots。每端 capability 报告真实 plugin/protocol/model/workspace 能力；协议与插件版本须一致。

在控制会话通过 `conductor_remote register` 登记已配置的 Host，再 `enable`、`check`。注册默认禁用，工具不能指定 shell 命令或新凭据。删除注册前需处理仍绑定于该 Host 的任务。

载体执行既有 SSH alias，固定启用 `BatchMode=yes`、`StrictHostKeyChecking=yes` 和连接超时，不自动接纳 Host key。首个远端 shell 契约是 POSIX，远端入口为 Node stdio 程序。不要把此配置当成已验证的 Windows SSH shell 支持。

IPC 在 Windows 使用随机 named pipe 和受当前用户 ACL 保护的目录，在 Unix 使用 0700 目录与 0600 socket/描述符。每次启动生成临时管道凭证，只放在描述符文件，不放命令行或日志。关闭时清理本次端点；工作区和业务数据保留。

## 迁移与恢复

`conductor_remote migrate` 需要 `taskId`、目标 `hostId`、`targetWorkspace`、`historyThroughSeq`、明确 `artifactIds`、`pathMap` 和稳定的 `operationId`/`migrationId`。历史是完成前缀中的上下文数据，不包含在途响应、队列、授权或凭据。路径映射须落入目标运维允许的 workspace。

顺序为 capability → freeze → bundle → stage（禁用）→ enable → finalize。源和目标都保留阶段记录；跨 Host 不能依靠进程内锁实现 exactly-once，因此结果不确定时按原操作身份只读对账。读取、发送、停止和队列走同一目标绑定的路由，目标端仍校验当前 epoch、binding 与冻结状态。

监控经有限纯读 `task.observe` 获取目标 Host 的真实状态投影与显著事件，不要求远程模型回复状态文本。`conductor_wait` 和 watch 各自保存 reader/session 游标；重连增量读取，迁移后的 session 不沿用旧 session 序号。`watch start/report` 已接远程路径，notice-only 轮次静默推进观察游标，断线事实去重，回包后再次核验读权限与绑定。

历史读取另按 reader/task/host/session/binding 保存游标，与 wait/watch 分离。观察协议每页至多 1000 个显著事件，通过 throughSeq 分页，不消费目标端 watch。等待把剩余 deadline 与 AbortSignal 传给 SSH 载体；正超时或取消会终止子进程，timeout 0 的远程快照仍有最多 1000 ms 网络预算。迟到响应不推进游标、不报告为最新在线状态。桥接启用但恢复存储尚未就绪时，原生 pre-step 默认拒绝派发并保留 inbox。

`abort` 先在目标保存永久禁用墓碑，再凭回执恢复源。已启用的迁移不能被该动作恢复为两个活动副本。中断留下的文件和会话不自动删除。

运行依赖包括 Host 原生 pre-step veto；未挂载时工作区迁移能力不可用。源迁移完成后旧源会话仍保持记录，但插件阻止它继续执行，应打开任务的当前绑定。为保持冻结保证，不要在未完成对账时移除插件。

## 可复现验证

`tests/remote.spec.ts` 和 `tests/remote-host.spec.ts` 使用两个真实 IPC 端点、实际 Node 桥接子进程及临时文件，验证固定内容、版本、幂等、丢回执、停止闸门、目标未启用与 abort。Host Agent 和协调存储使用结构化测试替身；传输端点与子进程是真实运行。兼容矩阵另行标记 Linux 实机状态；本轮未登记实际 SSH Host、创建 SSH key 或部署远端服务。

`tests/remote-watch.integration.spec.ts` 的 3 项生产入口回归使用受控传输响应与 Host 服务替身，验证远程完成事件/游标、notice-only 静默/断线去重，以及等待回包期间撤权。`tests/watch-regression.spec.ts` 另有 3 项回归覆盖同 watch 多个合并窗口事件 ID 保留、通知受理后持久写失败不重发及读权限撤销。此处“生产入口”指真实插件入口与协调逻辑，不表示实际 SSH 链路已测。
