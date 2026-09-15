/**
 * The task detail view's shape, shared by both halves (PRD §二.1's 任务详情).
 *
 * ## Why this is in `domain/`
 *
 * The browser half and the Host half share no *behaviour*, but they must agree on the shape they
 * exchange — the Host builds this payload and the panel renders it. Two copies of a sixty-line interface
 * in two files is how a field ends up rendered from a name that no longer exists, which TypeScript cannot
 * catch across the boundary and a browser test cannot catch here. So the shape lives in `domain/`, pure
 * types importing nothing, exactly as the panel's status vocabulary does (`domain/panel-status.ts`).
 *
 * ## What is deliberately not in it
 *
 * Two absences carry meaning and are fields on the payload rather than missing members:
 *
 * 1. **Conversation.** History is read through `conductor_read`, which keeps a per-reader cursor, marks
 *    truncation and decides what a reader may see. The detail payload carries a `refusals` entry naming
 *    that, so a view can say where chat is rather than render an empty area that reads as "no messages".
 * 2. **Artifact evidence strings.** The record's `evidence` is written for an auditor and can quote file
 *    contents; only its **count** crosses this boundary, because the route serves metadata and no content.
 *
 * @module dsh-session-conductor/domain/panel-detail
 */

import type { PanelTaskStatus } from './panel-status.ts'

/** One artifact as the detail view lists it (PRD §二.1's 成果). */
export interface PanelArtifactFact {
  readonly artifactId: string
  readonly kind: string
  readonly name: string
  /** The acceptance dimension, kept separate from existence (PRD §三.4). */
  readonly acceptance: string
  readonly existence: string
  /**
   * The four facts of PRD §二.9.1, labelled so a card cannot collapse a claim
   * into a check or a model review into user acceptance.
   */
  readonly facts: string
  readonly contentVersion: number
  /** Who accepted it, when that was recorded. Its absence is meaningful rather than neutral. */
  readonly acceptedBy?: string | undefined
  readonly acceptedAt?: string | undefined
  /** How many evidence entries the record holds, without reproducing them. */
  readonly evidenceCount: number
  readonly verifiedAt?: string | undefined
  /**
   * The recorded path, URL or git reference — the locator identity, never a
   * same-name substitute (PRD §二.9.1).
   */
  readonly location?: string | undefined
  /** Producing session, when registration recorded one (PRD §二.9.1). */
  readonly sourceSessionId?: string | undefined
  /** Producing turn, when registration recorded one. */
  readonly sourceTurn?: number | undefined
  /** Shared constraints in force at registration, rendered for display. */
  readonly constraints?: string | undefined
}

/**
 * One operation as the detail view lists it (PRD §二.1's 操作记录).
 *
 * The attribution is the operational half of PRD §四.2: a dispatch a rule caused must be traceable to the
 * authorisation that caused it, which is the only way to answer "why was this sent to my task?".
 */
export interface PanelOperationFact {
  readonly operationId: string
  readonly kind: string
  /** The delivery dimension — "accepted" is never "finished", and this field is where that shows. */
  readonly delivery: string
  readonly withdrawn: boolean
  readonly phase?: string | undefined
  readonly messageId?: string | undefined
  /** `user`, `relay`, `notice` or `rule`. */
  readonly source?: string | undefined
  readonly grantId?: string | undefined
  readonly ruleId?: string | undefined
  readonly createdAt: string
}

/** One unacknowledged report as the detail view lists it (PRD §二.1 未读事项). */
export interface PanelUnreadFact {
  readonly notificationId: string
  readonly summary: string
  readonly createdAt: string
}

/** One budget governing the task, with the ledger that measures it (PRD §二.13.2). */
export interface PanelBudgetFact {
  readonly policyKey: string
  readonly scope: string
  readonly strict: boolean
  readonly limits: readonly string[]
  readonly dispatches: number
  readonly attempts: number
  readonly reworkRounds: number
  /** Rendered through `describeUsage`, so an unmeterable figure never reads as zero. */
  readonly tokens: string
  readonly cost: string
  readonly firstDispatchedAt?: string | undefined
}

/**
 * What the task was configured with (PRD §二.1's 配置).
 *
 * Only persisted facts appear here. A per-task **model** selection is not among them, because this build
 * does not store one; the detail says so in `refusals` rather than inventing a field (C164, C166).
 */
