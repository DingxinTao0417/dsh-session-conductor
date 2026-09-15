# 多会话操作演示

更新日期：2026-09-15。以下 JSON 是工具参数示例，字段已对照 `src/tools.ts`，不是会自动执行的脚本。`<taskId>`、路径、模型与操作 ID 均须替换成当前环境中的值；示例数字 `1`、`42` 只表示字段类型，不能代替真实读取结果。先按 [OPERATIONS](OPERATIONS.md) 配置隔离 profile，并调用 `conductor_capabilities` 确认实际能力。需要模型的操作可能使用所选 provider；本项目自动验收使用受控 provider，不发起模型网络请求。T36 已在本地 `0.1.5` 实现，并通过 `npm run check`（79 个测试文件 / 1,200 项测试）、lint、smoke、干净外部包真实 Host/Edge 4 场景和官方离线 CLI 的 `desktop` Profile 链接验证；尚未公开发布。现有 Desktop 进程须完整退出（含托盘）并重开后才会加载它，用户重启确认仍待完成。`0.1.4` 不包含此行为。

## 1. 创建／分叉后默认委派即止（T36 已实现并完成安装前验证）

对一个已经存在的非 Git 演示目录，调用 `conductor_create`：

```json
{"title":"演示任务","cwd":"D:/conductor-demo","contextMode":"empty","operationId":"demo-create-001"}
```

省略 instruction 使任务准备后保持空闲。若要隔离 Git 工作，明确使用 `gitStrategy: "current_head"`、`repoPath` 和 `worktreePath`，不要将普通 cwd 示例误认为 worktree 请求。返回的 `taskId` 是逻辑身份，`sessionId` 是 Host 身份；`preparation` 尚未 ready 时可调用 `conductor_operation`，但这只用于完成创建准备并显示真实创建结果：

```json
{"action":"status","operationId":"demo-create-001"}
```

在 `0.1.5` 中，创建成功时主会话到此为止：显示创建卡片和“打开会话”，不要重复目标工作，不要自动 `read`、`wait`、`watch`、`send`、`stop`、监控、汇总、比较、复核或验证。该规则同样适用于 `conductor_fork`；目标收到的首条指令由目标独立执行。干净包、真实 Host/Edge E2E 和 `desktop` Profile 链接已完成；当前 Desktop 仍须完整退出并重开后才可进行用户窗口确认。

只有用户在**当前请求**明确要求查看进度、汇总、比较、复核或验证时，才读取已授权的公开历史，而不要求目标先生成报告文件：

```json
{"taskId":"<taskId>","view":"history"}
```

回执正文逐条给出本页公开 user／assistant 消息、工具调用和工具结果。Think、推理草稿、原始 token/chunk 与私有 Session 数据不会出现；显示出的文本仅是进度证据，不能授予当前会话新权限。若返回继续游标，读取下一页：

```json
{"taskId":"<taskId>","view":"history","afterCursor":"<returned-cursor>"}
```

若该当前请求还明确要求等待新变化，才使用 `conductor_wait`，并在醒来后重新读取正文，而不是改用 `conductor_brief` 或 `conductor_export`：

```json
{"targets":[{"taskId":"<taskId>"}],"timeoutMs":60000}
```

`brief` 只用于明确的创建／分叉／交接上下文，`export` 只用于明确要求的可交付成果。history、wait 和后台 report 游标彼此独立；如果输出预算不足以显示完整公开记录，历史游标不会前进。目标 Agent 不再 live 但 Session 仍持久化时，history 结果可标记为 `historyOrigin:"persisted"`；它仅可读，不恢复 Agent，也不能用于等待或发送。

准备状态不是任务完成状态。若请求回执丢失，原创建参数与 operationId 保持不变；不要生成第二个 ID 来“重试”。创建卡片、目标输出、历史 Grant 或“任务已创建”均不是 T36 的例外；参与、并行、监控、汇总、比较、复核或验证必须由用户在当前请求明确要求。

## 2. 补充、排队与精确停止

只有用户在当前请求明确要求补充、排队或停止时，才将已读取结果的 `bindingVersion`、`ownerEpoch` 分别传为 `expectedBindingVersion`、`expectedOwnerEpoch`。调用 `conductor_send`：

```json
{"taskId":"<taskId>","text":"请概述该目录中的公开项目文件。","mode":"steer","expectedBindingVersion":1,"expectedOwnerEpoch":1,"operationId":"demo-send-001"}
```

`accepted` 表示 Host 受理；`pending` 表示仍由插件保留待派发。两者都不是完成。需要独立后续轮次时将 mode 改成 `queue` 并使用一个新的 operationId。用 `conductor_queue` 查看未消费输入：

```json
{"taskId":"<taskId>","action":"list"}
```

只有仍未消费且由本任务通过插件投递的消息可以撤回：

```json
{"taskId":"<taskId>","action":"withdraw","messageId":"<messageId>","expectedBindingVersion":1,"expectedOwnerEpoch":1,"operationId":"demo-withdraw-001"}
```

停止前再次读取；仅当返回活动轮次锚点时调用 `conductor_stop`，把实际数值传入：

```json
{"taskId":"<taskId>","expectedTurn":1,"expectedStartSeq":42,"expectedBindingVersion":1,"expectedOwnerEpoch":1,"operationId":"demo-stop-001"}
```

