# 当前 Desktop 本地试用记录

## 当前已安装：Desktop 2.0.10 伴随包 0.1.1

日期：2026-09-16。本机 DSH Desktop 已是 **2.0.10**（未打包 `resources/app`，Host 包为 `0.1.5-rc.2`）。原先面向 2.0.3 / `dsh-host-apiproxy@0.1.1-rc.2` 的伴随包 `0.1.0` 不能再加载。已用官方离线 CLI 把干净外部包链接到 `desktop` Profile：

- `dsh-harness-compat@0.1.1`：insert-only overlay，保留官方 `session-controller` 与 `typert-gateway`，只挂载 `conductorSessionModelSelection` / `conductorSessionFork`。基线 SHA-256 `16ecb48f33996efe72868f1603223214430634c5ac4c3e8fe9060bf240e990ff`。
- `dsh-binary-files@0.1.1`：精确补丁 fs-local / fs-sandbox `0.1.5-rc.2`。
- `dsh-session-conductor@0.2.6`：沿用既有 T46 干净包。

官方 `--dump-config` 中 `dsh-session-conductor`、`conductor-binary-files`、`conductor-compatible-api-gateway` 各出现一次；`typert-gateway` 与 `session-controller` 仍在。单元测试：compat 11 项、binary 5 项通过。隔离三次 Host `verify:host` 尚未作为 0.1.1 结论。没有改写 Desktop app 目录，没有把带开发 `node_modules` 的源码目录链进 Profile。

**正常打开 DSH Desktop** 才能加载新组合。若仍停留在恢复模式，先从插件管理恢复或重启，不要 factory reset。

- 干净伴随包：`D:/dsh-local-plugins/dsh-session-conductor/0.1.1-20260916-desktop-2.0.10/`。
- 主插件：`D:/dsh-local-plugins/dsh-session-conductor/0.2.6-20260915-t46/package`。
- 收据：`.verification/desktop-install-2026-09-16-2.0.10/installation-2.0.10.json`。
- 安装前备份：`D:/dsh/plugin-backups/session-conductor-20260916-2.0.10-companions/before-upgrade/`。
- 回滚：同目录 `rollback-2.0.10-companions.ps1`；要求 Desktop 完全退出后，经官方 CLI `plugin remove` 卸下三个包，不直接覆盖 Profile。

## 历史安装 0.2.6：T46 侧栏开关与概览主界面归属

2026-09-15 本地完成 0.2.6 / PRD 2.11 / T46 的源码检查、隔离 Host/browser 布局验证、候选包封存和本机 `desktop` Profile 离线安装。当前安装链接为 `D:/dsh-local-plugins/dsh-session-conductor/0.2.6-20260915-t46/package`，包 `package.json` SHA-256 为 `3f72fca88470a7ce8ae9a7b4d23d3d8eaaa6a7bbec42124bdb3ff6090e383e6f`；候选归档 `dist/0.2.6-local-t46/dsh-session-conductor-0.2.6.tgz` 共 35 个文件，SHA-256 为 `57cf8b904bef9014fd0f114e300f4044908bf9eff743631136fb4824cd64de72`。

隔离 Desktop 2.0.3 Host/browser 在 1920×1000 会话中实测：侧栏开关位于 `conversation.session.header.utilities` 列表，`Session log` 右边（Session log x=1741…1852，开关 x=1860…1892）；概览卡位于主会话 owner 的正常文档流、宽屏右对齐（x=1574…1904，y=120…707），聊天滚动区保持会话容器全宽（x=280…1920、width=1640），滚动条位于主界面最右侧（x≈1912…1920），不再为概览预留右侧 padding。窄屏/长标题时仍使用概览顶部的可达回退入口，不显示两个开关。证据：`.verification/overview-2026-09-16T03-03-28-659Z/layout-t46-installed-verification.json`。

