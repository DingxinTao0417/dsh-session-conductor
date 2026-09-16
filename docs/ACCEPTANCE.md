# 本地验收与交付记录

# 0.2.6 / T46：侧栏开关顺序与概览主界面归属

源码验证已通过 `npm run check`（97 个测试文件 / 1,407 项测试）、`npm run lint` 与 Host/client/companion smoke。T46 将可见侧栏开关注入宿主公开的 `conversation.session.header.utilities` 列表并保持高顺序，使其紧跟 `Session log`；零尺寸 `WorkspacePreview` 锚点仍保留在 `conversation.session.header.actions`。`SessionOverviewCard` 宽屏不再使用绝对定位或为概览预留右侧 padding，而是在主会话 owner 的正常文档流中右对齐占位。

隔离 Desktop 2.0.3 Host/browser（当前源码候选、离线适配器、无模型调用）实测 1920×1000：Header utilities 中 `Session log` 位于 x=1741…1852，插件开关位于 x=1860…1892；聊天滚动区 x=280…1920、width=1640，滚动条位于主界面最右侧 x≈1912…1920；概览卡位于 y=120…707、x=1574…1904，不再出现在滚动条之外。证据：`.verification/overview-2026-09-16T03-03-28-659Z/layout-t46-installed-verification.json` 与同目录 `host.log`（0.2.6 mounted）。

0.2.6 候选包已封存并通过官方离线 CLI 安装到本机 `desktop` Profile：收据 `.verification/desktop-install-2026-09-15-t46/installation-t46.json`，归档为 `dist/0.2.6-local-t46/dsh-session-conductor-0.2.6.tgz`（35 文件，SHA-256 `57cf8b904bef9014fd0f114e300f4044908bf9eff743631136fb4824cd64de72`），安装链接指向 `D:/dsh-local-plugins/dsh-session-conductor/0.2.6-20260915-t46/package`。安装时没有停止正在运行的 Desktop，因此当前窗口仍持有 0.2.5 模块图；**用户完整退出 Desktop（含托盘进程）并重新打开后的实际窗口加载确认仍待完成**，该确认完成前不把隔离浏览器结果表述为用户当前窗口已加载 0.2.6。

# 0.2.5 / T45：Codex 类宽工作区与概览层级

源码验证已通过 `npm run check`（97 个测试文件 / 1,407 项测试）、`npm run lint` 和三类 smoke。新增自有工作区 surface 与只读原生详情可见性适配器：宽屏以排除左侧导航的会话可用区域默认分配工作区约 70%、聊天约 30%，最小宽度为工作区 300 CSS px、聊天 320 CSS px；支持分隔条拖动、左右方向键、Home 复位和本机比例记忆。可用宽度小于 740 CSS px 时切换为避开 Desktop 顶栏的全宽抽屉。

隔离 Desktop 2.0.3 Host/browser 运行目录 `.verification/overview-2026-09-16T02-03-01-333Z/` 已验证：1920×1000 会话容器 1,640px、工作区 1,148px（70%）；1280×900 会话容器 1,000px、工作区 680px，聊天保留 320px；390×844 抽屉为 x=0、y=36、width=390、height=808，页面无横向溢出。打开工作区、文件、来源和子智能体时概览卡 `display:none`，关闭后恢复；打开原生工具详情时只读结构探测发布实际可见性并隐藏概览，关闭后恢复。资源切换保留比例，Home 恢复 70%，切会话、插槽移除和卸载清除自有 DOM、监听器、CSS 变量、注册和占位。聊天正文、标题栏和输入框保持可操作；无模型调用、无 ASAR 修改。

以上是源码和隔离 Host/browser 结论。0.2.5 候选包已封存，官方离线 CLI 已按收据安装到 desktop Profile，归档哈希、安装路径和回滚脚本见 `DESKTOP-TRYOUT.md`；目前只剩用户将 DSH Desktop（含托盘进程）完整退出并重新打开后的原生窗口加载确认。该确认完成前，不把隔离浏览器结果表述为用户当前窗口已加载 0.2.5。

## 0.2.4 / T44：原生子智能体概览

95 个测试文件 / 1,386 项测试、typecheck/build/lint/Host-client-companion smoke 通过，日志 `.verification/subagents-024-{check,lint,smoke}-final.log`。新增目录投影与 UI 回归覆盖标签优先、冷父成功空目录、running 累计时间、inactive 非成功语义、目录失败、诊断项、精确地址跳转、5 秒共享租约、隐藏页面暂停、退订和迟到响应隔离，以及每组 10 条后分批 30 条。

实际 Desktop 2.0.3 Host、隔离 Profile、正式 spawn provider 与离线适配器生成 2 个运行中原生子智能体（one-shot / continuable）、1 个已结束 one-shot 和 1 个诊断记录。证据 `.verification/overview-2026-09-16T01-47-44-377Z/native-subagents-verification.json`。浏览器验证标签、分组、累计时长更新、不可用项禁用、可继续子会话原生跳转、父会话返回、返回侧栏首页、键盘打开、390×844 抽屉避开顶部 36 px、1920×1000 宽屏概览与侧栏并列。已结束子会话历史跳转另见同版本首次 run `.verification/overview-2026-09-16T01-45-06-446Z/`，后续仅修正响应式样式。

