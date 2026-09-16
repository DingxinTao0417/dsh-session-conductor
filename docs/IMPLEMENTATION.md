# PRD 2.11 实现与验收对照

## 当前增量：0.2.6 / PRD 2.11 / T46

| 验收 | 本地实现 | 当前验证状态 |
| --- | --- | --- |
| T46 | `src/client-navigation.ts` 将可见侧栏开关注入 `conversation.session.header.utilities` 的高顺序位置，使其紧跟 `Session log`；actions 插槽只保留零尺寸 `WorkspacePreview` 锚点。`src/client-overview.ts` 将宽屏概览卡改为主会话 owner 正常文档流中的右对齐元素，移除绝对定位与右侧 padding，使聊天滚动区保持完整宽度；窄屏继续按实际高度占位，标题过长时沿用概览顶部回退入口。 | 全量 `npm run check`（97 个测试文件 / 1,407 项）、lint 和三类 smoke 已通过，`scripts/smoke-client.mjs` 已同步校验 utilities 插槽；1920×1000 隔离 Desktop Host/browser 验证 Session log 右侧开关、概览右对齐、聊天滚动区全宽和滚动条位于主界面最右侧，证据 `.verification/overview-2026-09-16T03-03-28-659Z/layout-t46-installed-verification.json`。0.2.6 候选包已封存并通过官方离线 CLI 安装到本机 desktop Profile，收据 `.verification/desktop-install-2026-09-15-t46/installation-t46.json`；用户完整退出并重开 Desktop 后的实际窗口加载仍待确认。 |

## 历史增量：0.2.5 / PRD 2.10 / T45

| 验收 | 本地实现 | 当前验证状态 |
| --- | --- | --- |
| T45 | `src/client-workspace-layout.ts` 在公共 header slot 的会话容器旁挂载插件自有 workspace surface；宽屏按会话可用宽度（不含左侧导航）计算约 70% 工作区 / 30% 聊天，保留 300/320 CSS px 最小值，支持分隔条指针拖动、左右方向键、Home 复位和手动比例记忆；小于 740 CSS px 时将同一内容移至避开 `#root` 顶栏的全宽 drawer。`src/client-preview.ts` 管理 surface 与原生 details 回退的互斥生命周期；`src/client-native-pane.ts` 只读观察 Desktop 2.0.3 已验证的三轨 DOM 结构，在原生详情真实可见时发布状态。`src/client-overview.ts` 根据自有或原生实际可见状态隐藏/恢复概览卡。 | 97 个测试文件 / 1,407 项测试、typecheck/build/lint/smoke 通过；隔离 Desktop 2.0.3 Host/browser 已验证 1920×1000（1,148/1,640px）、1280×900（680/1,000px）和 390×844 drawer（390×808、top36）及资源切换、键盘、原生详情恢复、切会话清理。0.2.5 候选包已封存并通过官方离线 CLI 链接到本机 `desktop` Profile；用户完整退出 Desktop 后的实际窗口加载仍待确认，详见 DESKTOP-TRYOUT。 |

## 历史增量：0.2.4 / PRD 2.9 / T44

| 验收 | 本地实现 | 当前验证状态 |
| --- | --- | --- |
| T44 | `src/client-subagents-data.ts` 从正式 `sessions.list` 目录和 `refreshSubagents(parentId)` 建立按父会话隔离、共享 5 秒刷新租约的只读投影；`src/client-subagents.ts`、`src/client-overview.ts`、`src/client-preview.ts` 与 `src/client-navigation.ts` 接入常驻概览和临时原生 details 侧栏。健康条目在再次核验直系目录及 `mode` 后调用 `openSubagent`。 | 95 文件 / 1,386 项测试、typecheck/build/lint/smoke 与真实 Host/browser QA 通过；候选包已核验，本机 Profile 已安装；实际窗口重开确认仍待完成，详见 DESKTOP-TRYOUT。`client-subagents-data.spec.ts`、`client-subagents-ui.spec.ts` 与预览回归覆盖目录、分组、分页、生命周期和导航。 |

