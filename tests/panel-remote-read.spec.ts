import { expect, it, vi } from 'vitest'
import { readTool } from '../src/tools.ts'

it('routes remote history through the shared trusted callback before requiring a local live session', async () => {
  const result = { taskId: 'remote-task', sessionId: 'remote-session', state: 'running', execution: 'running',
    bindingVersion: 3, ownerEpoch: 2, cursor: '6', history: [{ seq: 6, kind: 'assistant', text: 'remote result' }],
    truncated: false, summary: 'remote result' }
  const remoteRead = vi.fn().mockResolvedValue(result)
  const tool = readTool({ observer: () => undefined, remoteRead } as never)
  expect(await tool.execute({ taskId: 'remote-task', view: 'history', afterCursor: '5', limit: 10 }, { agent: { id: 'trusted-owner' }, callId: 'read' } as never)).toEqual(result)
  expect(remoteRead).toHaveBeenCalledWith({ taskId: 'remote-task', callerSessionId: 'trusted-owner', view: 'history', afterCursor: '5', limit: 10 })
})

it('does not fall back to a local observer after a remote permission or connection refusal', async () => {
  const observer = vi.fn()
  const tool = readTool({ observer, remoteRead: () => Promise.reject(new Error('REMOTE_UNAVAILABLE')) } as never)
  await expect(tool.execute({ taskId: 'remote-task' }, { agent: { id: 'owner' } } as never)).rejects.toThrow('REMOTE_UNAVAILABLE')
  expect(observer).not.toHaveBeenCalled()
})