浏览器检查发现中等宽度四列过挤及长任务名称溢出，修正为按会话容器 ≥900 px 四列、620—899 px 两列、<620 px 单列，≥1080 px 使用原有独立概览定位。最终视图无重叠；源码中不编造子智能体进度文字或完成时间。状态仅“运行中 / 已结束或空闲”，不宣称 inactive 已成功。安装及实际用户窗口加载状态仍独立记录在 DESKTOP-TRYOUT.md。

## 0.2.3 / T43：独立右侧栏入口

93文件 / 1,352项测试、typecheck/build/lint/Host-client-companion smoke通过，日志 `.verification/sidebar-023-{check,lint,smoke}-final.log`。真实Host与Desktop容器仿真完成首页开关、集合/文件预览、返回首页、网页输入校验、轮询保留表单、工具详情恢复、会话切换及390px入口可达性验证。证据 `.verification/overview-2026-09-16T01-13-20-243Z/`，详见根目录design-qa.md。未增加模型调用，侧边聊天/内嵌终端/完整文件树/Git工作树审查不在已实现范围。安装状态独立见DESKTOP-TRYOUT。

## 0.2.2：Desktop 小窗口定位与冷会话只读鉴权

check通过91文件 / 1,339项测试，lint和Host/client/companion smoke通过，日志为 `.verification/overview-022-{check,lint,smoke}-final.log`。本次新增25项测试，覆盖冷会话凭据、正式元数据变更、异步预览权限与服务生命周期、窄屏抽屉边界及清理。

真实Host、隔离Profile、离线适配器下模拟实际ASAR的36px标题栏与transformed根容器，复现旧0.2.1在1199×798遮挡28px。新正常流概览与正文间距12px；验证长标题、114条来源、缩放断点、宽屏原生预览、390px窄屏抽屉和父子切换清理。详细边界、截图和证据见根目录 `design-qa.md`。此前0.2.1普通浏览器布局检查不覆盖该Desktop容器缺陷，本节补充修正。

冷持久会话通过正式metadata取得只读凭据，不恢复Agent；协调写仍要求live Agent。同源和loopback限制保留。截图具体403请求未经捕获，此处确认的是建立失败测试并修复的冷会话代码路径，不把所有403都归为相同原因。

安装与用户原生窗口重开确认分开记录在 `DESKTOP-TRYOUT.md`。以下为历史版本证据。

## 0.2.1：常驻概览、原生右侧预览与404诊断

本轮90个测试文件 / 1,314项测试全部通过，含真实Cordis注入生命周期与filesystem provider变更、文件权限/目录/绑定/身份竞态、缺失Host接口的实际HTTP回归、预览slot释放及Markdown安全解析。源码/测试typecheck、所有产物构建、lint与Host/client/companion smoke通过。日志：`.verification/overview-021-check-final.log`、`overview-021-lint-final.log`、`overview-021-smoke-fixed.log`。

真实Host/browser证据在 `.verification/overview-2026-09-16T00-32-51-693Z/`，含默认常驻、整行高亮、文件Markdown与原文、输出/来源集合、切会话释放、宽/紧凑/窄屏布局。详见根目录 `design-qa.md`。测试未改写用户会话，未调用外部模型，隔离Host和浏览器已关闭。

404根因已确认：用户Desktop Host进程启动于本地15:54:33，早于17:05:13安装0.2.0；现有panel接口存在，而overview/result路由不存在。前端刷新后加载新资产，后台仍持有旧模块图。证据 `.verification/desktop-overview-route-mismatch.json`。新版对此给出完整退出/重开的明确说明，不把真实文件不存在的404误诊为旧Host。

0.2.1本地安装状态在下方安装收据追加节及 `DESKTOP-TRYOUT.md` 记录；本节代码与隔离运行验收本身不等于用户原生窗口已重启加载。


更新日期：2026-09-15。状态为**本地实现、隔离验证与本机 Profile 链接完成，用户 Desktop 重开确认待完成；未提交、未发布、未公开部署**。本报告记录当前可核验结果；PRD 的全部功能标准以 [PRD 2.10](PRD.md) 为准，逐项代码/测试映射见 [IMPLEMENTATION](IMPLEMENTATION.md)。不同证据层级不相互替代。以下 0.2.0 及更早内容均为历史版本证据。

## 0.2.0：会话概览卡与独立回执（T38—T41，本地候选）