本次安装收据为 `.verification/desktop-install-2026-09-15-t46/installation-t46.json`；仅 `dsh-session-conductor` dependency 变化，bundle 顺序和 `cordis.patch.yml` 不变，官方 `--dump-config` 中 `dsh-session-conductor`、`conductor-binary-files`、`conductor-compatible-api-gateway` 各出现一次。安装脚本未启动或停止 Desktop GUI；当前正在运行的窗口仍持有 0.2.5 模块图。**必须完整退出 DSH Desktop（包括托盘进程）再正常打开**，才能加载 0.2.6/T46；仅刷新页面不能证明后台 Host 已升级。

- 候选包：`D:/dsh-local-plugins/dsh-session-conductor/0.2.6-20260915-t46/package`。
- 归档：`dist/0.2.6-local-t46/dsh-session-conductor-0.2.6.tgz`。
- 收据：`.verification/desktop-install-2026-09-15-t46/installation-t46.json`。
- 回滚：`D:/dsh/plugin-backups/session-conductor-20260915-t46/before-upgrade/rollback-t46.ps1`；要求完整退出 Desktop，并核验当前 0.2.6 链接与包哈希后，通过官方 offline CLI 恢复 0.2.5，不直接覆盖 Profile。
- 归档中的文档是安装前快照；本仓库文档在安装后追加了收据和实际加载待确认状态。不要修改已安装包目录，否则会使收据中的逐文件哈希失效。
- 用户完整退出并重开后的实际窗口加载确认仍待完成。

## 历史安装 0.2.5：Codex 类宽工作区

源码和隔离 Desktop Host/browser 已验证插件自有宽工作区：在排除左侧导航的会话可用区域中默认约 70% 工作区 / 30% 聊天，聊天与工作区最小宽度分别为 320/300 CSS px；支持拖动、左右方向键、Home 复位和本机比例记忆。小于 740 CSS px 时使用避开 Desktop 顶栏的全宽抽屉。打开工作区、输出、来源、网页或子智能体预览时概览卡隐藏，关闭后恢复；选择原生工具详情时按实际可见性隐藏概览，关闭后恢复。

隔离证据：`.verification/overview-2026-09-16T02-03-01-333Z/`，截图：[宽工作区](assets/wide-workspace.png)。1920×1000、1280×900 和 390×844 的几何、缩放、资源切换、键盘调整、原生详情恢复和无横向溢出均已核对；测试过程没有启动模型、修改用户会话或 ASAR。该结论覆盖隔离运行时；用户窗口仍须重开确认实际加载。

已通过官方 Desktop CLI 离线更新本机 `desktop` Profile 至 0.2.5。仅主插件依赖变化，bundle 顺序和 `cordis.patch.yml` 保持不变，`dsh-session-conductor`、`conductor-binary-files` 与 `conductor-compatible-api-gateway` 各出现一次。候选归档包含 35 个文件，SHA-256 为 `1a020e0f3cf9eee229c99b028f6f455e2dda702c67a05f38ac68773c045ac520`；安装后的 junction 指向 `D:/dsh-local-plugins/dsh-session-conductor/0.2.5-20260915-wide-workspace/package`，包 `package.json` SHA-256 为 `57fe49462c0f523158cbb41560b80d3eb023d73dcc2481eaab79dce7aaaacfd3`。

归档中的文档是安装前快照；本仓库文档在安装后追加了收据和实际加载待确认状态。不要修改已安装包目录，否则会使收据中的逐文件哈希失效。

- 候选包：`D:/dsh-local-plugins/dsh-session-conductor/0.2.5-20260915-wide-workspace/package`。
- 归档：`dist/0.2.5-local-wide-workspace/dsh-session-conductor-0.2.5.tgz`。
- 收据：`.verification/desktop-install-2026-09-15-wide-workspace/installation-wide-workspace.json`。
- 回滚：`D:/dsh/plugin-backups/session-conductor-20260915-wide-workspace/before-upgrade/rollback-wide-workspace-verified.ps1`；要求完整退出 Desktop，并核验当前 Profile、封存 0.2.4 包和 CLI 后才执行官方 offline add，不直接覆盖 Profile。

