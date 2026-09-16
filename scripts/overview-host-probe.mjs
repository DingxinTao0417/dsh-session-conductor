/** Real Host turns with a deterministic, offline adapter. Only isolated test-profile data is written. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LlmAdapter, createUserMessage, createToolResultMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
const verifySubagents = process.env.CONDUCTOR_SUBAGENTS_VERIFY === '1'
export const inject = ['apiProxy', 'agents', 'sessions', 'tools', 'llm', 'agentDefaultModel', 'workspaceRegistry', 'sessionTitle', 'sessionQuery', ...(verifySubagents ? ['subagents'] : [])]
const run = process.env.BINARY_RUN
const layoutRegression = process.env.CONDUCTOR_LAYOUT_REGRESSION === '1'
const verifyColdSession = layoutRegression && process.env.CONDUCTOR_COLD_SESSION_VERIFY === '1'
const childTitle = layoutRegression ? '前沿模型家族综合排名与性价比分析：长标题、父会话来源与一百一十四条来源布局回归' : '检查插件交互'
// Reserved example.test addresses are display-only fixture data; no web requests are made.
const layoutSources = layoutRegression ? Array.from({ length: 114 }, (_, index) => 'https://example.test/layout-source-' + String(index + 1).padStart(3, '0')) : []
const layoutAnswer = layoutRegression ? '\n\n## 窄窗口布局回归正文\n\n' + Array.from({ length: 18 }, (_, index) => '### 检查项目 ' + String(index + 1) + '\n\n- 概览、长标题和返回父会话入口应分别占据真实布局空间，不能覆盖聊天正文。\n- 调整窗口宽度、打开预览、展开全部来源后，正文与输入框仍须可见和可操作。\n- 这些段落和来源均为隔离测试数据，不表示对任何真实产品或网页的评测。').join('\n\n') : ''
let providerCalls = 0
class OfflineAdapter extends LlmAdapter {
  async listModels() { return [{ provider: 'overview-fixture', id: 'test', name: 'Offline test' }] }
  async resolveModel(provider, id) { return { provider, id, name: 'Offline test' } }
  async *stream(options) {
    providerCalls++
    const input = options.messages.filter(message => message.role === 'user').at(-1)
    const instruction = input?.content?.filter(block => block.type === 'text').map(block => block.text).join('') ?? ''
    const nativeInstruction = verifySubagents ? options.messages.filter(message => message.role === 'user')
      .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text))
      .find(text => text.includes('[native-subagent-fixture]')) : undefined
    if (nativeInstruction !== undefined) {
      const text = nativeInstruction.includes('[hold-until-disposed]') ? '原生子智能体隔离测试：离线运行已开始，等待测试结束后通过公开生命周期清理。' : '原生子智能体隔离测试已完成；这是正式 spawn provider 执行的一轮离线结果。'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      if (nativeInstruction.includes('[hold-until-disposed]')) {
        // A controlled real Agent turn, never a fabricated client status. Its
        // owned run/continuation is released by public disposal during teardown.
        assert(options.signal, 'controlled native fixture requires the adapter cancellation signal')
        await new Promise((resolve, reject) => {
          const abort = () => reject(options.signal.reason ?? new Error('Native fixture disposed'))
          if (options.signal.aborted) abort()
          else options.signal.addEventListener('abort', abort, { once: true })
        })
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const text = (instruction.includes('追加') ? '追加任务已完成：补充了兼容性与回归检查。\n这是独立的第二次委派结果。' : '初始任务已完成：会话创建、目录继承与原生跳转均可用。\n这份结果通过公开会话历史返回，无需导出文档。') + layoutAnswer
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function prepareNativeSubagents(ctx, parent) {
  assert(ctx.subagents.list().includes('spawn'), 'isolated native fixture requires the real spawn provider')
  const signal = new AbortController()
  ctx.effect(() => () => signal.abort(new Error('Native subagent fixture unloaded')))
  const prompt = hold => [{ type: 'text', text: '[native-subagent-fixture]' + (hold ? ' [hold-until-disposed]' : '') + '\n仅使用隔离测试的离线适配器，不访问网络或真实用户会话。' }]
  const completed = await ctx.subagents.start('spawn', { parent, signal: signal.signal, label: '已结束：原生代码检查', prompt: prompt(false) })
  ctx.effect(() => () => completed.dispose())
  assert.equal((await completed.result).stopReason, 'completed')
  assert(completed.localAgent, 'the fixture uses the official in-process provider')
  assert.equal(completed.localAgent.session.header.origin, 'subagent')
  assert.equal(completed.localAgent.session.header.parentSession, parent.id)
  await ctx.sessions.flush(completed.localAgent.session)
  await completed.dispose()
  assert.equal(ctx.agents.get(completed.id), undefined, 'completed native fixture must be cold')

  const running = await ctx.subagents.start('spawn', { parent, signal: signal.signal, label: '运行中：原生长任务验证', prompt: prompt(true) })
  // Observe the owned promise even when the Host shuts down during browser QA.
  void running.result.catch(() => {})
  ctx.effect(() => () => running.dispose())
  const continuable = await ctx.subagents.startContinuable({ provider: 'spawn', label: '可继续：原生子会话验证', childId: 'overview-native-continuable',
    signal: signal.signal, request: { parent, prompt: prompt(true) } })
  // Closing the parent lineage before draining suppresses its native settlement
  // wake. Do not replace this with drainChildren: that API intentionally wakes it.
  ctx.effect(() => () => ctx.subagents.drainContinuableDescendants([parent]))

  const diagnosticId = 'overview-native-diagnostic'
  const diagnostic = await ctx.agents.create({ sessionId: diagnosticId,
    meta: { cwd: parent.session.header.cwd, parentSession: parent.id, origin: 'subagent' } })
  try {
    // Deliberately missing identity fixture using public storage metadata. The
    // Host itself classifies the missing descriptor; no custom event is written.
    diagnostic.agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text',
      text: '隔离诊断夹具：此原生来源会话未获得 descriptor，用于验证宿主诊断行。',
    }] }), { surfaceOp: 'append' })
    await ctx.sessions.flush(diagnostic.agent.session)
  } finally { await diagnostic.dispose() }

  let catalog
  for (let attempt = 0; attempt < 200; attempt++) {
    const response = await ctx.apiProxy.subagents.list({ rpcId: crypto.randomUUID(), payload: { parentSessionId: parent.id } })
    assert.equal(response.result.ok, true, JSON.stringify(response.result))
    catalog = response.result.value
    const byId = new Map(catalog.entries.map(entry => [entry.id, entry]))
    if (byId.get(running.id)?.activity === 'running' && byId.get(continuable.childId)?.activity === 'running' && providerCalls === 5) break
    await pause(25)
  }
  const byId = new Map(catalog.entries.map(entry => [entry.id, entry]))
  assert.equal(byId.get(completed.id)?.kind, 'child')
  assert.equal(byId.get(completed.id)?.activity, 'inactive')
  assert.equal(byId.get(completed.id)?.mode, 'one-shot')
  assert.equal(byId.get(running.id)?.activity, 'running')
  assert.equal(byId.get(continuable.childId)?.activity, 'running')
  assert.equal(byId.get(continuable.childId)?.mode, 'continuable')
  assert.equal(byId.get(diagnosticId)?.kind, 'diagnostic')
  assert.equal(byId.get(diagnosticId)?.reason, 'corrupt')
  const history = await ctx.apiProxy.subagents.history({ rpcId: crypto.randomUUID(), payload: {
    parentSessionId: parent.id, childSessionId: completed.id, mode: 'one-shot', maxMessages: 5,
  } })
  assert.equal(history.result.ok, true, JSON.stringify(history.result))
  assert(history.result.value.events.some(entry => entry.event.type === 'turn/end' && entry.event.data.reason.kind === 'completed'))
  assert.equal(ctx.agents.get(completed.id), undefined, 'native history reads must not reactivate the disposed child')
  assert.equal(providerCalls, 5, 'native fixture adds exactly three offline child calls')
  assert.equal(parent.session.events.filter(event => event.type === 'turn/start').length, 1, 'native fixture must not wake the parent')
  const result = { parentSessionId: parent.id, completedId: completed.id, runningId: running.id,
    continuableId: continuable.childId, diagnosticId, catalog,
    completedHistory: { readThroughPublicApi: true, completedTurnPresent: true, agentRemainedAbsent: true,
      subagentTiming: history.result.value.projections?.values?.subagentTiming },
    providerCalls, extraNativeCalls: 3, parentTurns: 1, realHost: true, syntheticClientData: false,
    controlledRunning: 'held in the offline adapter until public run disposal / continuation drain', installedHarnessModified: false }
  await writeFile(join(run, 'native-subagents-verification.json'), JSON.stringify(result, null, 2))
  return result
}
async function verifyPersistedSessionReads(ctx, parent, output) {
  const coldSessionId = 'overview-cold-fixture'
  const handle = await ctx.agents.create({ sessionId: coldSessionId, meta: { cwd: parent.session.header.cwd } })
  // The fixture owns this exact handle. Only public append/flush/dispose APIs are
  // used; neither private registries nor persisted Session files are touched.
  try {
    handle.agent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text',
      text: '隔离测试记录：验证已持久化且不再运行的会话可以只读预览工作区文件，不派发模型。',
    }] }), { surfaceOp: 'append' })
    await ctx.sessions.flush(handle.agent.session)
  } finally { await handle.dispose() }
  const assertCold = () => {
    assert.equal(ctx.agents.get(coldSessionId), undefined, 'read verification must not restore the cold Agent')
    assert.equal(providerCalls, 2, 'cold reads must not dispatch a model call')
    assert.equal(parent.session.events.filter(event => event.type === 'turn/start').length, 1, 'cold reads must not wake the parent')
  }
  assertCold()
  const records = (await ctx.sessionQuery.listSessions()).filter(record => record.header.id === coldSessionId)
  assert.equal(records.length, 1, 'disposed fixture must remain in public persisted-session metadata')
  assert.equal(records[0].header.cwd, parent.session.header.cwd)
  assertCold()
  const port = Number(process.env.BINARY_PORT)
  assert(Number.isInteger(port) && port > 0 && port <= 65535, 'isolated Host port must be passed by the runner')
  const origin = 'http://127.0.0.1:' + String(port)
  let token
  const request = async (path, body) => {
    assertCold()
    const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { origin, 'sec-fetch-site': 'same-origin', accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token === undefined ? {} : { authorization: 'Bearer ' + token }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
    })
    const value = await response.json()
    assertCold()
    return { status: response.status, value }
  }
  const bootstrap = await request('/conductor/panel/bootstrap', { controllerSessionId: coldSessionId })
  assert.equal(bootstrap.status, 200, 'cold bootstrap: ' + String(bootstrap.value.error ?? bootstrap.value.message ?? 'unexpected status'))
  assert.equal(bootstrap.value.authority, 'local-user')
  assert.equal(bootstrap.value.controller.sessionId, coldSessionId)
  assert.deepEqual(bootstrap.value.actions, [])
  assert.equal(typeof bootstrap.value.token, 'string')
  token = bootstrap.value.token
  const overview = await request('/conductor/overview')
  assert.equal(overview.status, 200)
  assert.equal(overview.value.sessionId, coldSessionId)
  assert.deepEqual(overview.value.tasks, [])
  const preview = await request('/conductor/preview', { path: output })
  assert.equal(preview.status, 200, 'cold preview: ' + String(preview.value.error ?? preview.value.message ?? 'unexpected status'))
  assert.equal(preview.value.kind, 'text')
  assert.equal(preview.value.truncated, false)
  assert(preview.value.text.includes('隔离测试产物：会话跳转、独立回执与默认目录。'))
  const refused = await request('/conductor/panel/action', { action: 'create', operationId: 'cold-write-must-refuse',
    parameters: { title: '只读冷会话不得创建此任务', instruction: '这是必须被拒绝的隔离测试请求。', contextMode: 'empty' } })
  assert.equal(refused.status, 409)
  assert.match(refused.value.error, /^CONTROLLER_INACTIVE:/)
  assertCold()
  // Never persist the UserUI bearer token or request headers in evidence.
  await writeFile(join(run, 'cold-session-verification.json'), JSON.stringify({ coldSessionId,
    createdWithPublicAgentHandle: true, disposedWithPublicHandle: true, persistedMetadataPresent: true,
    bootstrap: { status: bootstrap.status, authority: bootstrap.value.authority, actions: bootstrap.value.actions },
    overview: { status: overview.status, sessionId: overview.value.sessionId, taskCount: overview.value.tasks.length },
    preview: { status: preview.status, kind: preview.value.kind, truncated: preview.value.truncated, contentMatched: true },
    coordinationWrite: { status: refused.status, errorCode: 'CONTROLLER_INACTIVE' },
    agentRemainedAbsent: true, providerCalls, parentTurns: 1, installedHarnessModified: false,
  }, null, 2))
  return coldSessionId
}
async function prepare(ctx) {
  ctx.llm.registerAdapter(['overview-fixture'], new OfflineAdapter())
  await ctx.agentDefaultModel.saveSelection({ provider: 'overview-fixture', model: 'test' })
  const workspace = await ctx.workspaceRegistry.create(join(run, 'workspace'), '概览验证工作区')
  const parentId = 'overview-parent', parentTitle = layoutRegression ? 'AI代码能力与代理排名调查：窄窗口长标题来源返回布局回归' : '插件升级与交互设计'
  assert.equal((await ctx.apiProxy.sessions.create({ rpcId: crypto.randomUUID(), payload: { sessionId: parentId, workspaceId: workspace.id } })).result.ok, true)
  await ctx.apiProxy.sessions.rename({ rpcId: crypto.randomUUID(), payload: { sessionId: parentId, title: parentTitle } })
  const parent = ctx.agents.get(parentId)
  parent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '创建一个任务检查插件交互。参考 https://github.com/DingxinTao0417/dsh-session-conductor 和 https://example.com/design 。这是隔离测试数据。' }] }), { surfaceOp: 'append' })
  parent.session.append('turn/start', { turn: 1 })
  parent.session.append('step/start', { turn: 1, step: 1 })
  const create = ctx.tools.get('conductor_create')
  const args = { operationId: 'overview-create', title: childTitle, instruction: '检查会话跳转与工作区继承（独立测试数据）。' + (layoutRegression ? '\n以下 114 个地址仅供来源列表布局验证，无需访问：\n' + layoutSources.join('\n') : ''), contextMode: 'empty' }
  const callId = crypto.randomUUID()
  parent.session.append('tool/call', { turn: 1, step: 1, callId, name: 'conductor_create', arguments: JSON.stringify(args) })
  let value
  for (let count = 0; count < 400; count++) {
    value = await create.execute(args, { callId, agent: parent })
    if (value.preparation === 'ready') break
    assert.notEqual(value.preparation, 'failed', JSON.stringify(value))
    await pause(25)
  }
  assert.equal(value.preparation, 'ready')
  parent.session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, isError: false, content: create.output.render(args, value) }), meta: create.output.presentationMeta(args, value) }, { surfaceOp: 'append' })
  parent.session.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({ source: { provider: 'overview-fixture', model: 'test' }, content: [{ type: 'text', text: '已创建「' + childTitle + '」，它会在当前工作区独立执行。完成后，这里的创建卡片会收到结果。' }] }) }, { surfaceOp: 'append' })
  parent.session.append('step/end', { turn: 1, step: 1 })
  parent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await ctx.sessions.flush(parent.session)
  const childId = value.sessionId ?? value.binding?.sessionId
  const child = ctx.agents.get(childId)
  assert.equal(child.session.header.cwd, parent.session.header.cwd)
  assert(workspace.sessionIds.includes(childId))
  const waitTurn = async count => {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (child.session.events.filter(event => event.type === 'turn/end').length >= count) return
      await pause(25)
    }
    throw Error('Offline child turn did not finish')
  }
  await waitTurn(1)
  if (layoutRegression) {
    // Public fixture-only user reference record: relay messages deliberately do not
    // count as user-provided sources. Appending/flush does not dispatch an Agent turn.
    child.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text',
      text: '布局回归夹具：以下 114 个地址为合成来源记录，仅验证来源列表显示与滚动，无需访问。\n' + layoutSources.join('\n'),
    }] }), { surfaceOp: 'append' })
    await ctx.sessions.flush(child.session)
  }
  await ctx.tools.get('conductor_send').execute({ operationId: 'overview-send', taskId: value.taskId, text: '追加检查兼容性与回归范围。', mode: 'steer' }, { callId: crypto.randomUUID(), agent: parent })
  await waitTurn(2)
  await ctx.sessions.flush(child.session)
  const output = join(run, 'workspace', '交互检查清单.md')
  await writeFile(output, '# 交互检查清单\n\n隔离测试产物：会话跳转、独立回执与默认目录。\n', 'utf8')
  await ctx.tools.get('conductor_artifact_register').execute({ artifactId: 'overview-artifact', taskId: value.taskId, kind: 'file', name: '交互检查清单.md', path: output }, { callId: crypto.randomUUID(), agent: parent })
  const coldSessionId = verifyColdSession ? await verifyPersistedSessionReads(ctx, parent, output) : undefined
  const nativeSubagents = verifySubagents ? await prepareNativeSubagents(ctx, parent) : undefined
  assert.equal(parent.session.events.filter(event => event.type === 'turn/start').length, 1, 'child must not wake the parent')
  assert.equal(providerCalls, verifySubagents ? 5 : 2, 'only the explicitly requested offline child turns run')
  // Let the production reconciliation pass persist both callbacks.
  await pause(5500)
  await writeFile(join(run, 'ready.json'), JSON.stringify({ parentId, parentTitle, childId, childTitle, taskId: value.taskId, workspaceId: workspace.id,
    layoutRegression, desktopFrameSimulation: layoutRegression, layoutSourceCount: layoutSources.length, initialSessionId: verifySubagents ? parentId : layoutRegression ? childId : parentId,
    ...(coldSessionId === undefined ? {} : { coldSessionId }),
    ...(nativeSubagents === undefined ? {} : { nativeSubagents }),
    workspaceTitle: '概览验证工作区', providerCalls, parentTurns: 1, realHost: true, offlineAdapter: true, installedHarnessModified: false }, null, 2))
  if (nativeSubagents) {
    let verified = false, checking = false
    const verify = setInterval(() => { void (async () => {
      if (verified || checking) return
      checking = true
      try {
        try { await readFile(join(run, 'verify-ui.json')) } catch { return }
        assert.equal(providerCalls, 5, 'UI browsing must not dispatch extra model calls')
        assert.equal(parent.session.events.filter(event => event.type === 'turn/start').length, 1, 'UI browsing must not wake the parent')
        assert.equal(ctx.agents.get(nativeSubagents.completedId), undefined, 'opening completed native history must not restore its Agent')
        await writeFile(join(run, 'native-ui-side-effects.json'), JSON.stringify({ providerCalls, parentTurns: 1, completedAgentRemainedAbsent: true, passed: true }, null, 2))
        verified = true; clearInterval(verify)
      } catch (error) { verified = true; clearInterval(verify); await writeFile(join(run, 'native-ui-side-effects.json'), JSON.stringify({ passed: false, error: error.stack })) }
      finally { checking = false }
    })() }, 500)
    ctx.effect(() => () => clearInterval(verify))
  }
}
export function apply(ctx) {
  const timer = setTimeout(() => { void prepare(ctx).catch(async error => {
    await writeFile(join(run, 'failed.json'), JSON.stringify({ error: error.stack, providerCalls }))
    console.error(error.stack); process.exitCode = 1
  }) }, 1000)
  ctx.effect(() => () => clearTimeout(timer))
}