T44 与 Conductor 的“委派任务”是两个分区：只列出当前会话的直系原生子智能体，不递归任务树，也不按标题猜关系。目录把 `running` 显示为“运行中”，把 `inactive` 显示为“已结束 / 空闲”，记录损坏、父目录不可用或宿主能力缺失时单列不可用状态；这些状态和 `SessionSummary.completed` 未读提醒都不能称为成功完成。累计时间仅取正式 `subagentTiming`，没有数据即不显示。右侧每组首屏 10 条、后续每次增加 30 条，计数基于完整目录。目录视图不读取子会话历史、私有缓存或 Session 日志，不恢复 Agent，不启动模型、不发送消息，也不安排模型监控。0.2.5 将其右侧呈现改由插件自有宽工作区承载，保留原生子会话跳转语义。

## 历史增量：0.2.0 / PRD 2.6

| 验收 | 实现 | 验证 |
| --- | --- | --- |
| T38 | src/client-overview.ts、src/client-navigation.ts；原生插槽、宿主主题/图标、默认收起、分区展开和焦点恢复 | client-cordis.spec.ts；真实 Host 浏览器及 design-qa.md |
| T39 | store/schema.ts、service/coordinator.ts、service/followup-returns.ts、service/completion-return.ts | overview.spec.ts、followup-returns.integration.spec.ts、既有首次回传测试；两轮真实 Host 离线执行 |
| T40 | service/overview.ts、overview-client-data.ts、既有 panel-controller 与共享工具；精确结果/已读路由和按钮调用 | overview.spec.ts、overview-client.spec.ts、既有 panel-actions.integration.spec.ts；实际模板创建/监控开关 |
| T41 | overview-client-data.ts 公开资源投影，service/overview.ts 成果/目录投影 | overview-client.spec.ts、overview.spec.ts；真实来源与登记成果界面 |

以下 `0.2.0` 验证快照为 85 文件 / 1,254 项测试，lint 和 smoke 通过；当时只做本地实现与隔离验证，正式 Desktop Profile 未升级。它不构成 `0.2.4 / T44` 的验证或安装证据。已实现范围与后续路线见 [概览规格](CONVERSATION-OVERVIEW.md)。下文保留历史映射和证据层级。

此文件保留 [PRD](PRD.md) 2.5—2.9 的历史映射，并补充 2.10 / T45。2.1 更新交互并增加 T33，2.2 更新默认环境及命名并增加 T34，2.3 增加直接公开历史进度读取 T35，2.4 增加创建／分叉后的默认委派即止 T36，2.5 新增创建首轮结束的一次性卡片回传 T37；其余业务要求不变。更新日期为 2026-09-15，原始运行证据另保留 UTC 时间。实现与实机验收分别记录；“有实现”不等于所有平台已验收。T45 的源码、隔离 Host/browser、候选包和 Profile 安装证据列在本文件顶部及 ACCEPTANCE/DESKTOP-TRYOUT；用户窗口重开仍待确认。

## 本轮补齐范围

