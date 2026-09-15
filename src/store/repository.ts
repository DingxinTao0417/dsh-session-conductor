/**
 * The conductor's durable store: typed access to the domain tables plus the
 * idempotency rules of PRD §四.1.
 *
 * The store takes the domain tables as a structural dependency rather than the
 * Host's `Domain` object directly, so the same logic runs against a real
 * backend and against the in-memory tables the tests and fault-injection runs
 * use. Nothing here drives sessions or talks to a Host service — it is the
 * persistence layer only.
 *
 * @module dsh-session-conductor/store/repository
 */

import {
  classifyOperation,
  paramDigest,
  recoveryAction,
  type OperationKind,
  type OperationMatch,
  type OperationRecord,
} from '../domain/operation.ts'
import type { DeliveryState } from '../domain/state.ts'
import { carryLedger, emptyLedger, type LedgerEvent } from '../service/budget.ts'
import type {
  AccessRecord,
  ArtifactRecord,
  BindingRecord,
  ContextSnapshotRecord,
  NotificationRecord,
  StoredOperationRecord,
  RuleRecord,
  ScheduleRecord,
  BudgetStoreRecord,
  ConstraintDeliveryRecord,
  ConstraintStoreRecord,
  LedgerStoreRecord,
  MessageSourceRecord,
  RemoteHostRecord,
  ShareStoreRecord,
  ResourceStoreRecord,
  WorkflowRecord,
  WorkflowRunRecord,
  TaskRecord,
  TransferRecord,
  WatchRecord,
} from './schema.ts'

/** The slice of a Host KV table this store uses. */
export interface TableLike<K extends string, V> {
  get(key: K): V | undefined
  entries(): IterableIterator<[K, V]>
  keys(): IterableIterator<K>
  readonly size: number
  put(key: K, value: V): Promise<void>
  delete(key: K): Promise<boolean>
  update(key: K, fn: (current: V) => V): Promise<V>
}

/** The conductor domain's tables, in the order the schema declares them. */
export interface ConductorTables {
  readonly tasks: TableLike<string, TaskRecord>
  readonly bindings: TableLike<string, BindingRecord>
  readonly access: TableLike<string, AccessRecord>
  readonly operations: TableLike<string, StoredOperationRecord>
  readonly watches: TableLike<string, WatchRecord>
  readonly notifications: TableLike<string, NotificationRecord>
  /** Handoff briefs, keyed by snapshot id. */
  readonly contexts: TableLike<string, ContextSnapshotRecord>
  /** Recorded artifacts, keyed by artifact id. */
  readonly artifacts: TableLike<string, ArtifactRecord>
  /** Handoff attempts, keyed by transfer id. */
  readonly transfers: TableLike<string, TransferRecord>
  /** Saved one-time rules, keyed by rule id. */
  readonly rules: TableLike<string, RuleRecord>
  /** Saved schedules, keyed by schedule id (PRD §二.11). */
  readonly schedules: TableLike<string, ScheduleRecord>
  /** Saved workflow definitions, keyed by workflow id (PRD §二.12). */
  readonly workflows: TableLike<string, WorkflowRecord>
  /** Workflow runs, keyed by run id. */
  readonly workflow_runs: TableLike<string, WorkflowRunRecord>
  /** Shared constraints, keyed by constraint id (PRD §二.13.1). */
  readonly constraints: TableLike<string, ConstraintStoreRecord>
  /** Constraint deliveries, keyed by <id>@<version>::<target>. */
  readonly constraint_deliveries: TableLike<string, ConstraintDeliveryRecord>
  /** Budget policies, keyed by <scope>::<target> (PRD §二.13.2). */
  readonly budgets: TableLike<string, BudgetStoreRecord>
  /** Run ledgers, keyed by target id (PRD §二.13.2). */
  readonly ledgers: TableLike<string, LedgerStoreRecord>
  /** Remote Hosts the user registered by hand (PRD §二.14.1). */
  readonly remote_hosts: TableLike<string, RemoteHostRecord>
  /** Published shares (PRD §二.14.2). */
  readonly shares: TableLike<string, ShareStoreRecord>
  /** Plugin-owned resources eligible for explicit cleanup (PRD §三.6). */
  readonly resources: TableLike<string, ResourceStoreRecord>
}

/** What a caller may filter a task list by (PRD §二.5). */
export interface TaskFilter {
  readonly controllerSessionId?: string
  readonly preparation?: TaskRecord['preparation']
  readonly groupId?: string
  readonly archived?: boolean
  readonly pinned?: boolean
}

/** The outcome of opening an operation (PRD §四.1). */
export type BeginOperationResult =
  | { readonly kind: 'accepted'; readonly record: StoredOperationRecord }
  | { readonly kind: 'replay'; readonly record: StoredOperationRecord }
  | { readonly kind: 'conflict'; readonly record: StoredOperationRecord | undefined; readonly reason: string }

/** Input for {@link ConductorStore.beginOperation}. */
export interface BeginOperationInput {
  readonly operationId: string
  readonly kind: OperationKind
  /** Parameters that define the operation; digested, never stored verbatim. */
  readonly params: unknown
  /**
   * Opaque native-card capability for a create/fork operation. It is kept
   * outside `params`: a retry must recover the original capability without
   * changing the request digest or the operation identity.
   */
  readonly sessionLinkCapability?: string
  readonly taskId?: string
  readonly messageId?: string
  /** What caused it, when something other than a person did (PRD §四.2). */
  readonly attribution?: MessageSourceRecord
  readonly dispatchGuard?: StoredOperationRecord['dispatchGuard']
}

/** Locks belong to the shared table, since tool calls create separate service wrappers. */
const storeLocks = new WeakMap<object, Map<string, Promise<void>>>()

/**
 * Durable conductor state.
 *
 * Times are injected rather than read from the clock inside, so a test can
 * assert ordering and so a single operation stamps every record it touches with
 * one consistent instant.
 */