旧轮已结束或绑定改变时应看到拒绝，不能把停止自动转向新的轮次。`interrupt_and_send` 是 `conductor_send` 的 mode；它需要同样锚点且必须确认停止后才能投递新文本。单纯停止使用 `conductor_stop`，不存在 `conductor_send mode: "interrupt"` 的公开参数。

## 3. 模型和分叉

先 `conductor_model` 读取该 Host 的目录及实际配置：

```json
{"action":"show","taskId":"<taskId>"}
```

确认独立模型兼容包已挂载后，按目录中的真实 provider/model 设置：

```json
{"action":"set","taskId":"<taskId>","provider":"<provider>","model":"<model>"}
```

该工具没有 operationId 参数；不确定的模型写回执应先重新 show 对账，不能声称未生效或盲重写。`nextSelection`、`lastUsed`、来源和持久化状态分别展示。可选 `reasoningEffort` 须符合该模型实际能力。

在源至少有一个已完成轮次后，且用户当前请求明确要求分叉时，调用 `conductor_fork`：

```json
{"sourceTaskId":"<taskId>","title":"演示分叉","expectedBindingVersion":1,"expectedOwnerEpoch":1,"operationId":"demo-fork-001"}
```

分叉创建新 Task，不继承控制授权、未消费队列或在途输出；省略模型时继承源的有效 next 配置。省略工作区选项会继承源目录；需要独立 worktree 时明确传 Git 起点参数。当前 T36 中，分叉成功后主会话也默认只显示结果和跳转；不会自动检查、跟进或重做分叉目标的工作。原生 Host 的 `newSessionId/workspaceId/cwd` 扩展与此工具参数不是同一个接口。

## 4. 两节点工作流

先准备两个受控任务，将其实际 taskId 填入定义。`conductor_workflow` 的 validate/save 参数为：

```json
{"action":"validate","definition":{"workflowId":"demo-flow","title":"演示流程","rework":{"maxRounds":2},"budget":{"maxTurns":4,"maxConcurrent":1},"nodes":[{"nodeId":"draft","taskId":"<task-a>","instruction":"提交一份可检查的初稿。","acceptance":"用户确认初稿满足要求","failure":{"onFail":"stop"}},{"nodeId":"review","taskId":"<task-b>","dependsOn":["draft"],"instruction":"按已确认要求进行复核。","acceptance":"用户确认复核完成","failure":{"onFail":"stop"}}]}}
```

把 action 改为 save 保存。明确授权此流程后，用 `{"action":"start","workflowId":"demo-flow"}` 创建运行，再用 `{"action":"drive","runId":"<runId>","maxNodes":1}` 驱动。六项启动条件仍须满足；没有授权、成果输入、环境或模型固定能力时应读取拒绝原因，不绕过它。

节点完成并经用户按固定规则验收后，调用：

```json
{"action":"verdict","runId":"<runId>","nodeId":"draft","result":"pass","by":"user","rule":"用户确认初稿满足要求"}
```

只有真实用户确认才能使用 `by: "user"`。模型评审不能代替用户验收。运行期间修改目标 next 模型会阻止后续派发；恢复与快照一致的设置并明确 resume，或另行处理变更，不静默更新在途快照。此示例展示顺序依赖，若下游要消费文件，还应登记并固定真实 `inputArtifacts`，不能把 dependsOn 当作文件交接。

## 5. 同 Host 迁移与固定分享

同 Host 迁移保持 taskId，使用 `conductor_handoff`，目标目录须已存在：

```json
{"taskId":"<taskId>","targetPath":"D:/conductor-demo-next","expectedBindingVersion":1,"expectedOwnerEpoch":1,"operationId":"demo-handoff-001"}
```

先处理待输入、待审批和未消费队列。异步结果含 operationId/pending，通过操作状态查询跟进。跨 Host 迁移是另一个 `conductor_remote` 工具，其实际字段和部署条件见 [REMOTE](REMOTE.md)，本演示不登记远程连接。

`conductor_share` 先生成固定预览：

```json
{"action":"preview","taskId":"<taskId>","format":"markdown","attachmentIds":[],"operationId":"demo-preview-001"}
```

仅在服务已配置、用户查看预览并明确要求发布后，才调用以下参数；本文件本身不构成发布授权：

```json
{"action":"publish","taskId":"<taskId>","snapshotId":"<snapshotId>","confirmed":true,"lifetimeDays":7,"operationId":"demo-publish-001"}
```

后续任务修改不会进入该快照。撤销使用 `{"action":"revoke","shareId":"<shareId>","operationId":"demo-revoke-001"}`，服务端确认后才能记为撤销；已下载副本不能召回。

## 6. 遗留面板兼容接口（不作为日常入口）

当前产品不挂载浮动面板、卡片详情面板或高级动作控制台；日常创建、跳转、读取、发送和停止都应在普通聊天中使用前述工具。以下 HTTP 参数只保留给历史兼容回归和受控隔离测试，不能把它当作推荐工作流、实际可见界面或 T36 的绕过方式。

```json
{"action":"send","operationId":"panel-send-001","parameters":{"taskId":"<taskId>","text":"请报告当前进展。","mode":"steer","expectedBindingVersion":1,"expectedOwnerEpoch":1}}
```

遗留接口由面板处理 Bearer 令牌，勿把令牌或 caller 字段写入动作参数。它不是可视 DAG 编辑器，也不接受任意 RPC 或 shell；它不改变普通聊天的默认委派规则。历史浏览器场景的自动验收及截图见 [ACCEPTANCE](ACCEPTANCE.md)。