安装脚本只在 Electron Node 模式调用官方 CLI，没有启动或停止 Desktop GUI；安装收据记录 `existingDesktopProcessesWereNotStopped: true`。安装后的进程复核仍看到 DSH Desktop 进程的启动时间早于该轮安装，因此该轮之后的窗口不能视为已加载 0.2.5。请完整退出 Desktop（包括托盘进程）再正常打开，才能让新版 Host 加载；仅刷新页面不能证明后台模块已更新。用户窗口重开确认仍待完成。

## 历史安装 0.2.4：原生子智能体概览与侧栏

已通过官方 Desktop CLI 离线更新本机 `desktop` Profile 至 0.2.4。仅主插件依赖变化，其他依赖、bundle 顺序及 patch 保持不变；三个组成项各出现一次。95 个文件 / 1,386 项测试、typecheck/build/lint/smoke 与真实 Host/browser 验证通过。安装包运行时文件与最终浏览器验证包逐字节一致。

常驻概览新增“子智能体”，点击打开原生子智能体分组列表，显示名称、状态和可用的累计执行时间；点击健康条目打开原生会话，原生面包屑返回父会话。与 Conductor“委派任务”分区并存。宿主只有 running/inactive 状态，因此非运行显示“已结束 / 空闲”，不能当作成功完成；不编造进度摘要和完成时间。

**完整退出 Desktop（包括托盘进程），再正常打开**才能加载更新。本次没有停止或重启正在使用的 Desktop，用户实际窗口重开确认仍待完成。封存包中文档是安装前快照，以当前仓库及独立安装收据为准。

- 干净包：`D:/dsh-local-plugins/dsh-session-conductor/0.2.4-20260915-subagents/package`。
- 归档：`dist/0.2.4-local-subagents/dsh-session-conductor-0.2.4.tgz`，34 个文件，SHA-256 `1b53df6b073276e8402ee8de63635f09aec2c87a81b8ce7c780145d78814f20f`。
- 收据：`.verification/desktop-install-2026-09-15-subagents/installation-subagents.json`。
- 回滚：`D:/dsh/plugin-backups/session-conductor-20260915-subagents/before-upgrade/rollback-subagents-verified.ps1`；要求完整退出 Desktop，并核验当前 Profile、封存 0.2.3 包与 CLI 后才执行官方 offline add，不直接覆盖 Profile。
- 两轮 UI 测试均保持 5 次预设离线调用、父会话 1 轮；已结束子智能体未恢复 Agent。测试 Host、端口和浏览器已关闭，viewport 恢复；验证文件和旧包保留。用户会话及 Desktop ASAR 未修改，未提交、推送或发布。

## 历史安装 0.2.3：独立右侧栏入口

已通过官方Desktop CLI离线更新 `desktop` Profile 至0.2.3。仅主插件依赖变化，其他依赖、bundle顺序及patch不变，三个组成项各出现一次。93文件 / 1,352项测试、lint、smoke与真实Host/browser验证通过；安装包全部运行时文件与最终界面验证包逐字节一致。

普通会话标题栏右侧新增侧栏按钮，点击打开工作区首页，可查看输出文件、来源、网页预览、工具详情；预览中可返回首页。若窗口缩小或长标题把入口挤出会话可视区域，入口移到概览卡顶部右侧。关闭侧栏保留概览。不启动模型任务；侧边聊天、内嵌终端、完整文件树和Git工作树审查尚未接入。

**完整退出Desktop（包括托盘进程）再正常打开**才能加载更新。本次没有停止或重启正在使用的Desktop，实际用户窗口重开确认仍待完成；候选包中文档为安装前快照，以当前仓库及安装收据为准。

