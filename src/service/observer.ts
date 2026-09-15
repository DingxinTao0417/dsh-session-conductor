/**
 * Reading a target and waiting on it.
 *
 * PRD §二.7 fixes the rules this module implements:
 *
 * - every reader keeps its **own** cursor, so one reader opening a detail view
 *   never consumes another's unread results;
 * - a wait returns as soon as any target completes, fails, or needs a human;
 * - an event already returned is never returned again;
 * - `timeoutMs = 0` answers with an immediate snapshot;
 * - a timeout still reports each target's current state and its updated cursor;
 * - one target being unreachable is a per-target error, not a failure of the
 *   whole call.
 *
 * Cursors are persisted in the `watches` table rather than held in memory, so a
 * Host restart resumes where the reader stopped instead of replaying history.
 * Direct history, synchronous waits and automatic reports have independent
 * cursors: a wake is a signal to read the result, never a reason to discard it.
 *
 * @module dsh-session-conductor/service/observer
 */

import type { ConductorStore } from '../store/repository.ts'
import type { WatchRecord } from '../store/schema.ts'
import { countArtifactDisplayFacts } from '../domain/artifact-facts.ts'
import { DEFAULTS } from '../domain/defaults.ts'
import {
  historyOf,
  initialProjection,
  interactionFromPending,
  pendingInterventionFromWatches,
  projectEvents,
  projectNotableAfter,
  type HistoryEntry,
  type NotableEvent,
  type ProjectionState,
  type SessionEventLike,
} from './projection.ts'
import {
  hitsInHistory,
  searchAccessOf,
  type SessionSearchResult,
  type TaskSearchMatch,
  type TaskSearchUnreadable,
} from './search.ts'
import { turnOriginOf } from './barrier.ts'
import { encodeObservationCursor, type TaskObservation } from './observation.ts'
import { mayRead } from './access.ts'

/** The live session view the observer reads. */
export interface SessionViewLike {
  readonly events: readonly SessionEventLike[]
  readonly seq: number
  /**
   * The Host's own statement of the configuration the most recent request was assembled with.
   *
   * `Session.requestHeader()` returns an `EpochHeader` whose `config` is an `LlmCallConfig`, and the
   * installed Host's own model-selection code reads exactly this to answer "what did the last request
   * use" (`const logged = agent.session.requestHeader()?.config`). Optional here because a Host need not
   * mirror it, and a reader that assumed it would report a configuration it never saw.
   */
  readonly requestHeader?: (() => unknown) | undefined
  /** The Host's own statement of the configuration the current request is being assembled with. */
  readonly requestContext?: (() => unknown) | undefined
}

/** The slice of an agent the observer needs. */
export interface ObservableAgentLike {
  readonly id: unknown
  readonly session: SessionViewLike
  /**
   * Lifecycle state, when the Host mirrors it.
   *
   * Optional because the observer does not need it — only the report pass does, to
   * choose between waking a session and queueing for it.
   */
  readonly status?: 'idle' | 'running'
  /** Wake an idle session with a message, when the Host exposes delivery here. */
  steer?(message: unknown): void
  /** Queue a message for a later turn without interrupting the current one. */
  followup?(message: unknown): void
}

/** The agent registry surface the observer looks targets up in. */
export interface ObservableAgentsLike {
  get(id: unknown): ObservableAgentLike | undefined
}

/** One detached, persisted session log supplied by the Host's public query API. */
export interface PersistedSessionSnapshotLike {
  readonly session: { readonly id: unknown }
  readonly events: readonly SessionEventLike[]
}

/** Read a complete persisted log without restoring an Agent into the live registry. */
export type PersistedSessionReader = (sessionId: string) => Promise<PersistedSessionSnapshotLike>

/** Where a target's session currently is. */
export interface TargetSnapshot {
  readonly taskId: string
  readonly sessionId: string
  readonly state: ProjectionState
  /** Why this target could not be read, when it could not be. */
  readonly error?: string
  /**
   * The current binding version, when this snapshot is of a live bound session.
   *
   * Pass it as `expectedBindingVersion` on a later write so a handoff that
   * landed in between is refused rather than applied to the predecessor
   * (PRD §二.10.2 旧绑定的插件写操作失效).
   */
  readonly bindingVersion?: number
  /**
   * The current write-control epoch, when this snapshot is of a live bound session.
   * Pass it as `expectedOwnerEpoch` on a later write (PRD §三.2).
   */
  readonly ownerEpoch?: number
}

/** One target of a wait, with the cursor the caller last saw. */
export interface WaitTarget {
  readonly taskId: string
  readonly afterCursor?: string
}

/** What one waited-on target produced. */
export interface WaitTargetResult {
  readonly taskId: string
  readonly state?: ProjectionState
  readonly cursor: string
  /** The event that ended the wait for this target, when one did. */
  readonly wake?: NotableEvent
  readonly error?: string
  /** The live bound session, when this target could be read. */
  readonly sessionId?: string
  /** The current binding version, when this target could be read. Pin a later write with it. */
  readonly bindingVersion?: number
  /** The current write-control epoch, when this target could be read. Pin a later write with it. */
  readonly ownerEpoch?: number
}

