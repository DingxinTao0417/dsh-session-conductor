# AGENTS.md

本文件面向 DeepSeek 及其他项目实施者，规定 DSH Session Conductor 的开发协作方式。

## 1. 接手与权威文档

- 开始前阅读 [中文 README](README.zh-CN.md)、[英文 README](README.md) 和 [完整 PRD](docs/PRD.md)。
- `docs/PRD.md` 是产品行为、技术边界、默认值与验收标准的权威规格；README 是入口摘要。
- 接手时核对实际文件、候选包与验收记录；不把规格、接口设想或性能目标写成已实现事实，也不把旧进程已加载新版作为未经确认的事实。
- 核对工作目录、Git 根与工作树状态、目标文件、运行环境和端口；只检查与当前任务相关的范围。
- 用户当前指令优先；发现真实冲突时说明证据与影响，不擅自改写 PRD 消除冲突。

## 2. 开发许可与协作边界

- 在用户已授权范围内，自主完成可逆的本地调查、实现、修复和验证，不为普通实现选择重复请求确认。
- 插件运行时的 `Grant` 是产品调度授权，与开发者修改项目的许可分开；不能相互替代或扩大。
- 只有缺少会实质改变结果的关键决定、发生真实冲突或缺少权限时，才暂停依赖部分并说明原因。
- 未获当前任务明确授权，不 commit、push、merge、部署、公开发布或分享，不发送外部消息。
- 不擅自创建持久凭据、启用计费资源、登记远程连接或部署分享服务；不得将凭据写入代码、日志和文档。
- 保留用户和并行任务的修改；编辑前重新读取目标，不 reset、覆盖、暂存、移动或清理无关内容。
- 并行工作先明确文件责任，独立子任务可委派；发现同时编辑时先协调，不靠覆盖解决冲突。
- 删除前核对精确绝对路径、所属资源和引用关系，优先可恢复方式；不自动删除 worktree、分支或任务成果。

## 3. 实施顺序与宿主兼容

- 从 PRD 的 M0 开始：先验证可安装的外部插件、Host 服务、Remote/有限 HTTP 适配与原生聊天跳转的完整闭环。
- 当前交互以 PRD 2.5 / T33—T37 为准：`src/client-navigation.ts` 是构建入口，不挂载面板；默认任务继承发起会话的实际目录/已有 workspace，主会话指定的名称同步宿主显式标题。用户当前请求明确查询已授权任务进度时，优先 `conductor_read({view:"history"})`，让公开历史正文直接进入发起会话；不得为此要求目标写报告。T36 规定：成功 `create` / `fork` 后，主会话默认只呈现创建结果和跳转并停止，绝不重复目标工作，也不自动 `read`、`wait`、`watch`、`send`、`stop`、监控、汇总、比较、复核或验证；仅当用户在当前请求明确要求主会话参与、并行、监控、汇总、比较、复核或验证时才执行该范围。`0.1.6` 源码候选的 T37 是唯一窄例外：仅 create/fork 的 `instruction` 是长度大于 0 的字符串时，准确初始 relay `messageId` 持久化并写入 `armedAt` 后，承载该 relay 的首个委派 turn 终态可无模型地一次性更新原父创建卡片。它只显示 `returned` 或 `delivery_failed`，不唤醒父模型、不写父消息、不消费游标，也不自动调用任何 read/wait/watch/send/stop/summary/verify；5 秒内部对账与 1 秒卡片刷新也不是监控。持续监控仍须用户在当前请求明确要求并使用 `watch`。T36 已在 `0.1.5` 的 `src/tools.ts` 和 `tests/create-delegation.spec.ts` 中实现，并经 `npm run check`（79 文件 / 1,200 项）、lint、smoke、干净包真实 Host/Edge 4 场景和官方离线 CLI 的 `desktop` Profile 链接验证。T37 在全部当前源码变更后也已通过本地 `npm run check`（82 文件 / 1,236 项）、lint 与 smoke；官方离线 CLI 已将干净 27 文件候选（SHA-256 `6640c35d28ec9aca2254e088fd0d65e6f6b1c59b8e1048eb2bb26f4ee9a64648`）链接到本机 `desktop` Profile，收据见 `.verification/desktop-install-2026-09-15-completion-return/installation-completion-return.json`。这只证明本地 Profile 链接，不证明 GUI 已加载、真实 Host/Edge、冷/重启行为或最终完整验证；不得把用户尚未确认的窗口加载写成已完成。`0.1.4` 不包含 T36。`src/client.ts` 和 `src/client/` 是停用的历史面板实现，不作为产品入口。
- M0 必须覆盖安装后的创建、配置、分叉、发送、观察、停止与卸载；不能用宿主内部示例代替外部包验收。
- 两项 Host 兼容扩展单独管理、测试与版本化，不自动修改用户已安装的 Harness。
- 第一项为 `selectModel.rememberAsDefault?: boolean`：保持宿主默认行为，插件固定传 `false`。
- 第二项为 `fork` 的 `newSessionId?`、`workspaceId?`、`cwd?`：遵守目录互斥与同身份重试核验要求。
- 禁止通过重复安装模型选择监听器、修改私有缓存或改写 Session 日志绕过兼容扩展。
- 先探测实际能力与版本；缺少能力时禁用对应写功能并显示原因，不静默退回不同语义。
- 源码审阅基线不等于 npm 包或运行环境兼容保证；安装与集成测试必须记录实际版本。
- M0 失败先留下证据并修复兼容层，再按 M1—M6 推进；阶段 A、B、C 各自形成可安装版本。