- 干净包：`D:/dsh-local-plugins/dsh-session-conductor/0.2.3-20260915-sidebar/package`。
- 归档：`dist/0.2.3-local-sidebar/dsh-session-conductor-0.2.3.tgz`，33文件，SHA-256 `d11d48499c97a1fc5d64703ec0e1199619ee3664f55a146f354a55726be03b2d`。
- 收据：`.verification/desktop-install-2026-09-15-sidebar/installation-sidebar.json`。
- 回滚：`D:/dsh/plugin-backups/session-conductor-20260915-sidebar/before-upgrade/rollback-layout-verified.ps1`，需完全退出Desktop，并校验当前Profile、封存0.2.2包和CLI才执行官方offline add；不直接覆盖Profile。
- 用户会话及Desktop ASAR未修改；旧版本保留。测试Host、端口、浏览器均已关闭，viewport恢复。未commit、push或公开发布。

## 历史安装0.2.2：小窗口与历史会话修复

已通过官方Desktop CLI离线更新 `desktop` Profile 至0.2.2；其他依赖、bundle顺序及patch保持不变，三个组成项各出现一次。源码通过91文件 / 1,339项测试、lint、smoke，带Desktop兼容模式定位容器的隔离Host/browser回归和真实Host冷会话HTTP验证通过。

修复窄窗口概览遮挡正文、极窄预览标题与关闭按钮被顶栏遮挡，以及冷历史会话只读鉴权。无需恢复Agent即可查看历史会话概览/预览；协调写仍要求活动Agent。截图具体403请求未经捕获，不把全部403都归为此原因。

**完整退出Desktop（包括托盘进程）再正常打开**，才能加载新版Host。安装没有停止现有Desktop；单独刷新不代表后台已升级。候选包中文档是安装前快照，以本节及独立安装收据为准。

- 安装目录：`D:/dsh-local-plugins/dsh-session-conductor/0.2.2-20260915-layout/package`。
- 归档：`dist/0.2.2-local-layout/dsh-session-conductor-0.2.2.tgz`，32文件，SHA-256 `c82a3e42ddd97e9ae8ffdf4195aa516ad810f2a1e99af384b8fe4240d32e20db`；全部运行时产物与最终浏览器验证包一致。
- 收据：`.verification/desktop-install-2026-09-15-layout/installation-layout.json`。
- 备份与回滚：`D:/dsh/plugin-backups/session-conductor-20260915-layout/before-upgrade/rollback-layout-verified.ps1`。要求Desktop完全退出，校验当前Profile、封存0.2.1包与官方CLI后再执行offline add；不会直接覆盖Profile。
- 保留旧包与本地验证证据；不修改ASAR或正式会话，不提交、推送或发布。测试Host、端口与浏览器标签均已关闭。

## 历史安装0.2.1：常驻概览与右侧预览

已通过官方Desktop CLI离线更新 `desktop` Profile，主包为0.2.1；其他依赖、bundle顺序及cordis.patch.yml保持原样，三个组成项各出现一次。源码、90文件 / 1,314项测试、lint、smoke和真实Host/browser验证已通过。安装收据为 `.verification/desktop-install-2026-09-15-preview/installation-preview.json`。用户Desktop进程没有被停止；实际窗口加载新版仍须完整退出重开。归档中的文档是安装前快照，以当前仓库本节及独立收据为准。

升级后完整退出Desktop（含托盘）并重新打开。进入普通会话，概览默认显示且没有关闭按钮；可点击输出/来源标题打开右側列表，点击资源在原生右栏预览。宽度不足时概览排在聊天上方，避免遮挡正文；关闭预览不会关闭概览。

本次404已核实为旧Host仍在运行：其启动早于0.2.0安装。只刷新页面会形成新前端配旧Host的状态；完整退出重开后才加载新接口。不需要删除Profile、会话或改写ASAR。