- 当前源码通过 check（85 个测试文件 / 1,254 项）、lint、smoke。新增测试覆盖消息消费边界、独立回执、授权与 I/O 竞态、已读隔离、来源过滤、订阅清理、真实 selector hook 契约和成果产出会话关系。
- 最终源码检查日志为 `.verification/overview-delivery-{check,lint,smoke}.log`；编码、相对链接、PRD 原章节与 T01—T41 完整性核对见 `.verification/overview-delivery-integrity.json`。本地候选包为 `dist/0.2.0-local-overview/dsh-session-conductor-0.2.0.tgz`，打包清单与 SHA-256 记录在 `.verification/overview-delivery.json`，不包含隔离运行数据或测试凭据。
- 干净外部包在本机 Desktop 内置 Host 运行时的隔离 Profile 中运行；scripts/overview-host-probe.mjs 使用离线确定性适配器实际执行两轮 child 工作，断言父会话仍只有一轮、子会话继承目录/工作区、providerCalls=2。这是 Host 执行集成验证，不是外部模型能力测试。
- Codex 内置浏览器实测默认收起、三分区、准确首次和追加结果、单条已读、模板创建与父命名、监控开关、双向导航、刷新、Escape 焦点恢复和 390 px 卡片边界。浏览器证据与修复迭代见根目录 design-qa.md；本轮不是 Edge 自动化测试。
- UI 实测暴露 selector 参数遗漏，已改为 useSession(selector) 并补回归；测试夹具的 assistant 消息缺少公开 source 也已修复。交互改进包含长目录换行、打开表单/结果时滚动和聚焦。
- 初次开发验证没有修改正式 Profile；用户反馈 Desktop 看不到概览卡后，核实其仍链接 0.1.6，再通过官方离线 CLI 升级为 0.2.0。收据为 `.verification/desktop-install-2026-09-15-overview/installation-overview.json`：仅 conductor dependency 变化，bundle 列表和 Profile patch 未变，实际 junction、干净包哈希及三个组成项各一次均通过。没有停止或重启用户 Desktop，没有改写 ASAR，也没有提交或推送；现有进程不会因包链接更新自动证明已加载新版。
- 安装目录为 `D:/dsh-local-plugins/dsh-session-conductor/0.2.0-20260915-overview/package`；备份及受保护回退脚本在 `D:/dsh/plugin-backups/session-conductor-20260915-overview/before-upgrade/`。旧 0.1.6 包保留。候选归档仍是安装前文档快照，不重打包或改写其已封存哈希。
- 四轮隔离验证的 `cleanup.json` 均确认测试端口释放；最终截图保留在 `.verification/overview-2026-09-15T23-46-16-026Z/`，可携带的卡片截图为 `docs/assets/overview-card.png`。测试浏览器标签已关闭，验证目录作为本地证据保留。
- 未实测 Linux、其他 Host 版本、当前用户完整 Desktop GUI 加载；真实进程崩溃期间的未终态恢复仍只有服务级测试，不能将本次浏览器刷新替代完整崩溃恢复验收。worktree 核心沿用既有测试，本轮 UI 仅验证选择与参数路径，没有在夹具中创建实际 Git 工作树。
- 持续监控是显式操作；一次性父模型自动汇总、自定义模板、跨会话通知汇总和完整开发工具入口仍在路线图。见 CONVERSATION-OVERVIEW.md。

下文是此前版本的历史证据；其中“待完成”等状态属于对应版本，不替代本节的当前状态。

### 0.1.6 源码候选：创建首轮结束的一次性卡片回传（T37，最终完整验证待完成）

T37 规定：仅 create/fork 的 `instruction` 是长度大于 0 的字符串时，准确初始 relay `messageId` 持久化并写入必填 `armedAt`；以该 relay 与初始 Binding 锚定承载它的首个委派轮次，兼容 `turn/start` 位于 relay 前后，终态严格取同一 turn 的 `turn/end`。只有 `returned` 的 completed、failed、interrupted、blocked 或明确初始投递失败 `delivery_failed` 才更新原父会话既有创建卡片；`armed`、`running`、`delivery_unknown` 不显示。回填不唤醒父模型、不写父消息、不调用或消费 `read`／`wait`／`watch`／`send`／`stop`，不自动汇总、验证或重复工作。默认 5 秒内部对账与 1 秒卡片刷新不是父会话监控；持续监控仍须用户在当前请求明确要求。detail/reason 各限 240、公开 assistant preview 限 480 个 UTF-16 code units，超限 `… [truncated]` 计入上限。

终态路由还要求请求来自原父会话、原父 `mayRead` 仍成立、且卡片提供该 operation 的私有 capability。capability 只通过创建工具结果 `presentationMeta` 和 `x-dsh-conductor-link-capability` header 传递，绝不出现于 URL、query、渲染内容或聊天正文。HTTP 投影会重复核对 callback 与当前 operation/task/message、非空 instruction、dispatch guard 的 bindingVersion 及准确初始 Binding；不符时只保留导航，不回传内容。原父 `mayRead` 失效时隐藏回传；冷会话／重启只能经正式公开历史恢复。后续轮次永远忽略。Task release 后，未终态 callback 停止后台观察；release 前已持久化的终态可在 `mayRead` 与 capability 仍成立时继续显示。

截至本记录，T37 的当前源码候选和文件映射见 [IMPLEMENTATION](IMPLEMENTATION.md)。在全部当前源码变更后，`npm run check` 已通过 **82 个测试文件 / 1,236 项测试**，`npm run lint` 与 `npm run smoke` 也通过；这三项是 `0.1.6` / T37 的**本地源码证据**。

另有独立的**本地 Profile 链接证据**：官方离线 CLI 已将干净的 27 文件 `0.1.6` 候选链接到本机 `desktop` Profile，候选 SHA-256 为 `6640c35d28ec9aca2254e088fd0d65e6f6b1c59b8e1048eb2bb26f4ee9a64648`，收据为 `.verification/desktop-install-2026-09-15-completion-return/installation-completion-return.json`。收据核验只有 `dsh-session-conductor` dependency 发生语义变更、bundle 与 `cordis.patch.yml` 未变、junction/package map 一致，且 `dsh-session-conductor`、`conductor-binary-files`、`conductor-compatible-api-gateway` 各组成一次。既有 Desktop 进程未被停止，GUI 未启动；CLI 规范化链接斜杠后，安装后核验才继续，且没有第二次 Profile 改写。此证据仅证明本地 Profile 已链接，不证明 GUI 重启加载、真实 Host/Edge 流程、冷/重启行为或最终完整验证；它不是发布或部署结论。候选包内封存的文档是安装前快照，后续源码文档更新不反向改变该包内容。待补证据至少包括干净包中的定向/全量回归、非终态隐藏、文本上限、权限/私有 capability/HTTP 关系复核、冷历史/重启/release 行为，以及真实 Host/Edge 与完整 Desktop 重启/加载流程。