- 原生聊天双向跳转：`src/client-navigation.ts` 为构建入口，注册独立创建节点及追加来源栏。`src/service/session-links.ts` 从初始创建操作和绑定读取关系。操作继续通过聊天工具执行，不挂载面板；历史面板源码/API 保留用于兼容回归。
- 直接公开历史进度读取（T35）：`src/tools.ts` 将 `read(view:"history")` 的公开记录正文写入模型可见回执；`src/service/observer.ts`、`src/service/projection.ts`、`src/store/schema.ts` 与 `src/index.ts` 分离 history/wait/report 游标、复查 reader 权限，并在 Agent 不 live 时经正式 Session 查询读取持久历史，不恢复 Agent。`brief/export` 不再是进度读取的前置路径。`npm run check`、lint、smoke、干净包真实 Host/Edge 与 Desktop Profile 安装证据见 [ACCEPTANCE](ACCEPTANCE.md)。
- 创建／分叉后的默认委派即止（T36）：`src/tools.ts` 已更新 create/fork 的模型可见回执与相关工具说明。成功回执先说明创建／分叉，再说明主会话默认报告创建并停止；不重复业务，也不自动 `read`、`wait`、`watch`、`send`、`stop` 或 artifact verify。失败回执同样不诱导自动后续动作。例外仅限用户当前请求明确要求主会话参与、并行、监控、汇总、比较、复核或验证；这是模型编排契约，不是新的 Host 工具访问控制。`tests/create-delegation.spec.ts` 的 6 项与相关 4 个测试文件共 61 项通过；全量 `npm run check`（79 文件 / 1,200 项）、lint、smoke、干净包真实 Host/Edge 4 场景与 `desktop` Profile 链接通过。当前只剩用户在完整退出并重开 Desktop 后的窗口确认。
- 创建首轮结束的一次性回传（T37，`0.1.6` 源码候选，最终完整验证待完成）：`src/service/coordinator.ts` 仅对非空 `instruction` 的 create/fork，在准确初始 relay `messageId` 持久化后连同必填 `armedAt` arm；`src/service/completion-return.ts` 从公开事件找出 relay 所在的首个委派 turn，兼容 `turn/start` 在 relay 前后出现，并严格采用同一 turn 的 `turn/end`。`src/index.ts` 的内部 pass 只对这条初始 Binding/message 对账，`src/service/session-links.ts` 在 HTTP 投影边界重新校验 callback 与当前 operation/task/message、非空 instruction、dispatch guard 的 bindingVersion 和准确初始 Binding 的关系；失败时只保留导航，不投影回传。投影还要求原父 `mayRead` 和私有 capability；capability 只经工具结果 `presentationMeta` 进入卡片，并仅随 header 返回，绝不进入 URL 或渲染内容。`src/client-navigation.ts` 只更新既有创建卡片，非终态不显示；`returned`／`delivery_failed` 才可回填。它不是 Watch：不唤醒父模型、不写父消息、不调用或消费 `read`／`wait`／`watch`／`send`／`stop`，后续轮次不参与；5 秒内部 pass 与 1 秒卡片刷新均不是父会话监控。全部当前源码变更后的本地 `npm run check`（82 文件 / 1,236 项）、lint 与 smoke 已通过，且官方离线 CLI 已将干净 27 文件候选链接到本机 `desktop` Profile。该安装记录只证明 Profile 链接；最终验证仍须在真实 Host/Edge、冷历史／重启和完整 Desktop 重启/加载中覆盖精确匹配、终态文案、240/480 UTF-16 截断、权限、幂等、绑定投影和无父会话副作用，不能把本地源码或链接结果写成这些完成。
- 原生子智能体概览（T44，`0.2.4` 历史实现）：`src/client-subagents-data.ts` 只从正式目录投影当前父会话的直系子智能体，并为同一父会话的多个挂载共享刷新租约；`src/client-subagents.ts` 显示运行中、已结束 / 空闲和不可用分组，首屏 10 条、每次“再显示”30 条，累计时间仅来自 `subagentTiming`。`src/client-overview.ts` 提供概览入口，`src/client-preview.ts` 复用临时原生 details 侧栏，`src/client-navigation.ts` 在切会话或卸载时释放状态。每次跳转都重新确认目录归属和 `mode`，再调用 `openSubagent({ parentSessionId, childSessionId, mode })`。目录读取不触及历史、Agent、私有缓存、模型、消息或模型监控；`inactive` 与未读 completed 都不是成功结论。源码、真实 Host/browser、候选包和 Profile 安装证据见 ACCEPTANCE/DESKTOP-TRYOUT；0.2.5 将右侧呈现迁移到自有宽工作区。
- Codex 类宽工作区（T45，`0.2.5`）：`src/client-workspace-layout.ts` 在公共 header slot 旁挂载插件自有 surface，宽屏按会话可用宽度计算约 70/30，保留 300/320 CSS px 最小值，支持拖动、方向键、Home 和手动比例记忆，窄屏切换为避开 Desktop 顶栏的全宽 drawer。`src/client-preview.ts` 在自有 surface 与原生 details 回退之间维护互斥注册；`src/client-native-pane.ts` 只读观察 Desktop 2.0.3 已验证结构，`src/client-overview.ts` 在自有或原生详情真实可见时隐藏概览并在关闭后恢复。97 个测试文件 / 1,407 项测试、typecheck/build/lint/smoke、隔离 Host/browser QA 和 0.2.5 官方离线 Profile 安装均已通过；用户完整退出并重开 Desktop 后的实际加载确认仍待完成。
- 独立 Host 兼容包：模型设置不写全局默认、下次请求配置可读且持久；指定分叉身份、目录与 workspace，核验幂等参数；创建、分叉和工作流固定配置。
- 定时计划修改：保留原创建时间、运行记录、已消耗次数和暂停状态；修改时撤回尚未派发的旧指令。
- 同 Host 迁移：持久异步操作回执、稳定后继身份、已提交绑定对账；持久化未确认时停止迁移。
- SSH/IPC：用户级私有管道、有限协议、真实传输、原 Host 路由对账、源冻结、固定传输清单、目标禁用准备、启用与源绑定提交、目标墓碑与源安全恢复。
- HTTPS 分享：固定预览、SHA-256 内容摘要、选定附件、服务端认证、幂等上传、撤销、到期与重启恢复；服务与连接仍默认关闭。
- 交付文档：使用、API、schema、升级恢复、演示、验收矩阵，以及本地候选包。