- 干净包：`D:/dsh-local-plugins/dsh-session-conductor/0.2.1-20260915-preview/package`。
- 本地归档：`dist/0.2.1-local-preview/dsh-session-conductor-0.2.1.tgz`，31文件，SHA-256 `1e4f1cbc648e500c90c281a647402322fd798a9591a39117129b79445151d3d2`。全部运行时文件与最终浏览器验证包逐字节一致。
- 备份：`D:/dsh/plugin-backups/session-conductor-20260915-preview/before-upgrade`。
- 正常安装后的回滚：该备份目录内 `rollback-preview-verified.ps1`，要求Desktop完全退出，并校验当前Profile、旧0.2.0包和CLI后才执行官方offline add；不会直接覆盖Profile。旧版本及原恢复证据保留。
- 本轮未commit、push或发布，没有改动ASAR和用户会话；测试Host、浏览器与端口均已关闭。



## 历史安装：0.2.0

2026-09-15 已确认本机原来仍链接 0.1.6，因此没有“概览”入口。现已通过官方 Desktop CLI 的 `plugin --profile desktop add --offline` 将封存的 0.2.0 干净包链接到 `D:/dsh/profiles/desktop`。仅主插件依赖变化；其他依赖、bundle 顺序与 `cordis.patch.yml` 保持不变，官方 `--dump-config` 复核三个配套组成项各出现一次。

1. 等待现有任务结束，正常退出 DSH Desktop，包括托盘中的后台进程，再正常打开。
2. 打开任意普通会话，在**会话标题栏右侧点击“概览”**。入口不要求先创建子任务；卡片默认收起。
3. 展开后可见输出内容、委派任务和来源。原聊天内创建卡片及返回发起会话保持可用。

单独刷新窗口不能证明 Host 已切换新版；“进入恢复模式”会暂停 Profile 加载，也不会出现概览入口。本次安装没有停止或重启现有 Desktop，因此用户窗口实际加载确认仍待完成。

- 独立安装目录：`D:/dsh-local-plugins/dsh-session-conductor/0.2.0-20260915-overview/package`，不含开发 node_modules。
- 归档：`dist/0.2.0-local-overview/dsh-session-conductor-0.2.0.tgz`，SHA-256 为 `b034651aa464f39cfbba696beeca9eb97ce87af1eb654ffc5c67e5f533f3945c`。包中文档为安装前快照。
- 收据：`.verification/desktop-install-2026-09-15-overview/installation-overview.json`。
- 备份及回退：`D:/dsh/plugin-backups/session-conductor-20260915-overview/before-upgrade/rollback-overview.ps1`。旧 0.1.6 包保留；该脚本要求 Desktop 完全退出，并校验当前安装及旧包后，才通过官方离线 CLI 回退，不把备份直接覆盖到 Profile。

## 历史试用记录：0.1.5

日期：2026-09-15。DSH Session Conductor **0.1.5** 已通过官方 Desktop CLI 离线链接到这台机器的 **DSH Desktop 2.0.3 / `desktop` Profile**；两个伴随包保持 0.1.0，不是公开发布版本。安装收据为 `.verification/desktop-install-2026-09-15/installation-delegation-only.json`。PRD 2.4 的 T36 已在该版本实现，并通过 `npm run check`（79 个测试文件 / 1,200 项测试）、lint、smoke、干净外部包的真实 Host/Edge E2E，以及 Profile 的独立官方 dump 组合复核。当前正在运行的 Desktop 没有被停止，仍持有旧模块图；完整退出（含托盘）并正常重新打开后的用户试用确认仍待完成。