## 当前验证清单

### 0.1.5 下一本地候选：创建／分叉后的默认委派即止（T36，源码、干净包、Host/Edge 与 `desktop` Profile 链接已通过；用户重启确认待完成）

T36 规定成功 `conductor_create` 或 `conductor_fork` 后，主会话默认只呈现真实创建结果和原生跳转并结束本次协调。它不得重复目标承担的工作，也不得自动 `read`、`wait`、`watch`、`send`、`stop`、监控、汇总、比较、复核或验证。只有用户在**当前请求**中明确要求主会话参与、并行、监控、汇总、比较、复核或验证时，才执行该明确范围内的后续动作；创建必需的 Operation 状态查询只服务于完成准备和呈现结果。

截至本记录，`0.1.5` 的 T36 已在 `src/tools.ts` 中实现，`tests/create-delegation.spec.ts` 的 6 项以及相关 4 个测试文件的 61 项通过；全量 `npm run check` 为 **79 个测试文件 / 1,200 项测试**，`npm run lint` 和 `npm run smoke` 也通过。该实现将默认委派边界写入 create/fork 成功和失败回执，以及 read/wait/watch/operation/artifact verify 的模型可见说明；它是编排契约，不是 Host 工具访问控制。

最终归档为 `dist/local-candidate-2026-09-15-delegation-only-final/dsh-session-conductor-0.1.5.tgz`，包含 27 个文件，SHA-256 为 `1ec3e4259a5bcd240de98eb4960fccf24208b5e779b4ba6408b4ff5ede04379f`。最终归档已与干净外部包 `D:/dsh-local-plugins/dsh-session-conductor/0.1.5-20260915-delegation-only/package` 核对一致；这项比较说明归档与该干净包一致，不把后来更新的源码文档表述为归档内容。

真实 Host/Edge 证据为 `.verification/navigation-2026-09-15T10-01-35-586Z/summary.json`：4 个场景通过、`errors` 为空、`providerCalls` 为 0、`responseInterception` 为 false、端口 53932 已释放。两个真实 create 场景可见地在创建结果处结束默认委派，并在当前请求明确要求时才显示 `read(history)` 正文；创建卡片/来源返回在刷新后保持正确，两个标签独立，真实 fork 继承发起工作区和主会话命名并能返回来源。自动化回归覆盖成功/失败回执、默认委派和用户当前请求例外；该 Host/Edge 场景不扩称为所有真实模型业务流程。

官方离线 CLI 已将 `desktop` Profile 链接到 `0.1.5`。首次 CLI 后的自动断言脚本有**两处不变量缺陷**，因此不把它的组合结论作为最终证明。安全恢复没有重新执行 `add`，只生成收据和受保护回滚；`.verification/desktop-install-2026-09-15/installation-delegation-only.json` 记录 `resumed: true`、`compositionChecked: false`。随后独立、只读的官方 CLI dump `.verification/desktop-install-2026-09-15/composition-delegation-only.json` 通过：`dsh-session-conductor`、`conductor-binary-files`、`conductor-compatible-api-gateway` 三个 ID 都恰好一次，Profile 文件未改变。受保护回滚脚本由安全恢复生成，要求停止 Desktop 并在摘要一致时才恢复先前的 0.1.4 关联。

当前 DSH Desktop 进程仍保有旧模块图；安装时没有停止它。必须完整退出 Desktop（包括托盘）并正常重新打开，才能由用户确认实际窗口加载 `0.1.5`。`0.1.4` 只包含 T35；其“直接读取公开历史”能力不表示创建后会默认或自动读取历史。

### 0.1.4 本地候选：直接公开历史进度读取（T35，历史本地验收与安装记录）

主会话现在通过 `conductor_read({view:"history"})` 直接看到已授权目标会话的公开历史正文，而非只得到条数或摘要，也不要求目标为查询进度另写 Markdown、报告或其他文件。`brief` 只服务于明确交接，`export` 只服务于明确导出交付物。回执仅投影公开 user／assistant 消息、工具调用和工具结果；Think、推理草稿、原始 token/chunk、Session JSONL、私有 cache 和其他未投影数据不会跨会话出现。

- `npm run check` 在 `0.1.4` 源码上通过：**78 个测试文件 / 1,194 项测试**；`npm run lint` 与 `npm run smoke` 也通过。T35 定向回归包含 `read-snapshot.spec.ts`、`observer.spec.ts`、`remote-observer.spec.ts` 与 `entry-security.spec.ts`，覆盖公开投影、history/wait/report 游标隔离、低预算不消费、读前后授权及 Binding 复查、无权 wait 单目标错误。冷持久 Session 的自动化覆盖也已通过：它只经正式 `ctx.sessionQuery.readSession()` 接口读取，标记为 persisted，且不会恢复 Agent 或成为 wait/write 目标。
- 干净解包的外部 `0.1.4` 包在真实 Desktop Host、完整 Harness Web 界面和本机 Edge 中通过 **4 个 live 目标场景**；证据为 `.verification/navigation-2026-09-15T09-15-52-719Z/summary.json`。该验证实际调用 `conductor_read({view:"history"})`，其 `output.render` 正文作为父会话 `tool/result` 持久化；正常展开工具回执后可见，返回子会话并刷新父会话后仍可读取。`errors` 为空、`responseInterception` 为 false、`providerCalls` 为 0，测试端口 **59294** 已释放。该 4 场景不是冷持久 Session 的浏览器 E2E。
- 在 T35 的历史轮次中，官方 Desktop CLI 曾将 `desktop` Profile 离线更新到 `dsh-session-conductor@0.1.4`，同时保留既有 dependency、bundle 与两个 0.1.0 伴随包；组合配置检查通过。安装收据为 `.verification/desktop-install-2026-09-15/installation-history-first.json`，安装前可恢复备份位于 `D:/dsh/plugin-backups/session-conductor-2026-09-15T07-32-33-735Z/before-history-first/`。该关联后来由本页顶部的 0.1.5 更新替代。