/** The outcome of one wait call. */
export interface WaitResult {
  readonly targets: WaitTargetResult[]
  /** True when the deadline passed with nothing to report. */
  readonly timedOut: boolean
  /**
   * Why the wait stopped, which is not the same question as whether it timed out.
   *
   * PRD §二.7 requires a wait to end on a wake, on the deadline, and — separately — when the user says
   * something new. Those are three different endings and only the first two used to exist, so a caller
   * could not tell "the user interrupted me" from "nothing happened for 60 seconds": the second reads as
   * a quiet system and is exactly the wrong thing to report when a person has just taken the wheel.
   */
  readonly ending: WaitEnding
}

/** How a wait ended (PRD §二.7). */
export type WaitEnding =
  /** A target finished a turn, failed, or needs a human. */
  | 'woke'
  /** The deadline passed with nothing to report. */
  | 'timed_out'
  /** A person spoke in the waiting session, so the wait stopped waiting (PRD §二.7's 用户新输入可结束等待). */
  | 'user_spoke'
  /** The Host cancelled the call — new input or an interrupt ended the turn that was waiting. */
  | 'cancelled'

/**
 * What can end a wait before its deadline.
 *
 * Two facts, both supplied by the caller because the observer owns the loop and not the environment: the
 * **Host's own** abort signal for this tool call, and whether a person has spoken to the waiting session
 * since the wait began. They are kept apart rather than folded into one "interrupted" flag because they
 * are different facts with different meanings to a reader — a person taking over is not a cancelled call,
 * and reporting one as the other would be the kind of collapsed distinction this project keeps fixing.
 */
export interface WaitInterruption {
  /** The Host's signal for this call, when the composition supplies one. */
  readonly signal?: AbortSignal | undefined
  /** Whether a person has spoken to the waiting session since the wait began. */
  readonly userSpoke?: (() => boolean) | undefined
}

/** Result of one read. */
export interface ReadResult {
  readonly taskId: string
  readonly sessionId: string
  readonly state: ProjectionState
  readonly cursor: string
  readonly history: HistoryEntry[]
  /** True when the history window was cut short by the requested limit. */
  readonly truncated: boolean
  readonly error?: string
  /**
   * The current binding version, when the task has a live bound session.
   *
   * The pin `conductor_send` / `conductor_stop` / `conductor_queue` take as
   * `expectedBindingVersion` so a write that still names a retired binding
   * after a handoff is refused (PRD §二.10.2).
   */
  readonly bindingVersion?: number
  /**
   * The current write-control epoch. The pin write tools take as `expectedOwnerEpoch`
   * (PRD §三.2 MutationContext).
   */
  readonly ownerEpoch?: number
  /** Durable artifact counts for the compact snapshot (PRD §二.7 成果摘要). */
  readonly artifacts?: {
    readonly total: number
    readonly present: number
    readonly checkPassed: number
    readonly userAccepted: number
    readonly changed: number
  }
  /** Set only when history came from a non-live, persisted Host session. */
  readonly historyOrigin?: 'persisted'
}

/** Everything the observer needs from its environment. */
export interface ObserverDeps {
  readonly agents: ObservableAgentsLike
  readonly store: ConductorStore
  /** Enforce the durable owner/observer relationship at public tool boundaries. */
  readonly enforceReadAccess?: boolean
  readonly localHostId?:string
  readonly remoteObservation?:(taskId:string,readerSessionId:string,afterCursor:string,signal?:AbortSignal)=>Promise<TaskObservation|undefined>
  /** Official Host read for a persisted log; it must not restore an Agent. */
  readonly readPersistedSession?: PersistedSessionReader
  /** How long to sleep between polls while waiting. */
  readonly pollMs?: number
  /** Injectable sleep, so tests do not spend real time. */
  readonly sleep?: (ms: number) => Promise<void>
  /** Injectable clock for the deadline. */
  readonly now?: () => number
  /**
   * History window when the caller does not pass `limit` (PRD §四.7 默认读取量).
   *
   * Optional so unit tests that only fold the log can omit it; they then get
   * the published default rather than a second magic 20.
   */
  readonly defaultReadLimit?: number
  /**
   * Overlay interrupting / reconciling onto a Host-derived projection.
   *
   * Optional so unit tests that only fold the log can omit it. The live plugin
   * supplies conductor-side cancel and unknown-delivery facts.
   */
  readonly overlayExecution?: (
    taskId: string,
    sessionId: string,
    state: ProjectionState,
    events: readonly SessionEventLike[],
  ) => ProjectionState
}

/** Key of one reader's watch on one target. */
export function watchKey(readerSessionId: string, taskId: string): string {
  return `${readerSessionId}::${taskId}`
}

/**
 * Read targets and wait on them.
 */
export class TaskObserver {
  private readonly pollMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private readonly defaultReadLimit: number

  /**
   * @param deps - the Host surface, store and timing this observer uses.
   */
  constructor(private readonly deps: ObserverDeps) {
    this.pollMs = deps.pollMs ?? 200
    this.sleep = deps.sleep ?? (async (ms: number) => { await new Promise(resolve => setTimeout(resolve, ms)) })
    this.now = deps.now ?? (() => Date.now())
    this.defaultReadLimit = deps.defaultReadLimit ?? DEFAULTS.defaultReadLimit
  }

