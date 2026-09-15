/**
 * The Host surfaces the coordinator drives, declared structurally.
 *
 * They are declared here rather than imported from the Host packages so the
 * coordinator can be unit-tested against fakes, and so a Host that renames an
 * unrelated member does not break this plugin. The two members that *do* come
 * from Host packages — `createUserMessage` and the `SessionId` brand — are used
 * directly, because getting a message identity wrong is not something a local
 * reimplementation should be trusted with.
 *
 * @module dsh-session-conductor/service/host
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { StopInboxLike } from './stop.ts'
import type { SessionEventLike } from './projection.ts'

/** The live agent surface the coordinator drives. */
export interface AgentLike {
  /** The agent and its session share this identity. */
  readonly id: SessionId
  /** Current lifecycle state. */
  readonly status: 'idle' | 'running'
  /**
   * The live session, when this Host exposes one.
   *
   * Optional on purpose. The pinned runtime declares it required, but the
   * handoff's "the source's queue could not be checked" path exists precisely for
   * a Host that does not, and making it required here would delete that check
   * rather than keep it meaningful. Code that *needs* these projections asks for
   * {@link LiveAgentLike} instead, so the requirement is stated where it is real.
   */
  readonly session?: {
    readonly events: readonly SessionEventLike[]
    readonly seq: number
    /** The folded session header, when the Host has recorded one. */
    readonly header?: unknown
  }
  /**
   * Whether the agent is holding unconsumed input, when the Host exposes it.
   *
   * Declared as the single fact the handoff needs rather than the whole inbox
   * projection: a caller that only asks "is anything pending?" should not have to
   * be handed a mutation surface it must not use. Code that needs to read or
   * change what is pending narrows to {@link LiveAgentLike}.
   */
  readonly inbox?: { readonly hasPending: boolean }
  /** Queue an ordinary follow-up turn and wake the driver. */
  followup(message: unknown): void
  /** Submit steering for the nearest step boundary. */
  steer(message: unknown): void
  /**
   * Queue model-facing context without waking the driver (PRD §二.2.2).
   *
   * This is the Host's own primitive for a task's **starting context**, and it is a different verb
   * from `followup` on purpose: an injected brief reaches the model at the next pre-step while the
   * session stays idle until something wakes it, which is what "a task prepared with a brief and no
   * instruction is ready and idle" requires. Using `followup` for a brief would start a turn
   * nobody asked for — and would put the brief in the log as if the user had sent it.
   *
   * Optional, because a Host that does not expose it cannot deliver a starting context at all, and
   * that has to be reportable rather than approximated.
   */
  inject?(message: unknown): void
  /** Cancel the active activity with a stated cause. Synchronous by contract. */
  cancel(
    cause: { kind: 'user' } | { kind: 'parent' } | { kind: 'hook'; reason: string } | { kind: 'disposed' },
    options?: { readonly keepInbox?: boolean },
  ): void
}

/**
 * An agent that has the live projections an exact stop requires.
 *
 * Narrowing to this type is what makes "the expected turn was verified in the same
 * critical section as the cancel" checkable rather than assumed: without the
 * session's event log there is no turn to verify, and the stop refuses instead of
 * cancelling whatever happens to be running.
 */
export interface LiveAgentLike extends AgentLike {
  readonly session: {
    readonly events: readonly SessionEventLike[]
    readonly seq: number
    readonly header?: unknown
  }
  readonly inbox: StopInboxLike
}

/**
 * Narrow an agent to the live projections, or report that it has none.
 *
 * The inbox is checked for its *reading* surface rather than only `hasPending`:
 * an inbox that can say "something is pending" but cannot say what, or withdraw
 * it, is not enough to run an exact stop or manage a queue, and reporting that
 * honestly is better than half-working.
 *
 * @param agent - the agent read from the registry.
 * @returns the narrowed agent, or undefined when a projection is missing.
 */
export function liveAgentOf(agent: AgentLike | undefined): LiveAgentLike | undefined {
  if (agent === undefined) return undefined
  if (agent.session === undefined) return undefined
  const inbox = agent.inbox as StopInboxLike | undefined
  if (inbox === undefined) return undefined
  if (!Array.isArray(inbox.nextTurn) || !Array.isArray(inbox.nextStep)) return undefined
  if (typeof inbox.remove !== 'function' || typeof inbox.replace !== 'function') return undefined
  return agent as LiveAgentLike
}

/** An owned agent plus its disposer. */
export interface AgentHandleLike {
  readonly agent: AgentLike
  dispose(): Promise<void>
}

/** Options for creating one agent/session pair. */
export interface CreateAgentOptionsLike {
  readonly sessionId: SessionId
  readonly meta?: {
    readonly cwd?: string
    readonly parentSession?: SessionId
    readonly seedLength?: number
    readonly agentPreset?: string
  }
  /**
   * Initial replay history.
   *
   * A fork supplies a balanced completed-turn prefix of the parent's log. The
   * Host validates that the seed is contiguous from seq 0 and contains no open
   * turn, step or dangling tool call, which is exactly why the cut is computed
   * from `turn/end` boundaries rather than at an arbitrary point.
   */
  readonly seed?: readonly unknown[]
  readonly agentOptions?: { readonly provider?: string; readonly model?: string }
  /** Creation-time composition of the agent's scoped world. */
  readonly setup?: (agentCtx: unknown) => void | Promise<void>
}

/** The agent registry surface the coordinator uses. */
export interface AgentRegistryLike {
  create(options: CreateAgentOptionsLike): Promise<AgentHandleLike>
  get(id: SessionId): AgentLike | undefined
  list(): AgentLike[]
}

/**
 * Who produced a message, as the Host records it (PRD §四.2).
 *
 * The specification names a plugin `relay` source for forwarded controller
 * instructions and a plugin `notice` source for background reports. On this
 * Host both are a plugin source carrying a {@link ContextForm}: `relay` for
 * content another agent addressed to this one, `notice` for a one-off account
 * of something that happened. A `notice` must also carry its one-line summary,
 * because the Host validates that a producer cannot select the form without it.
 */
export type MessageSource =
  | { readonly kind: 'user' }
  | { readonly kind: 'plugin'; readonly plugin: string; readonly form?: 'relay' }
  | { readonly kind: 'plugin'; readonly plugin: string; readonly form: 'notice'; readonly summary: string }

/** The plugin name every conductor-produced message is attributed to. */
export const CONDUCTOR_SOURCE_PLUGIN = 'dsh-session-conductor'

/**
 * The source for an instruction the controller session forwards to a target.
 *
 * The user's own input in the host UI keeps its native `user` source and is
 * never rewritten by this plugin; only what the conductor itself dispatches is
 * attributed here, so a reader can always tell who asked.
 *
 * @returns the plugin relay source.
 */
export function relaySource(): MessageSource {
  return { kind: 'plugin', plugin: CONDUCTOR_SOURCE_PLUGIN, form: 'relay' }
}

/**
 * The source for a background report the conductor raises on its own.
 * @param summary - the one-line account of what happened.
 * @returns the plugin notice source.
 */
export function noticeSource(summary: string): MessageSource {
  return { kind: 'plugin', plugin: CONDUCTOR_SOURCE_PLUGIN, form: 'notice', summary }
}

/**
 * Interpret a preparation failure into one operator-readable reason.
 * @param error - the thrown value.
 * @returns the reason text.
 */
export function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? `${code}: ${error.message}` : error.message
  }
  return String(error)
}
