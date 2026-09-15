/** Actual Host task creation; standard event fixtures are written only into the isolated test profile. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LlmAdapter, createUserMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
export const inject = ['apiProxy', 'agents', 'sessions', 'tools', 'llm', 'agentDefaultModel', 'workspaceRegistry', 'sessionTitle']
const run = process.env.BINARY_RUN
let providerCalls = 0
class NoRequestAdapter extends LlmAdapter {
  async listModels() { return [{ provider: 'navigation-fixture', id: 'test', name: 'test' }] }
  async resolveModel(provider, id) { return { provider, id, name: id } }
  // A generator is required by LlmAdapter; any request must fail before yielding.
  // eslint-disable-next-line require-yield
  async *stream() { providerCalls++; throw new Error('Navigation tests must never request model inference') }
}
async function prepare(ctx) {
  ctx.llm.registerAdapter(['navigation-fixture'], new NoRequestAdapter())
  await ctx.agentDefaultModel.saveSelection({ provider: 'navigation-fixture', model: 'test' })
  const workspaceTitle = '协调测试工作区'
  const workspace = await ctx.workspaceRegistry.create(join(run, 'workspace'), workspaceTitle)
  const pairs = []
  for (const [index, title] of [[1, '分析任务一'], [2, '分析任务二']]) {
    const parentId = `navigation-parent-${index}`, operationId = `navigation-create-${index}`, callId = crypto.randomUUID()
    const response = await ctx.apiProxy.sessions.create({ rpcId: crypto.randomUUID(), payload: { sessionId: parentId, workspaceId: workspace.id } })
    assert.equal(response.result.ok, true, JSON.stringify(response))
    const renamed = await ctx.apiProxy.sessions.rename({ rpcId: crypto.randomUUID(), payload: { sessionId: parentId, title: `发起会话${index}` } })
    assert.equal(renamed.result.ok, true, JSON.stringify(renamed))
    const parent = ctx.agents.get(parentId); assert(parent)
    parent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `创建${title}（独立测试数据）` }] }), { surfaceOp: 'append' })
    parent.session.append('turn/start', { turn: 1 })
    parent.session.append('step/start', { turn: 1, step: 1 })
    const args = { operationId, title, contextMode: 'empty' }
    parent.session.append('tool/call', { turn: 1, step: 1, callId, name: 'conductor_create', arguments: JSON.stringify(args) })
    let value
    for (let attempt = 0; attempt < 200; attempt++) {
      value = await ctx.tools.get('conductor_create').execute(args, { callId, agent: parent })
      if (value.preparation === 'ready') break
      assert.notEqual(value.preparation, 'failed', JSON.stringify(value))
      await new Promise(done => setTimeout(done, 20))
    }
    assert.equal(value.preparation, 'ready', JSON.stringify(value))
    // Persist the exact tool rendering that a normal Host turn receives.  The
    // first text must make the creation-only boundary visible before any
    // optional progress action could be considered.
    const create = ctx.tools.get('conductor_create')
    assert(create, 'conductor_create must be registered in the actual Host')
    const createBlocks = create.output.render(args, value)
    const renderedCreate = createBlocks
      .filter(block => block?.type === 'text')
      .map(block => String(block.text ?? ''))
      .join('\n')
    assert(renderedCreate.includes('Default delegation is complete:'), 'create renderer must front-load the delegation-only boundary')
    assert(renderedCreate.includes('Do not repeat the delegated work'), 'create renderer must prohibit duplicate parent work by default')
    parent.session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, isError: false, content: createBlocks }) }, { surfaceOp: 'append' })
    parent.session.append('step/end', { turn: 1, step: 1 })
    parent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const childId = value.sessionId ?? value.binding?.sessionId
    assert(childId, JSON.stringify(value))
    const child = ctx.agents.get(childId); assert(child)
    // This marker must travel through the registered tool renderer, then the
    // Host's normal persisted conversation path.  It is deliberately unique
    // per pair: the browser assertion below cannot be satisfied by a sidebar,
    // a creation card, or a stale fixture from a previous test run.
    const historyNeedle = `公开历史进度标记-${index}-${crypto.randomUUID().slice(0, 8)}`
    const childProgress = `${title}：由另一会话发起（独立测试数据，无模型推理）；${historyNeedle}`
    child.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: childProgress }] }), { surfaceOp: 'append' })
    assert.equal(child.session.header.cwd, parent.session.header.cwd, 'omitted directory must inherit initiating session')
    assert(workspace.sessionIds.includes(childId), 'new task must belong to initiating workspace')
    assert.equal(value.workspaceId, workspace.id)
    const childTitle = ctx.sessionTitle.get(child.session)
    assert.equal(childTitle.title, title, 'the initiating conversation decides the native title')
    assert.equal(childTitle.source.kind, 'user', 'automatic first-prompt title generation must not override the chosen title')
    await ctx.sessions.flush(child.session)

    // This distinct second user message is the explicit instruction that
    // authorizes a later parent-side progress read.  Creation itself did not
    // trigger the read, wait, watch, send, stop, review, or verification.
    const historyCallId = crypto.randomUUID()
    const historyArgs = { taskId: value.taskId, view: 'history', afterCursor: '-1', limit: 20 }
    const read = ctx.tools.get('conductor_read')
    assert(read, 'conductor_read must be registered in the actual Host')
    parent.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `读取${title}的公开进度（独立测试数据，明确请求）` }] }), { surfaceOp: 'append' })
    parent.session.append('turn/start', { turn: 2 })
    parent.session.append('step/start', { turn: 2, step: 1 })
    parent.session.append('tool/call', { turn: 2, step: 1, callId: historyCallId, name: 'conductor_read', arguments: JSON.stringify(historyArgs) })
    const historyValue = await read.execute(historyArgs, { callId: historyCallId, agent: parent })
    const historyBlocks = read.output.render(historyArgs, historyValue)
    const renderedHistory = historyBlocks
      .filter(block => block?.type === 'text')
      .map(block => String(block.text ?? ''))
      .join('\n')
    assert(renderedHistory.includes('Public persisted records from the target session'), 'history renderer must identify public records')
    assert(renderedHistory.includes(historyNeedle), 'history renderer must include the target record body')
    assert.notEqual(renderedHistory, String(historyValue.summary ?? ''), 'history renderer must not collapse to the summary')
    parent.session.append('tool/result', { turn: 2, step: 1, message: createToolResultMessage({ callId: historyCallId, isError: false, content: historyBlocks }) }, { surfaceOp: 'append' })
    parent.session.append('step/end', { turn: 2, step: 1 })
    parent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await ctx.sessions.flush(parent.session)
    pairs.push({ parentId, parentTitle: `发起会话${index}`, childId, operationId, title, taskId: value.taskId, workspaceTitle, workspaceId: workspace.id, inheritedDirectory: child.session.header.cwd, nativeChildTitle: childTitle.title, creation: { callId, renderedChars: renderedCreate.length }, historyRead: { callId: historyCallId, needle: historyNeedle, renderedChars: renderedHistory.length } })
  }
  const sourcePair = pairs[0], source = ctx.agents.get(sourcePair.childId)
  // A balanced completed-turn fixture makes the actual Host fork API eligible, without inference.
  source.session.append('turn/start', { turn: 1 })
  source.session.append('step/start', { turn: 1, step: 1 })
  source.session.append('step/end', { turn: 1, step: 1 })
  source.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await ctx.sessions.flush(source.session)
  const forkTitle = '主会话命名的分叉', forkOperation = 'navigation-fork'
  let forked
  for (let attempt = 0; attempt < 200; attempt++) {
    forked = await ctx.tools.get('conductor_fork').execute({ sourceTaskId: sourcePair.taskId, title: forkTitle, operationId: forkOperation }, { callId: crypto.randomUUID(), agent: ctx.agents.get(sourcePair.parentId) })
    if (forked.preparation === 'ready') break
    assert.notEqual(forked.preparation, 'failed', JSON.stringify(forked)); await new Promise(done => setTimeout(done, 20))
  }
  assert.equal(forked.preparation, 'ready', JSON.stringify(forked))
  const fork = ctx.tools.get('conductor_fork')
  assert(fork, 'conductor_fork must be registered in the actual Host')
  const renderedFork = fork.output.render({}, forked)
    .filter(block => block?.type === 'text')
    .map(block => String(block.text ?? ''))
    .join('\n')
  assert(renderedFork.includes('Default delegation is complete:'), 'fork renderer must front-load the delegation-only boundary')
  const forkSession = ctx.agents.get(forked.sessionId).session
  assert.equal(forkSession.header.cwd, ctx.agents.get(sourcePair.parentId).session.header.cwd)
  assert(workspace.sessionIds.includes(forked.sessionId))
  assert.equal(ctx.sessionTitle.get(forkSession).title, forkTitle)
  assert.equal(ctx.sessionTitle.get(forkSession).source.kind, 'user')
  assert.equal(providerCalls, 0)
  await writeFile(join(run, 'ready.json'), JSON.stringify({ pairs, fork: { title: forkTitle, sessionId: forked.sessionId, originSessionId: sourcePair.parentId, workspaceId: workspace.id }, providerCalls, boundary: 'actual installed Host and compiled external plugin; standard event fixtures only in isolated profile' }, null, 2))
}
export function apply(ctx) {
  const timer = setTimeout(() => { void prepare(ctx).catch(async error => {
    await writeFile(join(run, 'failed.json'), JSON.stringify({ error: error.stack, providerCalls }))
    console.error(error.stack); process.exit(1)
  }) }, 1000)
  ctx.effect(() => () => clearTimeout(timer))
}
