/** A one-shot, non-model return from an initial delegated child turn. */
export interface CompletionReturnLink {
  /** `armed`, `running`, `returned`, `delivery_unknown` or `delivery_failed`. */
  readonly phase: string
  /** The Host outcome of the initial delegated turn, when it has ended. */
  readonly outcome?: string
  /** Host-authored terminal reason, when it has ended. */
  readonly detail?: string
  /** Bounded public assistant text from the initial delegated turn only. */
  readonly preview?: string
  /** Time the terminal fact was observed, ISO 8601 UTC. */
  readonly completedAt?: string
  /** Why the first delivery or a later observation could not be confirmed. */
  readonly reason?: string
}

/** Native-chat navigation is a read-only projection of durable creation facts. */
export interface SessionLink {
  readonly taskId: string
  readonly operationId: string
  readonly title: string
  readonly originSessionId: string
  readonly targetSessionId?: string
  readonly targetHostId?: string
  readonly local: boolean
  readonly preparation: string
  readonly failureReason?: string
  /** Present only for a task that had an initial delegated instruction. */
  readonly completion?: CompletionReturnLink
}

export interface SessionLinks {
  readonly sessionId: string
  readonly created: readonly SessionLink[]
  readonly origin?: SessionLink
}

export const SESSION_LINKS_ROUTE = '/conductor/session-links'
