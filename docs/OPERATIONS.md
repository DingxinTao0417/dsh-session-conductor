# 安装、配置、使用、恢复与卸载

> 当前本机 `desktop` Profile 已通过官方离线 CLI 链接到 0.2.6 / T46 候选。安装流程没有启动或停止 Desktop；须完整退出（含托盘）并正常重开，才能加载新版 Host。启动后侧栏开关位于 `Session log` 右侧；宽屏概览卡在主会话正常文档流中右对齐，聊天滚动条位于主界面最右侧；打开自有工作区默认约 70/30 分配并隐藏概览，关闭后恢复。安装与回退证据见 [本机试用记录](DESKTOP-TRYOUT.md)；其他机器仍须核对宿主环境。下文版本记录保留历史归属。

更新日期：2026-09-15。当前源码为 0.2.6 / PRD 2.11 / T46：已实现侧栏开关顺序修正、概览卡主界面归属、插件自有宽工作区、原生详情可见性适配和既有多会话协调能力。0.2.6 的 `npm run check`（97 个测试文件 / 1,407 项）、lint、smoke、隔离 Host/browser QA、候选包封存及官方离线 CLI Profile 安装均已完成。创建／分叉成功后仍默认委派即止；只有用户在当前请求明确要求主会话参与、并行、监控、汇总、比较、复核或验证时才例外。用户窗口必须完整退出（含托盘）后重开才能加载新版 Host；窗口实际重开确认仍待完成。0.2.5 及更早版本的安装和回滚证据保留在 `ACCEPTANCE.md` 与 `DESKTOP-TRYOUT.md`，不替代当前 0.2.6 结论。先阅读 [实现对照](IMPLEMENTATION.md)、[验收报告](ACCEPTANCE.md) 和 [独立宿主扩展](host-extension.md)。

## 构建与安装

在项目源码根目录运行已提供的脚本（候选归档不包含开发脚本和 node_modules）：

```sh
npm install
npm run check
npm run lint
npm run smoke
```

`check` 包含主源码和测试类型检查、Host/Client/桥接/分享服务构建、Vitest 回归。真实 Host 基线验证在同级 `dsh-harness-compat` 项目执行 `npm run verify:host`，其读取 ASAR 和 Electron 的具体前置条件见该项目 README。二进制 provider 的独立构建与真实 Host 验证见同级 `dsh-binary-files` README；其可调用能力用于复制、导出和 Git 未跟踪文件快照，不以 Node 文件写入绕过 Host 沙盒。

原生聊天跳转 E2E 使用完整已安装 Harness Web 界面、真实 Host 服务与本机 Edge，不下载浏览器、不连接模型。先将构建归档解包到不含开发 node_modules 的独立目录，再设置以下环境变量（PowerShell）：

```powershell
$env:CONDUCTOR_ELECTRON = '<installed Desktop executable>'
$env:CONDUCTOR_ASAR = '<installed resources/app.asar>'
$env:CONDUCTOR_PACKAGE = '<clean unpacked conductor package directory>'
$env:CONDUCTOR_COMPAT = '<clean unpacked compatibility package directory>'
node scripts/navigation-e2e.mjs
```

脚本创建独立临时 Profile、两组真实任务和标准事件测试数据；不修改正式 Profile 或现有 Session。测试覆盖创建卡片、来源返回、刷新和两个浏览器标签隔离，无响应替换。证据保留在 `.verification/navigation-*/`，浏览器、测试 Host 与端口在 finally 中关闭。

通过 Harness 已有 CLI 将项目加入明确选择的 profile：

```text
dsh plugin --profile <profile-name> add <absolute-project-directory>
dsh --profile <profile-name> --dump-config
```

这会修改所选 profile，初次验证建议选择开发或测试 profile。2026-09-15 应用户试用要求，`0.1.5` 主包和两个 0.1.0 伴随包均从归档解包到无开发依赖的独立目录，再通过官方离线 CLI 链接到当前 Desktop 的 `desktop` Profile；最终归档、安装收据、组合复核与回滚见 [本机试用记录](DESKTOP-TRYOUT.md)。不要将带开发 node_modules 的源码目录直接用于三个包的实际安装，以免遮蔽 Desktop 宿主依赖。独立兼容扩展采用 bundle 行替换方式，按其指南配置；插件不会自动修改已安装 ASAR。没有相应可调用扩展时依赖功能保持禁用。

### 0.1.5 安装恢复与组合复核

