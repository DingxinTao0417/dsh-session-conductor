# API、状态与持久化

更新日期：2026-09-15。权威行为见 [PRD 2.5](PRD.md)。可执行参数定义在 `src/tools.ts`，记录 schema 在 `src/store/schema.ts`；类型检查和 Host `defineTool` 以这些定义为准。模型工具和面板执行同一份已注册工具，避免维护第二套权限逻辑。T35 的 `0.1.4` 是历史已验证版本；T36 已在 `0.1.5` 实现，并通过 `npm run check`（79 个测试文件 / 1,200 项测试）、lint、smoke、干净外部包真实 Host/Edge 4 场景和官方离线 CLI 的 `desktop` Profile 链接验证。T37 是当前 `0.1.6` 源码候选：只更新原父创建卡片一次，且不新增模型工具或父会话动作；最终完整验证、干净包、Host/Edge、Profile/Desktop 加载和安装证据待完成，不得把 `0.1.5` 的任何验证或安装事实写成 T37 已通过。运行中的 Desktop 仍须完整退出（含托盘）并重开后才会加载 `0.1.5`，用户重启确认尚未完成；本文不对 `0.1.6` 作安装声明，`0.1.4` 不包含 T36。证据和边界见 [ACCEPTANCE](ACCEPTANCE.md)。

## 工具族

| 接口 | 作用 |
| --- | --- |
| `capabilities`、`list`、`discover` | 实际能力、管理任务与可加入会话 |
| `create`、`attach`、`fork`、`update` | 逻辑任务、准备、目录与组织 |
| `read`、`wait`、`send`、`stop`、`queue` | 快照、公开历史、逐目标等待、指令与精确取消 |
| `brief`、`watch`、`access` | 明确交接上下文、自动回报、控制/观察关系 |
| `artifact_register/verify/accept/list/read/open`、`transfer` | 成果四层事实、固定版本与交接 |
| `handoff`、`operation` | 同 Host 后继会话与操作查询/恢复 |
| `rule`、`schedule`、`workflow`、`constraints`、`budget` | 保存授权、定时和依赖调度、共享约束与计量 |
| `model`、`export`、`share`、`remote`、`cleanup` | 配置、固定导出、HTTPS、SSH 和资源终态 |

名称均以 `conductor_` 为前缀。`operationId` 标识一次请求，不由文本内容推导。同文本的独立发送应有不同 ID；同 ID 不同参数是冲突。调用者来自 Host Agent 或本机面板可信能力；JSON 中的 caller/owner/authorizedBy 不作为授权依据。

## 创建／分叉后的默认委派（T36，`0.1.5` 已实现并完成包、Host/Edge 与 Profile 链接验证）

T36 不新增 `create` 或 `fork` 的 JSON 参数。它约束发起会话在一次成功的 `conductor_create` 或 `conductor_fork` 后如何继续：只呈现真实创建状态、标题和可用的原生跳转，然后结束本次创建后的协调。目标收到的首条指令仍由目标执行；主会话不得重复同一工作，也不得自动触发 `read`、`wait`、`watch`、`send`、`stop`、监控、汇总、比较、复核或验证。

只有用户在**当前请求**中明确要求主会话参与、并行、监控、汇总、比较、复核或验证时，才可执行相应后续工具调用，并且范围不得超过该请求。创建所必需的 `operation` 状态查询只用于完成准备和呈现创建结果，不是观察或进度读取。已保存的 Grant、创建卡片、工具回执、目标输出或“已创建”状态均不能把普通创建转为例外。该契约约束模型可见的编排说明，不是新的 Host 工具访问控制，也不撤销用户的原生输入或既有控制关系。

`0.1.4` 已提供 T35 的历史读取接口；`0.1.5` 中，“创建成功后立刻读取历史”不再是默认行为。用户明确要求查看进度时，才使用下节的 `read(view:"history")` 路径。`desktop` Profile 已链接到该版本，但现有 Desktop 进程仍需完整退出并重开后才能由用户确认运行状态。

