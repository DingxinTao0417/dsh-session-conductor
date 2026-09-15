# 原生聊天中的双向会话跳转

适用的已安装事实为本地 `0.1.5` / PRD 2.4；本文同时记录 PRD 2.5 的 T37 `0.1.6` 源码候选。用户要求的主入口为普通聊天，浮动面板不再挂载。T36 的创建后“默认委派即止”规则已在 `0.1.5` 实现，并通过 `npm run check`（79 个测试文件 / 1,200 项测试）、lint、smoke、干净外部包真实 Host/Edge E2E 与官方离线 CLI 的 `desktop` Profile 链接验证。T37 的最终完整验证、干净包、Host/Edge、Profile/Desktop 加载和安装证据仍待完成。当前运行的 Desktop 还持有旧模块图，需完整退出（含托盘）并重开后才能完成用户窗口确认；本文不对 `0.1.6` 作安装声明，`0.1.4` 不包含此行为。

## 使用行为

在主会话提出创建或分叉任务，模型调用 `conductor_create` / `conductor_fork` 后，聊天记录中出现创建卡片。准备期间显示“正在创建会话”，准备完成后显示标题及“已创建会话 / 打开会话”。点击打开进入宿主原生目标会话，继续使用该会话的原生输入框。

在 `0.1.5` 中，创建或分叉成功会是主会话本次工作的默认终点：主会话只呈现创建结果和跳转，不与目标做同一件工作，也不自动读取、等待、监控、发送、停止、汇总、比较、复核或验证。只有用户在当前请求明确要求主会话参与、并行、监控、汇总、比较、复核或验证时，才通过相应聊天工具继续；创建卡片或跳转本身从不触发这些动作。

PRD 2.5 的 T37 只为 `instruction` 为非空字符串的真实创建／分叉增加一次卡片回传：准确初始 relay `messageId` 持久化并写入 `armedAt` 后，承载该 relay 的首个委派 turn 进入终态，原父会话的**同一张**创建卡片才可更新。`returned` 的 completed、failed、interrupted、blocked 分别显示“子会话已完成本次委派并回传结果”、“子会话本次委派未能完成”、“子会话本次委派已中断”、“子会话本次委派已结束，需要处理”；明确初始投递失败的 `delivery_failed` 显示“子会话初始指令未送达”。`armed`、`running`、`delivery_unknown` 等非终态不在卡片显示。公开 assistant 预览仅来自准确首轮最后一条公开消息，路由最多 480 个 UTF-16 code units；detail/reason 各最多 240 个，超限均以 `… [truncated]`（计入上限）截断。点击“打开会话”仍只是跳转，完整内容由目标会话承载。它不产生父会话消息、不唤醒父模型，也不自动读取、等待、观察、发送、停止、汇总或验证。五秒内部对账和一秒卡片刷新都不是父会话监控；用户必须在当前请求明确要求，才以 `watch` 等工具让主会话持续跟进。

这不是“整个任务已验收”的标记，只是创建时所委派的首轮已经以 completed、failed、interrupted 或 blocked 终态结束，或初始投递被明确标记为失败。后续轮次不会改写这个回传。原父会话的 `mayRead` 不再成立时，卡片仍保留创建与跳转关系，但必须隐藏终态、原因、detail 和预览。

目标会话原生标题栏显示“由另一会话发起”，包含发起会话标题及“返回发起会话”。点击返回原会话。它只是导航，不发送指令、不转交控制权、不启动或停止任务。创建、监控、补充、工作流及成果操作继续通过普通聊天中的工具完成；其中创建后的任何后续协调必须满足 T36 的当前用户请求例外。

无法读取记录、准备失败/取消、源/目标不可用或目标位于其他 Host 时，不产生错误跳转。普通文字声称“已创建”不能生成可用卡片；加入已有任务不会虚构“由此创建”的来源。

## 实现与边界

新建/分叉默认继承发起会话的实际 cwd 和已有 workspace；主会话选择的名称在第一条指令前设置为显式原生标题，并保持不被首条消息自动命名覆盖。创建时将环境和命名阶段记录在原 Operation 的插件参数中，恢复继续原归属，避免重复创建或覆盖后续人工标题。主会话受控改名同时更新 Task 与宿主标题。明确指定目录或 worktree 时使用显式环境。原会话没有目录时明确失败，没有 workspace 时只继承目录。