  /**
   * Fold the Host log, then apply interrupting / reconciling when the caller supplied them.
   *
   * @param taskId - the logical task.
   * @param sessionId - the bound Host session.
   * @param events - the session log.
   * @returns the snapshot state.
   */
  private projected(
    taskId: string,
    sessionId: string,
    events: readonly SessionEventLike[],
  ): ProjectionState {
    const { state } = projectEvents(initialProjection(), events)
    return this.deps.overlayExecution?.(taskId, sessionId, state, events) ?? state
  }

  /**
   * Project one target's session from its log.
   *
   * The projection is recomputed from the session's own events every call
   * rather than cached: the specification requires the state to come from Host
   * facts, and a cache can never independently prove a task is still running.
   *
   * @param taskId - the logical task to read.
   * @returns the snapshot, or a snapshot carrying the reason it could not be read.
   */
  snapshot(taskId: string): TargetSnapshot {
    const resolved = this.resolve(taskId)
    if ('error' in resolved) {
      return {
        taskId,
        sessionId: '',
        state: this.notLiveState(taskId, resolved.error),
        error: resolved.error,
      }
    }
    const state = this.projected(taskId, resolved.sessionId, resolved.session.events)
    return {
      taskId,
      sessionId: resolved.sessionId,
      bindingVersion: resolved.bindingVersion,
      ...resolved.ownerEpoch === undefined ? {} : { ownerEpoch: resolved.ownerEpoch },
      state,
    }
  }

  /** Read a finite Host projection without consuming any remote/shared watch cursor. */
  observe(taskId:string,afterSeq=-1,limit=1000):TaskObservation {
    const resolved=this.resolve(taskId)
    if('error' in resolved)throw Error(resolved.error)
    const events=resolved.session.events
    const {state,notable}=projectNotableAfter(initialProjection(),events)
    const remaining=notable.filter(entry=>entry.seq>afterSeq)
    const page=remaining.slice(0,Math.max(1,Math.min(1000,limit)))
    return {taskId,sessionId:resolved.sessionId,bindingVersion:resolved.bindingVersion,ownerEpoch:resolved.ownerEpoch??0,
      position:state.cursor,throughSeq:remaining.length>page.length?page.at(-1)!.seq:state.cursor,truncated:remaining.length>page.length,
      state:this.deps.overlayExecution?.(taskId,resolved.sessionId,state,events)??state,
      notable:page.map(entry=>({...entry,reportTriggered:entry.event.kind==='turn_ended' && turnOriginOf(events.filter(event=>event.seq<=entry.seq)).reportTriggered}))}
  }

  /**
   * Read a target.
   *
   * The two views of PRD §二.7 differ in exactly one respect that matters: only
   * the `history` view **consumes**. A `snapshot` read reports state and leaves
   * the reader's cursor untouched, so opening a panel or checking on a task
   * never swallows a message the reader has not seen. That is the rule "打开详情
   * 不消耗未读结果" applied to the conductor's own readers.
   *
   * @param taskId - the logical task to read.
   * @param readerSessionId - the reading session; cursors are per reader.
   * @param options - view, cursor override and history window size.
   * @returns the state, the readable window and the cursor to resume from.
   */
  async read(
    taskId: string,
    readerSessionId: string,
    options: { view?: 'snapshot' | 'history'; afterCursor?: string; limit?: number } = {},
  ): Promise<ReadResult> {
    const readerError = this.readerError(taskId, readerSessionId)
    if (readerError !== undefined) return this.unreadableRead(taskId, readerError)
    const resolved = this.resolve(taskId)
    if ('error' in resolved) {
      if (options.view === 'history' && resolved.cold !== undefined) {
        return await this.readPersistedHistory(taskId, readerSessionId, options, resolved.cold)
      }
      return {
        taskId,
        sessionId: '',
        state: this.notLiveState(taskId, resolved.error, readerSessionId),
        cursor: '0',
        history: [],
        truncated: false,
        error: resolved.error,
      }
    }
    const cursor = this.historyCursorFor(readerSessionId, taskId, options.afterCursor)
    const state = this.projected(taskId, resolved.sessionId, resolved.session.events)
    const listed = this.deps.store.listArtifacts({ taskId })
    const artifacts = countArtifactDisplayFacts(listed)

    if (options.view !== 'history') {
      return {
        taskId,
        sessionId: resolved.sessionId,
        bindingVersion: resolved.bindingVersion,
        ...resolved.ownerEpoch === undefined ? {} : { ownerEpoch: resolved.ownerEpoch },
        state,
        cursor: String(cursor),
        history: [],
        truncated: false,
        artifacts,
      }
    }

    const limit = Math.max(0, options.limit ?? this.defaultReadLimit)
    const readable = resolved.session.events
      .filter(event => event.seq > cursor)
      .map(historyOf)
      .filter((entry): entry is HistoryEntry => entry !== undefined)

    const window = readable.slice(0, limit)
    const truncated = readable.length > window.length
    // The cursor advances past exactly what the reader was shown. Anything
    // beyond the window is left for the next read rather than silently skipped,
    // so a truncated result never loses a message — while an *empty* window
    // (everything already seen) also leaves the cursor alone.
    const lastShown = window[window.length - 1]?.seq
    const nextCursor = lastShown === undefined ? cursor : lastShown
    if (lastShown !== undefined) {
      const afterReadError = this.readerError(taskId, readerSessionId)
      if (afterReadError !== undefined) return this.unreadableRead(taskId, afterReadError)
      await this.persistHistoryCursor(readerSessionId, taskId, nextCursor)
      const afterPersistError = this.readerError(taskId, readerSessionId)
      if (afterPersistError !== undefined) return this.unreadableRead(taskId, afterPersistError)
    }
    return {
      taskId,
      sessionId: resolved.sessionId,
      bindingVersion: resolved.bindingVersion,
      ...resolved.ownerEpoch === undefined ? {} : { ownerEpoch: resolved.ownerEpoch },
      state,
      cursor: String(nextCursor),
      history: window,
      truncated,
      artifacts,
    }
  }