首次 CLI 后的自动断言脚本有两处不变量缺陷，因此不能把它的组合结论当作最终证明。安全恢复没有重新执行 `add`，只生成安装收据和受保护的回滚脚本；`.verification/desktop-install-2026-09-15/installation-delegation-only.json` 因而如实记录 `resumed: true` 与 `compositionChecked: false`。随后使用官方 CLI 的只读 `--dump-config` 单独复核，`.verification/desktop-install-2026-09-15/composition-delegation-only.json` 确认 `dsh-session-conductor`、`conductor-binary-files` 和 `conductor-compatible-api-gateway` 三个 ID 都恰好一行，Profile 文件未改变。受保护回滚位于 `D:/dsh/plugin-backups/session-conductor-2026-09-15T07-32-33-735Z/before-delegation-only/rollback-delegation-only.ps1`；它要求所有 Desktop 进程先退出，并在摘要一致时才通过官方离线 CLI 恢复 0.1.4。当前安装不等于运行中的旧 Desktop 已加载 0.1.5，仍须完整退出（含托盘）并重新打开。

## 基础配置

配置位于 profile 的 conductor 行。宿主扩展声明仅在已安装、实际探测到可调用实现时有效：

```yaml
config:
  hostExtensions:
    selectModelRememberAsDefault: true
    forkTargetParameters: true
  crossHostEnabled: false
  shareEnabled: false
```