- 活跃浏览器入口：`src/client-navigation.ts`，在 `tsdown.client.config.ts` 中指定。
- 服务声明：`slots, sessions, conversationEvents`；模块依赖：runtime、ui-conversation。
- 创建卡片：独立 `conductor-created-session` 节点投影已有 Host 的 tool/call、tool/result，使用 `conversation.chat.node` 的自有 key，不替换宿主工具呈现或其他插件节点。
- 返回来源：`conversation.session.header.actions` 的追加位置，不替换标题或输入。
- 数据投影：`src/service/session-links.ts` 的本机同源只读 `/conductor/session-links`；初始 Operation 的可信创建来源优先于当前控制者，Binding 决定当前目标。旧本地 Binding 保留来源返回。
- T37 候选投影：只读取 Task 可选的 CompletionReturn 记录，并且只对 `originSessionId` 等于当前父会话、原父 `mayRead` 仍成立、请求携带该 operation 的有效私有 capability 的 `created[]` 卡片返回 `completion`。capability 是工具结果 `presentationMeta` 中的 43 字符 base64url 值，卡片仅以 `x-dsh-conductor-link-capability` header 发送；URL、查询参数、渲染工具内容、聊天正文和卡片文本均不含 token。路由在投影边界重验 callback 与当前 create/fork operation、task、relay `messageId`、非空 instruction、dispatch guard 的 bindingVersion 和准确初始 Binding 的关系；任何一项不符只保留导航，不回传内容。该记录锚定 `operationId + bindingId + bindingVersion + relay messageId + armedAt`；只接受该消息所在的首个委派 turn，兼容 `turn/start` 在 relay 前或后的宿主边界顺序，并严格取同轮 `turn/end`，不按当前 Binding 或标题猜测。只有 `returned`／`delivery_failed` 可投影，非终态不返回。
- 每个可见会话和 capability 组合共享一个 1000 毫秒读取周期；卸载最后视图取消计时与读取，迟到响应不得污染下一会话。这只是原生卡片刷新，不是 `watch` 或父会话监控；后台的 5000 毫秒 T37 对账同样不唤醒父模型。
- 打开前复核宿主公开 Session 列表，调用 `sessions.open`。当前版本实现宿主会话视图导航，不宣称提供宿主未公开的操作系统新窗口 API。
- T37 候选只增加 Task 的兼容可选回传字段，不新增业务表、不写自定义 Session 事件、不改写宿主 Session 日志或私有缓存。Live Agent 不在内存时只能从 Host 正式公开历史接口恢复准确初始 relay/turn，不能读取 JSONL／私有 cache、恢复 Agent、改绑到当前 Binding 或猜测终态。历史面板源码与 API 保留用于兼容回归，未进入活跃浏览器 bundle。
- T36 改变主会话创建／分叉完成后的编排决策；T37 只在精确首轮终态时增加无模型卡片回填。两者都不改变 `sessions.open` 或 Host 导航的边界，也不提供面板。`0.1.4` 的已验证链接实现不声称已经包含这些决策。

## 验证

`tests/session-links.spec.ts` 覆盖初始来源、控制转交、后继 Binding、远程身份隔离、请求边界和读取取消。`tests/client-cordis.spec.ts` 使用真实 Cordis 严格服务上下文验证两个 slot、声明依赖及卸载。

`scripts/navigation-e2e.mjs` 启动实际安装的 Desktop 宿主和干净外部包，使用独立 Profile 与会话测试数据，在 Edge 加载完整 Harness Web 界面，不做响应替换、不调用模型。覆盖两组打开/返回、刷新和标签隔离；关闭浏览器和测试 Host 并确认端口释放。实际证据与完整回归结果见 [ACCEPTANCE](ACCEPTANCE.md)。操作系统原生窗口加载新版本仍需正常重启后确认。

T36 的 `0.1.5` 源码和本地回归已通过：`tests/create-delegation.spec.ts` 覆盖 create/fork 成功与失败回执、默认委派以及用户当前请求例外，相关 4 个文件共 61 项通过，完整 check/lint/smoke 也通过。干净包真实 Host/Edge 验证的 `.verification/navigation-2026-09-15T10-01-35-586Z/summary.json` 记录 4 个场景：两个创建结果可见地结束默认委派、仅在明确要求时读取 history、创建卡片/来源返回在刷新后正确、两标签隔离和真实 fork 的继承/返回正确；`errors` 为空、`providerCalls` 为 0、`responseInterception` 为 false，端口 53932 已释放。`desktop` Profile 已链接 `0.1.5`，但当前进程仍须完整退出并重开后由用户确认。历史 0.1.4 的链接证据不能替代这项验证。

T37 的最终独立验证最低包含：非空 initial `instruction`、relay 持久化后带 `armedAt` 的 exact relay／首轮匹配；四种 `returned` 终态文字及 `delivery_failed`；非终态不显示；detail/reason 240 与公开预览 480 UTF-16 code units（含截断标记）；父模型、父消息、工具调用和游标均无副作用；后续轮次不覆盖；原父 `mayRead` 失效隐藏；私有 capability 仅经 presentationMeta/header、不进入 URL/内容；路由拒绝 operation/task/message/非空 instruction/guard bindingVersion/初始 Binding 不匹配的回传；冷公开历史／重启恢复；刷新、多标签和原父卡片隔离；以及干净外部包、真实 Host/Edge、Profile 安装和用户完整重启后的窗口确认。现有 T33/T36 证据不能代替这些检查。
