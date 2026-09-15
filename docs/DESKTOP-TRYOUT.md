# 当前 Desktop 本地试用记录

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