这组 Host/Edge 验证使用隔离 Profile、受控 provider 和测试会话数据，不调用模型，也不修改现有用户会话；它证明 live 公开历史的真实渲染、持久化和浏览器显示路径，不等同于任意真实模型业务流程。冷持久 Session 路径的正式 API 与自动化覆盖已通过，但本轮没有把它伪称为完整浏览器实测或真实模型任务的业务结论。当时安装没有停止用户正在运行的 Desktop；现在 `desktop` Profile 已链接 0.1.5，当前进程仍可能保留旧模块图和 Host 路由，必须完整退出 Desktop（含托盘）并正常重新打开后才可由用户确认。任何本地安装都不等于 npm 发布、公开部署或已完成用户窗口重启后的确认。

### 0.1.3 默认继承主工作区与主会话命名（T34）

新建/分叉省略 cwd 与 Git 起点时，从可信发起 Agent 的 Session header 读取目录，并从 Host workspaceRegistry 的真实 Session ID 归属取得 workspaceId。创建时固定在 Operation 参数中；重试和失败恢复不跟随主会话的新目录。已有工作区加入失败会阻止首次指令，保留 Session 与原因。主会话 title 通过公开 sessionTitle.rename 成为显式用户命名标题并 flush，自动首条消息命名无法覆盖；原生规范化结果同步 Task，受控改名也同步两处。

这是 `0.1.3` 轮次的历史证据：`creation-environment.spec.ts` 新增 6 项测试通过；当时全量 `npm run check` 为 **78 文件 / 1183 项**，日志 `.verification/parent-workspace-check.log`，`npm run lint` 无告警。真实 Desktop 2.0.3 / Host 0.1.1-rc.2 与干净外部 0.1.3 主包，在独立 Profile 的真实 Edge 完整界面验证：两组创建任务继承同一主 workspace 和 cwd、主会话指定的标题在首条消息后保持显式固定、打开/刷新/返回、两个标签隔离，以及真实 fork 继承主工作区并使用主会话名称，**4 项场景通过**。证据 `.verification/navigation-2026-09-15T08-27-48-229Z/summary.json`；errors 空，providerCalls 为 0，测试 Host 和浏览器已退出，51318 端口释放。标准历史事件是独立测试夹具，任务/工作区/命名操作使用真实 Host 服务；未操作正式 Session 或调用模型。

安装后需完整退出 Desktop（含托盘）并正常重开，不能用刷新替代宿主模块重载。上述 `0.1.3` 干净包复验、`before-parent-workspace` 备份和 `dist/local-candidate-2026-09-15-parent-workspace/manifest.json` 都保留为该轮历史证据；当前 `desktop` Profile 已由本页顶部所列 `0.1.5` 关联替代。下方 0.1.2 及面板条目同样只保留历史证据。

### 0.1.2 原生双向会话跳转（T33）

按用户指令停用浮动面板，使用自有原生聊天节点及标题栏追加来源链接。创建来源取自初始 Operation，不跟随当前控制者；当前/历史 Binding 支持迁移后的目标跟随和旧来源返回。未添加业务 schema 或改写正式 Session。旧面板源码/API 保留兼容回归，下面面板记录属于历史实现，不代表当前界面。

`session-links.spec.ts` 与真实 Cordis 的 `client-cordis.spec.ts` 共 10 项定向检查通过。完整 Harness Web 界面使用实际 Desktop 2.0.3 的 Host 和兼容包、编译后的干净外部主包，在 Edge 无响应替换验证两组创建卡片→目标→刷新→返回，以及两个标签独立导航，共 3 项场景通过，errors 为空；独立 Profile 的标准事件是测试夹具，任务创建实际调用 Host 工具，providerCalls 为 0。证据：`.verification/navigation-2026-09-15T08-12-34-627Z/summary.json`、`parent-1.png`、`child-1.png`。测试 Host 与浏览器已退出，53577 端口释放。该测试不代表原生窗口已加载新版或真实模型推理已完成。

完整回归过程中发现远程观察夹具仍把插件版本写死为 0.1.0，导致升级后 3 项握手测试拒绝。已将夹具版本从实际 package.json 读取，保留生产协议的版本拒绝检查；不是放宽真实远程兼容策略。最终 `npm run check`（源码/测试类型、所有入口构建、Vitest）通过：**77 文件 / 1177 项**，日志 `.verification/native-links-check.log`；`npm run lint` 无告警。客户端 closure/服务声明/自有 slot/转义及卸载 smoke 通过。