  /**
   * Search session history the caller may read (PRD §二.5).
   *
   * This is a **location** search, not a body dump: each hit names the task and
   * the event (`seq` + `kind`). The matching text stays on `conductor_read`.
   * Access is decided before any session is opened — a caller that is not the
   * controller or an observer never learns whether a task would have matched.
   *
   * The search does not move a reader's cursor. Opening a search must not
   * swallow history a later `conductor_read` has not seen.
   *
   * @param readerSessionId - the calling session, from the Host context.
   * @param query - the text to look for.
   * @param taskIds - tasks to consider, in the order they should be reported;
   *   omitted means every managed task.
   * @returns matches (with locations) and tasks the caller may read but that
   *   could not be searched.
   */
  search(
    readerSessionId: string,
    query: string,
    taskIds?: readonly string[],
  ): SessionSearchResult {
    const ids = taskIds ?? this.deps.store.listTasks().map(record => record.taskId)
    const matches: TaskSearchMatch[] = []
    const unreadable: TaskSearchUnreadable[] = []
    for (const taskId of ids) {
      const access = this.deps.store.getAccess(taskId)
      const permission = searchAccessOf(access, readerSessionId)
      if (permission.kind === 'omit') continue
      if (permission.kind === 'unreadable') {
        unreadable.push({ taskId, reason: permission.reason })
        continue
      }
      const resolved = this.resolve(taskId)
      if ('error' in resolved) {
        unreadable.push({ taskId, reason: resolved.error })
        continue
      }
      const entries = resolved.session.events
        .map(historyOf)
        .filter((entry): entry is HistoryEntry => entry !== undefined)
      const hits = hitsInHistory(entries, query)
      if (hits.length > 0) matches.push({ taskId, hits })
    }
    return { matches, unreadable }
  }

