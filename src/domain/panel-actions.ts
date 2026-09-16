/** Finite browser contract. Identity is bound to an ephemeral UserUI capability by the Host. */
export const PANEL_ACTION_NAMES = [
  'create', 'attach', 'fork', 'read', 'wait', 'list', 'capabilities', 'send', 'stop', 'queue', 'model', 'update',
  'access', 'watch', 'operation', 'handoff', 'artifact_register', 'artifact_verify',
  'artifact_accept', 'artifact_list', 'artifact_read', 'artifact_open', 'transfer', 'rule', 'schedule',
  'workflow', 'constraints', 'budget', 'export', 'share', 'cleanup', 'discover', 'brief', 'remote',
] as const

export type PanelActionName = typeof PANEL_ACTION_NAMES[number]
export type PanelParameters = Readonly<Record<string, unknown>>

/** Parameters are validated against the selected shared tool's schema on the server. */
export interface PanelAction {
  readonly action: PanelActionName
  readonly parameters: PanelParameters
  /** Mandatory for every request; retries retain it. Never inferred from message text. */
  readonly operationId: string
}

export interface PanelActionResult {
  readonly action: PanelActionName
  readonly operationId: string
  readonly result: Readonly<Record<string, unknown>>
}

export interface PanelController {
  readonly sessionId: string
  readonly title: string
  readonly cwd?: string | undefined
}

/** Catalog is Host-derived. Choosing a controller is an explicit local user action. */
export interface PanelBootstrap {
  readonly controllers: readonly PanelController[]
  readonly actions: readonly PanelActionName[]
  readonly authority: 'local-user'
  readonly reason?: string | undefined
}

/** The token stays in one mounted panel's memory; never URL/localStorage/sessionStorage. */
export interface PanelAuthorization {
  readonly token: string
  readonly controller: PanelController
  readonly expiresAt: string
  readonly actions: readonly PanelActionName[]
  readonly authority: 'local-user'
}

/** Returned only by the server resolver; no browser payload can provide this identity. */
export interface PanelCaller {
  readonly sessionId: string
  readonly authority: 'local-user'
  /** Cold persisted sessions can inspect their UI, but cannot impersonate a live Agent. */
  readonly readOnly?: true
}

export interface PanelHistory {
  readonly taskId: string
  readonly execution?: string | undefined
  readonly sessionId?: string | undefined
  readonly bindingVersion?: number | undefined
  readonly ownerEpoch?: number | undefined
  readonly expectedTurn?: number | undefined
  readonly expectedStartSeq?: number | undefined
  readonly cursor: string
  readonly history: readonly {
    readonly seq: number
    readonly kind: string
    readonly text: string
    readonly source?: string | undefined
  }[]
  readonly truncated: boolean
  readonly error?: string | undefined
}

const forbiddenIdentityFields = new Set([
  'caller', 'callerSessionId', 'ownerSessionId', 'authorizedBy', 'source',
  'sourceEventId', '__proto__', 'constructor', 'prototype',
])

/** Structural envelope fence; the shared service remains the parameter and authorization authority. */
export function parsePanelAction(value: unknown): PanelAction {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('BAD_REQUEST: action object required')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !['action', 'parameters', 'operationId'].includes(key))
    || typeof input.action !== 'string' || !(PANEL_ACTION_NAMES as readonly string[]).includes(input.action)
    || typeof input.operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(input.operationId)
    || input.parameters === null || typeof input.parameters !== 'object' || Array.isArray(input.parameters)) {
    throw new Error('BAD_REQUEST: unknown action or invalid envelope')
  }
  const parameters = input.parameters as Record<string, unknown>
  if (Object.keys(parameters).some(key => forbiddenIdentityFields.has(key)
    || (key === 'operationId' && input.action !== 'operation'))) {
    throw new Error('BAD_REQUEST: identity and operation attribution are server-owned')
  }
  return { action: input.action as PanelActionName, operationId: input.operationId, parameters }
}
