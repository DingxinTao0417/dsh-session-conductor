import { createHash, randomBytes } from 'node:crypto'
import { validateJsonSchemaValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { PANEL_ACTION_NAMES, type PanelAction, type PanelCaller, type PanelController } from '../domain/panel-actions.ts'
import type { PanelActionServices } from './panelapi.ts'

interface PanelAgent {
  readonly id: string
  readonly session?: { readonly header?: { readonly cwd?: string | undefined } | undefined } | undefined
}
export interface PanelAgents {
  get(sessionId: string): PanelAgent | undefined
  list(): readonly PanelAgent[]
}

/** Local-user authority is established by the loopback/same-origin HTTP fence, never a model argument. */
export function createPanelController(options: {
  readonly agents: () => PanelAgents | undefined
  readonly definitions: ReadonlyMap<string, ToolDefinition>
  readonly active: () => boolean
  readonly now?: () => number
  readonly markUserInvocation?: (exec: object) => void
}): PanelActionServices & { dispose(): void } {
  const now = options.now ?? Date.now
  const tokens = new Map<string, { actor: PanelAgent; expiresAt: number }>()
  const receipts = new Map<string, { fingerprint: string; result: Promise<Readonly<Record<string, unknown>>> }>()
  let disposed = false
  const alive = (): void => { if (disposed || !options.active()) throw new Error('UNAVAILABLE: plugin has stopped') }
  const actions = () => PANEL_ACTION_NAMES.filter(action => options.definitions.has(`conductor_${action}`))
  const controller = (agent: PanelAgent): PanelController => ({
    sessionId: agent.id, title: agent.id,
    ...typeof agent.session?.header?.cwd === 'string' ? { cwd: agent.session.header.cwd } : {},
  })
  const pruneTokens = (): void => {
    for (const [token, entry] of tokens) if (entry.expiresAt <= now()) tokens.delete(token)
  }
  return {
    async catalog() {
      alive()
      return { authority: 'local-user', actions: actions(), controllers: (options.agents()?.list() ?? []).map(controller) }
    },
    async authorize(controllerSessionId) {
      alive(); pruneTokens()
      const registry = options.agents()
      const actor = registry?.get(controllerSessionId)
      if (actor === undefined || actor.id !== controllerSessionId
        || !registry?.list().some(entry => entry === actor)) throw new Error('FORBIDDEN: controller is not an existing Host Agent')
      if (tokens.size >= 128) throw new Error('FORBIDDEN: too many active panel authorizations')
      const token = randomBytes(32).toString('base64url')
      const expiresAt = now() + 30 * 60_000
      tokens.set(token, { actor, expiresAt })
      return { token, controller: controller(actor), expiresAt: new Date(expiresAt).toISOString(), actions: actions(), authority: 'local-user' }
    },
    async resolveCaller(token) {
      alive(); pruneTokens()
      const entry = tokens.get(token)
      if (entry === undefined || options.agents()?.get(entry.actor.id) !== entry.actor) return undefined
      return { sessionId: entry.actor.id, authority: 'local-user' }
    },
    async execute(action: PanelAction, caller: PanelCaller) {
      alive()
      const actor = options.agents()?.get(caller.sessionId)
      if (caller.authority !== 'local-user' || actor === undefined || actor.id !== caller.sessionId) throw new Error('UNAUTHORIZED')
      const definition = options.definitions.get(`conductor_${action.action}`)
      if (definition === undefined) throw new Error('UNAVAILABLE: unsupported panel action')
      const properties = definition.parameters.properties
      const parameters: Record<string, unknown> = { ...action.parameters,
        ...action.action !== 'operation' && properties !== null && typeof properties === 'object' && 'operationId' in properties
          ? { operationId: action.operationId } : {},
      }
      if (validateJsonSchemaValue(definition.parameters, parameters).length !== 0) throw new Error('BAD_REQUEST: invalid tool parameters')
      const execute = async (): Promise<Readonly<Record<string, unknown>>> => {
        alive()
        if (options.agents()?.get(caller.sessionId) !== actor) throw new Error('UNAUTHORIZED')
        const exec = { agent: actor, callId: action.operationId, signal: new AbortController().signal }
        options.markUserInvocation?.(exec)
        const value = await definition.execute(parameters, exec as never)
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_RESULT')
        return value as Readonly<Record<string, unknown>>
      }
      // Read windows are per-request and use explicit cursors. Mutations keep the same pending/result
      // Promise, including a failed/unknown response, so a lost HTTP reply cannot repeat a side effect.
      const readActions: Readonly<Record<string, readonly unknown[]>> = {
        read: [undefined], wait: [undefined], list: [undefined], capabilities: [undefined], discover: [undefined], brief: [undefined], artifact_list: [undefined], artifact_read: [undefined],
        queue: ['list'], model: ['show'], access: ['list'], operation: ['status', 'list'], watch: ['list'],
        workflow: ['read', 'validate'], rule: ['list'], schedule: ['list', 'preview'], constraints: ['list', 'read'],
        budget: ['list', 'check'], remote: ['list', 'check'], share: ['status', 'list', 'preview'], cleanup: ['preview'],
      }
      if (readActions[action.action]?.includes(parameters.action)) return await execute()
      const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
        : value !== null && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)])) : value
      const fingerprint = createHash('sha256').update(JSON.stringify(canonical({ caller: caller.sessionId, action: action.action, parameters }))).digest('hex')
      const existing = receipts.get(action.operationId)
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) throw new Error('IDEMPOTENCY_CONFLICT: operation parameters changed')
        return await existing.result
      }
      if (receipts.size >= 4_096) throw new Error('UNAVAILABLE: panel mutation receipt capacity reached; restart the panel Host after reconciling operations')
      const result = Promise.resolve().then(execute)
      receipts.set(action.operationId, { fingerprint, result })
      return await result
    },
    dispose() { disposed = true; tokens.clear(); receipts.clear() },
  }
}
