import { describe, expect, it, vi } from 'vitest'
import { createPanelController, readPanelSessionMetadata } from '../src/service/panel-controller.ts'

function fixture() {
  const actors = new Map<string, { id: string }>()
  let header: { id: string; createdAt: number; cwd?: string } | undefined = { id: 'cold', createdAt: 1, cwd: 'D:/workspace' }
  const sessionMetadata = vi.fn(async () => header)
  const execute = vi.fn(async () => ({}))
  const service = createPanelController({
    agents: () => ({ get: id => actors.get(id), list: () => [...actors.values()] }),
    sessionMetadata,
    definitions: new Map([['conductor_list', { name: 'conductor_list', description: '', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'object' }, render: () => [] }, execute }]]),
    active: () => true,
  })
  return { service, actors, sessionMetadata, execute, setHeader(value: typeof header) { header = value } }
}

describe('cold session overview authorization', () => {
  it('authorizes an existing cold Host session for read-only UI without creating an Agent', async () => {
    const f = fixture()
    const authorization = await f.service.authorize('cold')
    expect(authorization.actions).toEqual([])
    expect(authorization.controller).toMatchObject({ sessionId: 'cold', cwd: 'D:/workspace' })
    expect(await f.service.resolveCaller(authorization.token)).toEqual({ sessionId: 'cold', authority: 'local-user', readOnly: true })
    expect(f.actors.size).toBe(0)
    expect(f.execute).not.toHaveBeenCalled()
    f.service.dispose()
  })

  it('refuses unknown or mismatched persisted identities', async () => {
    const f = fixture()
    f.setHeader(undefined)
    await expect(f.service.authorize('missing')).rejects.toThrow('CONTROLLER_UNAVAILABLE')
    f.setHeader({ id: 'other', createdAt: 1 })
    await expect(f.service.authorize('cold')).rejects.toThrow('CONTROLLER_UNAVAILABLE')
    f.service.dispose()
  })

  it('revokes a cold credential when its session disappears or its immutable identity changes', async () => {
    for (const replacement of [undefined, { id: 'cold', createdAt: 2, cwd: 'D:/workspace' }, { id: 'cold', createdAt: 1, cwd: 'D:/elsewhere' }]) {
      const f = fixture(), authorization = await f.service.authorize('cold')
      f.setHeader(replacement)
      expect(await f.service.resolveCaller(authorization.token)).toBeUndefined()
      f.service.dispose()
    }
  })

  it('does not promote a cold credential to tool authority when an Agent later appears', async () => {
    const f = fixture(), authorization = await f.service.authorize('cold')
    f.actors.set('cold', { id: 'cold' })
    const caller = await f.service.resolveCaller(authorization.token)
    await expect(f.service.execute({ action: 'list', operationId: 'read', parameters: {} }, caller!)).rejects.toThrow('CONTROLLER_INACTIVE')
    expect(f.execute).not.toHaveBeenCalled()
    const fresh = await f.service.authorize('cold')
    expect(fresh.actions).toContain('list')
    expect(await f.service.resolveCaller(fresh.token)).toEqual({ sessionId: 'cold', authority: 'local-user' })
    f.service.dispose()
  })

  it('rejects a cold authorization that completes after plugin disposal', async () => {
    const f = fixture()
    f.sessionMetadata.mockImplementation(async () => { f.service.dispose(); return { id: 'cold', createdAt: 1 } })
    await expect(f.service.authorize('cold')).rejects.toThrow('UNAVAILABLE')
  })

  it('rejects a cold credential if metadata lookup fails or plugin disposal occurs during resolution', async () => {
    const f = fixture(), authorization = await f.service.authorize('cold')
    f.sessionMetadata.mockRejectedValueOnce(Error('backend unavailable'))
    expect(await f.service.resolveCaller(authorization.token)).toBeUndefined()
    f.sessionMetadata.mockImplementation(async () => { f.service.dispose(); return { id: 'cold', createdAt: 1, cwd: 'D:/workspace' } })
    expect(await f.service.resolveCaller(authorization.token)).toBeUndefined()
  })
})

describe('official session metadata adapter', () => {
  it('reads only public headers and drops fields outside identity and workspace', async () => {
    const readSession = vi.fn(() => { throw Error('history must not be loaded') })
    const listSessions = vi.fn(async () => [{ header: { id: 'cold', createdAt: 1, cwd: 'D:/workspace', parentSession: 'parent', version: 1 }, live: false, persisted: true }])
    expect(await readPanelSessionMetadata({ listSessions, readSession }, 'cold')).toEqual({ id: 'cold', createdAt: 1, cwd: 'D:/workspace' })
    expect(listSessions).toHaveBeenCalledOnce()
    expect(readSession).not.toHaveBeenCalled()
  })

  it('rejects unavailable, ambiguous or malformed metadata instead of inferring an identity', async () => {
    expect(await readPanelSessionMetadata(undefined, 'cold')).toBeUndefined()
    for (const records of [null, [], [{ header: { id: 'other', createdAt: 1 } }], [{ header: { id: 'cold' } }], [{ header: { id: 'cold', createdAt: NaN } }], [{ header: { id: 'cold', createdAt: 1, cwd: 42 } }], [{ header: { id: 'cold', createdAt: 1 } }, { header: { id: 'cold', createdAt: 1 } }]]) {
      expect(await readPanelSessionMetadata({ listSessions: async () => records }, 'cold')).toBeUndefined()
    }
  })
})