0.1.2 归档解包后再次使用同一真实 Host/Edge 脚本复验通过，证据 `.verification/navigation-2026-09-15T08-15-14-108Z/summary.json`，51119 端口释放。代码验证时归档 SHA-256：`9a778796bbc44c982900635d72e1b9993bfd02ed4a3799a51ef2ced98a6d5115`。安装后的文档收尾会更新归档摘要，最终 SHA 见 `dist/local-candidate-2026-09-15-native-links/manifest.json` 和 `installation.json`；编译产物保持逐字节一致，已安装文件与最终归档逐项校验。官方 Desktop CLI 离线更新活动 `desktop` Profile，仅主包更新，原依赖/bundle 均保留，三项 provider 行数量检查通过；备份 `D:/dsh/plugin-backups/session-conductor-2026-09-15T07-32-33-735Z/before-native-links/`。

当时正在运行的 Desktop HTTP 服务无响应替换加载新客户端资产 `2091ce0a4ede`，主界面出现、panel/toggle 均为 0、errors 为空，证据 `.verification/desktop-install-2026-09-15/installed-native-links.json`。**该历史进程仍缓存升级前的模块依赖清单和 Host 路由，新增 session-links 路由返回 404；完整退出 Desktop（含托盘）再正常重开是启用双向跳转的必要步骤，单独刷新不能更新 Host。** 新进程的实际包组合已在独立 Profile 完整复验；未强制停止用户 Desktop，也未在当前 Profile 创建测试会话或启动模型。

### Desktop 0.1.1 启动修复

0.1.0 安装到当前 Desktop 后白屏已复现。完整客户端加载器拒绝未经 inject 声明读取 slots；进一步审查发现 slot 声明回调和注册参数也与真实 API 不一致。0.1.1 声明 slots 及客户端 runtime 模块依赖，使用 ctx.get 探测可选服务，采用零参数声明回调及 register(options, component)。新增 `tests/client-cordis.spec.ts` 的 3 项真实 Cordis 上下文测试全部通过；原浏览器替身的 slot 接口也已按真实契约修正。

在当前 DSH Desktop 2.0.3 的实际 HTTP 服务上，真实 Edge 先复现白屏，再通过单个客户端 bundle 响应替换验证修复：完整 root 主界面及协调面板出现，前端错误为空。原始归档仍保留，重放原始 bundle 的复现证据为 `.verification/desktop-install-2026-09-15/original-white-screen.json`，修复响应验证为 `fixed-live-ui.json`，对应截图同目录。安装 0.1.1 后再次**不使用响应替换**加载实际服务，主界面和协调面板也正常，证据为 `installed-live-ui.json`；实际服务已提供修复后的资产版本 `071fe80e6ff2`。没有改写 Host、凭据或 Session；原生窗口刷新或正常重启后的实际状态仍待确认。完整业务操作与模型执行未由该启动验证覆盖。

本次修复后的源码/测试 typecheck、lint、全产物构建和客户端 smoke 通过，定向 Vitest **6 个文件 / 51 项测试**通过；修正替身后的 Edge 面板 E2E **7 个场景**通过，errors 为空，服务器已停止。下方 75 文件 / 1167 项是修复前的完整 Host/业务基线，不冒充本次全量重跑。

| 验证 | 结果 | 证据与边界 |
| --- | --- | --- |
| 主项目 `npm run check` | 通过，**75 个测试文件 / 1167 项测试** | 完整源码/测试 typecheck，Host/client/bridge/share 构建，全部 Vitest；日志 `.verification/prd-completion-2026-09-15/check.log` |
| 主项目 `npm run lint`、`npm run smoke` | 全部通过 | 同证据目录 `lint.log`、`smoke.log`；Host/client smoke，含 34 个工具实际注销及 domain close |
| 独立 Host API 兼容包 `npm run build`、`npm test` | 通过，7 项单元回归 | 精确基线/身份冲突/并发/确认丢失/flush 抛错和 false/ready 子会话丢失 |
| 兼容包 `npm run verify:host` | 通过，23 + 4 + 3 = **30 项真实 Host 断言** | 实际 Electron/原生 Host 包；写入、重启、卸载回到 stock 三次启动；受控 provider，无模型网络请求 |
| 独立二进制配套包 | 通过，5 项单元测试、**19 项真实 Host 断言** | 解包候选加载后，16 项 write + 3 项 stock；真实 fs-local/fs-sandbox provider |
| 主插件二进制复制/导出入口 | 通过，**13 项真实 Host 断言** | 真实 conductor_create、登记/核验、transfer、export；真实 Host Agent/Session/storage/fs/tools，无 Host 服务替身 |
| `node scripts/panel-e2e.mjs` | 通过，**7 个真实 Edge 场景**，errors 空 | 生产 apply/HTTP routes/tools；Host 服务是隔离替身，非完整 Harness shell |
| `tests/remote.spec.ts`、`tests/remote-host.spec.ts` | 全部通过，已含在主项目 1167 项中 | 两端点、实际 Node stdio 子进程与文件；Agent/store 使用结构化替身；未连接实际 SSH Host |
| `tests/share-integration.spec.ts` | 全部通过，已含在主项目 1167 项中 | 临时证书、真实 HTTPS socket、文件系统重启；非公网部署 |
| `remote-watch.integration.spec.ts`、`watch-regression.spec.ts` | 3 + 3 项通过，已含在主项目 1167 项中 | 生产插件入口、受控传输和 Host 服务替身；独立远程观察游标、notice-only 静默、断线去重、撤权、跨合并窗口去重、受理后崩溃不重发 |

上述断言数量不可相加称作一个统一测试总数：主 Vitest、Node 单元测试、Host 探针断言和浏览器场景是不同单位。