  /**
   * Wait until any target completes, fails or needs a human, or the wait ends.
   *
   * The three endings of PRD §二.7 are all reachable here: a wake, the deadline, and the two ways a person
   * or the Host can end the wait early. Every ending reports where **every** target got to and advances the
   * reader's cursor to that point, so an ended wait costs the caller nothing it would have to re-read —
   * which is what makes "wait again" the natural continuation the specification describes.
   *
   * @param targets - the targets, each with the cursor the caller last saw.
   * @param readerSessionId - the waiting session; cursors are per reader.
   * @param timeoutMs - deadline; `0` returns an immediate snapshot.
   * @param interruption - the Host's signal and the user's own input, when the caller can supply either.
   * @returns per-target results and how the wait ended.
   */
  async wait(
    targets: readonly WaitTarget[],
    readerSessionId: string,
    timeoutMs: number,
    interruption: WaitInterruption = {},
  ): Promise<WaitResult> {
    const deadline = this.now() + Math.max(0, timeoutMs)
    // A target whose cursor the caller did not supply starts from that reader's
    // own persisted *wait* position. It is deliberately separate from direct
    // history: wait only reports a wake or current state, while read renders
    // the actual public messages and tool results.
    const cursors = new Map<string, number>()
    const remoteCursors = new Map<string,string>()
    const remoteReadings = new Map<string,TaskObservation|{error:string}|undefined>()
    let observationDeadline=false
    for (const target of targets) {
      const waitCursor = this.waitCursorFor(readerSessionId, target.taskId, target.afterCursor)
      cursors.set(target.taskId, numericCursor(waitCursor))
      remoteCursors.set(target.taskId, waitCursor)
    }
    const readRemote=async(target:WaitTarget):Promise<TaskObservation|undefined>=>{
      if (this.readerError(target.taskId, readerSessionId) !== undefined) return undefined
      const binding=this.deps.store.getBinding(this.deps.store.getTask(target.taskId)?.currentBindingId??'')
      if(!this.deps.remoteObservation || !binding || binding.hostId==='local' || binding.hostId===this.deps.localHostId)return undefined
      const controller=new AbortController()
      const remaining=timeoutMs===0?1000:Math.max(0,deadline-this.now())
      const timeout=setTimeout(()=>{observationDeadline=true;controller.abort(Error('REMOTE_WAIT_DEADLINE'))},remaining)
      const check=():void=>{if(interruption.signal?.aborted || interruption.userSpoke?.())controller.abort(Error('REMOTE_WAIT_INTERRUPTED'))}
      const interval=setInterval(check,Math.max(1,Math.min(this.pollMs,50)))
      interruption.signal?.addEventListener('abort',check,{once:true});check()
      let cancel!:()=>void
      const cancelled=new Promise<never>((_resolve,reject)=>{cancel=()=>reject(controller.signal.reason);controller.signal.addEventListener('abort',cancel,{once:true});if(controller.signal.aborted)cancel()})
      try{return await Promise.race([this.deps.remoteObservation(target.taskId,readerSessionId,remoteCursors.get(target.taskId)??'-1',controller.signal),cancelled])}
      finally{clearTimeout(timeout);clearInterval(interval);interruption.signal?.removeEventListener('abort',check);controller.signal.removeEventListener('abort',cancel)}
    }
    const remoteResult=(taskId:string,reading:TaskObservation|{error:string}):WaitTargetResult=>{
      const from=remoteCursors.get(taskId)??'-1'
      if('error' in reading)return this.waitErrorResult(taskId,from,reading.error,readerSessionId)
      const access=this.deps.store.getAccess(taskId),binding=this.deps.store.getBinding(this.deps.store.getTask(taskId)?.currentBindingId??'')
      if(!access || !mayRead(access,readerSessionId))return this.waitErrorResult(taskId,from,'NOT_READER: remote observation permission changed',readerSessionId)
      if(binding?.sessionId!==reading.sessionId || binding.version!==reading.bindingVersion)return this.waitErrorResult(taskId,from,'STALE_BINDING: remote observation target moved',readerSessionId)
      return {taskId,sessionId:reading.sessionId,state:reading.state,cursor:encodeObservationCursor(reading.sessionId,reading.throughSeq),bindingVersion:reading.bindingVersion,ownerEpoch:access.ownerEpoch}
    }
    const validateRemoteResults=(results:WaitTargetResult[]):WaitTargetResult[]=>results.map(result=>{
      const reading=remoteReadings.get(result.taskId)
      if(!reading)return result
      const validated=remoteResult(result.taskId,reading)
      return validated.error?validated:result
    })

    /**
     * Report every target's position as it stands now, advancing each reader cursor.
     *
     * Used by both early endings and by the timeout, because all three owe the caller the same thing: the
     * state of every target at the moment it stopped, with the cursors moved so the next wait does not
     * repeat it.
     */
    const settle = async (): Promise<WaitTargetResult[]> => {
      const settled: WaitTargetResult[] = []
      for (const target of targets) {
        const from = cursors.get(target.taskId) ?? -1
        const readerError = this.readerError(target.taskId, readerSessionId)
        if (readerError !== undefined) {
          settled.push(this.waitErrorResult(target.taskId, from, readerError, readerSessionId))
          continue
        }
        const remote=remoteReadings.get(target.taskId)
        if(remote){
          const result=remoteResult(target.taskId,remote)
          if(!result.error)await this.persistWaitCursor(readerSessionId,target.taskId,result.cursor)
          settled.push(result);continue
        }
        const resolved = this.resolve(target.taskId)
        if ('error' in resolved) {
          settled.push(this.waitErrorResult(target.taskId, from, resolved.error, readerSessionId))
          continue
        }
        const { state } = projectEvents(initialProjection(), resolved.session.events)
        const overlaid = this.deps.overlayExecution?.(
          target.taskId,
          resolved.sessionId,
          state,
          resolved.session.events,
        ) ?? state
        if (state.cursor > from) await this.persistWaitCursor(readerSessionId, target.taskId, state.cursor)
        settled.push({
          taskId: target.taskId,
          state: overlaid,
          cursor: String(state.cursor),
          ...waitIdentityOf(resolved),
        })
      }
      return validateRemoteResults(settled)
    }

    for (;;) {
      const results: WaitTargetResult[] = []
      let woke = false
      await Promise.all(targets.map(async target=>{
        try{remoteReadings.set(target.taskId,await readRemote(target))}
        catch(error){remoteReadings.set(target.taskId,{error:error instanceof Error?error.message:'REMOTE_OBSERVATION_UNAVAILABLE'})}
      }))
      for (const target of targets) {
        const from = cursors.get(target.taskId) ?? -1
        const readerError = this.readerError(target.taskId, readerSessionId)
        if (readerError !== undefined) {
          results.push(this.waitErrorResult(target.taskId, from, readerError, readerSessionId))
          continue
        }
        const remote=remoteReadings.get(target.taskId)
        if(remote){
          const result=remoteResult(target.taskId,remote)
          const wake='error' in remote?undefined:remote.notable.find(entry=>isWake(entry.event))?.event
          if(!result.error){
            // Advance only this source reader; no remote controller watch is touched.
            await this.persistWaitCursor(readerSessionId,target.taskId,result.cursor)
            remoteCursors.set(target.taskId,result.cursor)
            if(wake){woke=true;results.push({...result,wake});continue}
          }
          results.push(result);continue
        }
        const resolved = this.resolve(target.taskId)
        if ('error' in resolved) {
          results.push(this.waitErrorResult(target.taskId, from, resolved.error, readerSessionId))
          continue
        }
        const { state, notable } = projectEventsWithCursor(initialProjection(), resolved.session.events, from)
        const overlaid = this.deps.overlayExecution?.(
          target.taskId,
          resolved.sessionId,
          state,
          resolved.session.events,
        ) ?? state
        const wake = notable.find(isWake)
        if (wake !== undefined) {
          woke = true
          const next = state.cursor
          cursors.set(target.taskId, next)
          await this.persistWaitCursor(readerSessionId, target.taskId, next)
          results.push({
            taskId: target.taskId, state: overlaid, cursor: String(next), wake, ...waitIdentityOf(resolved),
          })
        } else {
          results.push({
            taskId: target.taskId, state: overlaid, cursor: String(state.cursor), ...waitIdentityOf(resolved),
          })
        }
      }

      if (woke) {
        const validated=validateRemoteResults(results)
        return { targets: validated, timedOut: false, ending: validated.some(row=>row.wake!==undefined)?'woke':'cancelled' }
      }
      // Checked **after** the facts, and deliberately: a target that woke in the same instant the user
      // spoke must still be reported as having woken, because that is the fact with content. The
      // interruption decides whether to keep *waiting*, not whether to discard what has already happened.
      if (interruption.signal?.aborted === true) {
        return { targets: await settle(), timedOut: false, ending: 'cancelled' }
      }
      if (interruption.userSpoke?.() === true) {
        return { targets: await settle(), timedOut: false, ending: 'user_spoke' }
      }
      if (this.now() >= deadline || observationDeadline) {
        // A timeout still reports where every target got to, and advances the
        // reader's cursor to that point, so the next wait does not re-report.
        return { targets: await settle(), timedOut: true, ending: 'timed_out' }
      }

      await this.sleep(this.pollMs)
    }
  }