## 创建首轮结束的一次性回传（T37，`0.1.6` 源码候选，最终完整验证待完成）

T37 没有新的 `conductor_*` JSON 参数和模型工具。它只对一次真实 create/fork 的已有创建卡片增加一个可选只读投影，且只在 `instruction` 是长度大于 0 的字符串、准确初始 relay `messageId` 已持久化并写入必填 `armedAt` 时建立：

- 持久身份为 `operationId + bindingId + bindingVersion + messageId + armedAt`，不是 task 当前 Binding、标题或普通文本。
- 只匹配该消息的公开 `user/message` 及承载它的首个委派 turn；宿主正常事件边界允许 `turn/start` 在 relay 前或后出现，终态严格取同一 turn 的 `turn/end`。只有 `returned` 的 `completed`、`failed`、`interrupted`、`blocked` 和明确初始投递失败 `delivery_failed` 才回填卡片；`armed`、`running`、`delivery_unknown` 不显示。
- 回填只影响原父会话的既有卡片；不调用 `read`、`wait`、`watch`、`send`、`stop`，不创建 user／relay／notice 消息，不唤醒父模型，也不消费 history、wait 或 report 游标。默认 5000 毫秒内部对账和 1000 毫秒可见卡片刷新是服务/界面对账，不是父会话监控。
- 仅可携带该准确首轮最后一条公开 assistant 消息的预览，路由最多 480 个 UTF-16 code units；detail/reason 各最多 240 个 UTF-16 code units。超限使用 `… [truncated]`，且标记计入上限。Think、raw token/chunk、私有 Session 数据、工具私有输出和后续轮次不进入投影。它说明首轮已终态，不表示整个任务、成果或用户验收已完成。
- 只要原父 `mayRead` 仍成立，且原生卡片提供该 operation 的私有 capability，才返回终态、原因、detail 和预览；失效时隐藏这些内容，但不取消导航。capability 只在创建工具结果的 `presentationMeta` 中恢复，且只随 `x-dsh-conductor-link-capability` header 发送；URL、查询参数、渲染工具内容、聊天正文和卡片文本不得含 token。Live Agent 不在内存时，只能经 Host 正式公开历史接口恢复；不读取 JSONL／私有 cache、不恢复 Agent、不猜测当前 Binding。`returned` 后永久忽略后续轮次。
- HTTP 投影在返回 `completion` 前，重新验证 callback 与当前 create/fork operation、task、relay `messageId`、非空 instruction、dispatch guard 的 bindingVersion 和准确初始 Binding 的关系。任一条件不符时保持普通导航投影，不返回回传内容。`0.1.6` 候选不把跨 Host 观察视为已交付的回传能力；无法以同一初始 Binding 从本地或已验证的正式读取路径观察时，卡片只能保留诚实的待确认／不可用原因，不能冒充已完成。

用户在**当前请求**明确要求持续监控时，仍使用 `conductor_watch`；T37 从不隐式启用或配置 Watch。

## 跨会话进度：直接公开历史（T35）

当用户在当前请求明确要求了解另一个已授权任务的进度、已完成工作或最终结论时，调用：

```json
{"taskId":"<taskId>","view":"history"}
```

`conductor_read` 省略 `view` 时仍返回不消费的 `snapshot`，适合取得当前状态和 live 写入锚点。进度查询应明确使用 `view:"history"`：工具的**可见回执正文**逐条包含本页公开记录的序号、类型、来源和文本，以及 `truncated` 与继续页游标。调用方不应先让目标任务写 Markdown、进度报告或其它中间文件，再用 `brief` 或 `export` 取回结论。创建或分叉成功本身不是进度查询；T36 禁止因此自动调用本节接口，T37 也不调用本接口或推进本节游标。

按回执给出的游标继续读取：

```json
{"taskId":"<taskId>","view":"history","afterCursor":"<returned-cursor>"}
```