## 4. 概念、身份与接口

- `Task` 是稳定的逻辑任务；`Session` 是宿主聊天与执行历史，二者 ID 不得混用。
- `Binding` 保存当前 `hostId + sessionId` 及版本；迁移保留 Task，分叉创建新 Task。
- `Turn` 是一次宿主执行；`Operation` 是一次可追踪请求；`Artifact` 是带来源与版本的成果。
- 环境 ready、消息受理、消息消费、轮次结束、验收通过和成果交接成功分别建模、分别回报。
- 模型工具使用 `conductor_*`，前端通过对应 Remote；两者共用授权、幂等、预算和操作服务。
- 调用者身份取自 Host 可信上下文，不能接受模型自报身份；每次真实派发前复查控制权与绑定版本。
- 保留原界面输入的用户来源；转发与后台回报分别使用插件 `relay`、`notice` 来源。
- 规则执行保存 `grantId、ruleId、sourceEventId`；来源标记不能由目标输出伪造为用户授权。

## 5. 持久化、幂等与恢复

- 业务数据使用独立 `storageDomain`；不新增自定义 Session 事件，不直接修改宿主 JSONL 或私有 cache。
- 状态投影来自宿主事实；缓存只能帮助恢复，不能独立证明任务仍在运行或已经完成。
- 修改请求保存稳定 operationId、消息 ID、参数摘要与阶段；同 ID 不同参数返回冲突。
- 同文本的独立发送不是重复操作；已撤回消息不得因重启恢复投递。
- 遵守 PRD 的持久化、查重、受理、flush 与回执顺序，针对各崩溃窗口测试。
- 投递结果无法确认时进入 `unknown` 并对账，不自动盲重发，不宣称未获证明的 exactly-once。
- T37 CompletionReturn 必须是兼容的可选 Task 字段，并在准确初始 relay `messageId` 已持久化时连同必填 `armedAt` 锚定 `operationId + bindingId + bindingVersion + messageId`。不得按当前 Binding、标题、文本或后续消息猜测首轮；`returned` 后不得被后续轮次覆盖。
- 转交使用 ownerEpoch，迁移使用绑定版本；旧控制者及旧绑定的迟到写入必须拒绝。
- schema 迁移先备份、失败不推进版本；重启先校准历史、队列和操作，再恢复监控与规则。

## 6. 发送、等待与自动行为