  /**
   * One wait target that cannot be read live.
   *
   * PRD §二.7 returns a per-target error for 失联, and still wants each target's
   * current state on a timeout. A stored 待介入 (C252) is that last-known state:
   * dropping it made wait look idle after disconnect while read/panel still
   * showed the question (C253). The error stays; the overlay is added only when
   * there is something waiting on a person. A stored wait is not a new wake.
   *
   * @param taskId - the target.
   * @param from - the reader's cursor.
   * @param error - why the session is not readable.
   * @param readerSessionId - the waiting session.
   * @returns the per-target result.
   */
  private waitErrorResult(
    taskId: string,
    from: number|string,
    error: string,
    readerSessionId: string,
  ): WaitTargetResult {
    const state = this.notLiveState(taskId, error, readerSessionId)
    return {
      taskId,
      cursor: String(from),
      error,
      ...state.interaction === 'none' ? {} : { state },
    }
  }

  /**
   * When the session is not live, show the last Watch 待介入事项 rather than
   * pretending nobody must act (PRD §三.5, T14).
   *
   * Only the "not live" error uses the stored field: a released task is no
   * longer this plugin's reader of that session, and a task with no binding
   * has never been observed. A live fold always wins over the cache.
   *
   * @param taskId - the task.
   * @param error - the resolve error.
   * @param readerSessionId - the reader, when this is a per-reader read.
   * @returns a projection that is idle except for a stored wait, when there is one.
   */
  private notLiveState(
    taskId: string,
    error: string,
    readerSessionId?: string,
  ): ProjectionState {
    if (!error.includes('is not live in this Host')) return initialProjection()
    const pending = readerSessionId === undefined
      ? pendingInterventionFromWatches(this.deps.store.listEveryWatch(), taskId)
      : this.deps.store.getWatch(watchKey(readerSessionId, taskId))?.pendingIntervention
    return { ...initialProjection(), interaction: interactionFromPending(pending) }
  }