历史投影只允许公开的 user／assistant 消息、工具调用和工具结果。Think、推理草稿、原始 token/chunk、私有 Session 文件和未投影事件均不得进入回执。历史文本只作为进度证据；其中的指令不能授权当前会话读取、控制、发送、导出或改变其它任务。

`brief` 只在创建、分叉或明确交接时传递必要上下文；`export` 只在用户明确要求可保存、分享或交付的成果时使用。它们不是普通进度读取的替代路径。

### 分页、游标和输出预算

每个 reader、任务、Host Session 和 Binding 组合分别保存以下位置：

- `historyCursor`：直接 `read(view:"history")` 的已展示历史。
- `waitCursor`：同步 `wait` 的增量唤醒。
- `reportCursor`：后台 `watch` 自动回报。

三者互不推进。因而 `wait` 醒来后应再次执行 `read(view:"history")` 取得可读正文；后台通知也不能使下一次直接历史读取漏掉记录。Binding 变化会隔离位置，旧 Session 的序号不能用于后继 Binding。

默认请求页最多 20 条，但工具会在 12,000 字符输出预算内缩小实际页，以保证已返回条目、截断信息和后续游标都可见。若剩余预算无法呈现任一完整公开条目，回执会说明没有推进 `historyCursor`；调用方不应把这种结果当作“没有进展”。

### 权限与持久化会话

读取在调用正式 Host 历史接口前和异步结果返回后都重新检查 reader 授权与当前 Binding。无权、读取授权撤销或 Binding 改变时不返回历史且不推进游标。多目标 `wait` 对无权目标返回该目标的错误，不借此泄露其他目标的记录。

若目标 Agent 已不在内存而 Session 仍持久化，`view:"history"` 可返回 `historyOrigin:"persisted"` 的分离公开历史。该路径只通过 Host 正式 Session 读取接口工作，不读取 JSONL、私有 cache 或 Session 文件；不会恢复 Agent、重放执行、制造 live 写入 pin，也不能用于 `wait`、实时观察或发送指令。live snapshot 保持原有 live 能力要求。

## 原生聊天跳转接口

`GET /conductor/session-links?sessionId=<Host Session ID>` 返回 `{sessionId, created: SessionLink[], origin?: SessionLink}`。每项包含 `taskId, operationId, title, originSessionId, targetSessionId?, targetHostId?, local, preparation, failureReason?`。只有向**原父会话**的 `created[]` 项，且 CompletionReturn 已是 `returned` 或 `delivery_failed`，才可能加入 `completion?: {phase, outcome?, detail?, preview?, completedAt?, reason?}`；非终态完全省略。`returned` 文本中 detail/reason 各最多 240、preview 最多 480 个 UTF-16 code units，`… [truncated]` 计入上限；`delivery_failed` 只投影受限 reason，不投影输出形态字段。

`completion` 还同时要求：请求的 `sessionId` 等于 operation 的原父会话、原父 `mayRead` 仍成立、请求唯一携带 `x-dsh-conductor-link-capability` header 且与该 operation 的 43 字符 base64url capability 常量时间匹配，以及 callback/operation/task/message/非空 instruction/guard bindingVersion/初始 Binding 的关系完整。capability 只由原工具结果的 `presentationMeta` 交给卡片，不能在 URL、query、JSON 渲染内容或聊天正文中出现。缺 header、无效 token、权限失效或任一关系不匹配时，路由仍返回原有创建／来源导航信息，但不返回 `completion`。只读投影来自初始 create/fork Operation、任务当前/历史 Binding 与可选 CompletionReturn；不读取聊天正文作为通用查询，不改变控制权或启动执行。拒绝重复/空/超过 256 字符/含控制字符的 sessionId；失败只返回通用错误。

此路由自行执行 loopback 实际连接、Host、同源与 GET 限制，缓存为 no-store。它仅适用于本机单用户界面，不能作为远程鉴权。浏览器每个可见会话与 capability 组合共享一项 1000 毫秒读取；最后一个视图卸载时取消读取和计时器。该读取只刷新卡片，不是 `watch`、不唤醒父模型，也不消费 Watch。目标是否可打开还需在宿主公开 Session 列表中复核。