## 真实 Host 模型、fork 与工作流

保留证据位于同级项目 `dsh-harness-compat/.verification/2026-09-15T06-57-32-497Z/`，包含 `write.json`、`restart.json`、`stock.json`、各次 Host 日志及 `performance.json`。基线包为 `@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2`；原始 211624 字节 API bundle 的 SHA-256 为 `f069e97b3c2ee5425bae407c3ffe6b5e5c336b0ebb5e52fbb8d2e74ae067f7f0`。构建与启动均校验此基线，细节见独立包兼容记录。

覆盖 wire 参数、单会话设置不写全局默认、在途请求与下一请求分离、pending 配置重启持久化、真实 conductor 创建默认快照/显式配置/fork 当前配置继承、原生 fork 身份/cutoff/cwd/workspace 幂等，以及移除兼容 bundle 后原生 API 和 conductor 仍可启动。

50 节点 DAG 固定全部节点的模型配置；模型漂移导致派发停止；恢复一致配置后显式 resume。首次准入后重复 drive 20 次，没有重复派发该节点。额外验证原生 followup 在源已冻结、以及 pre-step 的 downstream await 期间才冻结，两种情况均未进入 provider。

性能采用 Windows x64 10.0.26200、嵌入式 Node v24.18.1，20 个真实受管 Host 会话，4 个受控 provider 流保持活跃。5 次预热后计时 100 次真实 `conductor_list` 工具调用：

| 指标 | 实测 |
| --- | --- |
| P50 | 0.301 ms |
| P95 | 0.383 ms |
| 最大值 | 0.820 ms |
| PRD 读取阈值 | 500 ms |

这是该机器上的进程内工具执行时间，排除浏览器渲染、网络传输和外部模型延迟；不作为通用端到端 SLA。该探针验证 50 节点保存/固定与重复准入，不宣称已执行并验收 50 次真实模型产出。

## 真实二进制 provider

最终候选包解包后的验收证据：同级 `dsh-binary-files/.verification/2026-09-15T07-15-13-580Z/`。`write.json`、`stock.json` 和 `summary.json` 记录 19 项真实断言、Windows、端口释放及未修改安装 Host。原始 fs-local/fs-sandbox 包都是 `0.1.1-rc.2`，两份 SHA 固定值见该项目 README。

覆盖全部 256 个字节值、create-if-absent、版本 CAS、并行字节替换与原生文本写入共享目标锁、read-only/workspace-write 沙盒、junction 改变后重新规范化、取消、竞态创建不覆盖、输入 buffer 快照及 staging 清理。移除配套 bundle 后 stock provider 恢复。配套 provider 的实测不自动等同于任意远程 Linux Host 的验证。

主插件入口的进一步实测证据为同级 `dsh-binary-files/.verification/conductor-2026-09-15T07-13-36-930Z/`（`conductor.json`、`summary.json`）。`scripts/verify-conductor-host.mjs` 在真实 Host 中创建两个受管任务，登记并完整摘要固定一个 65,536 字节、覆盖全部 256 种字节值的文件，通过生产 transfer/export 接线复制和导出。13 项断言验证精确字节、已有目标拒绝、接收目录范围和源漂移拒绝。这里 Agent、Session、storage、tools、fs/sandbox 都来自真实 Host；受控模型目录只服务创建配置，模型 stream 与网络调用均为零。该过程不是远程 SSH 验收，也不把复制/导出断言扩称为 Git 快照实机覆盖。

## Edge 面板

最终证据：本项目 `.verification/panel-e2e/result.json`（UTC `2026-09-15T07:21:13.150Z`），截图 `panel-desktop.png`、`panel-mobile.png`，本轮命令日志另在 `.verification/prd-completion-2026-09-15/`。实际 Edge `153.0.4234.32`；脚本使用桌面 1440 × 1000 与窄屏 390 × 844 视口。七个场景为：

1. 两标签选择独立控制会话和聊天目标，seq 0 历史可见。
2. 原输入框保持独立，user 和 relay 来源均显示。
3. 排队、撤回和带锚点停止复用生产协调服务。
4. 双击和已受理 HTTP 回执丢失不重复投递，重试保留 operation ID 和草稿。
5. 乱序详情响应不切错发送目标，切换保留草稿，读取失败后重连。
6. 观察者写控件禁用，原会话/新标签导航调用公开 sessions.open。
7. 关闭标签不停止 Host，更新继续，异步创建进度到 ready。

真实浏览器验证使用生产构建、入口、HTTP 路由和工具，以及内存 Host 服务替身。它未验证完整已安装 Harness UI，也未将高级 JSON 控制台描述为可视化工作流编辑器。

## IPC、TLS 与平台边界

Windows IPC 场景跨两个实际 named-pipe 端点和真实 Node stdio 桥接子进程，验证操作收据、固定清单/字节、身份与版本、丢回执只读对账、源冻结、目标禁用准备/启用/中止和文件保护。SSH argv/既有 alias/严格 Host key/POSIX 引用规则有自动化测试；没有由此推导已完成 Linux SSH 实机验收。

新增纯读 `task.observe` 路由返回 Host projection/notable，remote wait 与 watch 以 reader + session 维护独立进度。两组共 6 项定向回归通过，分别验证远程完成/断线、notice-only 静默、回包时撤权、多合并窗口事件 ID 保留及通知已受理后的存储失败恢复。远程 watch 测试替换 SSH transport 来控制迟到、断线和撤权时机，不能将其称为 SSH 实机验证。