默认管理 20 个目标，每 Host 插件目标并发 4、自动回报并发 1，默认 brief。新建/分叉省略环境时继承发起会话的目录及已有 workspace，主会话指定名称并同步宿主标题；在 `0.1.5` 中，创建／分叉成功的默认主会话行为是委派即止：只呈现创建结果与跳转，不自动重复工作、`read`、`wait`、`watch`、`send`、`stop`、监控、汇总、比较、复核或验证；只有用户在当前请求明确要求时才例外。PRD 2.5 的 T37 不改变这条边界：仅非空 `instruction` 的 create/fork 在 relay ID 与 `armedAt` 持久化后，才可在准确首轮／初始投递进入终态时无模型地回填原父卡片一次；`armed`、`running`、`delivery_unknown` 不显示，持续 `watch` 仍需用户当前请求明确要求。默认 5000 毫秒内部 pass 和可见卡片 1000 毫秒刷新只是对账/显示，不是父会话监控。全部当前源码变更后的 T37 已通过本地 check（82 文件 / 1,236 项）、lint 与 smoke，且其干净 27 文件候选已通过官方离线 CLI 链接至本机 `desktop` Profile；该链接验证仍不等于 GUI 加载、真实 Host/Edge、冷/重启或最终完整验证。`0.1.5` / T36 的干净包、真实 Host/Edge 及 `desktop` Profile 链接历史证据保持单独归属。GUI 没有由安装流程启动；打开 Desktop 前不应声称当前窗口已加载 0.1.6，`0.1.4` 尚未包含此行为。需要独立 Git 改动时明确选择 worktree 起点。直接历史读取默认请求最多 20 条、工具输出上限为 12,000 字符；为完整呈现可读记录和继续游标，实际页可缩小，预算不足以显示任一完整记录时不会推进历史游标。同步等待 60 秒，打断确认 30 秒。其他默认值仍由 [PRD 默认配置](PRD.md#7-默认配置) 和 `src/domain/defaults.ts` 定义。Host 服务设置可调整并发等运行值；连接地址、凭据环境变量名称和兼容扩展声明属于运维配置，修改 profile 后重启。

## 日常使用

先调用 `conductor_capabilities` 查看当前 Host 实际能力，再通过 `conductor_create` 或 `conductor_attach` 创建/加入任务。修改操作使用稳定 `operationId`，重试保持同 ID、同参数。创建和迁移返回受理结果时，通过 `conductor_operation` 查询，不重新创建。

直接在普通会话提出创建、监控或补充指令，不需要打开面板。真实创建/分叉工具调用在聊天中显示创建卡片，准备就绪后点击“打开会话”；目标原生标题栏显示来源，可点击“返回发起会话”。跳转不发送消息、不改变控制权；多标签独立，刷新后从存储域重新读取。任务不可用时禁用跳转，远程任务不假装能在本地打开。

在 `0.1.5` 中，普通“创建／分叉一个任务”请求的默认结果到创建卡片为止。主会话不为确认结果而重做目标工作，也不自动查进度、等待、观察、追加指令、停止或验证。PRD 2.5 的 `0.1.6` 源码候选 T37 仅在 `instruction` 为非空字符串、relay ID 已持久化且 `armedAt` 已写入后，把该 relay 所在首轮的 completed、failed、interrupted 或 blocked `returned` 终态，或明确 `delivery_failed`，回填到**原父会话的同一张**卡片；`armed`、`running`、`delivery_unknown` 不显示。它的 detail/reason 各最多 240、公开 assistant 预览最多 480 个 UTF-16 code units，超限标记 `… [truncated]` 计入上限；它不让父会话一直等待，也不启动 `read`、`wait`、`watch`、`send`、`stop`、汇总或验证。卡片不是整个任务验收，也不跟随后续轮次。若要让主会话参与、并行、持续监控、汇总、比较、复核或验证，用户必须在**当前请求**中明确写出该动作；此时才使用对应工具（持续监控使用 `conductor_watch`）。已创建状态、过去的 Grant、目标输出和创建卡片均不算此要求。本机 `desktop` Profile 已链接到干净 `0.1.6` 候选；若已有 Desktop 窗口，完整退出（含托盘）后再打开以加载它。安装本身不证明窗口已经加载、T37 的真实 Host/Edge 流程或最终完整验证，`0.1.4` 未实现 T36。

### 一次性回传的可见性与恢复（T37 `0.1.6` 源码候选）

一次性回传只有原父 `mayRead` 仍成立、请求会话确为原父、且原生卡片带回该 operation 的私有 capability 时才显示终态、原因、detail 和预览。capability 只能由创建工具结果的 `presentationMeta` 恢复，并仅随 `x-dsh-conductor-link-capability` header 发送；不得写入 URL、query、渲染工具内容、聊天正文或卡片文本。HTTP 投影还会重新验证 callback 与当前 operation/task/relay message、非空 instruction、dispatch guard 的 bindingVersion 及准确初始 Binding；任何一项不符时卡片保留导航但隐藏回传。原父 `mayRead` 失效（例如读取授权被撤销）时同样隐藏回传。目标 Agent 已退出或 Host 重启时，候选实现只能从 Host 正式公开历史接口重新找到已记录的初始 Binding、relay message 和首轮事件；不得读取 Session JSONL、私有 cache、恢复 Agent、换到当前 Binding 或猜测结果。相同终态重放仅更新同一记录一次，后续轮次始终忽略。Task release 后，未终态 callback 停止后台观察、不再读取 child；release 前已持久化的终态仍可在 `mayRead` 与 capability 允许时显示，因为不需要继续监控。

### 查看跨会话进度

当用户在当前请求明确要求知道已授权目标任务实际做了什么或已经得出什么结论时，直接调用：

```json
{"taskId":"<taskId>","view":"history"}
```

回执正文会逐条显示本页公开历史。不要要求目标先写进度 Markdown、汇报文件或另一个文档，再由主会话读取；这类文件只在它本来就是需要交付的成果时才应创建。`conductor_brief` 仅用于创建、分叉或明确交接时传递上下文，`conductor_export` 仅用于用户明确要求导出成果。刚创建或分叉成功不是读取或等待的自动触发条件。

若回执给出继续游标，使用相同任务和 `afterCursor` 读取下一页：

```json
{"taskId":"<taskId>","view":"history","afterCursor":"<returned-cursor>"}
```

公开历史仅包含 user／assistant 消息、工具调用和工具结果。Think、推理草稿、原始 token/chunk、私有 Session 文件和其他未投影事件不会显示；显示的历史文本也不构成对当前会话的授权。

用户当前请求明确要求等待新的状态变化时，同步等待用于等待，而不用于取代正文读取。例如：

```json
{"targets":[{"taskId":"<taskId>"}],"timeoutMs":60000}
```

等待醒来后再次执行 `view:"history"` 读取进展。直接历史、同步等待和后台自动回报分别使用 history、wait、report 游标，彼此不会吞掉结果。Binding 已改变、reader 已撤权或任务已解除管理时会拒绝相应读取；不要把空页或单目标权限错误解释为“任务没有工作”。

若目标 Agent 已退出但 Session 仍持久化，历史视图可经 Host 正式 Session 读取接口返回分离的公开记录，并标明 `historyOrigin:"persisted"`。该路径不会恢复 Agent、不能等待或发送，也不会提供 live 写入锚点。不要通过读取 JSONL、私有 cache 或手改 Session 文件替代该接口。

任务列表、快照、成果、工作流及高级操作继续通过聊天工具查询和执行，复用参数校验、控制关系、预算和幂等服务。仅由 notice 触发的模型轮仍不能写协调状态。历史面板 API 的短期能力令牌与白名单动作保留兼容性，当前产品界面不挂载这些入口。

`steer` 在后续步骤边界生效；`queue` 等待单独轮次。先读取 snapshot 获取 `ownerEpoch`、`bindingVersion` 与轮次锚点，再发送精确停止或修改队列。原会话输入保留 user 来源，转发使用 relay，后台回报使用 notice。轮次结束、成果验收和交接成功是不同事实。

## 跨 Host

参见 [远程配置](REMOTE.md)。SSH 使用运维已配置的 alias 和远端已安装的桥接入口，禁止复制浏览器 Cookie 或模型凭据；插件不生成 SSH key，不公开 Harness 控制端口。

迁移必须明确目标 workspace、已完成历史 cutoff、成果 ID 与路径映射。源冻结后，原生输入也由 Host pre-step 闸门阻止进入模型步骤；目标以不可派发状态准备，收到一致回执才启用。失败时保留源、已创建目标和文件；使用稳定 migration ID 对账或 `abort`。Abort 必须先取得目标永久禁用回执，才恢复源派发。插件卸载会移除其执行闸门，因此不要在迁移未对账时卸载参与的 Host 插件。

## 本地导出与分享

本地导出为 Markdown/JSON 和明确选择的附件包，默认排除凭据、环境变量值和完整工具原始输出。导出不是可执行恢复包。

在线服务参见 [HTTPS 分享指南](share-service.md)。`preview` 固定文档和附件摘要；用户确认后用原 `snapshotId` 发布。任务更新不会进入旧快照。默认七天有效，撤销须服务端确认；已下载副本不能召回。

发布操作固定最初服务源地址与控制 epoch，回执身份、期限和摘要必须匹配；未知上传只查询原服务回执，不能换服务重传。服务限制请求与磁盘快照读取为 8 MiB，并验证 UTF-8。发布/撤销经过 staging flush 与独占 hardlink 发布，文件系统不支持所需操作时安全失败。Windows Node 未提供目录 fsync，本轮未取得断电级持久保证；备份仍须覆盖快照和撤销标记整个目录。

## 恢复与升级

1. 停止继续提交重复操作，保存原 operation ID，读取操作阶段与绑定版本。
2. `prepared` 可能尚未派发；`dispatching` 经重启变为 `unknown`，不自动重发。普通创建可按既有准备记录恢复；无法确认的迁移创建不会再次创建后继。
3. 分享上传使用同 ID 查询服务回执；远程操作按最初 Host 和操作 ID 对账。没有回执保持 unknown。
4. 格式迁移先备份独立 `session_conductor` 数据域，再执行迁移；失败恢复备份，不推进版本。当前新增字段是可选字段，格式版本仍为 1。
5. 保留 Host Session 数据、协调域、独立兼容域、快照服务目录和明确命名的工作区。不要只恢复部分撤销记录，也不要通过手改 Session JSONL 进行恢复。

## 卸载与资源终态

从用户明确选择的 profile 移除 conductor bundle 后重启该 profile。移除兼容 bundle 会恢复原 Host gateway。普通会话、Git worktree、成果、协调记录与分享服务数据不会自动删除。原 Host 不会读取兼容包保留的 next-request overrides，回滚前按需要记录这些设置。

`conductor_cleanup preview` 展示插件资源；`execute` 只清理用户确认的精确 ID，仍被引用、活动、修改或状态未知的目录拒绝删除。远程注册删除不删除远程文件；有任务绑定的 Host 不能直接移除。

本轮保留的仅有源码、依赖、构建/候选产物和 `.verification` 证据。测试服务器、桥接子进程、浏览器和隔离 Host 均应在验证结束退出；具体终态见验收报告。无 Git 初始化、提交、推送、公开发布或正式部署。

## 概览/预览接口404与升级（0.2.1）

概览常驻，不提供关闭按钮。点击输出/来源标题或资源，在右侧预览；预览关闭不会关闭概览。窄窗口概览改为顶部紧凑布局，极窄窗口预览以临时抽屉显示。

如果bootstrap等旧路由可达，而 `/conductor/overview`、`/conductor/overview/result` 或 `/conductor/preview` 返回无结构404，先确认插件包关联，再完整退出Desktop（包括托盘）并重新打开。仅刷新前端不能刷新Host模块图；不要因此删除Profile或Session记录。新版会显示明确诊断。文件不存在、格式/大小限制等结构化错误另行显示，不与旧Host混淆。完整重开仍失败时检查当前Profile的插件加载日志和路由，不反复安装或改写ASAR。

文本预览仅对当前会话或已授权本机任务的工作区生效；最大512KiB，显示上限200,000个UTF-16代码单元。读取后重验授权、Binding、目录、provider和文件版本；拒绝越界、二进制和读取期间发生的身份变化。网页能否嵌入由目标站点决定，可使用“浏览器打开”。