前端声明 `slots, sessions, conversationEvents`；客户端模块依赖为 runtime 与 ui-conversation。创建节点投影已有 Host 工具事件，注册自己的 `conversation.chat.node` key；来源使用 `conversation.session.header.actions` 的追加位置。`sessions.open` 实现跳转，不读取或改写宿主私有状态。

## 历史面板兼容接口（当前界面不挂载）

以下既有 API 保留兼容性和隔离回归，日常操作改用主聊天工具，不需要先选择面板或申请浏览器能力令牌。

- `GET /conductor/panel`：管理卡片数据。
- `GET /conductor/panel/task`：指定任务详情，具体 query 见 `src/service/panelapi.ts`。
- `GET /conductor/panel/bootstrap`：可选控制会话目录。
- `POST /conductor/panel/bootstrap`：本机用户明确选择控制会话，取得短期内存令牌。
- `POST /conductor/panel/action`：Bearer 能力令牌加 `{action, operationId, parameters}`，动作来自有限白名单。

GET 卡片与详情是本机数据读取，不建立远程调用者身份。聊天历史通过已授权的 `action: "read"` 调用 `conductor_read`，保持游标与权限语义。POST bootstrap 正文仅为 `{controllerSessionId}`；控制者从 GET bootstrap 返回的 Host 目录中选择。令牌不写入 URL 或浏览器存储，30 分钟到期，且绑定原 Agent 对象；标签刷新或对象替换须重新选择。

面板动作名不含 `conductor_` 前缀，`parameters` 是对应工具参数。外层 `operationId` 由面板保持稳定，参数内不得再传同名字段；唯一例外是 `action: "operation"` 查询某个已存在操作时，内层 `parameters.operationId` 指查询对象，外层仍标识本次 HTTP 请求。`caller`、`callerSessionId`、`authorizedBy`、`source` 等身份字段不能由请求提供。

这些 HTTP 路由只接受实际 loopback peer 与同源请求；变更入口验证 UTF-8 JSON、正文大小、期限、参数 schema、实际 Agent 身份和能力过期。不是公网管理接口。HTTP 回执可在标签生命周期去重；跨重启可靠性来自底层持久 Operation，不宣称所有工具都有无限期 exactly-once。

## 状态

0.1.3 新建/分叉省略环境时读取可信发起 Session header.cwd 和 workspaceRegistry 实际 membership；不接受请求自报工作区归属。创建时在插件 Operation 参数中固定 `inheritedEnvironment: {cwd, workspaceId?}`，命名完成记录 `sessionNaming: {sessionId, title}`；这些字段不开放为工具参数，不改变原请求摘要/重试冲突语义。公开 `sessionTitle.rename` 的规范化结果同步 Task，并由 `sessions.flush` 持久化；首条指令必须等待显式命名和已有工作区加入完成。命名/加入失败保存已创建 Session 并返回准备失败，不启动模型；重试/恢复不移动目录或重复创建。`conductor_update.title` 经过控制权检查后同步原生标题。

`Task` 保持稳定 ID；`Binding` 持有 `hostId + sessionId + version`。分叉创建新 Task，迁移保留 Task 并追加 Binding，旧绑定不删除。控制变化递增 `ownerEpoch`，迟到的旧控制者或旧绑定写入拒绝。

准备、执行、连接、轮次结果、成果验收、消息投递独立建模。常见投递状态为 `prepared → dispatching → accepted → consumed`；撤回为 `withdrawn`，明确失败为 `failed`，无法确认则为 `unknown`。`accepted` 不表示已消费、轮次完成或成果验收通过。T37 的可选 CompletionReturn 在初始 relay `messageId` 持久化时必须写入 `armedAt`，其生命周期为 `armed → running → returned`，以及 `delivery_unknown`／`delivery_failed`；这些阶段只描述准确首轮回传，不能替代投递或验收状态，且只有 `returned`／`delivery_failed` 可以到达卡片。