0.1.0 的白屏问题已在 0.1.1 修复：声明 Cordis 服务依赖，使用零参数 slot 注入回调及 `register(options, component)` 的真实接口。0.1.2 改为聊天内创建卡片和来源返回链接，**不挂载浮动面板**；0.1.3 增加默认继承主工作区和主会话指定宿主名称；0.1.4 增加直接读取已授权子会话公开历史的进度路径，不再需要子会话为主会话另写报告文档。0.1.5 实现 T36：创建或分叉成功后，主会话默认只呈现创建结果并停止，不与目标重复工作，也不自动读取、等待、观察、发送、停止、监控、汇总、比较、复核或验证；仅用户在当前请求明确要求主会话参与、并行、监控、汇总、比较、复核或验证时例外。它已通过本地 check/lint/smoke、干净包、真实 Host/Edge 和 `desktop` Profile 链接验证。真实 Host/Edge 验证没有写入你的现有会话或调用模型；现有 Desktop 进程仍须完全退出并重开后才能由用户实际试用。

原生窗口需完整退出应用并正常重开以加载新的宿主与浏览器入口；从菜单选择“进入恢复模式”会暂停正常 Profile 加载，不能用于试用插件。

正在运行的进程可能仍缓存升级前的模块与 Host 路由。**完整退出（含托盘）再重开，单独刷新不能完成宿主升级。** 本次未强制停止你正在使用的 Desktop。

## 开始试用

1. 等待当前 Desktop 中的任务结束，使用应用的正常退出功能退出，再重新打开 Desktop。仅关闭窗口可能仍留在托盘，需要完整退出应用。
2. 新建或打开一个普通会话，直接使用原生聊天输入。新版不显示右下角协调面板按钮。
3. 在发起会话中要求创建或分叉任务；真实工具调用会显示创建卡片。准备好后点击 **打开会话**，新会话标题栏可点击 **返回发起会话**。刷新后跳转关系会重新读取，无需重新选控制会话。
4. 首次在普通会话输入以下指令，先确认真实能力：

   ```text
   调用 conductor_capabilities 检查多会话协调插件是否可用，并说明当前启用的功能。
   ```

5. 试用已安装 `0.1.5` 的创建卡片、默认委派和直接历史读取时，可以继续输入：

   ```text
   用 Session Conductor 创建一个名为“历史读取试用”的独立任务，读取当前项目的 README 并概述项目用途，不修改文件。创建成功后只显示“已创建会话 / 打开会话”，不要与新任务重复执行、读取其历史、等待、监控、发送、停止或验证；除非我在后续当前请求明确要求。
   ```

   新建任务默认使用发起会话的实际目录并加入其已有工作区。任务名称在发起会话决定，例如明确写“新会话命名为历史读取试用”，宿主标题会同步并固定。如果需要其他目录或独立 Git worktree，在主会话明确指定。任务与当前会话的身份不同；启动模型任务会使用你现有的模型服务和额度，安装验收不调用模型。上述“创建后停止”已在已链接的 `0.1.5` 中实现并完成安装前验证；只有完全退出并重开当前 Desktop 后的实际工具调用才能完成用户窗口确认。

需要监控、读取、发送、停止、汇总、比较、复核或验证时，在该次用户请求中明确任务名称和希望主会话执行的动作；T36 已将这些动作从普通创建后的默认路径中排除。每个窗口的原生输入始终发送给它当前打开的会话；从发起会话发给其他任务由协调工具执行。跳转不会发送消息、停止任务或改变控制权。交互与实现边界见 [NATIVE-LINKS](NATIVE-LINKS.md)，工具示例见 [DEMO](DEMO.md)。

## 安装位置与已启用内容

- 当前 profile：`D:/dsh/profiles/desktop`。
- 主插件独立安装目录：`D:/dsh-local-plugins/dsh-session-conductor/0.1.5-20260915-delegation-only/package/`。
- 两个伴随包安装目录仍为 `D:/dsh-local-plugins/dsh-session-conductor/0.1.0-2026-09-15T07-32-33-735Z/` 中的对应 package。
- 安装包：`dsh-session-conductor@0.1.5`、`dsh-harness-compat@0.1.0`、`dsh-binary-files@0.1.0`。
- 原 `dsh-context`、`dshmarket`、`dsh-computer-use` 及原 base/web bundle 均保留。
- 兼容包提供目标模型选择和分叉参数扩展；二进制包替换原 fs provider，保留原沙盒语义。原组合配置中的 gateway 与 fs-sandbox 都没有显式配置，因此无需复制额外配置。
- 两项 Host 兼容扩展已声明；跨 Host 与在线分享保持关闭。
- 没有修改 Desktop ASAR、凭据、会话历史或原插件源文件，没有初始化 Git、提交或公开发布。