## T01—T37 历史映射

| 编号 | 实现位置与自动化证据 | 本轮验证范围与剩余条件 |
| --- | --- | --- |
| T01 | `coordinator.ts`；`coordinator.spec.ts`、`panel-actions.integration.spec.ts` | 创建/加入实现；隔离真实 Host 创建、Edge 操作闭环；自然语言效果取决于所选模型 |
| T02 | `coordinator.operation.spec.ts`、`entry-lifecycle.spec.ts` | 异步准备、重试、取消、失败恢复；未将 ready 当作任务完成 |
| T03 | `brief.spec.ts`、`coordinator.context.spec.ts` | 交接摘要、来源、约束与固定截止位置 |
| T04 | `fork.spec.ts`；独立兼容包 `verify:host` | 完成轮次前缀、队列排除、固定 cutoff、并发同身份分叉 |
| T05 | `coordinator.workspace.spec.ts`、`git.integration.spec.ts`；兼容包 Host 探针 | 新 worktree、目录与 workspace 归属 |
| T06 | `modelconfig.spec.ts`、`model-creation.spec.ts`、`workflow-model.spec.ts`；兼容包 Host 探针 | 创建默认快照、源 pending 继承、工作流派发前复查、后续请求生效、重启与全局默认不变 |
| T07 | `git.snapshot.spec.ts`、`git.integration.spec.ts` | 固定 Git 起点、已暂存/未暂存区分、源目录保护；二进制写依赖独立扩展能力 |
| T08 | `coordinator.spec.ts`、`coordination.audit.spec.ts` | steer/queue、消费边界与持久回执 |
| T09 | `stop.spec.ts`、`coordination.audit.spec.ts` | 原子预期轮次校验、旧轮/新轮竞态 |
| T10 | `coordinator.spec.ts`、`coordination.audit.spec.ts` | 打断发送冲突、超时保留文本、绑定变化 |
| T11 | `panel-actions.integration.spec.ts`；Edge 多标签 | 主入口与目标窗口独立输入，user/relay 来源保留 |
| T12 | `observer.spec.ts`、`observer.release.spec.ts`、`remote-watch.integration.spec.ts` | 独立 reader + session 游标、任一目标唤醒、单目标错误；远程通过有限纯读 `task.observe` 取得 Host projection/notable |
| T13 | `entry-lifecycle.spec.ts`；Edge 关闭标签场景 | 浏览器关闭不停止 Host 后台调度；Host 退出需重启恢复 |
| T14 | `state.spec.ts`、`read-snapshot.spec.ts`、`panel.spec.ts` | 待输入/审批状态、未代答、未误标完成 |
| T15 | `taskfilter.spec.ts`、`list-page.spec.ts`、`access.spec.ts` | 组织、归档、恢复与原生会话分离 |
| T16 | `access.spec.ts`、`entry-security.spec.ts`、`coordination.audit.spec.ts` | 控制转交、旧权限与迟到绑定检查 |
| T17 | `artifacts.spec.ts`、`artifact-facts.spec.ts` | 固定版本、缺失/变化检测，四种成果事实分开 |
| T18 | `patch.spec.ts`、`transfer.spec.ts`、`entry-security.spec.ts`；二进制配套包真实 conductor 入口探针 | 基线、目标版本、目录边界与冲突拒绝；实际二进制复制字节一致 |
| T19 | `handoff.spec.ts`、`prd-completion.spec.ts` | taskId、后继链路、固定历史、异步回执 |
| T20 | `handoff.spec.ts`、`prd-completion.spec.ts` | 未提交绑定保留源；未知创建不盲重建 |
| T21 | `rules.spec.ts`、`automation.integration.spec.ts` | 保存 Grant、去重、派发前重校验 |
| T22 | `schedule.spec.ts`、`prd-completion.spec.ts`、`dispatch-admission.spec.ts` | 修改保留账本、停机补偿与待发撤回 |
| T23 | `workflow.spec.ts`、`workflow-model.spec.ts`、`automation.integration.spec.ts`；兼容包 50 节点 Host 探针 | 固定定义、输入和模型配置、验收门、下游启动条件、重复 drive 不重复派发 |
| T24 | `workflow.spec.ts`、`coordination.audit.spec.ts` | 两轮返工及部分重跑不绕过既有运行限制 |
| T25 | `constraints.spec.ts`、`workflow.spec.ts` | 版本固定、漂移显示、受影响成果重新验收 |
| T26 | `budget.spec.ts`、`ledger-idempotency.spec.ts` | 未知/部分计量、不虚报零值或硬费用上限 |
| T27 | `migrate.spec.ts`、`coordinator.operation.spec.ts`、新增远程/分享故障注入 | 派发中断进入 unknown；同身份对账；不可确认时不重发 |
| T28 | `report.spec.ts`、`entry-security.spec.ts`、`automation.integration.spec.ts`、`remote-watch.integration.spec.ts`、`watch-regression.spec.ts` | 通知合并、跨窗口事件去重、已受理通知的写后崩溃不重发、远程断线单次报告、撤权后丢弃迟到结果、notice-only 静默与模型轮写入屏障 |
| T29 | `remote.spec.ts`、`remote-host.spec.ts` | Windows 两个真实 IPC 端点、桥接子进程和文件传输；Host Agent/store 使用替身；Linux SSH 实机仍需另测 |
| T30 | `export.spec.ts`、`share.spec.ts`、`share-integration.spec.ts`；二进制配套包真实 conductor 入口探针 | 真实 Host 二进制本地导出；实际 TLS、固定中文/二进制字节、到期、撤销和重启；未公开部署 |
| T31 | `lifecycle.spec.ts`、`entry-lifecycle.spec.ts`；兼容包卸载 Host 探针 | 保留普通会话和文件，移除兼容 bundle 后回原 Host 启动 |
| T32 | `cleanup.spec.ts`、`entry-security.spec.ts` | 只处理明确选择的插件资源；引用、修改和不明状态拒绝清理 |
| T33 | `client-navigation.ts`、`service/session-links.ts`；`session-links.spec.ts`、`client-cordis.spec.ts`、`scripts/navigation-e2e.mjs` | 双向来源、初始创建身份、后继绑定、刷新、读取隔离与卸载；真实 Host/Edge 状态见 ACCEPTANCE |
| T34 | `service/creation-environment.ts`、`coordinator.ts`；`creation-environment.spec.ts`、`scripts/navigation-host-probe.mjs` | 发起 Session 实际目录/工作区默认值、创建时固定归属、显式宿主命名先于首条指令、失败保留与恢复、受控同步改名；真实 Host 首条消息后标题固定 |
| T35 | `tools.ts`、`service/observer.ts`、`service/projection.ts`、`store/schema.ts`、`index.ts`；`read-snapshot.spec.ts`、`observer.spec.ts`、`remote-observer.spec.ts`、`entry-security.spec.ts`、`scripts/verify/tree-probe.mjs` | `0.1.4` 已验证模型可见公开历史正文、history/wait/report 游标隔离、低预算不消费、读前后权限与 Binding 复查、冷持久 Session 正式只读接口；全量 78 文件 / 1,194 项、真实 Host/Edge 4 场景和历史 Desktop Profile 安装证据见 ACCEPTANCE。当前运行中的 Desktop 仍需完整退出并重开，才能由用户确认已链接的 0.1.5。 |
| T36 | `tools.ts`、`tests/create-delegation.spec.ts`；成功/失败 create/fork 的回执和 read/wait/watch/operation/artifact verify 工具说明均明确用户当前请求边界。定向 6 项、相关 4 文件 61 项、全量 `npm run check` 79 文件 / 1,200 项、lint、smoke 通过 | `0.1.5` 干净包真实 Host/Edge 4 场景、最终 27 文件归档和官方离线 CLI 的 `desktop` Profile 链接已验证；当前运行的 Desktop 仍待完整退出并重开后的用户窗口确认。不得把 `0.1.4` 的 T35 证据复用为 T36 通过证据。 |
| T37 | 当前源码候选：`service/completion-return.ts`、`service/coordinator.ts`、`service/session-links.ts`、`client-navigation.ts`、`store/schema.ts`、`index.ts`；全部当前源码变更后的 `npm run check` 为 82 文件 / 1,236 项，lint 与 smoke 通过 | 最终完整验证待完成：本地源码结果不能代替干净包、真实 Host/Edge、Profile/Desktop 加载或安装证据；仍须在这些环境复核 240/480 UTF-16 截断（含标记）、无父模型／父消息／工具或游标副作用、非终态不显示、原父 `mayRead` 失效隐藏、capability 不在 URL/内容、HTTP 投影的 operation/task/message/非空 instruction/guard bindingVersion/初始 Binding 复核、冷正式历史／重启、重复终态与后续轮次隔离。现有 T33—T36 的证据均不能代替。 |