export interface PanelConfiguration {
  /** What the caller *asked for* (PRD §二.2.2). */
  readonly contextMode: string
  /** What the task actually got, when that was recorded. The two can differ, which is the point. */
  readonly contextReceived?: string | undefined
  /** The Git starting state, when the task was prepared from one (PRD §二.4). */
  readonly start?: { readonly strategy: string; readonly commit: string; readonly created: boolean } | undefined
  readonly workspaceId?: string | undefined
  /**
   * The Host preset this task's session was composed with (PRD §二.3).
   *
   * Absent means one of two things and the payload says which elsewhere: the task took the Host's own
   * default, or it was created before the preset could be chosen. A preset cannot be changed here — §二.3
   * allows a choice only at create or fork — so this is a fact about how the session was assembled.
   */
  readonly preset?: string | undefined
  /**
   * Fork provenance (PRD §二.2.2): the source task, source session and history
   * cutoff. Absent when this task was not created by a fork, or when the cutoff
   * was never recorded.
   */
  readonly forkSourceTaskId?: string | undefined
  readonly forkSourceSessionId?: string | undefined
  readonly forkCutoffSeq?: number | undefined
  readonly budgets: readonly PanelBudgetFact[]
  /**
   * The model configuration the Host logged for the most recent assembled request — PRD §二.3's
   * "最近实际使用", rendered as one line.
   *
   * Read from the Host's own `request/header`, so it is the configuration the session *ran* with rather
   * than one the conductor believes it set. Absent when the Host logged none: a session whose turn never
   * reached assembly has no such header, which is a different fact from an unknown configuration.
   */
  readonly modelLastUsed?: string | undefined
}

/** Who may do what to this task (PRD §二.1's 权限, §二.5, §二.10.1). */
export interface PanelAccessFact {
  readonly ownerSessionId: string
  /** Incremented on every transfer; a late write from an older epoch is refused. */
  readonly ownerEpoch: number
  readonly observerSessionIds: readonly string[]
  /** Set when management was released. The record is kept, so this is a fact rather than an absence. */
  readonly detachedAt?: string | undefined
  readonly updatedAt: string
}

/** One task's detail: the parts of PRD §二.1's 任务详情 this route can serve. */
export interface PanelTaskDetail {
  readonly taskId: string
  readonly title: string
  readonly status: PanelTaskStatus
  readonly statusReason?: string | undefined
  readonly preparation: string
  readonly preparationPhase: string
  readonly execution: string
  readonly pendingInteraction?: string | undefined
  readonly lastTurn?: string | undefined
  /**
   * PRD §二.1's 最近进展: the Host's own reason for that last turn, kept
   * verbatim. Separate from `lastTurn` (最近结果).
   */
  readonly lastTurnDetail?: string | undefined
  readonly cwd?: string | undefined
  readonly project?: string | undefined
  readonly hostId?: string | undefined
  readonly sessionId?: string | undefined
  /**
   * PRD §二.10.2: after an environment handoff the interface shows 任务继续于新会话
   * and keeps the predecessor/successor session chain. Absent when this task has
   * only ever had one session.
   */
  readonly continuation?: string | undefined
  /** `older → … → current` when the chain has more than one session. */
  readonly sessionChain?: string | undefined
  /**
   * Whether the Host's own registry has this task's session **archived outside** the conductor (PRD §二.5).
   *
   * §二.5 separates two archives and requires the interface to show the scope of its own: the conductor's
   * archive applies to its task collection and never calls the Host's one-way interface, while the Host's
   * registry-global set is the user's own and can hold a session the conductor is managing. Rendering the
   * second fact is what lets a reader tell the two apart instead of assuming the panel's own archive state.
   *
   * **Absent means the Host's set could not be read — not "not archived".** The payload's `refusals` says
   * which case it is, so a view never shows a `false` this code invented.
   */
  readonly sessionArchivedExternally?: boolean | undefined
  /** Reachability of the bound session (PRD §三.4 连接, §二.5 失联 / 不可恢复). */
  readonly connection?: string | undefined
  readonly unrecoverable?: boolean | undefined
  readonly connectionReason?: string | undefined
  /** 成果 */
  readonly artifacts: readonly PanelArtifactFact[]
  /** 操作记录, in the order the store lists them. */
  readonly operations: readonly PanelOperationFact[]
  /**
   * Unacknowledged reports about this task (PRD §二.1 未读事项).
   *
   * Newest first, capped. Opening this view does not mark them read.
   */
  readonly unreadItems?: readonly PanelUnreadFact[] | undefined
  /** How many unread reports exist, which may exceed `unreadItems.length`. */
  readonly unreadCount?: number | undefined
  /** 配置 */
  readonly configuration: PanelConfiguration
  /** 权限, when the task has a control record. */
  readonly access?: PanelAccessFact | undefined
  /**
   * What this route does **not** serve, and where to get it.
   *
   * Never empty, and never rendered as an error: the view shows these as the answer to "where is the
   * conversation" rather than leaving an area blank.
   */
  readonly refusals: readonly string[]
}

/** What the detail route answers with. */
export interface PanelDetailPayload {
  readonly generatedAt: string
  readonly task: PanelTaskDetail
}