export class ConductorStore {
  /**
   * @param tables - the domain tables to operate on.
   * @param now - returns the current time as an ISO 8601 UTC string.
   */
  constructor(
    private readonly tables: ConductorTables,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** Serialize one Host-local operation across wrappers of the same durable domain. */
  async withExclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    let locks = storeLocks.get(this.tables.operations)
    if (locks === undefined) {
      locks = new Map()
      storeLocks.set(this.tables.operations, locks)
    }
    const previous = locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    locks.set(key, current)
    await previous
    try {
      return await work()
    } finally {
      release()
      if (locks.get(key) === current) locks.delete(key)
    }
  }

  // ── tasks ────────────────────────────────────────────────────────────────

  /** Read one task. @param taskId - logical task id. @returns the record or undefined. */
  getTask(taskId: string): TaskRecord | undefined {
    return this.tables.tasks.get(taskId)
  }

  /**
   * List tasks, newest first by `updatedAt`.
   * @param filter - optional narrowing; omitted members do not constrain.
   * @returns the matching task records.
   */
  listTasks(filter: TaskFilter = {}): TaskRecord[] {
    const matched: TaskRecord[] = []
    for (const [, record] of this.tables.tasks.entries()) {
      if (filter.controllerSessionId !== undefined && record.controllerSessionId !== filter.controllerSessionId) continue
      if (filter.preparation !== undefined && record.preparation !== filter.preparation) continue
      if (filter.groupId !== undefined && record.groupId !== filter.groupId) continue
      if (filter.archived !== undefined && record.archived !== filter.archived) continue
      if (filter.pinned !== undefined && record.pinned !== filter.pinned) continue
      matched.push(record)
    }
    return matched.sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : left.updatedAt > right.updatedAt ? -1 : 0))
  }

  /**
   * Write a new task record.
   *
   * A different record already occupying the id is refused rather than
   * overwritten: task ids are the conductor's stable handle, and silently
   * replacing one would corrupt every reference to it.
   *
   * @param record - the complete record to store.
   * @returns the stored record.
   * @throws when the id is already taken by a different task.
   */
  async createTask(record: TaskRecord): Promise<TaskRecord> {
    const existing = this.tables.tasks.get(record.taskId)
    if (existing !== undefined) {
      throw new Error(`conductor: task ${record.taskId} already exists`)
    }
    await this.tables.tasks.put(record.taskId, record)
    return record
  }

  /**
   * Apply a pure transform to one task, stamping `updatedAt`.
   * @param taskId - logical task id.
   * @param transform - receives the current record; returns the next one.
   * @returns the stored next record.
   */
  async updateTask(taskId: string, transform: (current: TaskRecord) => TaskRecord): Promise<TaskRecord> {
    const stamped = await this.tables.tasks.update(taskId, (current) => ({
      ...transform(current),
      updatedAt: this.now(),
    }))
    return stamped
  }

  // ── bindings ─────────────────────────────────────────────────────────────

  /** Read one binding. @param bindingId - binding identity. @returns the record or undefined. */
  getBinding(bindingId: string): BindingRecord | undefined {
    return this.tables.bindings.get(bindingId)
  }

  /**
   * List a task's bindings in creation order — the session chain a handoff shows.
   * @param taskId - logical task id.
   * @returns the task's binding records.
   */
  listBindings(taskId: string): BindingRecord[] {
    const matched: BindingRecord[] = []
    for (const [, record] of this.tables.bindings.entries()) {
      if (record.taskId === taskId) matched.push(record)
    }
    return matched.sort((left, right) => left.version - right.version)
  }

  /**
   * Store a binding and point its task at it.
   *
   * Both writes happen here so the task can never reference a binding that was
   * not persisted, and the previous binding is retired in the same pass.
   *
   * @param record - the binding to store.
   * @returns the stored binding.
   */
  async putBinding(record: BindingRecord, validate?: () => void): Promise<BindingRecord> {
    const task = this.tables.tasks.get(record.taskId)
    if (task === undefined) {
      throw new Error(`conductor: binding ${record.bindingId} references unknown task ${record.taskId}`)
    }
    const previousId = task.currentBindingId
    await this.tables.bindings.put(record.bindingId, record)
    await this.withExclusive(`control-commit:${record.taskId}`, async () => {
      await this.tables.tasks.update(record.taskId, current => {
        if (current.currentBindingId !== previousId) throw new Error('STALE_BINDING: the task binding changed during persistence')
        validate?.()
        return { ...current, currentBindingId: record.bindingId, updatedAt: this.now() }
      })
      // Retire only after the pointer commits: a failed switch must leave its source active.
      if (previousId !== undefined && previousId !== record.bindingId) {
        const previous = this.tables.bindings.get(previousId)
        if (previous !== undefined && previous.retiredAt === undefined) {
          await this.tables.bindings.put(previousId, { ...previous, retiredAt: this.now() })
        }
      }
    })
    return record
  }

  // ── access ───────────────────────────────────────────────────────────────

  /** Read a task's control record. @param taskId - logical task id. @returns the record or undefined. */
  getAccess(taskId: string): AccessRecord | undefined {
    return this.tables.access.get(taskId)
  }

  /**
   * List every control record.
   *
   * Used to count how many targets a controller still manages (PRD §四.7).
   *
   * @returns the access records, in table order.
   */
  listAccess(): AccessRecord[] {
    const matched: AccessRecord[] = []
    for (const [, record] of this.tables.access.entries()) matched.push(record)
    return matched
  }

  /**
   * Store a task's control record.
   * @param record - the complete record.
   * @returns the stored record.
   */
  async putAccess(record: AccessRecord): Promise<AccessRecord> {
    return this.withExclusive(`control-commit:${record.taskId}`, async () => {
      const previous = this.tables.access.get(record.taskId)
      if (previous !== undefined && (record.ownerEpoch < previous.ownerEpoch
        || (record.ownerSessionId !== previous.ownerSessionId && record.ownerEpoch <= previous.ownerEpoch))) {
        throw new Error('STALE_OWNER_EPOCH: a newer control transfer already committed')
      }
      await this.tables.access.put(record.taskId, record)
      return record
    })
  }

  // ── watches ──────────────────────────────────────────────────────────────

  /**
   * Read one reader's watch on one target.
   * @param key - the watch key (`reader::task`).
   * @returns the record or undefined.
   */
  getWatch(key: string): WatchRecord | undefined {
    return this.tables.watches.get(key)
  }

  /**
   * Store one reader's watch.
   *
   * Watches are keyed by reader and target, never by target alone: PRD §二.7
   * requires each reader to keep its own cursor so that one reader opening a
   * detail view does not consume another's unread results.
   *
   * @param key - the watch key (`reader::task`).
   * @param record - the complete record.
   * @returns the stored record.
   */
  async putWatch(key: string, record: WatchRecord): Promise<WatchRecord> {
    await this.tables.watches.put(key, record)
    return record
  }

  /**
   * List every watch belonging to one reader.
   * @param controllerSessionId - the reading session.
   * @returns the reader's watch records.
   */
  listWatches(controllerSessionId: string): WatchRecord[] {
    const matched: WatchRecord[] = []
    for (const [, record] of this.tables.watches.entries()) {
      if (record.controllerSessionId === controllerSessionId) matched.push(record)
    }
    return matched
  }

  /**
   * List every watch, across all controllers.
   *
   * The background report pass has no controller of its own: it runs for whoever is
   * watching, so it needs the whole set. Ordered by controller then task so a pass
   * behaves the same way twice.
   *
   * @returns every watch record.
   */
  listEveryWatch(): WatchRecord[] {
    const all: WatchRecord[] = []
    for (const [, record] of this.tables.watches.entries()) all.push(record)
    return all.sort((left, right) => {
      if (left.controllerSessionId !== right.controllerSessionId) {
        return left.controllerSessionId < right.controllerSessionId ? -1 : 1
      }
      return left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0
    })
  }

  /**
   * Remove one reader's watch on one target.
   * @param key - the watch key (`reader::task`).
   * @returns whether a watch was present.
   */
  async deleteWatch(key: string): Promise<boolean> {
    return this.tables.watches.delete(key)
  }

  // ── notifications ────────────────────────────────────────────────────────

  /**
   * Store one report, keyed by its own identity.
   *
   * The identity is derived from the controller and the fact, so re-storing the
   * same report is a write of the same value rather than a second record. That is
   * what keeps "reported once" true across a restart: the record is the evidence
   * that a fact was delivered, and it cannot be duplicated by re-reading a log.
   *
   * @param record - the complete record.
   * @returns the stored record.
   */
  async putNotification(record: NotificationRecord): Promise<NotificationRecord> {
    await this.tables.notifications.put(record.notificationId, record)
    return record
  }

  /**
   * Mark this controller's reports for a task as read (PRD §二.1 未读数量).
   *
   * Opening a panel or a detail view does not call this. Wait and snapshot
   * cursors are not moved. Already-acknowledged and withdrawn reports are
   * left as they are. Another controller's reports for the same task stay
   * unread.
   *
   * @param controllerSessionId - the Host-trusted caller.
   * @param taskId - the task whose reports are being acknowledged.
   * @param now - acknowledgement instant, ISO 8601 UTC.
   * @returns how many reports were newly marked.
   */
  async acknowledgeNotifications(
    controllerSessionId: string,
    taskId: string,
    now: string,
  ): Promise<number> {
    let marked = 0
    for (const record of this.listNotifications({ controllerSessionId, taskId })) {
      if (record.withdrawn || record.acknowledgedAt !== undefined) continue
      await this.tables.notifications.put(record.notificationId, {
        ...record,
        acknowledgedAt: now,
        updatedAt: now,
      })
      marked += 1
    }
    return marked
  }

  /**
   * Read one report.
   * @param notificationId - the report identity.
   * @returns the record or undefined.
   */
  getNotification(notificationId: string): NotificationRecord | undefined {
    return this.tables.notifications.get(notificationId)
  }

  /**
   * List reports, newest first, optionally narrowed.
   * @param filter - optional narrowing by controller, task, or delivery state.
   * @returns the matching records, newest first with an id tiebreaker.
   */
  listNotifications(
    filter: { controllerSessionId?: string; taskId?: string; delivery?: NotificationRecord['delivery'] } = {},
  ): NotificationRecord[] {
    const matched: NotificationRecord[] = []
    for (const [, record] of this.tables.notifications.entries()) {
      if (filter.controllerSessionId !== undefined && record.controllerSessionId !== filter.controllerSessionId) continue
      if (filter.taskId !== undefined && record.taskId !== filter.taskId) continue
      if (filter.delivery !== undefined && record.delivery !== filter.delivery) continue
      matched.push(record)
    }
    return matched.sort((left, right) => {
      if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1
      return left.notificationId < right.notificationId ? -1 : left.notificationId > right.notificationId ? 1 : 0
    })
  }

  // ── context snapshots ────────────────────────────────────────────────────

  /**
   * Store a handoff brief.
   * @param record - the complete snapshot record.
   * @returns the stored record.
   */
  async putContext(record: ContextSnapshotRecord): Promise<ContextSnapshotRecord> {
    await this.tables.contexts.put(record.snapshotId, record)
    return record
  }

  /**
   * Read one handoff brief.
   * @param snapshotId - the snapshot identity.
   * @returns the record or undefined.
   */
  getContext(snapshotId: string): ContextSnapshotRecord | undefined {
    return this.tables.contexts.get(snapshotId)
  }

  /**
   * List the briefs taken from one task, newest version first.
   * @param sourceTaskId - the logical task the briefs came from.
   * @returns the matching records.
   */
  listContexts(sourceTaskId: string): ContextSnapshotRecord[] {
    const matched: ContextSnapshotRecord[] = []
    for (const [, record] of this.tables.contexts.entries()) {
      if (record.sourceTaskId === sourceTaskId) matched.push(record)
    }
    return matched.sort((left, right) => right.contentVersion - left.contentVersion)
  }

  /**
   * List the briefs taken from one **session**, newest version first.
   *
   * A brief's version is monotonic *for its source* (PRD §二.2.2: "Monotonic version of the brief's
   * content for this source"), and a source is normally a session rather than a managed task: the
   * session that asked for a task need not be one. Reading by source *task* would therefore miss the
   * common case, which is exactly what it did until this method existed.
   *
   * @param sourceSessionId - the Host session the briefs were taken from.
   * @returns the matching records, newest version first.
   */
  listContextsBySourceSession(sourceSessionId: string): ContextSnapshotRecord[] {
    const matched: ContextSnapshotRecord[] = []
    for (const [, record] of this.tables.contexts.entries()) {
      if (record.sourceSessionId === sourceSessionId) matched.push(record)
    }
    return matched.sort((left, right) => right.contentVersion - left.contentVersion)
  }

  /**
   * List the briefs **delivered to** one task as its starting context, newest version first.
   *
   * The delivery is the fact a reader usually wants — "what context did this task start with" — and
   * it is not the same record set as the briefs taken *from* the task. Keeping the two lookups
   * separate is what stops a brief generated from a task being read as one handed to it.
   *
   * @param deliveredToTaskId - the task the briefs were delivered to.
   * @returns the matching records, newest version first.
   */
  listContextsDeliveredTo(deliveredToTaskId: string): ContextSnapshotRecord[] {
    const matched: ContextSnapshotRecord[] = []
    for (const [, record] of this.tables.contexts.entries()) {
      if (record.deliveredToTaskId === deliveredToTaskId) matched.push(record)
    }
    return matched.sort((left, right) => right.contentVersion - left.contentVersion)
  }

  // ── artifacts ────────────────────────────────────────────────────────────

  /**
   * Store an artifact record.
   * @param record - the complete record.
   * @returns the stored record.
   */
  async putArtifact(record: ArtifactRecord): Promise<ArtifactRecord> {
    await this.tables.artifacts.put(record.artifactId, record)
    return record
  }

  /**
   * Read one artifact.
   * @param artifactId - the artifact identity.
   * @returns the record or undefined.
   */
  getArtifact(artifactId: string): ArtifactRecord | undefined {
    return this.tables.artifacts.get(artifactId)
  }

  /**
   * Apply a pure transform to one artifact, stamping `updatedAt`.
   * @param artifactId - the artifact identity.
   * @param transform - receives the current record; returns the next one.
   * @returns the stored next record.
   */
  async updateArtifact(
    artifactId: string,
    transform: (current: ArtifactRecord) => ArtifactRecord,
  ): Promise<ArtifactRecord> {
    return this.tables.artifacts.update(artifactId, (current) => ({
      ...transform(current),
      updatedAt: this.now(),
    }))
  }

  /**
   * List artifacts, newest first, optionally narrowed to one task.
   * @param filter - optional narrowing.
   * @returns the matching records.
   */
  listArtifacts(filter: { taskId?: string; acceptance?: ArtifactRecord['acceptance'] } = {}): ArtifactRecord[] {
    const matched: ArtifactRecord[] = []
    for (const [, record] of this.tables.artifacts.entries()) {
      if (filter.taskId !== undefined && record.taskId !== filter.taskId) continue
      if (filter.acceptance !== undefined && record.acceptance !== filter.acceptance) continue
      matched.push(record)
    }
    return matched.sort((left, right) => (left.createdAt < right.createdAt ? 1 : left.createdAt > right.createdAt ? -1 : 0))
  }

  // ── transfers ────────────────────────────────────────────────────────────

  /**
   * Store a transfer record.
   * @param record - the complete record.
   * @returns the stored record.
   */
  async putTransfer(record: TransferRecord): Promise<TransferRecord> {
    await this.tables.transfers.put(record.transferId, record)
    return record
  }

  /**
   * Read one transfer.
   * @param transferId - the transfer identity.
   * @returns the record or undefined.
   */
  getTransfer(transferId: string): TransferRecord | undefined {
    return this.tables.transfers.get(transferId)
  }

  /**
   * List transfers, newest first, optionally narrowed to one receiver.
   * @param filter - optional narrowing.
   * @returns the matching records.
   */
  listTransfers(filter: { toTaskId?: string; artifactId?: string } = {}): TransferRecord[] {
    const matched: TransferRecord[] = []
    for (const [, record] of this.tables.transfers.entries()) {
      if (filter.toTaskId !== undefined && record.toTaskId !== filter.toTaskId) continue
      if (filter.artifactId !== undefined && record.artifactId !== filter.artifactId) continue
      matched.push(record)
    }
    return matched.sort((left, right) => (left.createdAt < right.createdAt ? 1 : left.createdAt > right.createdAt ? -1 : 0))
  }

  // ── rules ────────────────────────────────────────────────────────────────

  /**
   * Store a rule.
   * @param record - the complete record.
   * @returns the stored record.
   */
  async putRule(record: RuleRecord): Promise<RuleRecord> {
    await this.tables.rules.put(record.ruleId, record)
    return record
  }

  /**
   * Read one rule.
   * @param ruleId - the rule identity.
   * @returns the record or undefined.
   */
  getRule(ruleId: string): RuleRecord | undefined {
    return this.tables.rules.get(ruleId)
  }

  /**
   * List rules, newest first, optionally only the active ones.
   * @param filter - optional narrowing.
   * @returns the matching records.
   */
  listRules(filter: { active?: boolean; sourceTaskId?: string; targetTaskId?: string } = {}): RuleRecord[] {
    const matched: RuleRecord[] = []
    for (const [, record] of this.tables.rules.entries()) {
      if (filter.active !== undefined && record.active !== filter.active) continue
      if (filter.sourceTaskId !== undefined && record.sourceTaskId !== filter.sourceTaskId) continue
      if (filter.targetTaskId !== undefined && record.targetTaskId !== filter.targetTaskId) continue
      matched.push(record)
    }
    return matched.sort((left, right) => (left.createdAt < right.createdAt ? 1 : left.createdAt > right.createdAt ? -1 : 0))
  }

  /**
   * Apply a pure transform to one rule, stamping `updatedAt`.
   * @param ruleId - the rule identity.
   * @param transform - receives the current record; returns the next one.
   * @returns the stored next record.
   */
  async updateRule(ruleId: string, transform: (current: RuleRecord) => RuleRecord): Promise<RuleRecord> {
    return this.tables.rules.update(ruleId, (current) => ({
      ...transform(current),
      updatedAt: this.now(),
    }))
  }

  // ── schedules ────────────────────────────────────────────────────────────

  /**
   * Store a schedule.
   * @param record - the complete record.
   * @returns the stored record.
   */
  async putSchedule(record: ScheduleRecord): Promise<ScheduleRecord> {
    await this.tables.schedules.put(record.scheduleId, record)
    return record
  }

  /**
   * Read one schedule.
   * @param scheduleId - the schedule identity.
   * @returns the record or undefined.
   */
  getSchedule(scheduleId: string): ScheduleRecord | undefined {
    return this.tables.schedules.get(scheduleId)
  }

  /**
   * List schedules, newest first.
   *
   * Ordering is fixed rather than incidental: a preview or a recovery pass that
   * showed schedules in table order would be unreproducible between runs.
   *
   * @param filter - optional narrowing by status or target task.
   * @returns the matching records, newest first, ties broken by id.
   */
  listSchedules(filter: { status?: ScheduleRecord['status']; targetTaskId?: string } = {}): ScheduleRecord[] {
    const matched: ScheduleRecord[] = []
    for (const [, record] of this.tables.schedules.entries()) {
      if (filter.status !== undefined && record.status !== filter.status) continue
      if (filter.targetTaskId !== undefined && record.targetTaskId !== filter.targetTaskId) continue
      matched.push(record)
    }
    return matched.sort((left, right) => {
      if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1
      return left.scheduleId < right.scheduleId ? -1 : left.scheduleId > right.scheduleId ? 1 : 0
    })
  }

  /**
   * Apply a pure transform to one schedule, stamping `updatedAt`.
   *
   * The caller owns the whole transition — including appending to `runs` — so a
   * firing is recorded in the same write that advances `nextAt`. Recording the
   * run in a second write would leave a crash window in which the schedule has
   * moved on with no evidence that it ever fired.
   *
   * @param scheduleId - the schedule identity.
   * @param transform - receives the current record; returns the next one.
   * @returns the stored next record.
   */
  async updateSchedule(
    scheduleId: string,
    transform: (current: ScheduleRecord) => ScheduleRecord,
  ): Promise<ScheduleRecord> {
    return this.tables.schedules.update(scheduleId, (current) => ({
      ...transform(current),
      updatedAt: this.now(),
    }))
  }

  /**
   * Remove one schedule.
   * @param scheduleId - the schedule identity.
   * @returns whether a record was present.
   */
  async deleteSchedule(scheduleId: string): Promise<boolean> {
    return this.tables.schedules.delete(scheduleId)
  }

  // ── workflows ────────────────────────────────────────────────────────────

  /**
   * Read one workflow definition.
   * @param workflowId - the definition identity.
   * @returns the record or undefined.
   */
  getWorkflow(workflowId: string): WorkflowRecord | undefined {
    return this.tables.workflows.get(workflowId)
  }

  /**
   * Store one workflow definition.
   *
   * Saving adds a version rather than editing in place: PRD §二.12 requires a run to
   * fix the definition it started under, and a run that recorded a version number over
   * a mutable body would be recording nothing.
   *
   * @param record - the complete definition.
   * @returns the stored record.
   */
  async putWorkflow(record: WorkflowRecord): Promise<WorkflowRecord> {
    await this.tables.workflows.put(record.workflowId, record)
    return record
  }

  /**
   * List workflow definitions, newest first.
   * @param filter - optional narrowing by status.
   * @returns the matching records, newest first with an id tiebreaker.
   */
  listWorkflows(filter: { status?: WorkflowRecord['status'] } = {}): WorkflowRecord[] {
    const matched: WorkflowRecord[] = []
    for (const [, record] of this.tables.workflows.entries()) {
      if (filter.status !== undefined && record.status !== filter.status) continue
      matched.push(record)
    }
    return matched.sort((left, right) => {
      if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1
      return left.workflowId < right.workflowId ? -1 : left.workflowId > right.workflowId ? 1 : 0
    })
  }

  /**
   * Read one workflow run.
   * @param runId - the run identity.
   * @returns the record or undefined.
   */
  getWorkflowRun(runId: string): WorkflowRunRecord | undefined {
    return this.tables.workflow_runs.get(runId)
  }

  /**
   * Store one workflow run.
   * @param record - the complete run.
   * @returns the stored record.
   */
  async putWorkflowRun(record: WorkflowRunRecord): Promise<WorkflowRunRecord> {
    await this.tables.workflow_runs.put(record.runId, record)
    return record
  }

  /**
   * Apply a pure transform to one run, stamping `updatedAt`.
   * @param runId - the run identity.
   * @param transform - receives the current record; returns the next one.
   * @returns the stored next record.
   */
  async updateWorkflowRun(
    runId: string,
    transform: (current: WorkflowRunRecord) => WorkflowRunRecord,
  ): Promise<WorkflowRunRecord> {
    return this.tables.workflow_runs.update(runId, (current) => ({
      ...transform(current),
      updatedAt: this.now(),
    }))
  }

  /**
   * List workflow runs, newest first.
   * @param filter - optional narrowing by workflow or status.
   * @returns the matching runs, newest first with an id tiebreaker.
   */
  listWorkflowRuns(filter: { workflowId?: string; status?: WorkflowRunRecord['status'] } = {}): WorkflowRunRecord[] {
    const matched: WorkflowRunRecord[] = []
    for (const [, record] of this.tables.workflow_runs.entries()) {
      if (filter.workflowId !== undefined && record.workflowId !== filter.workflowId) continue
      if (filter.status !== undefined && record.status !== filter.status) continue
      matched.push(record)
    }
    return matched.sort((left, right) => {
      if (left.startedAt !== right.startedAt) return left.startedAt < right.startedAt ? 1 : -1
      return left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0
    })
  }

  // ── shared constraints ───────────────────────────────────────────────────

  /**
   * Read one constraint.
   * @param constraintId - the constraint identity.
   * @returns the record or undefined.
   */
  getConstraint(constraintId: string): ConstraintStoreRecord | undefined {
    return this.tables.constraints.get(constraintId)
  }

  /**
   * Store one constraint version.
   *
   * The current version is the record; superseded bodies are not retained here. A run
   * that needs "the version it started under" already recorded the number, so keeping
   * every old body would only preserve text nothing can be evaluated against.
   *
   * @param record - the complete record.
   * @returns the stored record.
   */
  async putConstraint(record: ConstraintStoreRecord): Promise<ConstraintStoreRecord> {
    await this.tables.constraints.put(record.constraintId, record)
    return record
  }

  /**
   * List constraints, newest first.
   * @param filter - optional narrowing by kind.
   * @returns the matching constraints, newest first with an id tiebreaker.
   */
  listConstraints(filter: { kind?: ConstraintStoreRecord['kind'] } = {}): ConstraintStoreRecord[] {
    const matched: ConstraintStoreRecord[] = []
    for (const [, record] of this.tables.constraints.entries()) {
      if (filter.kind !== undefined && record.kind !== filter.kind) continue
      matched.push(record)
    }
    return matched.sort((left, right) => {
      if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1
      return left.constraintId < right.constraintId ? -1 : left.constraintId > right.constraintId ? 1 : 0
    })
  }

  /**
   * Read one delivery of one constraint version to one target.
   * @param key - the delivery key (`<id>@<version>::<target>`).
   * @returns the record or undefined.
   */
  getConstraintDelivery(key: string): ConstraintDeliveryRecord | undefined {
    return this.tables.constraint_deliveries.get(key)
  }

  /**
   * Store one constraint delivery.
   * @param record - the complete record.
   * @returns the stored record.
   */
  async putConstraintDelivery(record: ConstraintDeliveryRecord): Promise<ConstraintDeliveryRecord> {
    await this.tables.constraint_deliveries.put(record.deliveryKey, record)
    return record
  }

  /**
   * List constraint deliveries, newest first.
   * @param filter - optional narrowing by constraint or target.
   * @returns the matching deliveries, newest first with a key tiebreaker.
   */
  listConstraintDeliveries(filter: { constraintId?: string; targetId?: string } = {}): ConstraintDeliveryRecord[] {
    const matched: ConstraintDeliveryRecord[] = []
    for (const [, record] of this.tables.constraint_deliveries.entries()) {
      if (filter.constraintId !== undefined && record.constraintId !== filter.constraintId) continue
      if (filter.targetId !== undefined && record.targetId !== filter.targetId) continue
      matched.push(record)
    }
    return matched.sort((left, right) => {
      if (left.updatedAt !== right.updatedAt) return left.updatedAt < right.updatedAt ? 1 : -1
      return left.deliveryKey < right.deliveryKey ? -1 : left.deliveryKey > right.deliveryKey ? 1 : 0
    })
  }

  // ── budgets and the run ledger ───────────────────────────────────────────

  /**
   * Read one budget policy.
   * @param policyKey - the policy key (`<scope>::<target>`).
   * @returns the record or undefined.
   */
  getBudget(policyKey: string): BudgetStoreRecord | undefined {
    return this.tables.budgets.get(policyKey)
  }

  /**
   * Store one budget policy.
   * @param record - the complete record.
   * @returns the stored record.
   */
  async putBudget(record: BudgetStoreRecord): Promise<BudgetStoreRecord> {
    await this.tables.budgets.put(record.policyKey, record)
    return record
  }

  /**
   * List budget policies, newest first.
   * @param filter - optional narrowing by scope.
   * @returns the matching policies, newest first with a key tiebreaker.
   */
  listBudgets(filter: { scope?: BudgetStoreRecord['scope'] } = {}): BudgetStoreRecord[] {
    const matched: BudgetStoreRecord[] = []
    for (const [, record] of this.tables.budgets.entries()) {
      if (filter.scope !== undefined && record.scope !== filter.scope) continue
      matched.push(record)
    }
    return matched.sort((left, right) => {
      if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1
      return left.policyKey < right.policyKey ? -1 : left.policyKey > right.policyKey ? 1 : 0
    })
  }

  /**
   * Read one run ledger.
   * @param targetId - the governed target.
   * @returns the record or undefined.
   */
  getLedger(targetId: string): LedgerStoreRecord | undefined {
    return this.tables.ledgers.get(targetId)
  }

  /**
   * Store one run ledger.
   *
   * There is deliberately no `resetLedger`, no `clearLedger` and no delete: PRD §二.13.2
   * says a transfer, a restart and a retry cannot zero the ledger, and the guarantee is
   * that no operation exists which could. A genuinely new run gets a new target id.
   *
   * @param record - the complete record.
   * @returns the stored record.
   */
  async putLedger(record: LedgerStoreRecord): Promise<LedgerStoreRecord> {
    return this.withExclusive(`ledger:${record.targetId}`, () => this.persistLedger(record))
  }

  /** Preserve durable deduplication identities even when an older writer omits them. */
  private async persistLedger(record: LedgerStoreRecord): Promise<LedgerStoreRecord> {
    const previous = this.tables.ledgers.get(record.targetId)
    const ids = [...new Set([...(previous?.countedOperationIds ?? []), ...(record.countedOperationIds ?? [])])]
    const next = { ...record, ...ids.length === 0 ? {} : { countedOperationIds: ids } }
    await this.tables.ledgers.put(record.targetId, next)
    return next
  }

  /** Count an event and its operation id in one durable write under a per-ledger lock. */
  async recordLedgerEvent(targetId: string, event: LedgerEvent, now: string, operationId?: string): Promise<LedgerStoreRecord> {
    return this.withExclusive(`ledger:${targetId}`, async () => {
      const previous = this.tables.ledgers.get(targetId)
      if (operationId !== undefined && previous?.countedOperationIds?.includes(operationId) === true) return previous
      const before = { ...emptyLedger(), ...previous, acceptances: previous?.acceptances ?? 0 }
      const after = carryLedger(before, event)
      return this.persistLedger({ ...after, targetId, updatedAt: now,
        ...operationId === undefined ? {} : { countedOperationIds: [...(previous?.countedOperationIds ?? []), operationId] } })
    })
  }

  /**
   * Apply a pure transform to one ledger, stamping `updatedAt`.
   * @param targetId - the governed target.
   * @param transform - receives the current record; returns the next one.
   * @returns the stored next record.
   */
  async updateLedger(
    targetId: string,
    transform: (current: LedgerStoreRecord) => LedgerStoreRecord,
  ): Promise<LedgerStoreRecord> {
    return this.withExclusive(`ledger:${targetId}`, async () => {
      const current = this.tables.ledgers.get(targetId)
      if (current === undefined) throw new Error(`conductor: missing ledger ${targetId}`)
      return this.persistLedger({ ...transform(current), targetId, updatedAt: this.now() })
    })
  }

  // ── remote hosts ─────────────────────────────────────────────────────────

  /**
   * Read one registered remote Host.
   * @param hostId - the registration identity.
   * @returns the record or undefined.
   */
  getRemoteHost(hostId: string): RemoteHostRecord | undefined {
    return this.tables.remote_hosts.get(hostId)
  }

  /**
   * Store one remote-Host registration.
   *
   * The record holds what identifies the Host and what it has reported — never a
   * credential. PRD §二.14.1's transport uses the user's existing SSH configuration, and
   * copying a key into this store would be the silent credential duplication the working
   * rules forbid.
   *
   * @param record - the complete record.
   * @returns the stored record.
   */
  async putRemoteHost(record: RemoteHostRecord): Promise<RemoteHostRecord> {
    await this.tables.remote_hosts.put(record.hostId, record)
    return record
  }

  /**
   * List registered remote Hosts, newest first.
   * @param filter - optional narrowing by enabled state.
   * @returns the matching registrations, newest first with an id tiebreaker.
   */
  listRemoteHosts(filter: { enabled?: boolean } = {}): RemoteHostRecord[] {
    const matched: RemoteHostRecord[] = []
    for (const [, record] of this.tables.remote_hosts.entries()) {
      if (filter.enabled !== undefined && record.enabled !== filter.enabled) continue
      matched.push(record)
    }
    return matched.sort((left, right) => {
      if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1
      return left.hostId < right.hostId ? -1 : left.hostId > right.hostId ? 1 : 0
    })
  }

  /**
   * Remove one registration.
   *
   * Removing a registration removes the *permission to name* a Host; it cannot undo a
   * migration that already happened, which is why the caller is expected to say so.
   *
   * @param hostId - the registration identity.
   * @returns whether a record was present.
   */
  async deleteRemoteHost(hostId: string): Promise<boolean> {
    return this.tables.remote_hosts.delete(hostId)
  }

  // ── shares ───────────────────────────────────────────────────────────────

  /**
   * Read one published share.
   * @param shareId - the share identity.
   * @returns the record or undefined.
   */
  getShare(shareId: string): ShareStoreRecord | undefined {
    return this.tables.shares.get(shareId)
  }

  /**
   * Store one published share.
   *
   * There is deliberately no `deleteShare`. Revocation records the instant; a deleted
   * record cannot answer "was this ever shared, and when did it stop?", which is the
   * question asked after a leak rather than before it.
   *
   * @param record - the complete record.
   * @returns the stored record.
   */
  async putShare(record: ShareStoreRecord): Promise<ShareStoreRecord> {
    await this.tables.shares.put(record.shareId, record)
    return record
  }

  /**
   * Apply a pure transform to one share.
   * @param shareId - the share identity.
   * @param transform - receives the current record; returns the next one.
   * @returns the stored next record.
   */
  async updateShare(shareId: string, transform: (current: ShareStoreRecord) => ShareStoreRecord): Promise<ShareStoreRecord> {
    return this.tables.shares.update(shareId, transform)
  }

  /**
   * List published shares, newest first.
   * @param filter - optional narrowing by task.
   * @returns the matching shares, newest first with an id tiebreaker.
   */
  listShares(filter: { taskId?: string } = {}): ShareStoreRecord[] {
    const matched: ShareStoreRecord[] = []
    for (const [, record] of this.tables.shares.entries()) {
      if (filter.taskId !== undefined && record.taskId !== filter.taskId) continue
      matched.push(record)
    }
    return matched.sort((left, right) => {
      if (left.publishedAt !== right.publishedAt) return left.publishedAt < right.publishedAt ? 1 : -1
      return left.shareId < right.shareId ? -1 : left.shareId > right.shareId ? 1 : 0
    })
  }

  // ── resources ────────────────────────────────────────────────────────────

  /**
   * Read one plugin-owned resource.
   * @param resourceId - the registry identity.
   * @returns the record, or undefined when none is registered.
   */
  getResource(resourceId: string): ResourceStoreRecord | undefined {
    return this.tables.resources.get(resourceId)
  }

  /**
   * Register or overwrite one plugin-owned resource.
   *
   * Overwrite is how a retry of the same preparation keeps one row for one
   * directory. There is deliberately no `deleteResource`: a cleaned resource
   * keeps its row so a later reader can tell the cleanup happened.
   *
   * @param record - the complete record.
   * @returns the stored record.
   */
  async putResource(record: ResourceStoreRecord): Promise<ResourceStoreRecord> {
    await this.tables.resources.put(record.resourceId, record)
    return record
  }

  /**
   * Apply a pure transform to one resource.
   * @param resourceId - the registry identity.
   * @param transform - receives the current record; returns the next one.
   * @returns the stored next record.
   */
  async updateResource(
    resourceId: string,
    transform: (current: ResourceStoreRecord) => ResourceStoreRecord,
  ): Promise<ResourceStoreRecord> {
    return this.tables.resources.update(resourceId, transform)
  }

  /**
   * List registered resources, newest first.
   * @returns every stored resource.
   */
  listResources(): ResourceStoreRecord[] {
    const matched: ResourceStoreRecord[] = []
    for (const [, record] of this.tables.resources.entries()) matched.push(record)
    return matched.sort((left, right) => {
      if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1
      return left.resourceId < right.resourceId ? -1 : left.resourceId > right.resourceId ? 1 : 0
    })
  }

  // ── operations ───────────────────────────────────────────────────────────

  /** Read one operation. @param operationId - stable operation id. @returns the record or undefined. */
  getOperation(operationId: string): StoredOperationRecord | undefined {
    return this.tables.operations.get(operationId)
  }

  /**
   * Claim an operation id for one set of parameters (PRD §四.1).
   *
   * The persisted order starts here: the operation is saved before anything is
   * dispatched, so a crash between the two leaves a record that recovery can
   * classify instead of a side effect with no trace.
   *
   * @param input - identity, family and parameters of the request.
   * @returns `accepted` for a fresh claim, `replay` for the same id and
   * parameters, `conflict` for a reused id whose parameters differ.
   */
  async beginOperation(input: BeginOperationInput): Promise<BeginOperationResult> {
    return this.withExclusive(`operation:${input.operationId}`, () => this.claimOperation(input))
  }

  private async claimOperation(input: BeginOperationInput): Promise<BeginOperationResult> {
    const digest = paramDigest(input.kind, input.params)
    const existing = this.tables.operations.get(input.operationId)
    const match: OperationMatch = classifyOperation(
      existing === undefined ? undefined : toOperationRecord(existing),
      input.kind,
      digest,
    )
    if (match.kind === 'conflict') {
      return { kind: 'conflict', record: existing, reason: match.reason }
    }
    if (match.kind === 'replay') {
      return { kind: 'replay', record: existing as StoredOperationRecord }
    }
    const stamp = this.now()
    const record: StoredOperationRecord = {
      operationId: input.operationId,
      kind: input.kind,
      paramDigest: digest,
      // Kept alongside the digest so a preparation can be resumed with the request that was
      // actually made. A replay returns this record unchanged, so the parameters describe the
      // original request rather than the retry.
      params: input.params,
      ...input.attribution === undefined ? {} : { attribution: input.attribution },
      ...input.dispatchGuard === undefined ? {} : { dispatchGuard: input.dispatchGuard },
      ...input.sessionLinkCapability === undefined ? {} : { sessionLinkCapability: input.sessionLinkCapability },
      delivery: 'prepared',
      withdrawn: false,
      createdAt: stamp,
      updatedAt: stamp,
      ...input.taskId === undefined ? {} : { taskId: input.taskId },
      ...input.messageId === undefined ? {} : { messageId: input.messageId },
    }
    await this.tables.operations.put(record.operationId, record)
    return { kind: 'accepted', record }
  }

  /**
   * Apply a pure transform to one operation, stamping `updatedAt`.
   *
   * Used to attach a task id once it exists and to record the phase an
   * operation reached, so progress survives a crash between two phases.
   *
   * @param operationId - stable operation id.
   * @param transform - receives the current record; returns the next one.
   * @returns the stored next record.
   */
  async updateOperation(
    operationId: string,
    transform: (current: StoredOperationRecord) => StoredOperationRecord,
  ): Promise<StoredOperationRecord> {
    return this.tables.operations.update(operationId, (current) => ({
      ...transform(current),
      updatedAt: this.now(),
    }))
  }

  /**
   * Advance an operation's delivery state.
   * @param operationId - stable operation id.
   * @param delivery - the next persisted delivery state.
   * @param phase - optional free-form phase label for progress reporting.
   * @returns the stored record.
   */
  async markDelivery(
    operationId: string,
    delivery: DeliveryState,
    phase?: string,
  ): Promise<StoredOperationRecord> {
    return this.updateOperation(operationId, current => ({
      ...current,
      delivery,
      ...phase === undefined ? {} : { phase },
    }))
  }

  /**
   * Mark an operation withdrawn without deleting it.
   *
   * The record outlives the withdrawal on purpose: PRD §四.1 forbids a
   * withdrawn operation from being delivered again after a restart, and a
   * deleted record would let the same id be claimed afresh.
   *
   * @param operationId - stable operation id.
   * @returns the stored record.
   */
  async withdrawOperation(operationId: string): Promise<StoredOperationRecord> {
    return this.updateOperation(operationId, current => ({
      ...current,
      withdrawn: true,
      delivery: 'withdrawn',
    }))
  }

  /**
   * Operations a restart must act on, with the action each one needs.
   *
   * This is the read side of the crash-window rules in PRD §四.1: continue what
   * never dispatched, reconcile what dispatched without a confirmable result,
   * and leave settled records alone. Nothing here resends.
   *
   * @returns one entry per unfinished operation, in creation order.
   */
  listRecoverableOperations(): { readonly record: StoredOperationRecord; readonly action: ReturnType<typeof recoveryAction> }[] {
    const found: { record: StoredOperationRecord; action: ReturnType<typeof recoveryAction> }[] = []
    for (const [, record] of this.tables.operations.entries()) {
      const action = recoveryAction(toOperationRecord(record))
      if (action === 'done') continue
      found.push({ record, action })
    }
    return found.sort((left, right) => (left.record.createdAt < right.record.createdAt ? -1 : 1))
  }

  /** Number of stored operations whose delivery is still unresolved. */
  get unresolvedOperationCount(): number {
    return this.listRecoverableOperations().length
  }

  /**
   * List persisted operations, optionally narrowed to one task.
   *
   * Every state is returned, including settled and withdrawn ones: a control
   * transfer has to account for the operations that are *finished* as well, because
   * "nothing is in flight" and "nothing was ever recorded" are different facts and
   * only one of them is reassuring.
   *
   * @param filter - optional narrowing by task.
   * @returns the matching records, oldest first with an id tiebreaker.
   */
  listOperations(filter: { taskId?: string } = {}): StoredOperationRecord[] {
    const matched: StoredOperationRecord[] = []
    for (const [, record] of this.tables.operations.entries()) {
      if (filter.taskId !== undefined && record.taskId !== filter.taskId) continue
      matched.push(record)
    }
    return matched.sort((left, right) => {
      if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1
      return left.operationId < right.operationId ? -1 : left.operationId > right.operationId ? 1 : 0
    })
  }
}

/**
 * Present a stored record to the pure idempotency rules.
 *
 * The stored shape carries a `phase` the domain model does not need, and the
 * rules only read identity, family, digest, delivery and the withdrawal flag —
 * so the projection is explicit rather than a cast.
 * @param record - the stored operation.
 * @returns the domain-model view of it.
 */
function toOperationRecord(record: StoredOperationRecord): OperationRecord {
  return {
    operationId: record.operationId,
    kind: record.kind as OperationKind,
    paramDigest: record.paramDigest,
    // Carried through, not dropped: the domain rules use it to say *which kind* of parameter mismatch a
    // conflict is, and the projection was discarding the only evidence that could tell them apart.
    ...record.params === undefined ? {} : { params: record.params },
    delivery: record.delivery,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    withdrawn: record.withdrawn,
  }
}