HTTPS 测试覆盖固定中文文档与二进制附件、上传认证、内容摘要、不可变重放、到期、撤销及重启恢复、当前控制者检查和丢响应对账。临时自签证书用于测试真实 TLS，运行时仍验证证书且拒绝重定向。本轮没有公开链接部署或对外上传。

分享服务还限制入站及磁盘快照读取为 8 MiB、检查 UTF-8 与完整回执身份/期限/摘要，按原服务源地址和控制 epoch 对账；撤销后的重放不返回活跃 URL。发布/撤销使用 staging flush 后独占 hardlink 发布，缺少所需文件系统能力时失败；Windows Node 没有目录 fsync，因此测试不构成断电级持久性保证。远程等待的取消和 deadline 传到载体进程；迟到结果不得推进独立读取游标。

Windows 为本轮控制端，构建/主测试 Node v26.5.0；实际 Host 的嵌入式版本单独记录。WSL 不可用（前期检查返回 `REGDB_E_CLASSNOTREG`），本次没有安装 WSL、创建 Linux 云机器、生成 SSH key 或登记真实远程连接。Linux、其他 Host 构建、正式 profile 接入和公网服务部署仍需相应环境的独立验收。

## 产物与进程终态

当前主包是本地 `0.1.5` 的干净外部包，位于 `D:/dsh-local-plugins/dsh-session-conductor/0.1.5-20260915-delegation-only/package`，已从无开发依赖的独立目录链接至 `desktop` Profile。最终归档 `dist/local-candidate-2026-09-15-delegation-only-final/dsh-session-conductor-0.1.5.tgz` 为 27 文件，SHA-256 `1ec3e4259a5bcd240de98eb4960fccf24208b5e779b4ba6408b4ff5ede04379f`，最终核对确认其与该干净包一致。安装关联、恢复、组合复核与回滚记录在 `.verification/desktop-install-2026-09-15/installation-delegation-only.json` 和 `.verification/desktop-install-2026-09-15/composition-delegation-only.json`；主包及两个独立配套包均使用文件白名单，不打包 node_modules、`.cache`、`.verification`、测试专用 Profile 或临时凭据。源码目录和本地证据保留，候选包不是公开 npm 发布。

兼容测试三个 Host 已退出，43963 无监听；最终二进制 provider 候选测试两个 Host 已退出，summary 确认 62134 端口释放；主插件二进制入口 Host 的 summary 确认进程退出和 61884 端口释放。T35 的历史干净包 Host/Edge 验证已释放 59294；T36 的干净包 Host/Edge 验证已释放 53932，Edge 浏览器和临时服务器在 finally 中关闭。IPC/TLS 测试负责关闭端点、子进程与服务器并清理临时目录；最终 check/lint/smoke 和导航命令进程均已退出。已通过官方离线 CLI 修改用户选择的 `desktop` Profile 以链接 `0.1.5`，但没有改写 Desktop ASAR、现有会话、凭据或原插件源码，也没有初始化 Git、提交、推送、公开发布或部署；正在运行的 Desktop 未被强制停止，仍需完整退出（含托盘）并重新打开。

## 0.2.1本机安装收据

官方离线CLI已将 `desktop` Profile从0.2.0更新到0.2.1；包、归档、manifest逐文件hash完全一致，所有lib运行时文件与真实浏览器验证包逐字节一致。原依赖和bundle除目标conductor链接外未改变，cordis.patch.yml未变，官方dump配置中conductor、binary-files、compatible-api-gateway各一次。

- 收据：`.verification/desktop-install-2026-09-15-preview/installation-preview.json`。
- 归档：`dist/0.2.1-local-preview/dsh-session-conductor-0.2.1.tgz`，31文件，SHA-256 `1e4f1cbc648e500c90c281a647402322fd798a9591a39117129b79445151d3d2`。
- 独立包：`D:/dsh-local-plugins/dsh-session-conductor/0.2.1-20260915-preview/package`。
- 备份及受保护回滚：`D:/dsh/plugin-backups/session-conductor-20260915-preview/before-upgrade/rollback-preview-verified.ps1`。

用户Desktop未被强制退出，新Host路由须完整退出含托盘并重开后加载。隔离测试50893、58761端口均已释放；浏览器标签关闭、viewport恢复。没有commit、push或公开发布。包中文档保留安装前快照，最终安装状态以本节及独立收据为准。

真实Host冷会话补充验证：`.verification/overview-2026-09-16T01-04-02-389Z/cold-session-verification.json`。由正式AgentHandle自行创建并dispose隔离会话；bootstrap/overview/preview均200，协调写409 CONTROLLER_INACTIVE，Agent始终未恢复，离线providerCalls保持2、父turn保持1。测试Host已停止且端口释放。

0.2.2已通过官方离线CLI安装到desktop Profile，收据 `.verification/desktop-install-2026-09-15-layout/installation-layout.json`；仅主插件依赖变更，其他依赖/bundle/patch不变，三个组成项各一次。用户Desktop未被停止，须完全退出重开；未commit/push/发布。安装包SHA和回滚见DESKTOP-TRYOUT。

0.2.3已通过官方offline CLI安装到desktop Profile，收据 `.verification/desktop-install-2026-09-15-sidebar/installation-sidebar.json`。仅主依赖变化，其他依赖/bundle/patch保留，三个组成项各一次。未停止现有Desktop，需完整退出重开；隔离Host与端口已关闭，未提交或发布。