插件目录是候选归档的干净解包目录，不能改为链接带有开发 `node_modules` 的源码目录，否则可能遮蔽 Desktop 宿主包并触发基线保护。

## 验证与当前终态

- `npm run check` 已通过 **79 个测试文件 / 1,200 项测试**；`npm run lint` 和 `npm run smoke` 也已通过。
- 干净外部 `0.1.5` 包在真实 Desktop Host、完整 Harness Web 界面和本机 Edge 中通过 4 个场景：两个创建结果可见地结束默认委派、显式要求时才展示 `read(history)` 正文、创建卡片/来源返回在刷新后仍正确、两个标签隔离、真实 fork 继承发起工作区并保留发起会话命名。证据为 `.verification/navigation-2026-09-15T10-01-35-586Z/summary.json`；`errors` 为空、`providerCalls` 为 0、`responseInterception` 为 false，端口 53932 已释放。
- 最终归档为 `dist/local-candidate-2026-09-15-delegation-only-final/dsh-session-conductor-0.1.5.tgz`，27 个文件，SHA-256 `1ec3e4259a5bcd240de98eb4960fccf24208b5e779b4ba6408b4ff5ede04379f`；最终记录确认其与干净外部包一致。
- 官方离线 CLI 已将当前 `desktop` Profile 链接到 `0.1.5`。安全恢复路径没有重新执行 `add`，收据 `.verification/desktop-install-2026-09-15/installation-delegation-only.json` 记录 `resumed: true` 与 `compositionChecked: false`；随后独立只读官方 dump 复核 `.verification/desktop-install-2026-09-15/composition-delegation-only.json` 确认主插件和两个 provider 的三个 ID 各一行，Profile 文件未改变。
- **完整退出并重开后的原生窗口仍待用户试用确认。** 安装时没有强制停止正在使用的 Desktop，当前进程仍可能使用旧模块图。pnpm 的 peer dependency 提示来自宿主提供依赖的链接方式；没有为消除提示另装一套宿主依赖。

## 备份与回滚

本轮安装前备份位于：

```text
D:/dsh/plugin-backups/session-conductor-2026-09-15T07-32-33-735Z/before-delegation-only/
```

包含更新前的 Profile 配置和 CLI 记录。`installation-delegation-only.json` 记录包摘要、安装状态与验证关联；`install-cli.log` 记录 CLI 结果。

如需回滚，先完整退出 Desktop，再在 PowerShell 执行：

```powershell
& 'D:\dsh\plugin-backups\session-conductor-2026-09-15T07-32-33-735Z\before-delegation-only\rollback-delegation-only.ps1'
```

脚本只有在 Desktop 已退出且受影响配置与安装完成时的摘要一致时，才恢复更新前的 Profile 配置。发现安装之后的配置修改就停止，避免覆盖后续工作。恢复后重新打开 Desktop。候选目录、未被加载的包链接、会话、worktree 和协调数据保留，不自动删除。

如果提示配置已变化，按实际差异恢复 `dsh-session-conductor` 链接和 conductor bundle 行，不直接覆盖备份。真实创建工具调用后没有卡片、能力工具不可用，或历史读取仍要求报告文件时，先确认已完整退出并重新打开、加载版本为 `0.1.5` 且 Profile 仍为 `desktop`；普通文字确认不能替代真实工具调用。创建后默认停止而不跟进是 T36 的 `0.1.5` 行为，不能由历史 `0.1.4` 推断。