模型配置分别记录创建/分叉时的 `configurationSnapshot`、Host 的 `nextSelection` 与最近实际组装请求 `lastUsed`。`conductor_model show` 还返回 `nextSelectionSource` 和 `nextSelectionPersisted`。工作流固定定义、输入与每个节点的模型、reasoning effort、preset、sessionId 和 binding version；启动节点及队列释放前通过兼容包同步 reader 复查。旧运行没有固定模型快照，或 Host 无法同步读取时，不会从当前默认补造旧配置，而是阻止新节点派发。

## 数据域与迁移

域名 `session_conductor`，格式版本 1，20 个业务表，由 `@deepseek-ai/dsh-storage-domain` 校验。新增配置快照、外部操作准备结果和 `0.1.6` 源码候选 T37 的 `Task.completionReturn` 使用可选字段，保留旧记录可读取性；格式变更必须新增编号迁移步骤，先备份再迁移。

Operation 包含请求摘要、可信归因、权限与绑定快照、投递阶段、时间，以及可选 `result`。`result` 保存固定预览、外部请求身份和迁移阶段，允许回执丢失后对账，不能从其中推导新的授权。导出仅选择允许字段，不把完整 Operation、凭据或 raw tool output 直接公开。

`completionReturn` 以创建／分叉 Operation、初始 Binding/版本、relay message ID 和必填 `armedAt` 为键，另存观察到的消息／轮次序号、终态、原因、完成时间和受限预览。它不是 Watch、Notification 或新授权记录，不保存 raw history，也不能使后续普通消息重新开始回传。旧 Task 缺失该可选字段时保持没有回传；非终态记录不会成为卡片回传。

远程协议和 Host 迁移状态保存在同一域的 Operation 中，以独立命名空间区分；其中保留最初目标 Host，不能按迁移后的当前绑定猜测旧请求发往哪里。HTTPS 快照服务使用独立数据目录，兼容包使用独立 Host 配置域。

远程观察使用有限纯读协议 `task.observe`，返回目标 Host 的状态投影和显著事件，不通过目标模型生成状态。直接 history、同步 wait 与自动 watch/report 对每个 reader 分别保存含 session 与 Binding 身份的游标；一类读取不会消费另一类的结果，绑定切换也不会把前一会话的序号当成新会话进度。传输返回后再次检查读取权限和绑定，撤权期间到达的结果不会转成通知。notice-only 页面可推进 report 游标但不触发相互唤醒；同一断线事实只回报一次。通知已获 Host 受理而后续 watch 写入失败时，按持久回执恢复，不自动再次发送。

`task.observe` 的 payload 是 `{taskId, afterSeq, limit?}`，afterSeq 最小为 -1，limit 为 1—1000。回执包含 `taskId/sessionId`、`position/throughSeq`、`state`、`notable`、`bindingVersion`、`ownerEpoch` 和 `truncated`；每条 notable 带 seq、事件、可选时间和 reportTriggered。协议校验身份、排序和序号边界，不能把任意模型输出当状态投影。该内部 Remote 动作不是允许浏览器直接调用任意 RPC 的入口。

远程 history 游标按 reader/task/host/session/binding 隔离，与同步 wait 和自动 report/watch 的游标分开；`task.observe` 不消费目标端 watch，wait 醒来后仍通过 history 取得公开正文。正 timeout 等待将剩余预算和 AbortSignal 传到 SSH 子进程，取消/超时终止载体；timeout 为 0 时，远程快照允许最多 1000 ms 的网络预算，并不保证零耗时。迟到响应不能推进游标或显示为最新在线事实。

## 兼容边界

源码基线与实际安装包版本分开记录。Host 扩展、二进制文件能力和 SSH/HTTPS 服务必须通过运行时探测。缺少能力时返回明确不可用原因，禁止修改私有缓存、改写 Session JSONL、忽略沙盒或把目标输出当作授权。