测试名称以当前 `tests/` 实际文件为准；最终数量、命令和性能记录见 [验收报告](ACCEPTANCE.md)。

## 里程碑出口（历史基线与当前边界）

| 里程碑 | 本地交付 | 不应混同的条件 |
| --- | --- | --- |
| M0 | 外部 bundle、两项兼容扩展、真实 Host 创建/模型/分叉/重启/卸载；T33、T34 使用真实 Host 与完整 Harness Web 界面验证默认工作区、固定标题、多标签双向跳转，`0.1.5` 已离线链接 `desktop` Profile | 原生窗口需要完整退出并重开，完整模型业务流程与 Linux 平台尚未逐项实测 |
| M1—M4 | 核心协调、直接公开历史读取、创建后的默认委派即止、首轮结束一次性回传、成果、调度、工作流、约束与预算源码及自动化回归；T35—T37 与 T44 的历史实现和证据继续保留，当前增量另见顶部 T45 | 本行保留早期版本的出口条件和证据边界，不代表当前待办列表；T45 已完成源码、隔离 Host/browser、候选包和 Profile 安装，唯一尚待确认的是用户完整退出并重开 Desktop 后的实际 GUI 加载。故障注入和受控 provider 不是任意模型质量保证 |
| M5 | SSH bridge、固定迁移清单、HTTPS 服务、清理 | 未登记真实远程连接；Linux SSH 和公网 HTTPS 部署验收待运维环境 |
| M6 | 指南、接口、schema、演示、候选包与证据 | 本地候选包不等于 npm 发布或正式部署 |

## 环境条件

控制端为 Windows，Node.js 26.5.0；实际 Host 运行包基线是 `0.1.1-rc.2`，与 PRD 所引源码 `0.1.5-rc.2` 分开记录。该机器 WSL 组件未注册（`REGDB_E_CLASSNOTREG`），因此没有将 Windows IPC 验证写成 Linux SSH 验证。为取得 Linux 证据需要一台用户提供且授权使用的 Linux Host；本次未安装 WSL、创建云资源或登记真实远程连接。