- 默认 `steer`，明确区分 `queue` 与 `interrupt_and_send`；补充不能承诺改变在途请求或工具。
- 精确取消须在同一 Host 临界区完成预期轮次校验与实际取消，内部不得异步让出。
- 必须通过旧轮提前结束、新轮启动等竞态测试；仅在调用处不写 await，不能证明精确取消。
- 打断发送遵守队列冲突、绑定校验及 30 秒确认期限；未确认停止时不发送后续指令。
- `wait` 对每个目标维护独立游标、错误与增量回执；单次最多 60 秒，不用一个全局游标替代。
- 直接 history、同步 wait 与后台 report/watch 必须使用相互独立、按 reader/task/session/Binding 隔离的游标；等待或自动回报不得吞掉后续直接历史。
- 历史回执只投影公开 user/assistant 消息、工具调用和工具结果；不写入或读取 Think、raw token/chunk、Session JSONL 或私有 cache。`brief` 仅用于明确交接，`export` 仅用于明确交付物。
- 读取在 I/O 前后复查授权和 Binding；低输出预算不推进不可见 history；冷持久 Session 只能经正式 Host 历史接口只读，不恢复 Agent，也不作为 live 等待或写入目标。
- 后台 `notice` 只汇报观察事实；仅由回报触发的轮次禁止协调写入，服务端实施限制。
- 回报生成器与规则执行器分离；通知、模型回复和普通任务输出不能创建授权或自行安排下一步。
- 自动动作只执行已保存且有效的 Grant；按事件去重、控制关系无环，防止跨控制者相互唤醒。
- 定时恢复只做规定的补偿，不重放全部错过周期；工作流返工不得新建运行绕过两轮上限。
- 创建／分叉操作完成所需的准备查询可以用于呈现真实创建结果；这不授权持续观察或验证目标。不得把既有 Grant、工具回执、目标输出或创建卡片视为 T36 的例外，例外只来自用户当前请求的明确措辞。
- T37 只能取该锚定消息的公开 `user/message` 和承载它的首个委派 turn；宿主正常边界允许 `turn/start` 在 relay 前或后出现，终态严格取同一轮 `turn/end`。只有 `returned`／`delivery_failed` 投影到卡片；`armed`、`running`、`delivery_unknown` 不显示。`detail`／`reason` 路由投影各最多 240 个 UTF-16 code units，公开 assistant `preview` 最多 480 个 UTF-16 code units，超限标记 `… [truncated]` 计入上限；排除 Think、raw token/chunk、私有 Session 数据、工具私有输出和后续轮次。终态投影还须逐项复核原父 `mayRead`、准确 operation/task/message/非空 instruction/dispatch guard 的 bindingVersion/初始 Binding 关系，以及仅在 `presentationMeta` 交给卡片、仅随 `x-dsh-conductor-link-capability` header 返回的私有 capability；URL、渲染内容和聊天正文不得含 token。原父 `mayRead` 失效时保留导航但隐藏回传细节；重启或冷会话只能经正式 Host 公开历史接口恢复，不得恢复 Agent、读取 JSONL／私有 cache。

## 7. 环境、成果与预算

- 新建/分叉默认继承发起会话目录与已有工作区，创建时固定归属；只有明确选择 Git 隔离时从指定起点创建独立 worktree，准备失败不得自动退回共享目录执行。
- 工作树快照不修改源目录、分支或暂存区；未跟踪文件、凭据与忽略文件按 PRD 边界处理。
- 自动依赖使用固定成果版本；区分模型声称生成、已验证存在、检查通过与用户验收。
- Patch 交接先验证基线和接收方修改；冲突停止，不自动覆盖，不隐含提交、合并或发布。
- 工作流运行固定定义、授权、约束、成果、验收与预算版本；新定义不静默改变在途节点。
- 实际、部分、估算、不可用计量分别展示；未知用量不能显示为零或宣称硬预算。
- 只有完整计量、可靠单次上界和并发预留俱全才可启用硬预算；转交、重启和返工不能清零账本。
- 跨 Host 与在线分享默认关闭；远程、服务、目录和临时进程均须有明确保留或停止状态。

## 8. 测试、文档与交付

- 每项实现标明对应 PRD T01—T37 与里程碑；未实现、未测试、已通过分别记录，不用概述代替验收。
- 缺陷修复优先复现或建立失败测试，再验证根因；运行与改动风险相称的定向、回归和差异检查。
- Host 语义使用真实集成测试，恢复与并发使用故障注入，界面使用多标签 E2E，安装生命周期单独验证。
- T37 至少测试非空 initial `instruction`、relay 持久化后带 `armedAt` 的准确消息／首轮匹配、四种 `returned` 终态文案与 `delivery_failed` 文案、非终态不显示、detail/reason 240 与 preview 480 UTF-16 code units（含 `… [truncated]`）、无父模型／消息／工具／游标副作用、后续轮次忽略、原父 `mayRead` 失效隐藏、冷历史与重启恢复、重复事件幂等、卡片 capability 不进入 URL/内容且 HTTP 投影重复验证 operation/task/message/非空 instruction/guard bindingVersion/初始 Binding 关系，以及原父卡片隔离。当前源码候选的最终完整验证、Host/Edge／包／Desktop 验证完成前，保持“最终验证待完成”状态。
- 兼容矩阵覆盖 Windows、Linux；阶段 C 增加 Linux 远程 Host。未实测的平台明确标记。
- 不为低影响文案改动堆砌测试；只在新改动、失败或未解决风险出现时扩大或重复测试。
- README 的中文与英文在状态、安装、范围、入口和限制上同步；PRD 更改同步更新相关摘要及验收记录。
- 最终报告说明修改、证据、对应验收、已知限制、运行与 Git 状态，以及保留的资源和下一步。
- 明确区分本地完成、已提交、已推送、已部署或发布；不把文档计划、源码审阅或目标指标当成运行证明。