  /**
   * Read public history from the Host's detached persisted-log service.
   *
   * This path is intentionally history-only. It does not restore an Agent,
   * does not make a cold task waitable, and does not return a binding pin for a
   * later write. The caller can learn what was completed without mistaking a
   * durable transcript for a live execution surface.
   */
  private async readPersistedHistory(
    taskId: string,
    readerSessionId: string,
    options: { view?: 'snapshot' | 'history'; afterCursor?: string; limit?: number },
    cold: { readonly bindingId: string; readonly sessionId: string; readonly bindingVersion: number },
  ): Promise<ReadResult> {
    const reader = this.deps.readPersistedSession
    if (reader === undefined) {
      return this.unreadableRead(
        taskId,
        'PERSISTED_HISTORY_UNAVAILABLE: this Host exposes no detached session-history reader',
      )
    }
    let persisted: PersistedSessionSnapshotLike
    try {
      persisted = await reader(cold.sessionId)
    } catch (error) {
      return this.unreadableRead(
        taskId,
        `PERSISTED_HISTORY_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (String(persisted.session.id) !== cold.sessionId || !Array.isArray(persisted.events)) {
      return this.unreadableRead(taskId, 'PERSISTED_HISTORY_INVALID: the Host returned a mismatched or malformed session log')
    }
    const stale = this.currentColdBindingError(taskId, cold)
    if (stale !== undefined) return this.unreadableRead(taskId, stale)
    const readerError = this.readerError(taskId, readerSessionId)
    if (readerError !== undefined) return this.unreadableRead(taskId, readerError)

    const cursor = this.historyCursorFor(readerSessionId, taskId, options.afterCursor)
    const state = this.projected(taskId, cold.sessionId, persisted.events)
    const artifacts = countArtifactDisplayFacts(this.deps.store.listArtifacts({ taskId }))
    const limit = Math.max(0, options.limit ?? this.defaultReadLimit)
    const readable = persisted.events
      .filter(event => event.seq > cursor)
      .map(historyOf)
      .filter((entry): entry is HistoryEntry => entry !== undefined)
    const window = readable.slice(0, limit)
    const truncated = readable.length > window.length
    const lastShown = window[window.length - 1]?.seq
    const nextCursor = lastShown === undefined ? cursor : lastShown
    if (lastShown !== undefined) {
      const beforePersist = this.currentColdBindingError(taskId, cold) ?? this.readerError(taskId, readerSessionId)
      if (beforePersist !== undefined) return this.unreadableRead(taskId, beforePersist)
      await this.persistHistoryCursor(readerSessionId, taskId, nextCursor)
      const afterPersist = this.currentColdBindingError(taskId, cold) ?? this.readerError(taskId, readerSessionId)
      if (afterPersist !== undefined) return this.unreadableRead(taskId, afterPersist)
    }
    return {
      taskId,
      sessionId: cold.sessionId,
      state,
      cursor: String(nextCursor),
      history: window,
      truncated,
      artifacts,
      historyOrigin: 'persisted',
    }
  }

  /** Ensure an asynchronous detached read still names the binding it began with. */
  private currentColdBindingError(
    taskId: string,
    cold: { readonly bindingId: string; readonly sessionId: string; readonly bindingVersion: number },
  ): string | undefined {
    const task = this.deps.store.getTask(taskId)
    if (task === undefined) return `TASK_NOT_FOUND: task ${taskId} no longer exists`
    const access = this.deps.store.getAccess(taskId)
    if (access?.detachedAt !== undefined) {
      return `MANAGEMENT_RELEASED: task ${taskId} was released while reading persisted history`
    }
    const binding = task.currentBindingId === undefined ? undefined : this.deps.store.getBinding(task.currentBindingId)
    return binding?.bindingId === cold.bindingId
      && binding.version === cold.bindingVersion
      && binding.sessionId === cold.sessionId
      ? undefined
      : `STALE_BINDING: task ${taskId} changed while reading persisted history`
  }

  /**
   * Resolve a task to its live session.
   * @param taskId - the logical task.
   * @returns the session, or the reason it is not readable.
   */
  private resolve(taskId: string): {
    sessionId: string
    bindingId: string
    bindingVersion: number
    ownerEpoch?: number
    session: SessionViewLike
  } | {
    error: string
    /** A local binding is durable but its Agent is not live; history may be read detached. */
    cold?: { readonly bindingId: string; readonly sessionId: string; readonly bindingVersion: number }
  } {
    const task = this.deps.store.getTask(taskId)
    if (task === undefined) return { error: `no managed task ${taskId}` }
    // PRD §二.5, and §二.7's per-target error: a task **released** from management is reported as
    // this target's error rather than read as an ordinary result. The relationship is what makes the
    // conductor a reader of that session at all, so continuing to serve its history would pretend a
    // relationship that no longer exists — the same defect the watch path had.
    //
    // Only the release is checked here, not the whole `monitoringAllowed` question: an absent control
    // record is not a release, and treating it as one would invent a rule the specification does not
    // state.
    const access = this.deps.store.getAccess(taskId)
    if (access?.detachedAt !== undefined) {
      return {
        error: `management of task ${taskId} was released at ${access.detachedAt}, so the conductor no longer reads `
          + 'its session. Anything already accepted is untouched; rejoin the task to observe it again.',
      }
    }
    const binding = task.currentBindingId === undefined
      ? undefined
      : this.deps.store.getBinding(task.currentBindingId)
    if (binding === undefined) {
      return { error: `task ${taskId} has no session bound to it yet (it is ${task.preparation})` }
    }
    if(binding.hostId!=='local' && binding.hostId!==this.deps.localHostId)return {error:`task ${taskId} is bound to remote Host ${binding.hostId}; a fresh remote observation is required`}
    const agent = this.deps.agents.get(binding.sessionId)
    if (agent === undefined) {
      return {
        error: `the session bound to task ${taskId} (${binding.sessionId}) is not live in this Host`,
        cold: { bindingId: binding.bindingId, sessionId: binding.sessionId, bindingVersion: binding.version },
      }
    }
    return {
      sessionId: binding.sessionId,
      bindingId: binding.bindingId,
      bindingVersion: binding.version,
      ...access === undefined ? {} : { ownerEpoch: access.ownerEpoch },
      session: agent.session,
    }
  }

  /** Read the direct-history cursor; a legacy report/wait cursor never hides history. */
  private historyCursorFor(readerSessionId: string, taskId: string, override: string | undefined): number {
    if (override !== undefined) return numericCursor(override)
    const stored = this.deps.store.getWatch(watchKey(readerSessionId, taskId))
    const bindingId = this.currentBindingId(taskId)
    return stored?.historyCursor === undefined || stored.historyBindingId !== bindingId
      ? -1
      : numericCursor(stored.historyCursor)
  }

  /** Read the synchronous-wait cursor, retaining a legacy record's old wait position. */
  private waitCursorFor(readerSessionId: string, taskId: string, override: string | undefined): string {
    if (override !== undefined) return override
    const stored = this.deps.store.getWatch(watchKey(readerSessionId, taskId))
    if (stored === undefined) return '-1'
    if (stored.waitCursor !== undefined) {
      return stored.waitBindingId === this.currentBindingId(taskId) ? stored.waitCursor : '-1'
    }
    // Older rows had one shared cursor. They were created by a background
    // watch, so preserve that position for wait while history starts at -1.
    return stored.watchEnabled === false ? '-1' : stored.cursor
  }

  /** Persist a history or wait cursor without enabling background reports. */
  private async persistReaderCursor(
    readerSessionId: string,
    taskId: string,
    kind: 'history' | 'wait',
    cursor: number | string,
  ): Promise<void> {
    const key = watchKey(readerSessionId, taskId)
    const existing = this.deps.store.getWatch(key)
    const bindingId = this.currentBindingId(taskId)
    const stamp = new Date(this.now()).toISOString()
    const record: WatchRecord = existing === undefined
      ? {
          controllerSessionId: readerSessionId,
          taskId,
          // `cursor` remains the automatic-report cursor for compatibility.
          cursor: '-1',
          deliveredEventIds: [],
          watchEnabled: false,
          createdAt: stamp,
          updatedAt: stamp,
        }
      : existing
    await this.deps.store.putWatch(key, {
      ...record,
      ...(kind === 'history'
        ? {
            historyCursor: String(cursor),
            ...bindingId === undefined ? {} : { historyBindingId: bindingId },
          }
        : {
            waitCursor: String(cursor),
            ...bindingId === undefined ? {} : { waitBindingId: bindingId },
          }),
      updatedAt: stamp,
    })
  }

  /** Persist only a direct-history cursor. */
  private async persistHistoryCursor(readerSessionId: string, taskId: string, cursor: number): Promise<void> {
    await this.persistReaderCursor(readerSessionId, taskId, 'history', cursor)
  }

  /** Persist only a synchronous-wait cursor. */
  private async persistWaitCursor(readerSessionId: string, taskId: string, cursor: number | string): Promise<void> {
    await this.persistReaderCursor(readerSessionId, taskId, 'wait', cursor)
  }

  /** Return the reader refusal without exposing a task's session contents. */
  private readerError(taskId: string, readerSessionId: string): string | undefined {
    // Unit-level projection consumers can deliberately operate on a partially
    // constructed store. The mounted plugin turns this on, and its tool entry
    // also uses the Host-trusted guard before crossing an async boundary.
    if (this.deps.enforceReadAccess !== true) return undefined
    const access = this.deps.store.getAccess(taskId)
    return access !== undefined && mayRead(access, readerSessionId)
      ? undefined
      : `NOT_READER: session ${readerSessionId} may not read task ${taskId}`
  }

  /** Current binding identity, used to prevent a predecessor cursor hiding successor history. */
  private currentBindingId(taskId: string): string | undefined {
    return this.deps.store.getTask(taskId)?.currentBindingId
  }

  /** Shape a denied direct read without querying or revealing its session. */
  private unreadableRead(taskId: string, error: string): ReadResult {
    return {
      taskId,
      sessionId: '',
      state: initialProjection(),
      cursor: '-1',
      history: [],
      truncated: false,
      error,
    }
  }
}

/** Parse a local sequence cursor without accepting partially numeric strings. */
function numericCursor(cursor: string): number {
  if (!/^-?\d+$/.test(cursor)) return -1
  const parsed = Number(cursor)
  return Number.isSafeInteger(parsed) && parsed >= -1 ? parsed : -1
}

/**
 * Fold events from a given cursor without re-deriving the whole log.
 * @param previous - the projection before the window.
 * @param events - the session's events.
 * @param from - the cursor the reader last saw.
 * @returns the projection and the notable events after it.
 */
function projectEventsWithCursor(
  previous: ProjectionState,
  events: readonly SessionEventLike[],
  from: number,
): { state: ProjectionState; notable: NotableEvent[] } {
  // A reader cursor filters notifications, not the facts that establish current
  // execution. Rebuild the prefix before folding new events so a quiet target
  // retains its open turn and intervention when another target wakes the wait.
  const prefix = projectEvents(previous, events.filter(event => event.seq <= from)).state
  return projectEvents(prefix, events.filter(event => event.seq > from))
}

/**
 * The live binding identity a wait target can pin a later write with.
 *
 * @param resolved - a successfully resolved live session.
 * @returns fields a wait result can spread.
 */
function waitIdentityOf(resolved: {
  sessionId: string
  bindingVersion: number
  ownerEpoch?: number
}): {
  sessionId: string
  bindingVersion: number
  ownerEpoch?: number
} {
  return {
    sessionId: resolved.sessionId,
    bindingVersion: resolved.bindingVersion,
    ...resolved.ownerEpoch === undefined ? {} : { ownerEpoch: resolved.ownerEpoch },
  }
}

/**
 * Whether a notable event is one that ends a wait.
 *
 * The specification names completion, failure and required intervention. Two interventions are
 * observable from a session log: an approval request, and the **call to the tool that asks the user a
 * question**. The second was recorded here as a gap — "a user question is not a session event on this
 * Host" — which was true of the event *vocabulary* and wrong about the log: the question is visible as
 * the tool call, and that is the one signal a log carries. The distinction matters because a wait that
 * does not wake on a question keeps waiting while the target is blocked on an answer.
 *
 * @param event - a notable event.
 * @returns true when a waiting reader should be woken.
 */
export function isWake(event: NotableEvent): boolean {
  return event.kind === 'turn_ended' || event.kind === 'approval_asked' || event.kind === 'user_question'
}
