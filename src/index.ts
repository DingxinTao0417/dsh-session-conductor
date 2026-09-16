/**
 * dsh-session-conductor — host half.
 *
 * Coordinates ordinary Harness sessions from one controller conversation. This
 * entry point is deliberately thin: it probes the Host, mounts the
 * `conductor_*` tools, and hands the live context to the coordination service.
 *
 * Design boundaries fixed by the specification that are visible here:
 *
 * - the plugin adds no custom Session event type and never edits Host JSONL
 *   (PRD §三.5), so all state lives in the plugin's own storage domain;
 * - the two Host API compatibility extensions of PRD §一.5 are never assumed —
 *   features that need them stay disabled with a reason until the operator
 *   service (PRD §三.2), so the service is created here and passed down rather
 *   than re-created per surface.
 *
 * @module dsh-session-conductor
 */

import { createRequire } from 'node:module'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import { validateJsonSchemaValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { RemotePanelFacts } from './domain/panel-remote.ts'
import { taskObservationSchema } from './service/observation.ts'
import { remoteHistoryCursor, persistRemoteHistoryCursor } from './service/remote-read-cursor.ts'
import { createPanelController, readPanelSessionMetadata, type PanelAgents } from './service/panel-controller.ts'
import { explicitLocalUserInvocation } from './tools.ts'
import { Config, type ConductorConfig } from './config.ts'
import { automaticDispatchRefusal } from './service/dispatch-admission.ts'
import { freezeWorkflowModels, workflowModelRefusal, workflowOperationModelRefusal } from './service/workflow-model.ts'
import { enqueueHandoff } from './service/handoff-operation.ts'
import { startRemoteRuntime, type RemoteRuntime } from './service/remote-runtime.ts'
import { executeRemoteMutation, reconcileRemoteSource, remoteSendReceipt, remoteStopReceipt, remoteQueueReceipt } from './service/remote-source.ts'
import { createRemoteHostAdapter, remoteTaskFrozen, remoteSessionDispatchBlocked, type RemoteHostAdapterOptions } from './remote/host-adapter.ts'
import {
  probeCapabilities,
  type CapabilitySnapshot,
  type ProbeContext,
  type StoreStatus,
} from './capabilities.ts'
import { registerConductorTools, type AccessToolRequest, type AccessToolResult, type ArtifactAcceptanceRequest, type ArtifactAcceptanceResult, type BriefOutcome, type RuleToolRequest, type RuleToolResult, type ScheduleToolRequest, type ScheduleToolResult, type TaskStatusReading, type ToolRegistryLike, type TransferToolRequest, type WatchToolRequest, type WatchToolResult, type WorkflowToolRequest, type WorkflowToolResult, type ConstraintsToolRequest, type ConstraintsToolResult, type BudgetToolRequest, type BudgetToolResult, type ExportToolRequest, type ExportToolResult, type ModelConfigToolRequest, type ModelConfigToolResult, type RemoteToolRequest, type RemoteToolResult, type ShareToolRequest, type ShareToolResult, type CleanupToolRequest, type CleanupToolResult, type OperationToolRequest, type OperationToolResult } from './tools.ts'
import { calibrateOperation } from './domain/operation.ts'
import { canTransition, connectionListFields, connectionOf, overlayExecution } from './domain/state.ts'
import { sortTaskList } from './service/taskfilter.ts'
import { openConductorStore, type DomainFacilityLike } from './store/host.ts'
import { DOMAIN_NAME } from './store/schema.ts'
import { prepareStoredMedium, restoreMediumBackup, type MediumFiles } from './store/migrate.ts'
import { CONDUCTOR_SETTINGS_NS, createLiveConfig } from './service/liveconfig.ts'
import { IMPLEMENTATION_DEFAULTS } from './domain/defaults.ts'
import {
  countArtifactDisplayFacts,
  describeArtifactFactSummary,
  describeArtifactFacts,
} from './domain/artifact-facts.ts'
import { sessionContinuationFields } from './domain/session-chain.ts'
import { forkOriginOf } from './domain/fork-origin.ts'
import { archivedSessionsOf, gitArtifactKindPort, hostGitRunner, hostPathOpener, snapshotIoOf, transferFsOf, workspacePortOf } from './adapters.ts'
import { parentEnvironmentOf, setCreatedSessionTitle } from './service/creation-environment.ts'
import { encodeObservationCursor, observationAfterCursor, type TaskObservation } from './service/observation.ts'
import { readRepoState, removeWorktree } from './service/git.ts'
import { CancelTracker, openTurnOf } from './service/stop.ts'
import {
  cleanupDecision,
  describeCleanupPreview,
  planCleanupExecute,
  samePath,
  underPath,
  worktreeResourceId,
  type CleanupPreviewItem,
  type TreeState,
} from './service/cleanup.ts'
import type { ConductorStore } from './store/repository.ts'
import { Coordinator, type PresetPort } from './service/coordinator.ts'
import { buildBrief, digestBrief, renderBrief } from './service/brief.ts'
import {
  acceptanceCounts,
  applyAcceptance,
  applyVerification,
  ARTIFACT_PREVIEW_BYTE_LIMIT,
  ARTIFACT_PREVIEW_CHAR_LIMIT,
  boundListing,
  decideArtifactOpen,
  decideArtifactRead,
  describeArtifactProvenance,
  isPinnedForDependency,
  artifactConstraintCompatibleWithRun,
  newArtifactRecord,
  stampArtifactProvenance,
  utf8PreviewOf,
  verifyArtifact,
  type ArtifactFsPort,
  type ArtifactOpenResult,
  type ArtifactReadResult,
  type RegisterArtifactRequest,
} from './service/artifacts.ts'
import { controlCycleRefusal, evaluateRules, fireOperationId, planEnable, recordFiring, triggerOf } from './service/rules.ts'
import {
  advanceNextAt,
  countRuns,
  dueDecision,
  calibratedInspectRun,
  inspectNoticeDecision,
  lastInspectObservation,
  planRecovery,
  planResume,
  planScheduleSave,
} from './service/schedule.ts'
import { inspectObservationOf } from './service/inspect.ts'
import { initialProjection, lastTurnFieldsOf, pendingInterventionFromWatches, pendingInterventionOf, projectEvents, projectNotableAfter, type NotableEvent, type ProjectionState, type SessionEventLike } from './service/projection.ts'
import {
  deliveryFor,
  externalFact,
  mergeReports,
  notableFactsOf,
  renderReport,
  storedFactsOf,
  type ReportFact,
} from './service/report.ts'
import { unreadCountOf, unreadItemsOf } from './service/unread.ts'
import { PLUGIN_DISABLED_ACCOUNT, PluginLifecycle } from './service/lifecycle.ts'
import type { ArtifactRecord, BudgetStoreRecord, NotificationRecord, ResourceStoreRecord, RuleRecord, ScheduleRecord, TaskRecord, TransferRecord, WatchRecord, WorkflowRecord, WorkflowRunRecord } from './store/schema.ts'
import { buildReference, patchHandoff, snapshotCopy, type TransferFsPort } from './service/transfer.ts'
import {
  handoffTask,
  type HandoffAgents,
  type HandoffFs,
  type HandoffOutcome,
  type HandoffRequest,
  type HandoffSessions,
} from './service/handoff.ts'
import {
  listCandidates,
  type ArchiveSetRead,
  type CandidateFilter,
  type CandidateList,
  type SessionQueryLike,
} from './service/discovery.ts'
import { TaskObserver, type ObservableAgentsLike } from './service/observer.ts'
import { lastPromptSource, turnOriginOf } from './service/barrier.ts'
import { admitPluginTurn } from './service/concurrency.ts'
import { noticeSource, type AgentRegistryLike, type MessageSource } from './service/host.ts'
import { addObserver, applyTransfer, mayRead, monitoringAllowed, mutationPinRefusal, observationContinues, planTransfer, removeObserver, snapshotDeliveryPlan, writeControlRefusal } from './service/access.ts'
import { BackgroundPass } from './service/pass.ts'
import { advanceDelivery, describeDelivery, planConstraintChange, planConstraintImpact } from './service/constraints.ts'
import { budgetBoundary, budgetDecision, budgetLimitsOf, describeUsage, emptyLedger, hardBudgetAllowed, inFlightCancelApplies, planBudgetTurnCancel, type LedgerEvent, type MeteringCapabilities, type BudgetPolicy, type BudgetScope, type RunLedger, type UsageFact } from './service/budget.ts'
import { SHARE_RULES, buildExport, renderJson, renderMarkdown, shareAvailability } from './service/export.ts'
import { applySelection, describeConfigState, modelListingNotes, modelSelectionWriterOf, modelSelectionReaderOf, readSessionSelection, MODEL_SELECTION_WRITER_SERVICE, publishedReasoningOf, resolveSelection, selectionFromHeader, type CreationModelPort, type ModelCatalogPort, type ModelSelection } from './service/modelconfig.ts'
import type { SessionViewLike } from './service/observer.ts'
import { PANEL_DETAIL_ROUTE, PANEL_ROUTE, panelStatusOf, registerPanelActionRoutes, registerPanelDetailRoute, registerPanelRoute, type PanelArtifactFact, type PanelBudgetFact, type PanelOperationFact, type PanelPayload, type PanelTaskDetail, type PanelTaskView, type WebRoutePort } from './service/panelapi.ts'
import { registerSessionLinksRoute, sessionLinksOf } from './service/session-links.ts'
import { reconcileFollowupReturns } from './service/followup-returns.ts'
import { overviewOf, registerOverviewRoute, registerOverviewResultRoute } from './service/overview.ts'
import { registerPreviewRoute, type PreviewContext } from './service/preview.ts'
import { registerTerminalRoutes, type TerminalSubprocess } from './service/terminal.ts'
import { resolveCompletionReturn, type CompletionReturnCallback } from './service/completion-return.ts'
import { remoteAction } from './service/remote-actions.ts'
import type { RemoteReadToolRequest, RemoteReadToolResult } from './tools.ts'
import { createShareCoordinator } from './share/coordinator.ts'
import { createShareClient, MAX_SHARE_BYTES, type ShareServicePort, type ShareAttachment } from './share/transport.ts'
import {
  afterNodeFailure,
  approveNode,
  budgetPolicyText,
  cancelUnfinishedNodes,
  canonicalNodeState,
  definitionFromFixed,
  definitionViewOf,
  fixedDrift,
  frozenFailureOf,
  isStartable,
  nodeReadiness,
  runHasSettled,
  nodesForPartialRerun,
  overlayNodeFromTarget,
  planPartialRerun,
  recordVerdict,
  runViewOf,
  turnsToStopOnWorkflowCancel,
  validateDefinition,
  verdictRefusal,
  verdictRuleRefusal,
  type WorkflowDefinition,
  type WorkflowRun,
  type RunFixed,
} from './service/workflow.ts'

export { Config }
export type { ConductorConfig }

/**
 * Cordis plugin name; must match the row id the bundle patch inserts.
 */
export const name = 'dsh-session-conductor'

/**
 * This plugin declares **no** hard service dependency, deliberately.
 *
 * A cordis entry whose injections are unmet stays pending and silently never
 * runs, so `inject: ['tools']` would turn "this composition has no tool
 * registry" into "the conductor does not exist" — with no error and nothing to
 * act on. The specification instead requires an unavailable capability to be
 * disabled *and explained*. So the plugin always mounts, probes what is there,
 * and reports what it had to turn off; only the tool registration is skipped
 * when no registry exists.
 */
export const inject: readonly string[] = []

/**
 * Read this package's version at runtime.
 *
 * A literal constant would drift from `package.json` on the first release
 * bump, and the capability snapshot is the one place the model reads the
 * version from, so it must be the real one.
 *
 * @returns the package version, or an explicit unknown marker.
 */
function readPluginVersion(): string {
  try {
    const require = createRequire(import.meta.url)
    const manifest = require('../package.json') as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0-unknown'
  } catch {
    // A bundled or relocated install may not keep package.json adjacent to the
    // entry. Reporting an unknown version is better than failing to load.
    return '0.0.0-unknown'
  }
}

/**
 * Build the preset port a fork uses, or `undefined` when the Host mounts no
 * preset roster.
 *
 * Two things are deliberately *not* reimplemented here. The preset a session
 * actually ran under is resolved by the Host's own `resolveSessionPreset`, which
 * knows that a later `agent-preset/selected` event overrides the header's
 * creation-time value — reading the header alone would silently pick the wrong
 * composition. And the composition itself is mounted through the service's own
 * `mount`, which is what the Host's fork does. Both are resolved at call time so
 * a late-published service is still found.
 *
 * @param probe - the service lookup.
 * @returns the port, or `undefined` when the Host has no preset service.
 */
function presetPortOf(probe: ProbeContext): PresetPort | undefined {
  const serviceOf = (): PresetsLike | undefined => {
    const service = probe.get('agentPresets') as PresetsLike | undefined
    return service !== undefined && typeof service.mount === 'function' ? service : undefined
  }
  if (serviceOf() === undefined) return undefined
  return {
    presetOf: (source) => {
      try {
        return resolveSessionPreset(source as unknown as Parameters<typeof resolveSessionPreset>[0])
      } catch {
        // A session whose preset cannot be resolved forks without one, which is
        // what the Host's own fork does when the roster is absent.
        return undefined
      }
    },
    mount: async (agentCtx, presetId) => {
      const service = serviceOf()
      if (service === undefined) return
      await service.mount(agentCtx, presetId)
    },
    // Validation is the Host's own `resolve`, not a check written here: the roster is read fresh on every
    // call (its documentation says a preset written while the process runs is visible immediately), and it
    // is the only thing that knows the available ids and which of them are broken. Its own error already
    // lists what is available, so the refusal a caller sees names the real alternatives.
    //
    // A composition that mounts the service without `resolve` reports that it cannot check rather than
    // accepting the name on trust — the same rule as every other capability in this plugin.
    checkPreset: async (presetId) => {
      const service = serviceOf()
      if (service === undefined || typeof service.resolve !== 'function') {
        return {
          ok: false,
          reason: 'this Host mounts a preset service without a `resolve`, so a preset id cannot be checked '
            + 'against the roster; nothing was created, because accepting the name on trust would record a '
            + 'composition the task may never have received.',
        }
      }
      try {
        const preset = await service.resolve(presetId)
        // A broken preset resolves too — its directory still holds the id — so the row's own reason is what
        // makes "the preset exists but cannot be assembled" a different answer from "no such preset".
        const broken = (preset as { broken?: unknown }).broken
        if (typeof broken === 'string' && broken.length > 0) {
          return {
            ok: false,
            reason: `preset "${presetId}" is present but cannot be assembled: ${broken}. Nothing was created: a `
              + 'task composed with a broken preset would fail later, where the cause is much harder to see.',
          }
        }
        return { ok: true, id: typeof (preset as { id?: unknown }).id === 'string' ? String((preset as { id: string }).id) : presetId }
      } catch (error) {
        return {
          ok: false,
          reason: `preset "${presetId}" could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    },
    defaultPresetId: () => {
      const service = serviceOf()
      return typeof service?.defaultId === 'string' && service.defaultId.length > 0 ? service.defaultId : undefined
    },
  }
}

/** The slice of `ctx.agentPresets` the create and fork paths use. */
interface PresetsLike {
  mount(agentCtx: unknown, id?: string): Promise<unknown>
  /** Present on the Host's own service; optional here so a partial double is still usable. */
  resolve?(id?: string): Promise<unknown>
  readonly defaultId?: string | undefined
}

/**
 * Mount the conductor's host half.
 *
 * The whole body is contained: a plugin that fails during mount and says
 * nothing is indistinguishable from a plugin that never loaded, which is the
 * single most confusing state an operator can meet. A failure is therefore
 * reported on the way out and then rethrown, so the Host's own error handling
 * still sees it.
 *
 * @param ctx - the plugin context.
 * @param config - validated conductor configuration.
 */
export function apply(ctx: Context, config: ConductorConfig): void {
  try {
    mount(ctx, config)
  } catch (error) {
    announce(ctx, `[dsh-session-conductor] mount FAILED: ${describeError(error)}`)
    throw error
  }
}

/**
 * Mount the conductor, assuming the Host is healthy enough to try.
 * @param ctx - the plugin context.
 * @param config - validated conductor configuration.
 */
function mount(ctx: Context, config: ConductorConfig): void {
  const pluginVersion = readPluginVersion()
  const panelDefinitions = new Map<string, ToolDefinition>()
  const remotePanelFacts = new RemotePanelFacts()
  ctx.effect(() => () => { remotePanelFacts.clear() })
  const capturePanelDefinitions = (registry: ToolRegistryLike): ToolRegistryLike => ({
    register(definition) {
      const dispose = registry.register(definition)
      panelDefinitions.set(definition.name, definition)
      return () => {
        if (panelDefinitions.get(definition.name) === definition) panelDefinitions.delete(definition.name)
        dispose()
      }
    },
  })
  const liveConfig = createLiveConfig(config)
  // `installSettingsSection` uses `ctx.inject(['settings'], …)`. A composition
  // (or the host-half smoke double) without that hook keeps the entry config;
  // claiming a settings surface there would be a different, untrue fact.
  if (typeof (ctx as { inject?: unknown }).inject === 'function') {
    installSettingsSection(
      ctx,
      settingsNamespace(CONDUCTOR_SETTINGS_NS),
      Config,
      config,
      {
        setSource: liveConfig.setSource,
        onChange: liveConfig.onChange,
        validate: liveConfig.validate,
      },
    )
  }
  const configOf = (): ConductorConfig => liveConfig.current()
  const probeContext: ProbeContext = {
    // `ctx.get` is typed against the Host's own service keys, which an external
    // package cannot widen; the probe only needs "look this name up", and a
    // lookup that throws is reported as an absent service rather than taken
    // down the whole mount.
    get: (serviceName: string) => {
      try {
        return (ctx as unknown as { get(name: string): unknown }).get(serviceName)
      } catch {
        return undefined
      }
    },
  }

  // Storage opens asynchronously, so the status starts as "not yet open" and is
  // replaced once the domain either opens or refuses. Reporting "open" before
  // the medium has been read would be exactly the kind of unearned claim the
  // specification's capability rules exist to prevent.
  let storeStatus: StoreStatus = {
    available: false,
    reason: 'the conductor storage domain has not been opened yet',
  }
  let store: ConductorStore | undefined
  let remoteRuntime: RemoteRuntime | undefined
  let remoteDispatchGuardReady = false
  const hookHost=ctx as unknown as {on?: (event:string,callback:(payload:{agent:{id:unknown;cancel(cause:{kind:'hook';reason:string},options:{keepInbox:true}):void}},next:()=>Promise<unknown>)=>Promise<unknown>)=>(()=>unknown)}
  if(typeof hookHost.on==='function'){
    const dispose=hookHost.on('agent/pre-step',async(payload,next)=>{
      const blocked=():boolean=>store===undefined
        ? configOf().crossHostEnabled && configOf().bridge!==undefined
        : remoteSessionDispatchBlocked(store,String(payload.agent.id))
      const reject=():{kind:'reject'}=>{payload.agent.cancel({kind:'hook',reason:store===undefined?'Remote migration state is not readable yet; retry after storage recovery.':'This session is frozen or continues on another Host; use its current task binding.'},{keepInbox:true});return {kind:'reject'}}
      if(blocked())return reject()
      const decision=await next()
      return blocked()?reject():decision
    })
    remoteDispatchGuardReady=true
    ctx.effect(()=>()=>{remoteDispatchGuardReady=false;dispose()})
  }
  const lifecycle = new PluginLifecycle()
  ctx.effect(() => () => { lifecycle.disable() })
  const cancelTracker = new CancelTracker()

  /**
   * Overlay interrupting / reconciling onto a Host-derived projection.
   *
   * Used by the panel, the export and the observer so those surfaces cannot
   * disagree about the execution dimension (PRD §三.4).
   */
  const overlayTaskState = (
    taskId: string,
    sessionId: string,
    state: ProjectionState,
    events: readonly SessionEventLike[],
  ): ProjectionState => {
    const current = store
    const open = openTurnOf(events)
    const unknown = current !== undefined
      && current.listOperations({ taskId }).some(record => record.delivery === 'unknown')
    const requested = cancelTracker.requestedTurn(sessionId)
    const execution = overlayExecution(state.execution, {
      unknownDeliveries: unknown,
      ...requested === undefined ? {} : { cancelRequestedTurn: requested },
      ...open === undefined ? {} : { openTurn: open.turn },
    })
    return execution === state.execution ? state : { ...state, execution }
  }

  // The snapshot is re-probed on demand rather than captured once: a Host
  // restart or plugin reload changes the answer, and a stale snapshot would let
  // the model plan against capabilities that are no longer there.
  const snapshot = (): CapabilitySnapshot => probeCapabilities(probeContext, {
    pluginVersion,
    declared: {
      selectModelRememberAsDefault: config.hostExtensions.selectModelRememberAsDefault,
      forkTargetParameters: config.hostExtensions.forkTargetParameters,
    },
    // The unresolved count is read **here** rather than captured with the status: operations get resolved as
    // a session goes on, so a number frozen at open would report a stale backlog for the rest of the process.
    store: storeStatus.available === false || store === undefined
      ? storeStatus
      : { ...storeStatus, ...unresolvedAccount(store) },
  })

  /**
   * How many operations are still unresolved, and what they are (PRD §四.5).
   *
   * The calibration announces its account at mount, but a log line is not a question a caller can ask. This
   * is the same fact, made readable on demand through the snapshot, which the PRD designates as the surface
   * for "the environment's state and why anything is unavailable".
   *
   * @param current - the open store.
   * @returns the count and, when it is non-zero, one line naming what is unresolved.
   */
  function unresolvedAccount(current: ConductorStore): { unresolvedOperations: number; unresolvedNote?: string } {
    const unresolved = current.listRecoverableOperations()
    if (unresolved.length === 0) return { unresolvedOperations: 0 }
    const summarise = (records: typeof unresolved): string => records
      .slice(0, 3)
      .map(entry => `${entry.record.operationId} (${entry.record.kind}, ${entry.record.delivery})`)
      .join(', ')
    return {
      unresolvedOperations: unresolved.length,
      unresolvedNote: `${summarise(unresolved)}${unresolved.length > 3 ? `, and ${String(unresolved.length - 3)} more` : ''}`
        + ' did not finish before the last restart. They are reported as they stand and are NOT resent: an'
        + ' operation that was mid-dispatch is recorded as unknown for reconciliation, and one that was claimed'
        + ' and never dispatched waits for its controller to resume or retry it under the same id.',
    }
  }

  const storageFacility = probeContext.get('storageDomain') as DomainFacilityLike | undefined

  /**
   * Build the coordinator once durable state and the agent registry exist.
   *
   * Every service is resolved **at call time** rather than captured at mount.
   * Cordis mounts entries concurrently, so a one-shot `ctx.get(...)` during
    * `apply` races the publication of a service belonging to a sibling entry —
   * the same race that once made the conductor report "no tool registry" for a
   *
   * @returns the coordinator, or `undefined` when durable state or the agent
   * registry is missing.
   */
  const coordinatorOf = (): Coordinator | undefined => {
    const liveAgents = probeContext.get('agents') as AgentRegistryLike | undefined
    if (store === undefined || liveAgents === undefined) return undefined
    const presets = presetPortOf(probeContext)
    // The Git adapter, the snapshot's filesystem port and the workspace registry (PRD §二.4).
    // Resolved here, inside the call, for the same reason as everything else on this builder: a
    // sibling entry may publish any of them after this plugin mounts, and a value captured at mount
    // time would freeze in the "not mounted" answer.
    const git = hostGitRunner(probeContext)
    const snapshotIo = snapshotIoOf(probeContext)
    const workspaces = workspacePortOf(probeContext)
    const sessions = probeContext.get('sessions') as { flush?(session: unknown): Promise<boolean> } | undefined
    const modelService = probeContext.get(MODEL_SELECTION_WRITER_SERVICE)
    const writer = modelSelectionWriterOf(modelService)
    const reader = modelSelectionReaderOf(modelService)
    const models: CreationModelPort | undefined = !configOf().hostExtensions.selectModelRememberAsDefault || writer === undefined || reader === undefined ? undefined : {
      resolve: async selection => {
        const llm = probeContext.get('llm') as { resolveCallConfig?(selection: ModelSelection): Promise<unknown> } | undefined
        if (typeof llm?.resolveCallConfig !== 'function') throw new Error('MODEL_RESOLUTION_UNAVAILABLE: Host cannot verify the frozen model before session creation')
        const resolved = selectionFromHeader({ config: await llm.resolveCallConfig(selection) })
        if (resolved === undefined) throw new Error('MODEL_STATE_UNCONFIRMED: Host returned an invalid resolved configuration')
        return resolved
      },
      defaultSelection: async () => {
        const defaults = probeContext.get('agentDefaultModel') as { currentSelection?(): unknown } | undefined
        const selected = selectionFromHeader({ config: defaults?.currentSelection?.() })
        if (selected === undefined) throw new Error('MODEL_DEFAULT_UNAVAILABLE: Host exposes no verifiable default selection')
        return selected
      },
      stateForSession: async sessionId => {
        const state = await readSessionSelection(reader, sessionId)
        return { selection: state.next, persisted: state.persisted }
      },
      apply: async (sessionId, selection) => {
        const result = await applySelection(selection, { rememberAsDefaultSupported: true }, writer, sessionId)
        if (!result.ok) throw new Error(`MODEL_STATE_UNCONFIRMED: ${result.reason}`)
        return result.selection
      },
    }
    return new Coordinator({
      agents: liveAgents,
      store,
      localHostId: configOf().bridge?.hostId ?? 'local',
      remoteStop: async(request,binding)=>{
        if(!remoteRuntime || !configOf().crossHostEnabled)throw Error('REMOTE_UNAVAILABLE')
        const current=store!, runtime=remoteRuntime, ownerEpoch=current.getAccess(request.taskId)!.ownerEpoch
        return await executeRemoteMutation({store:current,binding,...request,action:'task.stop',params:request,
          admission:()=>{
            if(!lifecycle.active || !configOf().crossHostEnabled)throw Error('REMOTE_UNAVAILABLE')
            if(remoteTaskFrozen(current,request.taskId))throw Error('REMOTE_MIGRATION_FROZEN')
          },validate:value=>remoteStopReceipt(value,request),
          counted:async(result,operationId,at)=>{if(result.sent)await countDispatch(current,request.taskId,at,undefined,operationId)},
          dispatch:async beforeDispatch=>await runtime.router.request(binding.hostId,'task.stop',{
          taskId:request.taskId,expectedBindingVersion:binding.version,expectedOwnerEpoch:ownerEpoch,
          ...request.text===undefined?{}:{text:request.text},...request.expectedTurn===undefined?{}:{expectedTurn:request.expectedTurn},
          ...request.expectedStartSeq===undefined?{}:{expectedStartSeq:request.expectedStartSeq},
          confirmLimitMs:request.confirmLimitMs??configOf().interruptConfirmLimitMs,
        },request.operationId,beforeDispatch)})
      },
      remoteQueue: async(request,binding)=>{
        if(!remoteRuntime || !configOf().crossHostEnabled)throw Error('REMOTE_UNAVAILABLE')
        const current=store!, runtime=remoteRuntime, ownerEpoch=current.getAccess(request.taskId)!.ownerEpoch
        const dispatch=async(beforeDispatch?:()=>void)=>await runtime.router.request(binding.hostId,'task.queue',{
          taskId:request.taskId,action:request.action,expectedBindingVersion:binding.version,expectedOwnerEpoch:ownerEpoch,
          ...request.messageId===undefined?{}:{messageId:request.messageId},...request.text===undefined?{}:{text:request.text},
        },request.action==='list'?`remote-queue-read-${randomUUID()}`:request.operationId,beforeDispatch)
        if(request.action==='list'){
          const result=remoteQueueReceipt(await dispatch(),request)
          throwUnlessReader(request.taskId,request.callerSessionId)
          const latest=current.getBinding(current.getTask(request.taskId)?.currentBindingId??'')
          if(latest?.bindingId!==binding.bindingId || latest.version!==binding.version)throw Error('STALE_BINDING')
          return result
        }
        return await executeRemoteMutation({store:current,binding,...request,action:'task.queue',params:request,dispatch,
          validate:value=>remoteQueueReceipt(value,request),admission:()=>{
            if(!lifecycle.active || !configOf().crossHostEnabled)throw Error('REMOTE_UNAVAILABLE')
            if(remoteTaskFrozen(current,request.taskId))throw Error('REMOTE_MIGRATION_FROZEN')
          }})
      },
      remoteSend: async (request,binding) => {
        if (!remoteRuntime || !configOf().crossHostEnabled) throw new Error('REMOTE_UNAVAILABLE: configured bridge and registered SSH transport are required')
        if (request.mode !== 'steer' && request.mode !== 'queue') throw new Error('REMOTE_UNSUPPORTED_MODE')
        if (request.requireIdle || request.attribution?.kind === 'rule') throw new Error('REMOTE_CONDITIONAL_DISPATCH: this remote protocol cannot prove a conditional grant or idle precondition')
        const current=store!
        const denied=writeControlRefusal(current.getAccess(request.taskId),request.taskId,request.callerSessionId)
        if (denied) throw new Error(denied.reason)
        const runtime=remoteRuntime, ownerEpoch=current.getAccess(request.taskId)!.ownerEpoch
        const messageId=`remote-message-${createHash('sha256').update(request.operationId).digest('hex')}`
        return await executeRemoteMutation({store:current,binding,...request,action:'task.send',params:{...request,requestedMessageId:messageId},
          validate:value=>remoteSendReceipt(value,request,messageId),pending:result=>result.delivery==='pending',
          counted:async(_result,operationId,at)=>await countDispatch(current,request.taskId,at,undefined,operationId),
          admission:record=>{
            if(!lifecycle.active || !configOf().crossHostEnabled)throw Error('REMOTE_UNAVAILABLE')
            if(remoteTaskFrozen(current,request.taskId))throw Error('REMOTE_MIGRATION_FROZEN')
            if(record.attribution && record.attribution.kind!=='user'){
              const refusal=automaticDispatchRefusal(current,record,Date.now())
                ?? workflowOperationModelRefusal(current,record,modelSelectionReaderOf(probeContext.get(MODEL_SELECTION_WRITER_SERVICE)))
              if(refusal)throw Error(refusal)
              const budget=budgetPermits(current,request.taskId,new Date().toISOString())
              if(!budget.allowed)throw Error(budget.reason)
            }
          },dispatch:async beforeDispatch=>await runtime.router.request(binding.hostId,'task.send',{
            taskId:request.taskId,messageId,text:request.text,mode:request.mode as 'steer'|'queue',
            expectedOwnerEpoch:ownerEpoch,expectedBindingVersion:binding.version,
          },request.operationId,beforeDispatch)})
      },
      createMessage: (text: string, source: MessageSource) =>
        createUserMessage({ content: [{ type: 'text', text }], source }) as unknown as { readonly id: string },
      newTaskId: () => `task-${randomUUID()}`,
      newSessionId: () => `session-${randomUUID()}`,
      newBindingId: () => `binding-${randomUUID()}`,
      now: () => new Date().toISOString(),
      defaultCwd: () => process.cwd(),
      parentEnvironment: controllerSessionId => parentEnvironmentOf(probeContext, controllerSessionId),
      setSessionTitle: (agent, title) => setCreatedSessionTitle(probeContext, agent, title),
      ...models === undefined ? {} : { models },
      ...presets === undefined ? {} : { presets },
      // All three are resolved at call time for the same reason as everything else here: a
      // sibling entry may publish them after this plugin mounts. When one is genuinely absent the
      // coordinator refuses the feature with the reason rather than approximating it.
      ...git === undefined ? {} : { git },
      ...snapshotIo === undefined ? {} : { snapshotIo },
      ...workspaces === undefined ? {} : { workspaces },
      managedTargetLimit: configOf().managedTargetLimit,
      targetTurnConcurrency: configOf().targetTurnConcurrency,
      noticeConcurrency: configOf().noticeConcurrency,
      interruptConfirmLimitMs: configOf().interruptConfirmLimitMs,
      cancels: cancelTracker,
      dispatchAdmission: record => {
        const current = store
        if (current === undefined) return 'NO_DURABLE_STATE: dispatch state is unavailable'
        if (record.taskId && remoteTaskFrozen(current,record.taskId)) return 'REMOTE_MIGRATION_FROZEN: task dispatch is frozen until migration is finalized or safely aborted'
        if (record.attribution !== undefined && record.attribution.kind !== 'user') {
          if (!lifecycle.active) return 'PLUGIN_DISABLED: automatic dispatch is disabled'
          const refusal = automaticDispatchRefusal(current, record, Date.now())
          if (refusal !== undefined) return refusal
          const modelRefusal = workflowOperationModelRefusal(current, record, modelSelectionReaderOf(probeContext.get(MODEL_SELECTION_WRITER_SERVICE)))
          if (modelRefusal !== undefined) return modelRefusal
          if (record.taskId !== undefined && record.attribution.kind !== 'notice') {
            const permitted = budgetPermits(current, record.taskId, new Date().toISOString())
            if (!permitted.allowed) return permitted.reason
          }
        }
        return undefined
      },
      flushSession: async agent => {
        if (agent.session === undefined || typeof sessions?.flush !== 'function') {
          throw new Error('SESSION_DURABILITY_UNAVAILABLE: Host cannot confirm the accepted message was persisted')
        }
        if (!await sessions.flush(agent.session)) {
          throw new Error('SESSION_DURABILITY_UNAVAILABLE: no Host durability listener participated')
        }
      },
    })
  }

  /**
   * Read a complete persisted session through the Host's public, detached
   * session-query API. This deliberately does not open private JSONL files or
   * restore an Agent; `TaskObserver` uses it only for a history read of a cold
   * local binding.
   */
  const readPersistedSessionOf = async (sessionId: string): Promise<{
    readonly session: { readonly id: unknown }
    readonly events: readonly SessionEventLike[]
  }> => {
    const query = probeContext.get('sessionQuery') as { readSession?: unknown } | undefined
    const readSession = query?.readSession
    if (typeof readSession !== 'function') {
      throw new Error('this Host exposes no ctx.sessionQuery.readSession service')
    }
    const raw = await (readSession as (this: unknown, id: string) => Promise<unknown>).call(query, sessionId)
    if (typeof raw !== 'object' || raw === null) throw new Error('the Host returned no session-log object')
    const snapshot = raw as { session?: unknown; events?: unknown }
    if (typeof snapshot.session !== 'object' || snapshot.session === null || !Array.isArray(snapshot.events)) {
      throw new Error('the Host returned a malformed session-log object')
    }
    const id = (snapshot.session as { id?: unknown }).id
    if (String(id) !== sessionId) throw new Error('the Host returned a different session id')
    if (!snapshot.events.every(event => typeof event === 'object' && event !== null
      && typeof (event as { type?: unknown }).type === 'string'
      && typeof (event as { seq?: unknown }).seq === 'number')) {
      throw new Error('the Host returned malformed session events')
    }
    return { session: { id }, events: snapshot.events as readonly SessionEventLike[] }
  }

  /**
   * Build the observer once durable state exists. A missing live-agent registry
   * still permits an authorized detached-history read through sessionQuery.
   * @returns the observer, or `undefined` when durable state is unavailable.
   */
  const observerOf = (): TaskObserver | undefined => {
    const liveAgents = probeContext.get('agents') as AgentRegistryLike | undefined
    if (store === undefined) return undefined
    return new TaskObserver({
      agents: liveAgents as unknown as ObservableAgentsLike ?? { get: () => undefined },
      store,
      enforceReadAccess: true,
      overlayExecution: overlayTaskState,
      defaultReadLimit: configOf().defaultReadLimit,
      localHostId:configOf().bridge?.hostId??'local',
      remoteObservation:remoteObservationOf,
      readPersistedSession: readPersistedSessionOf,
    })
  }

  /**
   * Generate, record and return a handoff brief for one task.
   *
   * The brief is produced from the session's own log and cut at the last event
   * the Host has committed, so the record says exactly what it describes. The
   * content version increments per source task, so a reader can tell a fresh
   * brief from a stale one.
   *
   * @param taskId - the managed task to brief from.
   * @param operationId - stable id, recorded so a retry is not a second brief.
   * @returns the rendered brief and its record, or the reason there is none.
   */
  const briefOf = async (taskId: string, operationId?: string, callerSessionId?: string): Promise<BriefOutcome> => {
    const current = store
    if (current === undefined) {
      return { sourceSessionId: '', cutoffSeq: -1, contentVersion: 0, rendered: '', decisions: 0, openItems: 0, references: 0, error: 'the conductor has no durable state' }
    }
    throwUnlessReader(taskId, callerSessionId ?? '')
    const task = current.getTask(taskId)
    if (task === undefined) {
      return { sourceSessionId: '', cutoffSeq: -1, contentVersion: 0, rendered: '', decisions: 0, openItems: 0, references: 0, error: `no managed task ${taskId}` }
    }
    const binding = task.currentBindingId === undefined ? undefined : current.getBinding(task.currentBindingId)
    if (binding === undefined) {
      return { sourceSessionId: '', cutoffSeq: -1, contentVersion: 0, rendered: '', decisions: 0, openItems: 0, references: 0, error: `task ${taskId} has no session bound to it yet` }
    }
    const liveAgents = probeContext.get('agents') as AgentRegistryLike | undefined
    const agent = liveAgents === undefined
      ? undefined
      : (liveAgents as unknown as ObservableAgentsLike).get(binding.sessionId)
    if (agent === undefined) {
      return { sourceSessionId: binding.sessionId, cutoffSeq: -1, contentVersion: 0, rendered: '', decisions: 0, openItems: 0, references: 0, error: `the session bound to task ${taskId} (${binding.sessionId}) is not live in this Host` }
    }

    const events = agent.session.events as readonly SessionEventLike[]
    const cutoff = agent.session.seq
    const built = buildBrief(events, cutoff, binding.sessionId)
    const rendered = renderBrief(built)
    const previous = current.listContexts(taskId)
    const contentVersion = (previous[0]?.contentVersion ?? -1) + 1
    const snapshotId = `ctx-${randomUUID()}`
    await current.putContext({
      snapshotId,
      sourceTaskId: taskId,
      sourceSessionId: binding.sessionId,
      cutoffSeq: cutoff,
      contentVersion,
      contentDigest: digestBrief(rendered),
      createdAt: new Date().toISOString(),
    })
    // The operation record makes a retried brief observable without pretending
    // the brief itself is a delivery to a target.
    if (operationId !== undefined) {
      await current.beginOperation({
        operationId,
        kind: 'constraints',
        params: { taskId, cutoffSeq: cutoff },
        taskId,
      }).catch(() => undefined)
    }
    return {
      sourceSessionId: binding.sessionId,
      cutoffSeq: cutoff,
      contentVersion,
      rendered,
      decisions: built.decisions.length,
      openItems: built.openItems.length,
      references: built.references.length,
    }
  }

  /**
   * Refuse a write when the caller is not the live controller (PRD §二.10.1).
   *
   * One helper so rule save, schedule save, artifact register/verify/transfer,
   * handoff and workflow start cannot grow a second, slightly different freeze.
   *
   * @param taskId - the logical task being written.
   * @param callerSessionId - the session asking, from the Host's trusted context.
   */
  const throwUnlessController = (taskId: string, callerSessionId: string): void => {
    const current = store
    if (current === undefined) throw new Error('NO_DURABLE_STATE: the conductor has no durable state')
    if (current.getTask(taskId) === undefined) throw new Error(`TASK_NOT_FOUND: no managed task ${taskId}`)
    const refusal = writeControlRefusal(current.getAccess(taskId), taskId, callerSessionId)
    if (refusal !== undefined) throw new Error(`${refusal.code}: ${refusal.reason}`)
  }

  /**
   * Observers and the controller may read an artifact; nobody else may
   * (PRD §一.3 只读观察者, §二.9.1).
   *
   * @param taskId - the artifact's task.
   * @param callerSessionId - the session asking, from the Host's trusted context.
   */
  const throwUnlessReader = (taskId: string, callerSessionId: string): void => {
    const current = store
    if (current === undefined) throw new Error('NO_DURABLE_STATE: the conductor has no durable state')
    if (current.getTask(taskId) === undefined) throw new Error(`TASK_NOT_FOUND: no managed task ${taskId}`)
    const access = current.getAccess(taskId)
    if (access === undefined || !mayRead(access, callerSessionId)) {
      throw new Error(`NOT_READER: session ${callerSessionId} may not read task ${taskId}`)
    }
  }

  /**
   * Register an artifact claim.
   * @param request - what the caller says it produced.
   * @returns the stored record, still in its claimed state.
   */
  const registerArtifactOf = async (request: RegisterArtifactRequest): Promise<ArtifactRecord> => {
    const current = store
    if (current === undefined) throw new Error('NO_DURABLE_STATE: the conductor has no durable state')
    throwUnlessController(request.taskId, request.claimedBy ?? '')
    const existing = current.getArtifact(request.artifactId)
    if (existing !== undefined) {
      throw new Error(`ARTIFACT_EXISTS: artifact ${request.artifactId} is already recorded`)
    }
    const task = current.getTask(request.taskId)
    const binding = task?.currentBindingId === undefined ? undefined : current.getBinding(task.currentBindingId)
    const live = binding === undefined
      ? undefined
      : (probeContext.get('agents') as ObservableAgentsLike | undefined)?.get(binding.sessionId)
    const liveTurnsStarted = live === undefined
      ? undefined
      : projectEvents(initialProjection(), live.session.events as readonly SessionEventLike[]).state.turnsStarted
    const stamped = stampArtifactProvenance(request, {
      ...binding?.sessionId === undefined ? {} : { bindingSessionId: binding.sessionId },
      ...liveTurnsStarted === undefined ? {} : { liveTurnsStarted },
      constraints: current.listConstraints({}).map(constraint => ({
        constraintId: constraint.constraintId,
        version: constraint.version,
      })),
    })
    return await current.putArtifact(newArtifactRecord(stamped, new Date().toISOString()))
  }

  /**
   * Verify an artifact by its kind (PRD §二.9.1).
   *
   * Files, patches and test reports go through the Host's own filesystem
   * service rather than `node:fs`. A directory is listed at the recorded path.
   * A link or service entry is the recorded URL (reachability is not probed).
   * A commit is the recorded git object. Missing services are reported rather
   * than approximated, and another file, URL or commit of the same name is
   * never this artifact.
   *
   * @param artifactId - the artifact to check.
   * @returns the stored record after the check.
   */
  const verifyArtifactOf = async (artifactId: string, callerSessionId: string): Promise<ArtifactRecord> => {
    const current = store
    if (current === undefined) throw new Error('NO_DURABLE_STATE: the conductor has no durable state')
    const record = current.getArtifact(artifactId)
    if (record === undefined) throw new Error(`ARTIFACT_NOT_FOUND: no artifact ${artifactId}`)
    throwUnlessController(record.taskId, callerSessionId)
    const fs = probeContext.get('fs') as ArtifactFsPort | undefined
    const kinds = gitArtifactKindPort(hostGitRunner(probeContext))
    const outcome = await verifyArtifact(record, fs, kinds)
    return await current.updateArtifact(artifactId, held =>
      applyVerification(held, outcome, new Date().toISOString()))
  }

  /**
   * Read one artifact at its recorded locator (PRD §三.3 读取, §二.9.1).
   *
   * The live check uses the recorded path only. A missing or changed file is
   * reported as such; another file of the same name is never read. A present
   * directory is listed at that path; another directory of the same name is
   * never listed. The store is not updated: a read is not a verification write.
   * Observers may call this.
   *
   * @param artifactId - the artifact.
   * @param callerSessionId - the Host-trusted caller.
   * @param maxChars - preview cap, further bounded by the implementation limit.
   * @returns metadata, a UTF-8 preview when the recorded file is present and unchanged,
   *   or a listing of the recorded directory's direct children.
   */
  const readArtifactOf = async (
    artifactId: string,
    callerSessionId: string,
    maxChars: number,
  ): Promise<ArtifactReadResult> => {
    const current = store
    if (current === undefined) throw new Error('NO_DURABLE_STATE: the conductor has no durable state')
    const record = current.getArtifact(artifactId)
    if (record === undefined) throw new Error(`ARTIFACT_NOT_FOUND: no artifact ${artifactId}`)
    throwUnlessReader(record.taskId, callerSessionId)

    const fs = probeContext.get('fs') as ArtifactFsPort | undefined
    let live = record.existence
    if (record.path !== undefined) {
      if (fs === undefined) {
        const decision = decideArtifactRead(record, record.existence)
        const location = decision.locator.kind === 'none' ? undefined : decision.locator.value
        return {
          artifactId: record.artifactId,
          taskId: record.taskId,
          kind: record.kind,
          name: record.name,
          existence: record.existence,
          storedExistence: record.existence,
          acceptance: record.acceptance,
          contentVersion: record.contentVersion,
          locatorKind: decision.locator.kind,
          ...location === undefined ? {} : { location },
          previewIncluded: false,
          truncated: false,
          binary: false,
          reason: 'no filesystem service is mounted, so the recorded path was not re-checked; '
            + (record.kind === 'directory'
              ? 'another directory of the same name is not listed'
              : 'a file of the same name is not read in its place'),
        }
      }
      const outcome = await verifyArtifact(record, fs, gitArtifactKindPort(hostGitRunner(probeContext)))
      live = outcome.existence
    }

    const decision = decideArtifactRead(record, live)
    const location = decision.locator.kind === 'none' ? undefined : decision.locator.value
    const base = {
      artifactId: record.artifactId,
      taskId: record.taskId,
      kind: record.kind,
      name: record.name,
      existence: live,
      storedExistence: record.existence,
      acceptance: record.acceptance,
      contentVersion: record.contentVersion,
      locatorKind: decision.locator.kind,
      ...location === undefined ? {} : { location },
    }

    if (decision.includeListing) {
      const listDir = fs?.listDir
      if (fs === undefined || record.path === undefined || listDir === undefined) {
        return {
          ...base,
          previewIncluded: false,
          truncated: false,
          binary: false,
          reason: `${decision.reason}; this composition cannot list a directory, so `
            + 'another directory of the same name is not listed',
        }
      }
      try {
        const target = await fs.resolve(record.path)
        const listing = boundListing(await listDir.call(fs, target))
        return {
          ...base,
          previewIncluded: false,
          listingIncluded: true,
          entries: listing.entries,
          truncated: listing.truncated,
          binary: false,
          reason: decision.reason,
        }
      } catch (error) {
        return {
          ...base,
          previewIncluded: false,
          truncated: false,
          binary: false,
          reason: `${decision.reason}; the recorded path could not be listed: `
            + `${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }

    if (!decision.includePreview || fs === undefined || record.path === undefined) {
      return {
        ...base,
        previewIncluded: false,
        truncated: false,
        binary: false,
        reason: decision.reason,
      }
    }

    const cap = Math.max(1, Math.min(maxChars, ARTIFACT_PREVIEW_CHAR_LIMIT))
    try {
      const target = await fs.resolve(record.path)
      const bytes = await fs.readBytes(target, undefined, ARTIFACT_PREVIEW_BYTE_LIMIT)
      const preview = utf8PreviewOf(bytes, cap)
      if (preview.binary || preview.text === undefined) {
        return {
          ...base,
          previewIncluded: false,
          truncated: false,
          binary: true,
          reason: `${decision.reason}; the recorded path is not UTF-8 text, so no preview is returned`,
        }
      }
      return {
        ...base,
        previewIncluded: true,
        content: preview.text,
        truncated: preview.truncated,
        binary: false,
        reason: decision.reason,
      }
    } catch (error) {
      return {
        ...base,
        previewIncluded: false,
        truncated: false,
        binary: false,
        reason: `${decision.reason}; the recorded path could not be read: `
          + `${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  /**
   * Open one artifact at its recorded path (PRD §三.3 打开, §二.9.1).
   *
   * The recorded path is re-verified and the outcome is stored, so a later
   * reader sees the same missing/changed fact. Native open is refused when
   * that check fails, when the artifact is not a path, or when this
   * composition has no Host opener — never by opening another file of the
   * same name. Requires write control.
   *
   * @param artifactId - the artifact.
   * @param callerSessionId - the Host-trusted caller.
   * @returns whether the recorded path was handed to the OS opener.
   */
  const openArtifactOf = async (
    artifactId: string,
    callerSessionId: string,
  ): Promise<ArtifactOpenResult> => {
    const current = store
    if (current === undefined) throw new Error('NO_DURABLE_STATE: the conductor has no durable state')
    const record = current.getArtifact(artifactId)
    if (record === undefined) throw new Error(`ARTIFACT_NOT_FOUND: no artifact ${artifactId}`)
    throwUnlessController(record.taskId, callerSessionId)

    const fs = probeContext.get('fs') as ArtifactFsPort | undefined
    let held = record
    if (record.path !== undefined) {
      if (fs === undefined) {
        const decision = decideArtifactOpen(record, record.existence)
        const location = decision.locator.kind === 'none' ? undefined : decision.locator.value
        return {
          artifactId: record.artifactId,
          existence: record.existence,
          opened: false,
          locatorKind: decision.locator.kind,
          ...location === undefined ? {} : { location },
          reason: 'no filesystem service is mounted, so the recorded path was not re-checked; '
            + 'another file of the same name is not opened in its place',
        }
      }
      const outcome = await verifyArtifact(record, fs, gitArtifactKindPort(hostGitRunner(probeContext)))
      held = await current.updateArtifact(artifactId, currentHeld =>
        applyVerification(currentHeld, outcome, new Date().toISOString()))
    }

    const decision = decideArtifactOpen(held, held.existence)
    const location = decision.locator.kind === 'none' ? undefined : decision.locator.value
    if (!decision.nativeOpen) {
      return {
        artifactId: held.artifactId,
        existence: held.existence,
        opened: false,
        locatorKind: decision.locator.kind,
        ...location === undefined ? {} : { location },
        reason: decision.reason,
      }
    }

    const path = decision.locator.kind === 'path' ? decision.locator.value : undefined
    if (path === undefined) {
      return {
        artifactId: held.artifactId,
        existence: held.existence,
        opened: false,
        locatorKind: decision.locator.kind,
        reason: decision.reason,
      }
    }
    const opener = hostPathOpener(probeContext)
    if (opener === undefined) {
      return {
        artifactId: held.artifactId,
        existence: held.existence,
        opened: false,
        locatorKind: decision.locator.kind,
        location: path,
        reason: `${decision.reason}; this composition has no native path opener, so the verified `
          + 'recorded path is returned rather than handing another file to the OS',
      }
    }
    try {
      await opener.openPath(path)
      return {
        artifactId: held.artifactId,
        existence: held.existence,
        opened: true,
        locatorKind: decision.locator.kind,
        location: path,
        reason: decision.reason,
      }
    } catch (error) {
      return {
        artifactId: held.artifactId,
        existence: held.existence,
        opened: false,
        locatorKind: decision.locator.kind,
        location: path,
        reason: `${decision.reason}; the opener failed: `
          + `${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  /**
   * Hand an artifact to another task.
   *
   * The filesystem port is assembled here so the three modes reach the Host's
   * own filesystem service rather than `node:fs`, and a composition without one
   * reports that instead of writing anyway.
   *
   * @param request - what to hand over, and how.
   * @returns the stored record and, for a reference, its rendered text.
   */
  const executeTransferArtifact = async (
    request: TransferToolRequest,
  ): Promise<{ record: TransferRecord; reference?: string }> => {
    const current = store
    if (current === undefined) throw new Error('NO_DURABLE_STATE: the conductor has no durable state')
    const artifact = current.getArtifact(request.artifactId)
    if (artifact === undefined) throw new Error(`ARTIFACT_NOT_FOUND: no artifact ${request.artifactId}`)
    throwUnlessController(artifact.taskId, request.callerSessionId)
    const destinationTask = current.getTask(request.toTaskId)
    if (destinationTask === undefined) throw new Error(`TASK_NOT_FOUND: no managed task ${request.toTaskId}`)
    throwUnlessController(request.toTaskId, request.callerSessionId)
    const sourceEpoch = current.getAccess(artifact.taskId)?.ownerEpoch
    const destinationEpoch = current.getAccess(request.toTaskId)?.ownerEpoch
    const destinationBinding = destinationTask.currentBindingId === undefined
      ? undefined : current.getBinding(destinationTask.currentBindingId)
    const assertTransferAuthority = (): void => {
      throwUnlessController(artifact.taskId, request.callerSessionId)
      throwUnlessController(request.toTaskId, request.callerSessionId)
      if (current.getAccess(artifact.taskId)?.ownerEpoch !== sourceEpoch
        || current.getAccess(request.toTaskId)?.ownerEpoch !== destinationEpoch) {
        throw new Error('STALE_OWNER_EPOCH: transfer control changed during preparation')
      }
      const latestTask = current.getTask(request.toTaskId)
      const latestBinding = latestTask?.currentBindingId === undefined
        ? undefined : current.getBinding(latestTask.currentBindingId)
      if (latestTask?.currentBindingId !== destinationTask.currentBindingId
        || latestBinding?.version !== destinationBinding?.version) {
        throw new Error('STALE_BINDING: the receiving task moved during transfer preparation')
      }
    }

    const now = new Date().toISOString()
    if (request.mode === 'reference') {
      const outcome = buildReference({
        transferId: request.transferId, artifact, toTaskId: request.toTaskId, now,
      })
      await current.putTransfer({ ...outcome.record, referenceText: outcome.reference })
      return outcome.reference === undefined
        ? { record: outcome.record }
        : { record: outcome.record, reference: outcome.reference }
    }

    const fs = probeContext.get('fs') as (TransferFsPort & {
      contains?(parent: unknown, child: unknown): boolean
    }) | undefined
    const transferFs = transferFsOf(probeContext)
    if (fs === undefined || transferFs === undefined) {
      throw new Error(
        'NO_FILESYSTEM: this Host composition mounts no filesystem service, so the conductor cannot copy '
        + 'or patch files',
      )
    }
    if (destinationBinding?.cwd === undefined || typeof fs.contains !== 'function') {
      throw new Error('DESTINATION_UNVERIFIED: transfer needs a bound receiving directory and Host canonical contains API')
    }
    if (request.destination === undefined) throw new Error('BAD_REQUEST: this transfer mode needs a destination')
    const destinationRoot = await fs.resolve(destinationBinding.cwd)
    const assertDestination = async (target: unknown): Promise<void> => {
      // Host resolve canonicalizes existing ancestors, including symlinks/junctions.
      const freshRoot = await fs.resolve(destinationBinding.cwd!)
      const freshTarget = await fs.resolve(request.destination!)
      if (!fs.contains!(destinationRoot, freshRoot) || !fs.contains!(freshRoot, destinationRoot)
        || !fs.contains!(freshRoot, target) || !fs.contains!(freshRoot, freshTarget)
        || !fs.contains!(target, freshTarget) || !fs.contains!(freshTarget, target)) {
        throw new Error('DESTINATION_OUTSIDE_TASK: the canonical destination is outside the receiving task directory')
      }
    }
    await assertDestination(await fs.resolve(request.destination))
    assertTransferAuthority()
    const port: TransferFsPort = {
      ...transferFs,
      resolve: async path => await fs.resolve(path),
      stat: async (target, signal) => await fs.stat(target, signal),
      readText: async (target, signal) => await fs.readText(target, signal),
      writeText: async (target, content, expected, signal) => {
        await assertDestination(target)
        assertTransferAuthority()
        return await fs.writeText(target, content, expected, signal)
      },
      ...transferFs.writeBytes === undefined ? {} : {
        writeBytes: async (target, content, expected, signal) => {
          await assertDestination(target)
          assertTransferAuthority()
          return await transferFs.writeBytes!(target, content, expected, signal)
        },
      },
    }

    if (request.mode === 'snapshot_copy') {
      if (request.destination === undefined) {
        throw new Error('BAD_REQUEST: the snapshot_copy mode needs a destination path')
      }
      const outcome = await snapshotCopy({
        transferId: request.transferId,
        artifact,
        toTaskId: request.toTaskId,
        destination: request.destination,
        now,
      }, port)
      await current.putTransfer(outcome.record)
      return { record: outcome.record }
    }

    if (request.destination === undefined) {
      throw new Error('BAD_REQUEST: the patch mode needs the path of the file to patch')
    }
    if (request.diff === undefined) {
      throw new Error('BAD_REQUEST: the patch mode needs the unified diff')
    }
    const outcome = await patchHandoff({
      transferId: request.transferId,
      artifact,
      toTaskId: request.toTaskId,
      target: request.destination,
      diff: request.diff,
      apply: request.apply ?? false,
      now,
      ...request.expectedBaselineHash === undefined ? {} : { expectedBaselineHash: request.expectedBaselineHash },
    }, port)
    await current.putTransfer(outcome.record)
    return { record: outcome.record }
  }

  const transferArtifactOf = async (request: TransferToolRequest): Promise<{ record: TransferRecord; reference?: string }> => {
    const current = store
    if (current === undefined) throw new Error('NO_DURABLE_STATE: no transfer state')
    return await current.withExclusive(`transfer:${request.transferId}`, async () => {
      const artifact = current.getArtifact(request.artifactId)
      if (artifact === undefined) throw new Error(`ARTIFACT_NOT_FOUND: ${request.artifactId}`)
      throwUnlessController(artifact.taskId, request.callerSessionId)
      throwUnlessController(request.toTaskId, request.callerSessionId)
      const previous = current.getTransfer(request.transferId)
      const operation = current.getOperation(request.transferId)
      if (previous !== undefined && operation === undefined) {
        throw new Error('LEGACY_TRANSFER: this transfer has no verifiable request identity; it was not repeated')
      }
      const claim = await current.beginOperation({ operationId: request.transferId, kind: 'transfer', taskId: artifact.taskId, params: request })
      if (claim.kind === 'conflict') throw new Error(`OPERATION_CONFLICT: ${claim.reason}`)
      if (claim.kind === 'replay') {
        if (previous !== undefined) {
          return { record: previous, ...previous.referenceText === undefined ? {} : { reference: previous.referenceText } }
        }
        throw new Error('TRANSFER_UNKNOWN: an earlier transfer has no confirmed result; inspect its destination before starting another')
      }
      await current.markDelivery(request.transferId, 'dispatching', 'transferring')
      try {
        const result = await executeTransferArtifact(request)
        await current.markDelivery(request.transferId, 'accepted', 'transfer result recorded')
        return result
      } catch (error) {
        await current.markDelivery(request.transferId, 'unknown', describeError(error))
        throw error
      }
    })
  }

  /**
   * Move a task to a successor session in another directory.
   *
   * Every Host surface is resolved at call time, and each is optional: a
   * composition without a session store or a filesystem still performs the move
   * and reports the corresponding precondition as *not checked* rather than
   * claiming it passed.
   *
   * @param request - what to move, and where to.
   * @returns the handoff outcome.
   */
  const handoffOf = async (request: HandoffRequest): Promise<HandoffOutcome> => {
    const current = store
    if (current === undefined) {
      return {
        taskId: request.taskId,
        reached: 'stopping',
        succeeded: false,
        reason: 'the conductor has no durable state',
        preconditions: { checked: [], unchecked: ['everything: the conductor store is not open'] },
      }
    }
    const liveAgents = probeContext.get('agents') as HandoffAgents | undefined
    if (liveAgents === undefined) {
      return {
        taskId: request.taskId,
        reached: 'stopping',
        succeeded: false,
        reason: 'this Host composition mounts no agent registry',
        preconditions: { checked: [], unchecked: ['everything: no agent registry is mounted'] },
      }
    }
    const sessions = probeContext.get('sessions') as HandoffSessions | undefined
    const fs = probeContext.get('fs') as HandoffFs | undefined
    const git = hostGitRunner(probeContext)
    const presets = presetPortOf(probeContext)
    if (!sessions || !fs) return {taskId:request.taskId,reached:'stopping',succeeded:false,reason:'HOST_CAPABILITY_REQUIRED: migration needs session persistence and filesystem validation',preconditions:{checked:[],unchecked:['source flush or target directory']}}
    return await enqueueHandoff(current,request,async identities => await handoffTask({
      agents: liveAgents,
      store: current,
      ...sessions === undefined ? {} : { sessions },
      ...fs === undefined ? {} : { fs },
      ...git === undefined ? {} : { git },
      ...presets === undefined
        ? {}
        : { presets: { presetOf: presets.presetOf, mount: presets.mount } },
      createMessage: (text: string, source: unknown) =>
        createUserMessage({ content: [{ type: 'text', text }], source: source as never }),
      newSessionId: () => identities.successorSessionId,
      newBindingId: () => identities.successorBindingId,
      now: () => new Date().toISOString(),
      interruptConfirmLimitMs: configOf().interruptConfirmLimitMs,
      dispatchInstruction: async instruction => {
        const coordinator = coordinatorOf()
        if (coordinator === undefined) throw new Error('NO_DURABLE_STATE: no coordinator for the handoff instruction')
        const now = new Date().toISOString()
        const permitted = budgetPermits(current, instruction.taskId, now)
        if (!permitted.allowed) throw new Error(`BUDGET_EXCEEDED: ${permitted.reason}`)
        const outcome = await coordinator.send({
          ...instruction, mode: 'steer',
          attribution: { kind: 'relay', sourceEventId: instruction.operationId },
        })
        if (outcome.delivery === 'accepted' || outcome.delivery === 'replayed') {
          await countDispatch(current, instruction.taskId, now, undefined, instruction.operationId)
        }
        return outcome
      },
    }, {...request,expectedOwnerEpoch:request.expectedOwnerEpoch??identities.ownerEpoch,expectedBindingVersion:request.expectedBindingVersion??identities.bindingVersion}))
  }

  /**
   * Save, list, enable, disable or evaluate one-time rules.
   *
   * The `evaluate` action runs the same executor an automatic watcher will use:
   * it reads the source task's projection, turns the notable events into
   * triggers, and performs whatever the saved rules authorise. The model asks
   * for an evaluation; it never chooses the action, which is why the executor
   * reads `instruction` and `action` from the rule rather than from the request.
   * `enable` resumes a disabled rule under the same grant; it does not mint a
   * new authorisation or reset firings.
   *
   * @param request - the rule request.
   * @returns the rules in scope and whatever the pass produced.
   */
  const ruleOf = async (request: RuleToolRequest): Promise<RuleToolResult> => {
    const current = store
    if (current === undefined) throw new Error('NO_DURABLE_STATE: the conductor has no durable state')
    const now = new Date().toISOString()

    if (request.action === 'list') {
      const rules = current.listRules({})
      return {
        rules,
        dispatches: [],
        refusals: [],
        summary: rules.length === 0
          ? 'No rules are saved.'
          : `${String(rules.length)} rule(s):\n` + rules.map(entry =>
              `- ${entry.ruleId} "${entry.title}" [${entry.trigger}] → ${entry.targetTaskId}, `
              + `${String(entry.firings.length)}/${String(entry.maxExecutions)} fired, `
              + `${entry.active ? 'active' : 'disabled'}`).join('\n'),
      }
    }

    if (request.action === 'disable') {
      if (request.ruleId === undefined) throw new Error('BAD_REQUEST: disabling a rule needs its ruleId')
      const existing = current.getRule(request.ruleId)
      if (existing === undefined) throw new Error(`NOT_FOUND: no rule ${request.ruleId} is saved`)
      throwUnlessController(existing.sourceTaskId, request.authorizedBy)
      throwUnlessController(existing.targetTaskId, request.authorizedBy)
      const disabled = await current.updateRule(request.ruleId, entry => ({ ...entry, active: false, version: entry.version + 1 }))
      return {
        rules: [disabled],
        dispatches: [],
        refusals: [],
        summary: `Rule ${disabled.ruleId} is disabled; it will not fire again.`,
      }
    }

    if (request.action === 'enable') {
      if (request.ruleId === undefined) throw new Error('BAD_REQUEST: enabling a rule needs its ruleId')
      const existing = current.getRule(request.ruleId)
      if (existing === undefined) throw new Error(`NOT_FOUND: no rule ${request.ruleId} is saved`)
      throwUnlessController(existing.sourceTaskId, request.authorizedBy)
      throwUnlessController(existing.targetTaskId, request.authorizedBy)
      const decision = planEnable(
        existing,
        current.listRules({ active: true }).map(entry => ({
          ruleId: entry.ruleId,
          sourceTaskId: entry.sourceTaskId,
          targetTaskId: entry.targetTaskId,
        })),
      )
      if (!decision.enable) throw new Error(`CONTROL_CYCLE: ${decision.reason}`)
      if (decision.already) {
        return {
          rules: [existing],
          dispatches: [],
          refusals: [],
          summary: `Rule ${existing.ruleId} is already enabled.`,
        }
      }
      const enabled = await current.updateRule(request.ruleId, entry => ({
        ...entry,
        active: true,
        version: entry.version + 1,
        updatedAt: now,
      }))
      return {
        rules: [enabled],
        dispatches: [],
        refusals: [],
        summary: `Rule ${enabled.ruleId} is enabled under grant ${String(enabled.grantId ?? '(none recorded)')}; `
          + `${String(enabled.firings.length)}/${String(enabled.maxExecutions)} firing(s) are unchanged.`,
      }
    }

    if (request.action === 'save') {
      if (request.sourceTaskId === undefined || request.targetTaskId === undefined) {
        throw new Error('BAD_REQUEST: saving a rule needs sourceTaskId and targetTaskId')
      }
      if (request.instruction === undefined || request.mode === undefined || request.trigger === undefined) {
        throw new Error('BAD_REQUEST: saving a rule needs trigger, mode and instruction — a rule that does not state its action is not an authorisation')
      }
      if (request.expiresAt !== undefined && !Number.isFinite(Date.parse(request.expiresAt))) {
        throw new Error('BAD_REQUEST: expiresAt must be a readable expiry instant')
      }
      throwUnlessController(request.sourceTaskId, request.authorizedBy)
      throwUnlessController(request.targetTaskId, request.authorizedBy)
      const ruleId = request.ruleId ?? `rule-${randomUUID()}`
      const existing = current.getRule(ruleId)
      if (existing !== undefined) throw new Error(`RULE_EXISTS: rule ${ruleId} is already saved`)
      // PRD §三.6 / AGENTS.md §6: the control relation must be acyclic. Checked here because this is the
      // only moment the whole picture exists — an automatic firing that starts a loop is an authorisation
      // problem, and the fire path cannot see the rules that would close the circle behind it.
      const cycle = controlCycleRefusal(
        current.listRules({ active: true }).map(entry => ({
          ruleId: entry.ruleId,
          sourceTaskId: entry.sourceTaskId,
          targetTaskId: entry.targetTaskId,
        })),
        { ruleId, sourceTaskId: request.sourceTaskId, targetTaskId: request.targetTaskId },
      )
      if (cycle !== undefined) throw new Error(`CONTROL_CYCLE: ${cycle}`)
      const saved = await current.putRule({
        ruleId,
        version: 0,
        title: request.title ?? request.instruction.slice(0, 60),
        trigger: request.trigger,
        sourceTaskId: request.sourceTaskId,
        targetTaskId: request.targetTaskId,
        action: request.mode,
        instruction: request.instruction,
        maxExecutions: request.maxExecutions ?? 1,
        authorizedBy: request.authorizedBy,
        // A save **is** the authorisation, so it mints one identity (PRD §四.2's `grantId`). Minting
        // per save rather than per rule is what makes a re-save a new authorisation instead of the
        // same one quietly extended — and an existing rule cannot be re-saved at all, so the grant
        // and the rule version cannot drift apart.
        grantId: `grant-${randomUUID()}`,
        active: true,
        firings: [],
        createdAt: now,
        updatedAt: now,
        ...request.requiredArtifactId === undefined ? {} : { requiredArtifactId: request.requiredArtifactId },
        ...request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt },
      })
      return {
        rules: [saved],
        dispatches: [],
        refusals: [],
        summary: `Saved rule ${saved.ruleId} under grant ${String(saved.grantId)}: on ${saved.trigger} of `
          + `${saved.sourceTaskId}, ${saved.action} to ${saved.targetTaskId} at most `
          + `${String(saved.maxExecutions)} time(s). `
          + 'It is executed by the conductor\'s own rule executor, not by any target\'s output.',
      }
    }

    // evaluate
    const scoped = request.ruleId === undefined
      ? current.listRules({ active: true })
      : [current.getRule(request.ruleId)].filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
    const bySource = new Map<string, RuleRecord[]>()
    for (const rule of scoped) {
      if (!rule.active) continue
      const list = bySource.get(rule.sourceTaskId) ?? []
      list.push(rule)
      bySource.set(rule.sourceTaskId, list)
    }

    const dispatches: RuleToolResult['dispatches'] = []
    const refusals: string[] = []
    for (const [sourceTaskId, rules] of bySource) {
      const outcome = await dispatchRulesFor(current, sourceTaskId, rules, now, [])
      dispatches.push(...outcome.dispatches)
      refusals.push(...outcome.refusals)
    }

    return {
      rules: scoped,
      dispatches,
      refusals,
      summary: dispatches.length === 0 && refusals.length === 0
        ? `Evaluated ${String(scoped.length)} rule(s): nothing to dispatch.`
        : `Evaluated ${String(scoped.length)} rule(s): ${String(dispatches.length)} dispatch(es), `
          + `${String(refusals.length)} refusal(s).`
          + (refusals.length === 0 ? '' : `\n${refusals.map(item => `- ${item}`).join('\n')}`),
    }
  }

  /**
   * Record an artifact's acceptance (PRD §二.9.1, §二.12).
   *
   * §二.9.1 keeps "检查通过" and "用户验收" as separate facts from the model's claim, and §二.12
   * forbids a subjective review from standing in for acceptance. Until this existed, nothing in the
   * product could record either: `applyAcceptance` was written and tested but **called by nobody**,
   * so `acceptance` stayed `pending` forever — which in turn made the `artifact_accepted` trigger
   * unreachable and refused every rule that named a required artifact, permanently.
   *
   * The verdict vocabulary and the "a deterministic check must record its command and result" rule
   * are the workflow module's, reused rather than re-implemented: it is the same sentence of the
   * specification, so it must not be enforced differently here.
   *
   * @param request - the artifact, the verdict, and who is asking.
   * @returns the updated artifact and what the acceptance triggered.
   */
  const acceptArtifactOf = async (request: ArtifactAcceptanceRequest): Promise<ArtifactAcceptanceResult> => {
    const current = store
    if (current === undefined) throw new Error('NO_DURABLE_STATE: the conductor has no durable state')
    const artifact = current.getArtifact(request.artifactId)
    if (artifact === undefined) throw new Error(`ARTIFACT_NOT_FOUND: no artifact ${request.artifactId}`)
    // Accepting is a decision about someone else's work, so it needs the same control the rest of the
    // mutating surface needs (PRD §一.3): a session that merely observes the task may not accept its
    // artifacts.
    const coordinator = coordinatorOf()
    if (coordinator === undefined) throw new Error('NO_DURABLE_STATE: the conductor cannot be built')
    coordinator.requireController(artifact.taskId, request.callerSessionId)

    const now = new Date().toISOString()
    // §四.1's idempotency record, claimed **before** anything is written. A retried acceptance is the same
    // decision, and re-applying it would append a second evidence line, move `acceptedAt` and count a second
    // time in the run ledger — a figure a budget decides on, inflated by a retry.
    const claim = await current.beginOperation({
      operationId: request.operationId,
      kind: 'artifact_accept',
      params: {
        artifactId: request.artifactId,
        result: request.result,
        by: request.by,
        command: request.command ?? null,
        output: request.output ?? null,
        evidence: request.evidence === undefined ? null : [...request.evidence],
        note: request.note ?? null,
      },
      taskId: artifact.taskId,
    })
    if (claim.kind === 'conflict') {
      throw new Error(`OPERATION_CONFLICT: ${claim.reason}`)
    }
    if (claim.kind === 'replay') {
      // The decision is already recorded. Nothing is re-counted, no rule is re-evaluated, and the artifact is
      // reported as it stands rather than re-accepted at a later instant.
      const held = current.getArtifact(request.artifactId) ?? artifact
      return {
        artifact: held,
        counts: acceptanceCounts(held),
        replayed: true,
        triggered: [],
        summary: `Acceptance of ${request.artifactId} was already recorded under operation ${request.operationId} `
          + `(${held.acceptance} by ${held.acceptedBy ?? 'nobody named'}${held.acceptedAt === undefined ? '' : ` at ${held.acceptedAt}`}). `
          + 'A retry is a replay, so nothing was recorded again and the run ledger was not counted a second time.',
      }
    }
    const malformed = verdictRefusal({
      result: request.result,
      by: request.by,
      at: now,
      ...request.command === undefined ? {} : { command: request.command },
      ...request.output === undefined ? {} : { output: request.output },
    })
    if (malformed !== undefined) throw new Error(`BAD_REQUEST: ${malformed}`)

    const proved = request.command === undefined
      ? []
      : [`${request.by} ran: ${request.command}`, `it returned: ${request.output ?? ''}`]
    const evidence = [
      `acceptance recorded by ${request.callerSessionId} at ${now}: ${request.result} by ${request.by}`,
      ...proved,
      ...request.evidence ?? [],
      ...request.note === undefined ? [] : [`note: ${request.note}`],
    ].join(' | ')
    const updated = await current.putArtifact(applyAcceptance(
      artifact,
      request.result,
      evidence,
      now,
      { by: request.by, at: now },
    ))

    // PRD §二.13.2: 所有由插件发起的节点、验收、回报和返工计入关联运行账本 — an acceptance is one of the four, and it
    // was the only one not counted. Counted into **every** ledger that governs the artifact's task, exactly as
    // a dispatch is, because a group-scope limit is about the work its tasks do rather than only its own.
    await countAcceptance(current, artifact.taskId, now)

    // A rule listening for an acceptance is a rule about this fact, so the fact is what the executor
    // is given. The event id carries the artifact and the acceptance instant: accepting the same
    // artifact again after a change is a new fact and may fire again, while a replayed acceptance
    // keeps its identity and is deduplicated by the firing record.
    let triggered: ArtifactAcceptanceResult['triggered'] = []
    const artifactRules = current.listRules({ active: true }).filter(rule => rule.sourceTaskId === artifact.taskId)
    if (artifactRules.length > 0) {
      const outcome = await dispatchRulesFor(current, artifact.taskId, artifactRules, now, [{
        event: { kind: 'artifact_accepted', artifactId: artifact.artifactId, by: request.by },
        eventId: `${String(artifact.contentVersion)}-${now}`,
      }])
      triggered = outcome.dispatches
      for (const refusal of outcome.refusals) {
        // Refusals are reported, not swallowed: a rule that could not fire is the fact the caller
        // most needs, and it is the difference between "nothing was configured" and "something
        // refused".
        if (!/already fired|has already fired|is not active|listens for/.test(refusal)) triggered.push({
          ruleId: refusal.split(':')[0] ?? refusal,
          operationId: '',
          targetTaskId: '',
          instruction: '',
          reason: refusal,
        })
      }
    }

    return {
      artifact: updated,
      counts: acceptanceCounts(updated),
      replayed: false,
      triggered,
      summary: `Artifact ${updated.artifactId} is now "${updated.acceptance}" by ${request.by}`
        + `${request.command === undefined ? '' : ` (${request.command})`}`
        + `${acceptanceCounts(updated).counts
          ? ', which counts as acceptance: it may gate an automatic dependency.'
          : `, which does NOT count as acceptance — ${acceptanceCounts(updated).reason}.`}`
        + (triggered.length === 0
          ? ' No rule reacted to it.'
          : ` ${String(triggered.length)} rule reaction(s): `
            + triggered.map(entry => `${entry.ruleId}${entry.operationId === '' ? '' : ` → ${entry.operationId}`}`).join(', ')),
    }
  }

  /**
   * Read a persisted ledger as the pure shape, defaulting to an empty one.
   * @param current - the open store.
   * @param targetId - the thing the ledger counts for.
   * @returns the ledger.
   */
  function ledgerOfRecord(current: ConductorStore, targetId: string): RunLedger {
    const record = current.getLedger(targetId)
    if (record === undefined) return emptyLedger()
    return {
      dispatches: record.dispatches,
      attempts: record.attempts,
      reworkRounds: record.reworkRounds,
      turns: record.turns,
      reportTurns: record.reportTurns,
      // Absent on a ledger written before the field existed, and read as zero: a counter that was never
      // written counted nothing, which is different from "unknown".
      acceptances: record.acceptances ?? 0,
      ...record.firstDispatchedAt === undefined ? {} : { firstDispatchedAt: record.firstDispatchedAt },
      ...record.tokens === undefined ? {} : { tokens: record.tokens },
      ...record.cost === undefined ? {} : { cost: record.cost },
    }
  }

  /**
   * Every budget policy that governs one target (PRD §二.13.2's three scopes).
   *
   * A task-scope policy names the task, a group-scope policy names the group the task is in, and a
   * workflow-scope policy names the workflow a run belongs to. All of them apply at once: a limit
   * set on a group is not excused by the task having no limit of its own.
   *
   * @param current - the open store.
   * @param taskId - the task about to be dispatched to.
   * @param workflowId - the workflow, when the dispatch belongs to one.
   * @returns the governing policies.
   */
  function budgetsGoverning(
    current: ConductorStore,
    taskId: string,
    workflowId?: string,
  ): { policy: BudgetPolicy; ledgerTargetId: string; label: string }[] {
    const groupId = current.getTask(taskId)?.groupId
    const governing: { policy: BudgetPolicy; ledgerTargetId: string; label: string }[] = []
    for (const record of current.listBudgets()) {
      const policy = policyFromRecord(record)
      const applies = (record.scope === 'task' && record.targetId === taskId)
        || (record.scope === 'group' && groupId !== undefined && record.targetId === groupId)
        || (record.scope === 'workflow' && workflowId !== undefined && record.targetId === workflowId)
      if (applies) {
        governing.push({
          policy,
          ledgerTargetId: record.targetId,
          label: `${record.scope} budget ${record.targetId}`,
        })
      }
    }
    return governing
  }

  /**
   * How many executions are in flight for one budget scope right now.
   *
   * Concurrency is a state rather than a total, so it is **observed** at the moment of the check
   * instead of being accumulated into the ledger. For a task scope that is whether the task's own
   * session is running; for a group scope it is how many of the group's tasks are running. The
   * observation is reported as `undefined` when the registry cannot answer, so the limit is refused
   * with that reason rather than silently treated as satisfied.
   *
   * @param current - the open store.
   * @param scope - the policy's scope.
   * @param targetId - the thing the policy names.
   * @returns the count, or undefined when it cannot be observed.
   */
  function inFlightFor(current: ConductorStore, scope: BudgetScope, targetId: string): number | undefined {
    const agents = probeContext.get('agents') as ObservableAgentsLike | undefined
    if (agents === undefined || typeof agents.get !== 'function') return undefined
    const running = (taskId: string): boolean => {
      const bindingId = current.getTask(taskId)?.currentBindingId
      if (bindingId === undefined) return false
      const sessionId = current.getBinding(bindingId)?.sessionId
      if (sessionId === undefined) return false
      return agents.get(sessionId)?.status === 'running'
    }
    if (scope === 'task') return running(targetId) ? 1 : 0
    if (scope === 'group') {
      return current.listTasks().filter(task => task.groupId === targetId).filter(task => running(task.taskId)).length
    }
    return undefined
  }

  /**
   * Whether the budgets that govern one target permit another **automatic** dispatch.
   *
   * PRD §二.13.2: on reaching a limit the conductor must "停止新的自动调度", request cancellation
   * according to the authorised policy, keep the results and the ledger, and report the actual stop
   * state. This is the gate that makes the first of those three actions real;
   * {@link enforceReachedBudgetCancels} is the second. It is deliberately *not* inside the ordinary
   * send path, because a person's explicit instruction is not "automatic scheduling" and refusing it
   * would be a different rule than the specification states.
   *
   * @param current - the open store.
   * @param taskId - the task about to be dispatched to.
   * @param now - the current time as ISO 8601 UTC.
   * @param workflowId - the workflow, when the dispatch belongs to one.
   * @returns whether it is permitted, or why not.
   */
  function budgetPermits(
    current: ConductorStore,
    taskId: string,
    now: string,
    workflowId?: string,
  ): { allowed: true } | { allowed: false; reason: string } {
    for (const governing of budgetsGoverning(current, taskId, workflowId)) {
      const ledger = ledgerOfRecord(current, governing.ledgerTargetId)
      // The concurrency limit is the one limit that is not in the ledger, because it is a state
      // rather than a total: observe it now and hand it to the pure decision.
      const concurrent = governing.policy.maxConcurrent === undefined
        ? undefined
        : inFlightFor(current, governing.policy.scope, governing.ledgerTargetId)
      const decision = budgetDecision(
        governing.policy,
        concurrent === undefined ? ledger : { ...ledger, concurrent },
        now,
      )
      if (!decision.within) {
        return {
          allowed: false,
          reason: `${governing.label}: ${decision.reason}. PRD §二.13.2's response is `
            + `${decision.actions.join(', ')}; the automatic dispatch was not made, and the ledger and results are kept.`,
        }
      }
    }
    return { allowed: true }
  }

  /**
   * Read a persisted budget as the pure policy shape.
   *
   * One mapping, because budgetsGoverning, the gate, the cancel pass and the tool
   * all have to agree about which limits a record actually sets.
   *
   * @param record - the stored policy.
   * @returns the pure policy.
   */
  function policyFromRecord(record: BudgetStoreRecord): BudgetPolicy {
    return {
      scope: record.scope,
      strict: record.strict,
      ...record.deadlineAt === undefined ? {} : { deadlineAt: record.deadlineAt },
      ...record.maxConcurrent === undefined ? {} : { maxConcurrent: record.maxConcurrent },
      ...record.maxDispatches === undefined ? {} : { maxDispatches: record.maxDispatches },
      ...record.maxAttempts === undefined ? {} : { maxAttempts: record.maxAttempts },
      ...record.maxReworkRounds === undefined ? {} : { maxReworkRounds: record.maxReworkRounds },
      ...record.maxTokens === undefined ? {} : { maxTokens: record.maxTokens },
      ...record.maxCost === undefined ? {} : { maxCost: record.maxCost },
    }
  }

  /**
   * The tasks one stored budget governs.
   *
   * @param current - the open store.
   * @param record - the policy.
   * @returns task ids, possibly empty when the named target is gone.
   */
  function tasksGovernedBy(current: ConductorStore, record: BudgetStoreRecord): string[] {
    if (record.scope === 'task') {
      return current.getTask(record.targetId) === undefined ? [] : [record.targetId]
    }
    if (record.scope === 'group') {
      return current.listTasks().filter(task => task.groupId === record.targetId).map(task => task.taskId)
    }
    const nodes = current.getWorkflow(record.targetId)?.nodes ?? []
    return [...new Set(nodes.map(node => node.taskId))]
  }

  /**
   * Request cancellation of current turns where a reached budget authorises it.
   *
   * The second of PRD §二.13.2's three actions. It uses the exact-stop critical
   * section (`requestTurnCancel`) and does **not** wait for confirmation: a budget
   * requests the cancel and reports the actual state. Native-interface turns are
   * skipped. A concurrency ceiling is not a reason to abort in-flight work.
   *
   * @param current - the open store.
   * @param now - the current instant.
   * @param onlyKeys - when set, only these policy keys are examined (a `set` of one).
   * @returns what was requested or skipped, for the tool summary and the pass log.
   */
  async function enforceReachedBudgetCancels(
    current: ConductorStore,
    now: string,
    onlyKeys?: readonly string[],
  ): Promise<{ notes: string[]; cancels: { taskId: string; outcome: string; reason: string }[] }> {
    const notes: string[] = []
    const cancels: { taskId: string; outcome: string; reason: string }[] = []
    const coordinator = coordinatorOf()
    const agents = probeContext.get('agents') as ObservableAgentsLike | undefined

    for (const record of current.listBudgets()) {
      if (onlyKeys !== undefined && !onlyKeys.includes(record.policyKey)) continue
      const ledger = ledgerOfRecord(current, record.targetId)
      const concurrent = record.maxConcurrent === undefined
        ? undefined
        : inFlightFor(current, record.scope, record.targetId)
      const decision = budgetDecision(
        policyFromRecord(record),
        concurrent === undefined ? ledger : { ...ledger, concurrent },
        now,
      )
      if (!inFlightCancelApplies(decision)) continue

      const already = record.cancelRequestedLimit === (decision.limit ?? 'unknown')
        && record.cancelRequestedAt !== undefined
      const outcomes: string[] = []
      for (const taskId of tasksGovernedBy(current, record)) {
        const bindingId = current.getTask(taskId)?.currentBindingId
        const sessionId = bindingId === undefined ? undefined : current.getBinding(bindingId)?.sessionId
        const live = sessionId === undefined || agents === undefined ? undefined : agents.get(sessionId)
        const running = live?.status === 'running'
        const plan = planBudgetTurnCancel(decision, {
          taskId,
          running,
          ...running ? { openingSource: lastPromptSource(live?.session.events as readonly SessionEventLike[] | undefined) } : {},
        })
        if (plan.intent === 'skip') {
          if (!already) {
            outcomes.push(`${taskId}: skipped — ${plan.reason}`)
            cancels.push({ taskId, outcome: 'skipped', reason: plan.reason })
          }
          continue
        }
        // Already requested this limit against an idle session: do not re-request forever.
        if (already && !running) continue
        if (coordinator === undefined) {
          outcomes.push(`${taskId}: skipped — no coordinator, so nothing was cancelled`)
          cancels.push({ taskId, outcome: 'skipped', reason: 'no coordinator, so nothing was cancelled' })
          continue
        }
        const access = current.getAccess(taskId)
        if (access === undefined) {
          outcomes.push(`${taskId}: skipped — no control record`)
          cancels.push({ taskId, outcome: 'skipped', reason: 'no control record' })
          continue
        }
        try {
          const result = coordinator.requestTurnCancel({
            taskId,
            callerSessionId: access.ownerSessionId,
            cause: `conductor budget ${decision.limit ?? 'limit'}`,
          })
          outcomes.push(`${taskId}: ${result.outcome} — ${result.reason}`)
          cancels.push({ taskId, outcome: result.outcome, reason: result.reason })
        } catch (error) {
          const reason = describeError(error)
          outcomes.push(`${taskId}: refused — ${reason}`)
          cancels.push({ taskId, outcome: 'refused', reason })
        }
      }

      if (outcomes.length === 0 && already) continue

      await current.putBudget({
        ...record,
        cancelRequestedAt: now,
        cancelRequestedLimit: decision.limit ?? 'unknown',
        cancelOutcome: outcomes.join('; ') || record.cancelOutcome || 'no governed task',
        updatedAt: now,
      })
      notes.push(
        `${record.policyKey}: ${decision.limit ?? 'limit'} — ${outcomes.join('; ') || 'no governed task'}`,
      )
    }
    return { notes, cancels }
  }

  /**
   * Count one plugin-initiated event into every ledger that governs a task.
   *
   * One writer for all four kinds PRD §二.13.2 names — nodes, acceptances, reports and reworks — because the
   * field list below is what a reader sees and what the gate decides on: two writers is how one of them ends
   * up missing a counter. Every governing target is incremented, because a group-scope limit counts what the
   * group's tasks do rather than only its own.
   *
   * @param current - the open store.
   * @param taskId - the task the event belongs to.
   * @param event - what happened.
   * @param now - the current time as ISO 8601 UTC.
   * @param workflowId - the workflow, when the event belongs to one.
   */
  async function countLedgerEvent(
    current: ConductorStore,
    taskId: string,
    event: LedgerEvent,
    now: string,
    workflowId?: string,
    operationId?: string,
  ): Promise<void> {
    const targets = new Set(budgetsGoverning(current, taskId, workflowId).map(entry => entry.ledgerTargetId))
    for (const targetId of targets) {
      await current.recordLedgerEvent(targetId, event, now, operationId)
    }
  }

  /**
   * Count one automatic dispatch.
   *
   * The counterpart of {@link budgetPermits}, and the half that was missing entirely: the ledger was
   * written only by the manual `record` action, so a "measured" budget counted nothing by itself and
   * no limit could ever be reached in practice.
   *
   * @param current - the open store.
   * @param taskId - the task dispatched to.
   * @param now - the current time as ISO 8601 UTC.
   * @param workflowId - the workflow, when the dispatch belongs to one.
   */
  async function countDispatch(
    current: ConductorStore,
    taskId: string,
    now: string,
    workflowId?: string,
    operationId?: string,
  ): Promise<void> {
    await countLedgerEvent(current, taskId, { kind: 'dispatch', at: now }, now, workflowId, operationId)
    await enforceReachedBudgetCancels(current, now)
  }

  /**
   * Count one acceptance (PRD §二.13.2's 验收).
   *
   * @param current - the open store.
   * @param taskId - the task whose artifact was accepted.
   * @param now - the current time as ISO 8601 UTC.
   */
  async function countAcceptance(current: ConductorStore, taskId: string, now: string): Promise<void> {
    await countLedgerEvent(current, taskId, { kind: 'acceptance' }, now)
  }

  /**
   * Count one delivered background report (PRD §二.13.2's 回报).
   *
   * Counted only after the Host accepted the notice: a failed or silent pass did not
   * initiate a report turn, and counting those would inflate the figure a budget reads.
   *
   * @param current - the open store.
   * @param taskId - one task the notice covered.
   * @param now - the current time as ISO 8601 UTC.
   */
  async function countReportTurn(current: ConductorStore, taskId: string, now: string): Promise<void> {
    await countLedgerEvent(current, taskId, { kind: 'report_turn' }, now)
  }

  /**
   * Count one opened rework round (PRD §二.13.2's 返工).
   *
   * Counted when a round actually opens, not when a later failure hits the limit
   * and hands the run to the user — that is a stop, not another round.
   *
   * @param current - the open store.
   * @param taskId - the node task the round is for.
   * @param now - the current time as ISO 8601 UTC.
   * @param workflowId - the workflow the round belongs to.
   */
  async function countReworkRound(
    current: ConductorStore,
    taskId: string,
    now: string,
    workflowId: string,
  ): Promise<void> {
    await countLedgerEvent(current, taskId, { kind: 'rework_round' }, now, workflowId)
  }

  /**
   * Evaluate one source task's rules and perform their dispatches.
   *
   * Extracted because there are now two callers and they observe different things: the periodic
   * `evaluate` action reads the source session's log, and an artifact acceptance contributes an
   * observation that is not in any log. Both must go through the **same** executor — a second
   * dispatch path would be a second place for the deduplication and execution-count rules to be
   * got wrong, and PRD §二.8.2 requires one logical dispatch per event.
   *
   * @param current - the open store.
   * @param sourceTaskId - the task whose rules are being evaluated.
   * @param rules - that task's active rules.
   * @param now - the current time as ISO 8601 UTC.
   * @param extra - observations that did not come from the session log (an acceptance).
   * @returns the dispatches performed and the refusals worth reporting.
   */
  async function dispatchRulesFor(
    current: ConductorStore,
    sourceTaskId: string,
    rules: readonly RuleRecord[],
    now: string,
    extra: readonly { event: NotableEvent; eventId: string }[],
  ): Promise<{ dispatches: RuleToolResult['dispatches']; refusals: string[] }> {
    return current.withExclusive('rule-executor', () => dispatchRulesForLocked(current, sourceTaskId, rules, now, extra))
  }

  async function dispatchRulesForLocked(
    current: ConductorStore,
    sourceTaskId: string,
    rules: readonly RuleRecord[],
    now: string,
    extra: readonly { event: NotableEvent; eventId: string }[],
  ): Promise<{ dispatches: RuleToolResult['dispatches']; refusals: string[] }> {
    const dispatches: RuleToolResult['dispatches'] = []
    const refusals: string[] = []
    const bound = current.getTask(sourceTaskId)?.currentBindingId
    const binding = bound === undefined ? undefined : current.getBinding(bound)
    const agent = binding === undefined
      ? undefined
      : (probeContext.get('agents') as ObservableAgentsLike | undefined)?.get(binding.sessionId)
    if (agent === undefined && extra.length === 0) {
      refusals.push(`rule source task ${sourceTaskId}: its session is not live, so its events cannot be read`)
      return { dispatches, refusals }
    }
    // A missing log is not fatal when something outside the log is being observed: an acceptance
    // happened whether or not the source session is still live, and refusing to react to it would
    // tie the rule to an unrelated fact.
    const fromLog = agent === undefined
      ? []
      : projectNotableAfter(initialProjection(), agent.session.events as readonly SessionEventLike[]).notable
    const plan = { dispatches: [] as ReturnType<typeof evaluateRules>['dispatches'], refusals: [] as ReturnType<typeof evaluateRules>['refusals'] }
    for (const saved of rules) {
      const rule = current.getRule(saved.ruleId)
      if (rule === undefined || !rule.active) continue
      try { throwUnlessController(sourceTaskId, rule.authorizedBy) }
      catch (error) { refusals.push(`${rule.ruleId}: ${describeError(error)}`); continue }
      const createdAt = Date.parse(rule.createdAt)
      const events = fromLog.flatMap((entry, index) => {
        const legacyId = `seq-${String(index)}`
        const legacyTrigger = triggerOf(entry.event, legacyId)
        const legacyOperation = legacyTrigger === undefined ? undefined : current.getOperation(fireOperationId(rule.ruleId, legacyTrigger.eventId))
        const legacyFired = legacyTrigger !== undefined && rule.firings.some(firing => firing.sourceEventId === legacyTrigger.eventId)
        // Retain an already-started legacy operation's identity across upgrades;
        // new events use the real session + sequence, never a projection-array index.
        if (legacyOperation !== undefined || legacyFired) return [{ event: entry.event, eventId: legacyId }]
        if (!Number.isFinite(createdAt) || entry.at <= createdAt) return []
        if (entry.event.kind === 'turn_ended' && agent !== undefined
          && turnOriginOf((agent.session.events as readonly SessionEventLike[]).filter(event => event.seq <= entry.seq)).reportTriggered) return []
        return [{ event: entry.event, eventId: `${binding?.sessionId ?? sourceTaskId}#${String(entry.seq)}` }]
      })
      const evaluated = evaluateRules([rule], {
        events: [...events, ...extra], artifact: artifactId => current.getArtifact(artifactId), now,
      })
      plan.dispatches.push(...evaluated.dispatches)
      plan.refusals.push(...evaluated.refusals)
    }
    for (const refusal of plan.refusals) refusals.push(`${refusal.ruleId}: ${refusal.reason}`)
    for (const dispatch of plan.dispatches) {
      const disabled = lifecycle.refusal('an automatic rule dispatch')
      if (disabled !== undefined) {
        refusals.push(`${dispatch.rule.ruleId}: not dispatched — ${disabled}`)
        continue
      }
      // §二.13.2's first action, before anything is sent: a reached limit stops new automatic
      // scheduling. A rule firing **is** automatic scheduling, so it is gated here.
      const permitted = budgetPermits(current, dispatch.rule.targetTaskId, now)
      if (!permitted.allowed) {
        refusals.push(`${dispatch.rule.ruleId}: not dispatched — ${permitted.reason}`)
        continue
      }
      // The dispatch is performed through the ordinary send path, handing it the deterministic
      // operation id. That is deliberate: the send path claims the operation as its own kind, and
      // its idempotency layer is what makes a repeated event a *replay* rather than a second
      // instruction. Claiming the id here first would collide with that claim and the dispatch
      // would be refused as a conflict.
      try {
        const outcome = await coordinatorOf()?.send({
          operationId: dispatch.operationId,
          taskId: dispatch.rule.targetTaskId,
          text: dispatch.rule.instruction,
          mode: dispatch.rule.action === 'queue' ? 'queue' : 'steer',
          callerSessionId: dispatch.rule.authorizedBy,
          attribution: {
            kind: 'rule',
            ruleId: dispatch.rule.ruleId,
            sourceEventId: dispatch.sourceEventId,
            ...dispatch.rule.grantId === undefined ? {} : { grantId: dispatch.rule.grantId },
          },
        })
        if (outcome === undefined || (outcome.delivery !== 'accepted' && outcome.delivery !== 'replayed')) {
          refusals.push(
            `${dispatch.rule.ruleId}: kept pending — ${outcome?.reason ?? 'no coordinator'}`,
          )
          continue
        }
      } catch (error) {
        refusals.push(`${dispatch.rule.ruleId}: the dispatch failed: ${describeError(error)}`)
        continue
      }
      await countDispatch(current, dispatch.rule.targetTaskId, now, undefined, dispatch.operationId)
      await current.updateRule(dispatch.rule.ruleId, entry => recordFiring(entry, dispatch, 'dispatched', now))
      dispatches.push({
        ruleId: dispatch.rule.ruleId,
        operationId: dispatch.operationId,
        targetTaskId: dispatch.rule.targetTaskId,
        instruction: dispatch.rule.instruction,
        reason: dispatch.reason,
      })
    }
    return { dispatches, refusals }
  }

  /**
   * The schedule surface (PRD §二.11).
   *
   * The parts that matter are not the storage: they are the four places where a
   * schedule must not guess. A local time is resolved through the chosen zone or
   * refused. An execution plan without a stated limit is saved as a draft rather
   * than started. An occurrence that has already been recorded is never fired
   * twice, because the dispatch's operation id **is** the dedupe identity
   * (`scheduleId` + scheduled instant) and the ordinary send path owns the claim
   * on it. And after downtime nothing is replayed: {@link planRecovery} decides
   * that, and its decision is recorded in the run log rather than inferred later.
   *
   * @param request - what the caller asked for.
   * @returns the affected schedules, the preview notes and any refusals.
   */
  const scheduleOf = async (request: ScheduleToolRequest): Promise<ScheduleToolResult> => {
    const current = store
    if (current === undefined) throw new Error('NO_DURABLE_STATE: the conductor has no durable state')
    return current.withExclusive('schedule-executor', async () => {
      if ((request.action !== 'save' && request.action !== 'update') || !request.operationId) return await scheduleOfUnlocked(request)
      if (request.targetTaskId) throwUnlessController(request.targetTaskId, request.authorizedBy ?? '')
      if (request.scheduleId) {
        const existing = current.getSchedule(request.scheduleId)
        if (existing && existing.authorizedBy !== request.authorizedBy) throw new Error('NOT_CONTROLLER: the schedule belongs to another controller')
        if (existing?.targetTaskId) throwUnlessController(existing.targetTaskId,request.authorizedBy??'')
      }
      const claim = await current.beginOperation({operationId:request.operationId,kind:'schedule',params:request,
        ...request.targetTaskId ? {taskId:request.targetTaskId} : {}})
      if (claim.kind === 'conflict') throw new Error('OPERATION_CONFLICT: schedule identity has different parameters')
      const saved = current.getOperation(request.operationId)?.result as ScheduleToolResult | undefined
      if (saved) return saved
      if (claim.kind === 'replay') throw new Error('UNKNOWN: schedule mutation needs reconciliation before it can be repeated')
      const result = await scheduleOfUnlocked({...request,scheduleId:request.scheduleId ?? `schedule-${createHash('sha256').update(request.operationId).digest('hex').slice(0,32)}`})
      await current.updateOperation(request.operationId,row=>({...row,result,delivery:'accepted',phase:'saved'}))
      return result
    })
  }

  const scheduleOfUnlocked = async (request: ScheduleToolRequest): Promise<ScheduleToolResult> => {
    const current = store
    if (current === undefined) throw new Error('NO_DURABLE_STATE: the conductor has no durable state')
    const nowMs = Date.now()
    const now = new Date(nowMs).toISOString()

    /** Describe a saved schedule the way a preview reads. */
    const describe = (entry: ScheduleRecord): string => {
      const state = entry.status === 'draft' && entry.draftReason !== undefined
        ? `draft (${entry.draftReason})`
        : entry.status
      return `${entry.scheduleId} "${entry.title}" [${entry.kind} ${entry.action}] next ${entry.nextAt} `
        + `in ${entry.timezone} — ${state}, ${String(countRuns(entry))} run(s)`
    }

    if (request.action === 'list') {
      const schedules = current.listSchedules({})
      return {
        schedules,
        notes: [],
        runs: [],
        refusals: [],
        summary: schedules.length === 0
          ? 'No schedules are saved.'
          : `${String(schedules.length)} schedule(s):\n` + schedules.map(entry => `- ${describe(entry)}`).join('\n'),
      }
    }

    if (request.action === 'remove') {
      if (request.scheduleId === undefined) throw new Error('BAD_REQUEST: removing a schedule needs its scheduleId')
      const existing = current.getSchedule(request.scheduleId)
      if (existing === undefined) throw new Error(`NOT_FOUND: no schedule ${request.scheduleId} is saved`)
      if (request.authorizedBy === undefined) {
        throw new Error('BAD_REQUEST: removing a schedule needs the calling session, which the Host supplies')
      }
      if (existing.targetTaskId !== undefined) throwUnlessController(existing.targetTaskId, request.authorizedBy)
      await current.deleteSchedule(request.scheduleId)
      return {
        schedules: [],
        notes: [],
        runs: [],
        refusals: [],
        summary: `Removed schedule ${request.scheduleId}. Its run log went with it; nothing else was touched.`,
      }
    }

    if (request.action === 'pause') {
      if (request.scheduleId === undefined) throw new Error('BAD_REQUEST: pausing a schedule needs its scheduleId')
      const existing = current.getSchedule(request.scheduleId)
      if (existing === undefined) throw new Error(`NOT_FOUND: no schedule ${request.scheduleId} is saved`)
      if (request.authorizedBy === undefined) {
        throw new Error('BAD_REQUEST: pausing a schedule needs the calling session, which the Host supplies')
      }
      if (existing.targetTaskId !== undefined) throwUnlessController(existing.targetTaskId, request.authorizedBy)
      const paused = await current.updateSchedule(request.scheduleId, entry =>
        ({ ...entry, status: 'paused' }))
      return {
        schedules: [paused],
        notes: [],
        runs: [],
        refusals: [],
        summary: `Paused ${paused.scheduleId}. Nothing fires while it is paused, and a pause does not replay what it skips.`,
      }
    }

    if (request.action === 'resume') {
      if (request.scheduleId === undefined) throw new Error('BAD_REQUEST: resuming a schedule needs its scheduleId')
      const existing = current.getSchedule(request.scheduleId)
      if (existing === undefined) throw new Error(`NOT_FOUND: no schedule ${request.scheduleId} is saved`)
      if (request.authorizedBy === undefined) {
        throw new Error('BAD_REQUEST: resuming a schedule needs the calling session, which the Host supplies')
      }
      if (existing.targetTaskId !== undefined) throwUnlessController(existing.targetTaskId, request.authorizedBy)
      const decision = planResume(existing, nowMs)
      const resumed = await current.updateSchedule(request.scheduleId, entry => ({
        ...entry,
        status: decision.status,
        nextAt: decision.nextAt,
        runs: decision.record === undefined ? entry.runs : [...entry.runs, decision.record],
      }))
      return {
        schedules: [resumed],
        notes: [decision.note],
        runs: decision.record === undefined
          ? []
          : [`${decision.record.scheduledFor} ${decision.record.outcome}: ${decision.record.reason ?? ''}`],
        refusals: [],
        summary: `Resumed ${resumed.scheduleId}: ${decision.note}. Next occurrence ${resumed.nextAt}.`,
      }
    }

    if (request.action === 'preview' || request.action === 'save' || request.action === 'update') {
      const authorizedBy = request.authorizedBy
      if (authorizedBy === undefined) {
        // Only the requester of a plan can authorise it, and the background pass has
        // no session of its own — which is why it only ever ticks.
        throw new Error(`BAD_REQUEST: ${request.action} needs the calling session, which the Host supplies`)
      }
      const saving = request.action !== 'preview'
      const updating = request.action === 'update'
      const previous = updating && request.scheduleId ? current.getSchedule(request.scheduleId) : undefined
      if (updating && !previous) throw new Error('NOT_FOUND: update requires an existing scheduleId')
      if (previous && previous.authorizedBy !== authorizedBy) throw new Error('NOT_CONTROLLER: the schedule belongs to another controller')
      if (previous?.targetTaskId) throwUnlessController(previous.targetTaskId,authorizedBy)
      if (previous) request = {
        scheduleId:previous.scheduleId,title:previous.title,kind:previous.kind,timezone:previous.timezone,
        ...request.delayMs===undefined?{at:previous.nextAt}:{},mode:previous.action,
        ...previous.intervalMs === undefined ? {} : {intervalMs:previous.intervalMs},
        ...previous.wall === undefined ? {} : {hour:previous.wall.hour,minute:previous.wall.minute},
        ...previous.targetTaskId === undefined ? {} : {targetTaskId:previous.targetTaskId},
        ...previous.instruction === undefined ? {} : {instruction:previous.instruction},
        ...previous.maxRuns === undefined ? {} : {maxRuns:previous.maxRuns},
        ...previous.expiresAt === undefined ? {} : {expiresAt:previous.expiresAt},
        ...previous.graceMs === undefined ? {} : {graceMs:previous.graceMs},
        ...request,
      }
      // `preview` with a scheduleId answers a different question: not "would these
      // parameters be accepted" but "what would that saved plan do right now".
      if (!saving && request.scheduleId !== undefined) {
        const existing = current.getSchedule(request.scheduleId)
        if (existing === undefined) throw new Error(`NOT_FOUND: no schedule ${request.scheduleId} is saved`)
        const decision = dueDecision(existing, nowMs)
        return {
          schedules: [existing],
          notes: [`at ${now}: ${decision.reason}`],
          runs: [],
          refusals: [],
          summary: `${describe(existing)}\nAt ${now} this ${decision.due ? 'is due' : 'is not due'}: ${decision.reason}.`,
        }
      }
      // One plan call for both actions: a preview that planned differently from a save
      // would be a preview of something else.
      const plan = planScheduleSave({
        scheduleId: request.scheduleId ?? (saving ? `schedule-${randomUUID()}` : `schedule-preview-${randomUUID()}`),
        kind: request.kind ?? 'once',
        timezone: request.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        action: request.mode ?? 'inspect',
        authorizedBy,
        now: nowMs,
        ...request.title === undefined ? {} : { title: request.title },
        ...request.at === undefined ? {} : { at: request.at },
        ...request.delayMs === undefined ? {} : { delayMs: request.delayMs },
        ...request.intervalMs === undefined ? {} : { intervalMs: request.intervalMs },
        ...request.hour === undefined || request.minute === undefined
          ? {} : { wall: { hour: request.hour, minute: request.minute } },
        ...request.targetTaskId === undefined ? {} : { targetTaskId: request.targetTaskId },
        ...request.instruction === undefined ? {} : { instruction: request.instruction },
        ...request.maxRuns === undefined ? {} : { maxRuns: request.maxRuns },
        ...request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt },
        ...request.graceMs === undefined ? {} : { graceMs: request.graceMs },
      })
      if (!plan.ok) {
        return {
          schedules: [],
          notes: [],
          runs: [],
          refusals: [plan.reason],
          summary: saving
            ? `The schedule was not saved: ${plan.reason}`
            : `This plan would be refused: ${plan.reason}`,
        }
      }
      if (!saving) {
        return {
          schedules: [plan.record],
          notes: plan.notes,
          runs: [],
          refusals: [],
          summary: `Preview only; nothing was saved. It would be created as ${plan.record.status}`
            + ` with its next occurrence at ${plan.record.nextAt} in ${plan.record.timezone}.`
            + (plan.notes.length === 0 ? '' : `\n${plan.notes.map(note => `- ${note}`).join('\n')}`),
        }
      }
      const existing = current.getSchedule(plan.record.scheduleId)
      if (existing !== undefined && !updating) throw new Error(`SCHEDULE_EXISTS: schedule ${plan.record.scheduleId} is already saved`)
      if (plan.record.targetTaskId !== undefined) throwUnlessController(plan.record.targetTaskId, authorizedBy)
      if (previous) {
        for (const operation of current.listOperations({})) {
          if (operation.delivery === 'prepared' && operation.attribution?.sourceEventId?.startsWith(`schedule-${previous.scheduleId}-`)) {
            await current.updateOperation(operation.operationId,row=>({...row,withdrawn:true,delivery:'withdrawn',phase:'schedule_updated'}))
          }
        }
      }
      const saved = await current.putSchedule(previous === undefined ? plan.record : {
        ...plan.record, createdAt:previous.createdAt,runs:previous.runs,
        ...previous.status === 'paused' ? {status:'paused' as const} : {},
      })
      const limit = saved.action === 'inspect'
        ? 'It is read-only: it inspects and reports, and never sends anything.'
        : `It may ${saved.action} at most ${String(saved.maxRuns ?? 0)} time(s)`
          + (saved.expiresAt === undefined ? '' : ` and stops after ${saved.expiresAt}`) + '.'
      return {
        schedules: [saved],
        notes: plan.notes,
        runs: [],
        refusals: [],
        summary: `Saved ${saved.scheduleId} as ${saved.status}: ${describe(saved)}. ${limit}`
          + (plan.notes.length === 0 ? '' : `\n${plan.notes.map(note => `- ${note}`).join('\n')}`),
      }
    }

    // tick: perform what is due now, and record what happened either way.
    const disabledTick = lifecycle.refusal('a scheduled occurrence')
    if (disabledTick !== undefined) {
      return {
        schedules: [],
        notes: [],
        runs: [],
        refusals: [disabledTick],
        summary: disabledTick,
      }
    }
    const schedules = current.listSchedules({}).filter(entry => request.scheduleId === undefined || entry.scheduleId === request.scheduleId)
    const notes: string[] = []
    const runs: string[] = []
    const refusals: string[] = []
    const touched: ScheduleRecord[] = []

    for (const entry of schedules) {
      const decision = dueDecision(entry, nowMs)
      if (!decision.due) continue
      const scheduledFor = decision.scheduledFor ?? entry.nextAt

      if (entry.action === 'inspect') {
        // A read-only occurrence: report what it sees and record that it ran.
        // PRD §二.11: 有变化时通知 — the observation is always recorded; a notice is
        // delivered only when it differs from the last one, and never as an instruction.
        const observation = await inspectOf(entry)
        const decision = inspectNoticeDecision(lastInspectObservation(entry.runs), observation)
        let notice = decision.reason
        if (decision.notify && entry.targetTaskId !== undefined) {
          const sent = await deliverInspectNotice(
            entry,
            scheduledFor,
            observation,
            lastInspectObservation(entry.runs),
            now,
          )
          notice = sent.account
          if (sent.delivered) await countReportTurn(current, entry.targetTaskId, now)
        }
        const recorded = await current.updateSchedule(entry.scheduleId, item => ({
          ...item,
          runs: [...item.runs, { scheduledFor, ranAt: now, outcome: 'ran', reason: observation }],
          ...nextOf(item, nowMs),
        }))
        touched.push(recorded)
        runs.push(`${entry.scheduleId} ${scheduledFor}: inspected — ${observation} (${notice})`)
        continue
      }

      if (entry.targetTaskId === undefined || entry.instruction === undefined) {
        refusals.push(`${entry.scheduleId}: the plan states no target or no instruction, so it cannot execute`)
        continue
      }
      // The dedupe identity of PRD §三.5: one schedule, one scheduled instant, one
      // dispatch. Handing the send path this deterministic id is what makes a
      // replayed tick a *replay* instead of a second instruction.
      const operationId = `schedule-${entry.scheduleId}-${scheduledFor}`
      // §二.13.2's first action: a reached limit stops new automatic scheduling, and a due schedule
      // is exactly that. The occurrence is recorded as refused rather than silently skipped,
      // because a plan that quietly stops firing is indistinguishable from one that was never saved.
      const permitted = budgetPermits(current, entry.targetTaskId, now)
      if (!permitted.allowed) {
        const recorded = await current.updateSchedule(entry.scheduleId, item => ({
          ...item,
          runs: [...item.runs, { scheduledFor, outcome: 'refused', reason: permitted.reason }],
          ...nextOf(item, nowMs),
        }))
        touched.push(recorded)
        refusals.push(`${entry.scheduleId}: not dispatched — ${permitted.reason}`)
        continue
      }
      // §四.2's other half: a scheduled dispatch is plugin-initiated too, so it says so. The
      // association names the schedule rather than a grant: a schedule is authorised once at save
      // time and its identity is its own.
      try {
        const outcome = await coordinatorOf()?.send({
          operationId,
          taskId: entry.targetTaskId,
          text: entry.instruction,
          mode: entry.action === 'queue' ? 'queue' : 'steer',
          callerSessionId: entry.authorizedBy,
          attribution: { kind: 'relay', sourceEventId: `schedule-${entry.scheduleId}-${scheduledFor}` },
        })
        if (outcome === undefined || (outcome.delivery !== 'accepted' && outcome.delivery !== 'replayed')) {
          refusals.push(`${entry.scheduleId}: kept pending — ${outcome?.reason ?? 'no coordinator'}`)
          continue
        }
      } catch (error) {
        const reason = describeError(error)
        const unknown = current.getOperation(operationId)?.delivery === 'unknown'
        await current.updateSchedule(entry.scheduleId, item => ({
          ...item,
          runs: [...item.runs, { scheduledFor, outcome: unknown ? 'refused' : 'failed', reason }],
          ...(unknown ? { status: 'paused' as const } : nextOf(item, nowMs)),
        }))
        refusals.push(`${entry.scheduleId}: ${unknown ? 'delivery is unknown; paused for reconciliation' : 'the dispatch failed'}: ${reason}`)
        continue
      }
      await countDispatch(current, entry.targetTaskId, now, undefined, operationId)
      const recorded = await current.updateSchedule(entry.scheduleId, item => ({
        ...item,
        runs: [...item.runs, { scheduledFor, ranAt: now, outcome: 'ran', reason: `dispatched as ${operationId}` }],
        ...nextOf(item, nowMs),
      }))
      touched.push(recorded)
      runs.push(`${entry.scheduleId} ${scheduledFor}: dispatched to ${entry.targetTaskId} as ${operationId}`)
    }

    return {
      schedules: touched,
      notes,
      runs,
      refusals,
      summary: runs.length === 0 && refusals.length === 0
        ? `Checked ${String(schedules.length)} schedule(s) at ${now}: nothing is due.`
        : `At ${now}: ${String(runs.length)} occurrence(s) performed, ${String(refusals.length)} refusal(s).\n`
          + [...runs, ...refusals].map(line => `- ${line}`).join('\n'),
    }
  }

  /**
   * Recover every schedule after the Host was not running (PRD §二.11).
   *
   * This is the one calibration the specification asks for on restart, and it is
   * deliberately not a replay: {@link planRecovery} decides per schedule, and the
   * decision is written into the run log so a later reader sees what was skipped
   * rather than having to reconstruct it. It runs once, after the store opens.
   *
   * @returns a one-line account, for the load announcement.
   */
  const recoverSchedules = async (): Promise<string> => {
    const current = store
    if (current === undefined) return 'no durable state, so no schedules were calibrated'
    const nowMs = Date.now()
    const active = current.listSchedules({ status: 'active' })
    if (active.length === 0) return `${String(current.listSchedules({}).length)} schedule(s), none active`
    let calibrated = 0
    let missed = 0
    let caughtUp = 0
    for (const entry of active) {
      const decision = planRecovery(entry, nowMs)
      if (decision.record === undefined && !decision.calibrate) continue
      if (decision.record?.outcome === 'ran' && !decision.calibrate) {
        // A recovery decision is permission to attempt the saved occurrence,
        // not a delivery receipt. The ordinary executor owns the write, all
        // admission checks, the stable operation identity and the run record.
        const performed = await scheduleOf({ action: 'tick', scheduleId: entry.scheduleId })
        caughtUp += performed.runs.length
        continue
      }
      // PRD §二.11: 恢复后补一次只读状态校准. The decision says *whether* to calibrate;
      // the inspection is what the calibration *is*. Recording `ran` with the policy
      // sentence and never calling inspectOf is how a later reader was told a check
      // happened that did not.
      const observation = decision.calibrate ? await inspectOf(entry) : undefined
      await current.updateSchedule(entry.scheduleId, item => ({
        ...item,
        nextAt: decision.nextAt ?? item.nextAt,
        runs: decision.record === undefined
          ? [...item.runs, calibratedInspectRun(
              item.nextAt,
              new Date(nowMs).toISOString(),
              observation ?? decision.reason,
            )]
          : [...item.runs, decision.record],
        ...(entry.kind === 'once' && decision.record !== undefined ? { status: 'completed' as const } : {}),
      }))
      if (decision.calibrate) calibrated += 1
      else missed += 1
    }
    return `${String(active.length)} active schedule(s): ${String(calibrated)} calibrated once, `
      + `${String(missed)} missed occurrence(s) recorded, ${String(caughtUp)} authorised catch-up occurrence(s) performed`
  }

  /**
   * Report the next instant and status to store after one occurrence.
   *
   * A one-shot is finished once it has run; a recurring plan moves to its next
   * occurrence and, if its allowance is used up or it has expired, stops rather
   * than being left to look active.
   *
   * @param entry - the schedule as it was before the occurrence.
   * @param nowMs - the current instant.
   * @returns the members to overwrite.
   */
  const nextOf = (entry: ScheduleRecord, nowMs: number): Pick<ScheduleRecord, 'nextAt' | 'status'> => {
    if (entry.kind === 'once') return { nextAt: entry.nextAt, status: 'completed' }
    const nextAt = advanceNextAt(entry, nowMs)
    const spent = entry.maxRuns !== undefined && entry.action !== 'inspect' && countRuns(entry) + 1 >= entry.maxRuns
    const expired = entry.expiresAt !== undefined && nowMs > Date.parse(entry.expiresAt)
    return { nextAt, status: spent || expired ? 'completed' : entry.status }
  }

  /**
   * Read what a read-only occurrence sees.
   *
   * The observation is drawn from durable conductor facts — the task's own state,
   * the artifacts recorded for it, and the shared constraints that are the
   * defined conditions of PRD §二.11 — never from a claim about a live session,
   * because a stored record cannot prove a session is still running.
   *
   * @param entry - the schedule being inspected.
   * @returns a one-line observation.
   */
  const inspectOf = async (entry: ScheduleRecord): Promise<string> => {
    const current = store
    if (current === undefined) return 'no durable state is available to inspect'
    if (entry.targetTaskId === undefined) {
      return inspectObservationOf({})
    }
    const task = current.getTask(entry.targetTaskId)
    const bound = task?.currentBindingId === undefined ? undefined : current.getBinding(task.currentBindingId)
    return inspectObservationOf({
      taskId: entry.targetTaskId,
      ...task === undefined ? {} : { task },
      ...bound === undefined ? {} : { sessionId: bound.sessionId },
      artifacts: task === undefined ? [] : current.listArtifacts({ taskId: entry.targetTaskId }),
      constraints: current.listConstraints(),
      deliveries: current.listConstraintDeliveries({ targetId: entry.targetTaskId }),
    })
  }

  /**
   * Deliver an inspect-change notice to the session that authorised the plan.
   *
   * PRD §二.11: 有变化时通知. The notice is an observation, not an instruction: it
   * uses the plugin `notice` source so the turn it opens cannot authorise the next
   * step. A session that is not live is named as undelivered rather than invented.
   *
   * @param entry - the schedule that inspected.
   * @param scheduledFor - the occurrence that produced the observation.
   * @param observation - what this occurrence saw.
   * @param previous - what the last occurrence saw.
   * @param now - the current instant as ISO 8601 UTC.
   * @returns whether the Host accepted the notice, and a one-line account.
   */
  const deliverInspectNotice = async (
    entry: ScheduleRecord,
    scheduledFor: string,
    observation: string,
    previous: string | undefined,
    now: string,
  ): Promise<{ delivered: boolean; account: string }> => {
    const current = store
    if (current === undefined) {
      return { delivered: false, account: 'no durable state is available to deliver a notice' }
    }
    const text = `Scheduled inspection "${entry.title}" saw a change`
      + `${entry.targetTaskId === undefined ? '' : ` on task ${entry.targetTaskId}`}:\n`
      + `- previously: ${previous ?? '(none)'}\n`
      + `- now: ${observation}`
    const agents = probeContext.get('agents') as ObservableAgentsLike | undefined
    const agent = agents?.get(entry.authorizedBy)
    const delivery = snapshotDeliveryPlan(agent, entry.authorizedBy)
    const taskId = entry.targetTaskId ?? entry.scheduleId
    const record = async (status: NotificationRecord['delivery']): Promise<void> => {
      await current.putNotification({
        notificationId: `${entry.authorizedBy}::schedule-${entry.scheduleId}-${scheduledFor}`,
        controllerSessionId: entry.authorizedBy,
        taskId,
        sourceEventId: `schedule-${entry.scheduleId}-${scheduledFor}`,
        summary: text.slice(0, 500),
        delivery: status,
        withdrawn: false,
        createdAt: now,
        updatedAt: now,
      })
    }
    if (delivery.kind === 'not_live' || delivery.kind === 'no_channel') {
      await record('failed')
      return { delivered: false, account: `change not delivered: session ${entry.authorizedBy} is not live` }
    }
    const channel = delivery.kind === 'wake' ? agent?.steer : agent?.followup
    if (typeof channel !== 'function' || agent === undefined) {
      await record('failed')
      return { delivered: false, account: `change not delivered: session ${entry.authorizedBy} has no delivery channel` }
    }
    try {
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: noticeSource(text.slice(0, 100)),
      })
      channel.call(agent, message)
      await record('accepted')
      return {
        delivered: true,
        account: delivery.kind === 'wake'
          ? `notified ${entry.authorizedBy} (woke)`
          : `notified ${entry.authorizedBy} (queued)`,
      }
    } catch (error) {
      await record('failed')
      return { delivered: false, account: `change not delivered: ${describeError(error)}` }
    }
  }

  /**
   * Record one delivered report and advance the watch that produced it.
   *
   * The watch's cursor and its delivered-id list are both written, and they answer
   * different questions: the cursor says how far the log has been read, the ids say
   * what was actually reported. A crash between delivering and saving therefore
   * re-reports nothing, because the ids — not the cursor — decide what is new.
   *
   * @param current - the open store.
   * @param controllerSessionId - the session that received the report.
   * @param watch - the watch that produced it.
   * @param facts - the facts in the report.
   * @param now - the current instant as ISO 8601 UTC.
   * @param nowMs - the current instant in epoch milliseconds.
   * @param delivery - how the report ended up.
   */
    const recordReport = async (
    current: ConductorStore,
    controllerSessionId: string,
    watch: WatchRecord,
    facts: readonly ReportFact[],
    now: string,
    nowMs: number,
    delivery: NotificationRecord['delivery'] = 'accepted',
    pending?: string | undefined,
    remoteSessionId?: string,
  ): Promise<void> => {
    const ids = facts.map(fact => fact.eventId)
    for (const fact of facts) {
      await current.putNotification({
        // Derived rather than random: re-delivering the same fact is then a write of
        // the same value, so "reported once" cannot be broken by a repeat pass.
        notificationId: `${controllerSessionId}::${fact.eventId}`,
        controllerSessionId,
        taskId: fact.taskId,
        sourceEventId: fact.eventId,
        summary: fact.summary,
        delivery,
        withdrawn: false,
        createdAt: now,
        updatedAt: now,
      })
    }
    // A missing controller or unavailable delivery method is known not to have
    // accepted a report. Keep those facts unread so reconnect can deliver them.
    // An uncertain Host call is retained as unknown and must not be resent.
    if (delivery !== 'accepted' && delivery !== 'consumed' && delivery !== 'unknown') return
    const latest = current.getWatch(`${controllerSessionId}::${watch.taskId}`)
    if (latest === undefined) return
    const stored = remoteSessionId === undefined ? Number.parseInt(latest.cursor, 10) : observationAfterCursor(latest.cursor, remoteSessionId)
    const fromCursor = Number.isFinite(stored) ? stored : -1
    const sequenced = facts.filter(fact => fact.eventId === `${fact.sessionId}#${String(fact.seq)}`)
    const highest = sequenced.reduce((max, fact) => Math.max(max, fact.seq), fromCursor)
    const { pendingIntervention: _drop, ...rest } = latest
    await current.putWatch(`${controllerSessionId}::${watch.taskId}`, {
      ...rest,
      cursor: sequenced.length === 0 ? latest.cursor
        : remoteSessionId === undefined ? String(highest) : encodeObservationCursor(remoteSessionId, highest),
      deliveredEventIds: [...new Set([...latest.deliveredEventIds, ...ids])],
      lastNotifiedAt: new Date(nowMs).toISOString(),
      ...pending === undefined ? {} : { pendingIntervention: pending },
      updatedAt: now,
    })
  }

  /**
   * The watch surface: background reports to a controlling session (PRD §二.8.1).
   *
   * The pass is deliberately boring, because everything interesting is in what it
   * refuses to do. It folds only the events past each watch's own cursor, drops
   * every fact whose identity is already in the watch's delivered list, merges what
   * is left into one notice per window, and then delivers it according to the
   * controller's own state — waking an idle session, queueing for a busy one, and
   * staying completely silent when nothing meaningful changed.
   *
   * The notice is built with `noticeSource()`, which is what makes the write
   * barrier work: the Host records that source in the durable log, so the turn it
   * opens is identifiable as report-triggered and the coordination writes it
   * attempts are refused server-side rather than discouraged in a prompt.
   *
   * @param request - what the caller asked for.
   * @returns the saved watches, what was delivered, and what was suppressed.
   */
  const watchOf = async (request: WatchToolRequest): Promise<WatchToolResult> => {
    const current = store
    if (current === undefined) throw new Error('NO_DURABLE_STATE: the conductor has no durable state')
    return current.withExclusive(`watch-executor:${request.controllerSessionId}`, () => watchOfUnlocked(request))
  }

  const watchOfUnlocked = async (request: WatchToolRequest): Promise<WatchToolResult> => {
    const current = store
    if (current === undefined) throw new Error('NO_DURABLE_STATE: the conductor has no durable state')
    const now = new Date().toISOString()
    const nowMs = Date.now()
    const keyOf = (taskId: string): string => `${request.controllerSessionId}::${taskId}`
    // Direct history and synchronous waits also persist reader cursors in this
    // table. They are not background watches unless explicitly started here.
    // Old rows predate the bit and keep their original active interpretation.
    const activeWatches = (): WatchRecord[] => current.listWatches(request.controllerSessionId)
      .filter(record => record.watchEnabled !== false)

    /** Describe one watch the way the saved configuration reads. */
    const describe = (record: WatchRecord): WatchToolResult['watches'][number] => ({
      taskId: record.taskId,
      cursor: record.cursor,
      reported: record.deliveredEventIds.length,
      ...record.lastNotifiedAt === undefined ? {} : { lastNotifiedAt: record.lastNotifiedAt },
      ...record.pendingIntervention === undefined ? {} : { pendingIntervention: record.pendingIntervention },
    })

    /**
     * Persist the Watch 待介入事项 without moving the cursor or the delivered-id list.
     *
     * Opening a panel does not clear this; only a later observation that the
     * target is no longer waiting does. A target that is not live keeps the last
     * recorded intervention rather than pretending it went away.
     */
    const persistPending = async (watch: WatchRecord, pending: string | undefined): Promise<void> => {
      if (watch.pendingIntervention === pending) return
      const { pendingIntervention: _drop, ...rest } = watch
      await current.putWatch(`${watch.controllerSessionId}::${watch.taskId}`, {
        ...rest,
        ...pending === undefined ? {} : { pendingIntervention: pending },
        updatedAt: now,
      })
    }

    /** The live pending intervention for a task, when its session can be folded. */
    const pendingForTask = (taskId: string): string | undefined => {
      const task = current.getTask(taskId)
      const binding = task?.currentBindingId === undefined ? undefined : current.getBinding(task.currentBindingId)
      const live = binding === undefined
        ? undefined
        : (probeContext.get('agents') as ObservableAgentsLike | undefined)?.get(binding.sessionId)
      if (live === undefined) return undefined
      return pendingInterventionOf(
        projectEvents(initialProjection(), live.session.events as readonly SessionEventLike[]).state.interaction,
      )
    }

    if (request.action === 'list') {
      const watches = activeWatches()
      return {
        watches: watches.map(describe),
        delivered: [],
        suppressed: 0,
        refusals: [],
        summary: watches.length === 0
          ? 'This session is not watching any task.'
          : `Watching ${String(watches.length)} task(s):\n`
            + watches.map(record =>
                `- ${record.taskId} at cursor ${record.cursor}, `
                + `${String(record.deliveredEventIds.length)} fact(s) already reported`
                + (record.pendingIntervention === undefined
                  ? ''
                  : `, pending ${record.pendingIntervention}`)).join('\n'),
      }
    }

    if (request.action === 'start') {
      if (request.taskId === undefined) throw new Error('BAD_REQUEST: starting a watch needs its taskId')
      const task = current.getTask(request.taskId)
      if (task === undefined) throw new Error(`TASK_NOT_FOUND: no managed task ${request.taskId}`)
      const existing = current.getWatch(keyOf(request.taskId))
      if (existing !== undefined && existing.watchEnabled !== false) {
        return {
          watches: [describe(existing)],
          delivered: [],
          suppressed: 0,
          refusals: [],
          summary: `Already watching ${request.taskId} at cursor ${existing.cursor}; the saved watch was left as it is.`,
        }
      }
      throwUnlessReader(request.taskId, request.controllerSessionId)
      const remote = await remoteObservationOf(request.taskId, request.controllerSessionId, '-1')
      throwUnlessReader(request.taskId, request.controllerSessionId)
      const pending = remote === undefined ? pendingForTask(request.taskId) : pendingInterventionOf(remote.state.interaction)
      const saved = await current.putWatch(keyOf(request.taskId), {
        controllerSessionId: request.controllerSessionId,
        taskId: request.taskId,
        // A new watch starts from the target's current position, not from the
        // beginning: reporting a task's entire past as "news" would bury the
        // controller in history it can already read with conductor_read.
        cursor: remote === undefined ? String(currentPositionOf(request.taskId)) : encodeObservationCursor(remote.sessionId, remote.position),
        deliveredEventIds: [],
        watchEnabled: true,
        ...existing?.historyCursor === undefined ? {} : { historyCursor: existing.historyCursor },
        ...existing?.historyBindingId === undefined ? {} : { historyBindingId: existing.historyBindingId },
        ...existing?.waitCursor === undefined ? {} : { waitCursor: existing.waitCursor },
        ...existing?.waitBindingId === undefined ? {} : { waitBindingId: existing.waitBindingId },
        ...pending === undefined ? {} : { pendingIntervention: pending },
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      })
      return {
        watches: [describe(saved)],
        delivered: [],
        suppressed: 0,
        refusals: [],
        summary: `Watching ${saved.taskId} from cursor ${saved.cursor}. Events from now on are reported; `
          + 'earlier history stays available through conductor_read.',
      }
    }

    if (request.action === 'ack') {
      if (request.taskId === undefined) throw new Error('BAD_REQUEST: acknowledging unread reports needs a taskId')
      const acknowledged = await current.acknowledgeNotifications(
        request.controllerSessionId,
        request.taskId,
        now,
      )
      const remaining = unreadCountOf(current.listNotifications({
        controllerSessionId: request.controllerSessionId,
        taskId: request.taskId,
      }))
      return {
        watches: activeWatches().map(describe),
        delivered: [],
        suppressed: 0,
        refusals: [],
        acknowledged,
        unreadRemaining: remaining,
        summary: acknowledged === 0
          ? `No unread report on ${request.taskId} for this session.`
          : `Acknowledged ${String(acknowledged)} report(s) on ${request.taskId}. `
            + `${String(remaining)} unread remain for this session. `
            + 'The wait cursor, snapshot cursor and already-reported event list were not moved.',
      }
    }

    if (request.action === 'stop') {
      if (request.taskId === undefined) throw new Error('BAD_REQUEST: stopping a watch needs its taskId')
      const existing = current.getWatch(keyOf(request.taskId))
      const removed = existing?.watchEnabled === false ? false : await current.deleteWatch(keyOf(request.taskId))
      return {
        watches: activeWatches().map(describe),
        delivered: [],
        suppressed: 0,
        refusals: [],
        summary: removed
          ? `Stopped watching ${request.taskId}. Its reports stop here; the task itself is untouched.`
          : `No watch on ${request.taskId} was saved, so nothing was removed.`,
      }
    }

    // report: the pass the plugin also runs on its own.
    const disabledReport = lifecycle.refusal('a background report')
    if (disabledReport !== undefined) {
      return {
        watches: activeWatches().map(describe),
        delivered: [],
        suppressed: 0,
        refusals: [disabledReport],
        summary: disabledReport,
      }
    }
    const watches = activeWatches()
    const delivered: string[] = []
    const refusals: string[] = []
    let suppressed = 0
    const controller = (probeContext.get('agents') as ObservableAgentsLike | undefined)
      ?.get(request.controllerSessionId)

    /**
     * The facts each watch produced, kept **per watch** because the two halves need different shapes.
     *
     * Merging is per controller (PRD §二.8.1 merges "the same main session's" events within the window),
     * while the cursor and the delivered-id list belong to one watch — so the facts are gathered per
     * watch and merged across all of them. The previous shape merged a one-watch map inside the loop,
     * which made merging *unreachable*: a controller watching three tasks was woken three times inside
     * the window it was supposed to be woken once for.
     */
    const perWatch: { watch: WatchRecord; facts: ReportFact[]; pending: string | undefined;
      bindingId?: string | undefined; bindingVersion?: number | undefined; remoteSessionId?: string | undefined }[] = []

    for (const watch of watches) {
      const task = current.getTask(watch.taskId)
      if (task === undefined) {
        refusals.push(`${watch.taskId}: the task is no longer managed, so it cannot be observed`)
        continue
      }
      // PRD §二.5 / T15: releasing a task stops the monitoring that depended on that relationship.
      // Archiving does not — it is organisation only, so an active archived task still reports.
      const monitoring = observationContinues(current.getAccess(watch.taskId), task.archived)
      if (!monitoring.allowed) {
        refusals.push(monitoring.reason)
        continue
      }
      const watchedAccess = current.getAccess(watch.taskId)
      if (!watchedAccess || !mayRead(watchedAccess, request.controllerSessionId)) {
        refusals.push(`${watch.taskId}: this controller no longer has permission to observe the task`)
        continue
      }
      const binding = task.currentBindingId === undefined ? undefined : current.getBinding(task.currentBindingId)
      const isRemote = binding !== undefined && binding.hostId !== 'local' && binding.hostId !== configOf().bridge?.hostId
      const live = binding === undefined || isRemote
        ? undefined
        : (probeContext.get('agents') as ObservableAgentsLike | undefined)?.get(binding.sessionId)
      let remote: TaskObservation | undefined
      let remoteError: string | undefined
      if (isRemote) {
        try { remote = await remoteObservationOf(watch.taskId, request.controllerSessionId, watch.cursor) }
        catch (error) { remoteError = describeError(error) }
        const access = current.getAccess(watch.taskId)
        const latestBinding = current.getBinding(current.getTask(watch.taskId)?.currentBindingId ?? '')
        if (!access || !mayRead(access, request.controllerSessionId)
          || latestBinding?.bindingId !== binding?.bindingId || latestBinding?.version !== binding?.version) {
          refusals.push(`${watch.taskId}: observation permission or binding changed while reading the remote Host`)
          continue
        }
      }

      // The facts the **store** already holds: an artifact verified missing or changed, a transfer that
      // recorded conflicts, a governing budget that refuses, and a workflow run that stopped for the user.
      // PRD §二.8.1 lists all four, none is a session event, and until now nothing produced three of them —
      // `externalFact` had exactly one caller. They are read for a live target and for a dead one alike,
      // because a missing artifact stays missing whether or not its session is.
      const governing = budgetsGoverning(current, watch.taskId)
      const stored = storedFactsOf(
        { taskId: watch.taskId, sessionId: binding?.sessionId ?? '' },
        {
          artifacts: current.listArtifacts({ taskId: watch.taskId }).map(record => ({
            artifactId: record.artifactId,
            name: record.name,
            kind: record.kind,
            existence: record.existence,
            contentVersion: record.contentVersion,
            observedAt: record.verifiedAt ?? record.createdAt,
          })),
          // The store lists transfers by receiver only, and a conflict on either side of a handoff is
          // about the watched task, so the filter is applied here rather than narrowing the query.
          transfers: current.listTransfers()
            .filter(record => record.fromTaskId === watch.taskId || record.toTaskId === watch.taskId)
            .map(record => ({
              transferId: record.transferId,
              artifactId: record.artifactId,
              fromTaskId: record.fromTaskId,
              toTaskId: record.toTaskId,
              conflicts: record.conflicts,
              applied: record.applied,
              updatedAt: record.updatedAt,
            })),
          // The budget gate's **own** decision, not a second opinion: a notice that said "budget limited"
          // while `budgetPermits` was still permitting would be worse than no notice. `budgetPermits` is
          // not reused directly because the report needs the decision rather than the verdict, and the
          // two must be the same call.
          budgets: governing.flatMap(entry => {
            const ledger = ledgerOfRecord(current, entry.ledgerTargetId)
            const concurrent = entry.policy.maxConcurrent === undefined
              ? undefined
              : inFlightFor(current, entry.policy.scope, entry.ledgerTargetId)
            const decision = budgetDecision(
              entry.policy,
              concurrent === undefined ? ledger : { ...ledger, concurrent },
              now,
            )
            if (decision.within) return []
            return [{
              policyKey: entry.label,
              ...decision.limit === undefined ? {} : { limit: decision.limit },
              reason: decision.reason,
              ...ledger.firstDispatchedAt === undefined ? {} : { firstDispatchedAt: ledger.firstDispatchedAt },
              // The deadline is the one limit whose instant is knowable from the policy itself.
              ...decision.limit === 'deadline' && entry.policy.deadlineAt !== undefined
                ? { reachedAt: entry.policy.deadlineAt }
                : {},
            }]
          }),
          // A run is stuck **on this task** when it stopped for the user, or when one of its nodes is failed
          // or inconclusive. A run that is merely running or paused is not reported: calling "paused" 受阻
          // would invent a problem nobody has, and a `pending` node is a node that has not started yet.
          //
          // Which tasks a run drives comes from **the run's own fixed authorisations**, not from the
          // definition: a definition can be edited while a run is in flight, and attributing a notice
          // through a later definition would name a task the run never agreed to drive. A run recorded
          // before that field existed falls back to resolving its nodes through the saved definition —
          // which is the only other place the node-to-task association is written down.
          workflows: current.listWorkflowRuns().flatMap(run => {
            const taskIds = run.fixed === undefined
              ? (current.getWorkflow(run.workflowId)?.nodes ?? [])
                  .filter(node => run.nodes.some(entry => entry.nodeId === node.nodeId))
                  .map(node => node.taskId)
              : run.fixed.authorisations.map(entry => entry.taskId)
            if (!taskIds.includes(watch.taskId)) return []
            const problem = run.nodes.filter(node =>
              canonicalNodeState(node.state) === 'failed'
              || node.verdict?.result === 'inconclusive')
            if (run.status !== 'needs_user' && problem.length === 0) return []
            const named = run.status === 'needs_user'
              ? run.nodes.filter(node => {
                  const state = canonicalNodeState(node.state)
                  return state !== 'passed' && state !== 'cancelled'
                })
              : problem
            return [{
              runId: run.runId,
              workflowId: run.workflowId,
              status: run.status,
              blockedNodeIds: named.map(node => node.nodeId),
              updatedAt: run.updatedAt,
            }]
          }),
          nowMs,
        },
      ).filter(fact => !watch.deliveredEventIds.includes(fact.eventId))

      let facts: ReportFact[]
      let remotePageHasFreshFacts = false
      if (remote !== undefined) {
        const reportable = notableFactsOf({ taskId: watch.taskId, sessionId: remote.sessionId },
          remote.notable.filter(entry => entry.event.kind !== 'turn_ended' || !entry.reportTriggered))
        const fresh = reportable.filter(fact => !watch.deliveredEventIds.includes(fact.eventId))
        remotePageHasFreshFacts = fresh.length > 0
        suppressed += reportable.length - fresh.length
        facts = [...fresh, ...stored]
      } else if (live === undefined) {
        // A target that is not live is itself a fact worth reporting once: the
        // controller is waiting on work that cannot currently progress.
        const unavailable = externalFact({
          taskId: watch.taskId,
          sessionId: binding?.sessionId ?? '',
          eventId: `${watch.taskId}:unavailable:${binding?.bindingId ?? 'unbound'}:${watch.cursor}`,
          at: nowMs,
          kind: 'target_unavailable',
          summary: isRemote ? `the remote Host could not be observed: ${remoteError ?? 'no verified observation returned'}`
            : 'the session bound to this task is not live, so no progress can be observed',
        })
        const fresh = watch.deliveredEventIds.includes(unavailable.eventId) ? [] : [unavailable]
        facts = [...fresh, ...stored]
      } else {
        const events = live.session.events as readonly SessionEventLike[]
        const storedCursor = Number.parseInt(watch.cursor, 10)
        // Resuming from the watch's own cursor onto a fresh projection: a watch
        // persists only its cursor, so the accumulated state is rebuilt. The
        // delivered-id list, not the cursor, decides what counts as new.
        const { notable } = projectNotableAfter(
          { ...initialProjection(), cursor: Number.isFinite(storedCursor) ? storedCursor : -1 },
          events,
        )
        const reportable = notableFactsOf(
          { taskId: watch.taskId, sessionId: binding?.sessionId ?? '' },
          notable.filter(entry => entry.event.kind !== 'turn_ended'
            || !turnOriginOf(events.filter(event => event.seq <= entry.seq)).reportTriggered),
        )
        facts = reportable.filter(fact => !watch.deliveredEventIds.includes(fact.eventId))
        // Counted, not hidden: a fact suppressed because it was already reported
        // is the mechanism working, and a caller that cannot see it would mistake
        // "nothing new" for "the watch saw nothing".
        suppressed += reportable.length - facts.length
        facts = [...facts, ...stored]
      }

      // Fold the whole log for 待介入, not the cursor window: a watch that resumes
      // from its cursor would otherwise forget a question asked before that point.
      const pending = remote !== undefined ? pendingInterventionOf(remote.state.interaction) : live === undefined
        ? watch.pendingIntervention
        : pendingInterventionOf(
            projectEvents(initialProjection(), live.session.events as readonly SessionEventLike[]).state.interaction,
          )
      await persistPending(watch, pending)
      if (remote !== undefined && !remotePageHasFreshFacts) {
        const latest = current.getWatch(keyOf(watch.taskId))
        if (latest !== undefined) await current.putWatch(keyOf(watch.taskId), {
          ...latest, cursor: encodeObservationCursor(remote.sessionId, remote.throughSeq), updatedAt: now,
        })
      }
      if (facts.length > 0) perWatch.push({ watch, facts, pending, bindingId: binding?.bindingId,
        bindingVersion: binding?.version, remoteSessionId: remote?.sessionId })
    }

    // One merge across every watch, which is what makes §二.8.1's rule reachable: the constraint is on
    // the waking session, not on the target, so two tasks reporting inside the window are one notice.
    const reports = mergeReports(
      new Map([[request.controllerSessionId, perWatch.flatMap(entry => entry.facts)]]),
      configOf().noticeMergeWindowMs,
    )
    for (const report of reports) {
      const decision = deliveryFor(controller?.status ?? 'idle', report)
      if (decision === 'silent') continue
      const text = renderReport(report)
      // The report spans watches, so recording is split back per watch: the cursor and the delivered-id
      // list belong to one watch, and the report's facts are what each watch is credited with.
      const covered = perWatch
        .map(entry => ({
          watch: entry.watch,
          own: entry.facts.filter(fact => report.facts.some(merged => merged.eventId === fact.eventId)),
          pending: entry.pending,
          bindingId: entry.bindingId,
          bindingVersion: entry.bindingVersion,
          remoteSessionId: entry.remoteSessionId,
        }))
        .filter(entry => entry.own.length > 0)
      const kinds = [...new Set(report.facts.map(fact => fact.kind))].join(', ')
      /** Record the report against every watch it covers, with the outcome it actually had. */
      const record = async (delivery: NotificationRecord['delivery']): Promise<void> => {
        for (const entry of covered) {
          await recordReport(
            current,
            request.controllerSessionId,
            entry.watch,
            entry.own,
            now,
            nowMs,
            delivery,
            entry.pending,
            entry.remoteSessionId,
          )
        }
      }
      if (controller === undefined) {
        await record('failed')
        refusals.push(`${report.taskIds.join(', ')}: the controller session is not live, so the report could not `
          + `be delivered (${String(report.facts.length)} fact(s): ${kinds})`)
        continue
      }
      if (decision === 'wake') {
        const slots = coordinatorOf()?.occupiedSlots() ?? { target: 0, notice: 0 }
        const noticeRoom = admitPluginTurn({
          occupiedTargets: slots.target,
          occupiedNotices: slots.notice,
          targetLimit: configOf().targetTurnConcurrency,
          noticeLimit: configOf().noticeConcurrency,
          slot: 'notice',
        })
        if (!noticeRoom.admit) {
          refusals.push(`${report.taskIds.join(', ')}: ${noticeRoom.reason}`)
          continue
        }
      }
      const deliver = decision === 'wake' ? controller.steer : controller.followup
      if (typeof deliver !== 'function') {
        // Reported rather than silently dropped: a Host that cannot deliver here
        // means no report ever arrives, and a controller that believes it is being
        // watched would never learn otherwise.
        await record('failed')
        refusals.push(`${report.taskIds.join(', ')}: this Host exposes no message delivery on the controller's `
          + 'agent, so the report could not be delivered')
        continue
      }
      try {
        // A notice travels through the same Host primitives as any other message:
        // `steer` wakes an idle session, `followup` queues for a busy one and
        // never interrupts the turn in progress (PRD §二.8.1).
        const message = createUserMessage({
          content: [{ type: 'text', text }],
          source: noticeSource(text.slice(0, 100)),
        })
        // A crash after Host acceptance must not make a notice fresh again on restart.
        await record('unknown')
        const invalid = lifecycle.refusal('a background report') !== undefined || covered.some(entry => {
          const access = current.getAccess(entry.watch.taskId)
          const latest = current.getBinding(current.getTask(entry.watch.taskId)?.currentBindingId ?? '')
          return !access || !mayRead(access, request.controllerSessionId)
            || latest?.bindingId !== entry.bindingId || latest?.version !== entry.bindingVersion
        })
        if (invalid) {
          refusals.push(`${report.taskIds.join(', ')}: report withheld because permission, binding or plugin lifecycle changed`)
          continue
        }
        deliver.call(controller, message)
        await record('accepted')
        // PRD §二.13.2: 回报 counts into the run ledger. Counted once per delivered report,
        // against every task the notice covered, through the same writer dispatches use.
        for (const taskId of report.taskIds) {
          await countReportTurn(current, taskId, now)
        }
        // The kinds and the task count are part of the receipt: "1 report delivered" cannot tell a
        // caller whether a conflict was reported or a turn ended, and the two need different attention.
        delivered.push(`${report.taskIds.join(', ')}: ${decision === 'wake' ? 'woke' : 'queued for'} the controller `
          + `with ${String(report.facts.length)} fact(s) [${kinds}] over ${String(report.taskIds.length)} task(s)`)
      } catch (error) {
        await record('unknown')
        refusals.push(`${report.taskIds.join(', ')}: report delivery is unknown and needs reconciliation: ${describeError(error)}`)
      }
    }

    return {
      watches: activeWatches().map(describe),
      delivered,
      suppressed,
      refusals,
      summary: delivered.length === 0 && refusals.length === 0
        ? `Checked ${String(watches.length)} watch(es): nothing meaningful changed, so nothing was reported.`
          + (suppressed === 0 ? '' : ` ${String(suppressed)} already-reported fact(s) were suppressed.`)
        : `${String(delivered.length)} report(s) delivered, ${String(refusals.length)} refusal(s), `
          + `${String(suppressed)} duplicate fact(s) suppressed.\n`
          + [...delivered, ...refusals].map(line => `- ${line}`).join('\n'),
    }
  }

  /**
   * The access surface: observers and control transfer (PRD §二.10.1).
   *
   * Every change requires the caller to hold write control *at the epoch it believes
   * it holds*, which is what makes the freeze real rather than advisory: a transfer
   * increments the epoch, so the previous controller's next request is refused on the
   * existing check rather than by a rule written specifically for transfers.
   *
   * The transfer itself is one record write. The owner and the epoch change together
   * because two writes would leave a window in which the new owner holds control at
   * the old epoch — and in that window the previous controller's requests still pass,
   * which is precisely the race the sequence exists to prevent.
   *
   * @param request - what the caller asked for.
   * @returns the resulting relationship, and the snapshot on a transfer.
   */
  const accessOf = async (request: AccessToolRequest): Promise<AccessToolResult> => {
    const current = store
    if (current === undefined) throw new Error('NO_DURABLE_STATE: the conductor has no durable state')
    const now = new Date().toISOString()
    const record = current.getAccess(request.taskId)
    if (record === undefined) {
      throw new Error(`TASK_NOT_FOUND: no control record for task ${request.taskId}`)
    }

    const describe = (access: typeof record): AccessToolResult => ({
      taskId: access.taskId,
      ownerSessionId: access.ownerSessionId,
      ownerEpoch: access.ownerEpoch,
      observers: access.observerSessionIds,
      uncertain: [],
      changed: false,
      summary: `Task ${access.taskId}: write control ${access.ownerSessionId} at epoch ${String(access.ownerEpoch)}, `
        + `observers ${access.observerSessionIds.length === 0 ? 'none' : access.observerSessionIds.join(', ')}.`,
    })

    if (request.action === 'list') return describe(record)

    const throwIfStalePins = (): void => {
      const task = current.getTask(request.taskId)
      const binding = task?.currentBindingId === undefined
        ? undefined
        : current.getBinding(task.currentBindingId)
      const pin = mutationPinRefusal(
        record,
        binding === undefined ? undefined : { version: binding.version },
        {
          ...request.expectedOwnerEpoch === undefined ? {} : { expectedOwnerEpoch: request.expectedOwnerEpoch },
          ...request.expectedBindingVersion === undefined
            ? {}
            : { expectedBindingVersion: request.expectedBindingVersion },
        },
        request.taskId,
      )
      if (pin !== undefined) throw new Error(`${pin.code}: ${pin.reason}`)
    }

    // Releasing is checked before the shared guards below, because those refuse a task that is
    // already released — and this is the action that releases it. PRD §二.5: the task keeps its
    // record, its artifacts and its accepted input; what stops is the monitoring and the new
    // automatic actions that depended on the relationship.
    if (request.action === 'release') {
      if (record.ownerSessionId !== request.callerSessionId) {
        throw new Error(
          `NOT_CONTROLLER: session ${request.callerSessionId} does not hold write control of task ${request.taskId}, `
          + 'so it cannot release it',
        )
      }
      if (record.detachedAt !== undefined) {
        return {
          ...describe(record),
          summary: `Task ${request.taskId} was already released at ${record.detachedAt}; nothing changed. Its records, `
            + 'artifacts and accepted input are untouched.',
        }
      }
      throwIfStalePins()
      const released = await coordinatorOf()?.detachTask(request.taskId, request.callerSessionId)
      return {
        ...describe(released ?? record),
        summary: `Task ${request.taskId} is released from management. Monitoring that depended on the relationship has `
          + 'stopped and new automatic actions through it are blocked; the task record, its artifacts and anything '
          + 'already accepted are kept. Rejoining the task is how monitoring resumes — the release is not an archive '
          + 'and not a stop.',
      }
    }

    // Every other action changes the relationship, so the caller must be the
    // controller. An observer may read; it may not grant or move control.
    if (record.ownerSessionId !== request.callerSessionId) {
      throw new Error(
        `NOT_CONTROLLER: session ${request.callerSessionId} does not hold write control of task ${request.taskId}, `
        + `so it cannot change who does`,
      )
    }
    if (record.detachedAt !== undefined) {
      throw new Error(
        `NOT_MANAGED: task ${request.taskId} was released from management at ${record.detachedAt}`,
      )
    }
    throwIfStalePins()
    if (request.sessionId === undefined) {
      throw new Error(`BAD_REQUEST: ${request.action} needs the sessionId to act on`)
    }

    if (request.action === 'observe' || request.action === 'unobserve') {
      const outcome = request.action === 'observe'
        ? addObserver(record, request.sessionId, now)
        : removeObserver(record, request.sessionId, now)
      if (!outcome.changed) {
        return {
          ...describe(record),
          summary: request.action === 'observe'
            ? `${request.sessionId} is already an observer of ${request.taskId} (or is already its controller), so nothing changed.`
            : `${request.sessionId} was not an observer of ${request.taskId}, so there was nothing to revoke.`,
        }
      }
      const stored = await current.putAccess(outcome.access)
      return {
        ...describe(stored),
        changed: true,
        summary: request.action === 'observe'
          ? `${request.sessionId} may now read task ${request.taskId} and nothing more. Observers cannot send, stop, `
            + 'reorganise, hand over or schedule.'
          : `${request.sessionId} can no longer read task ${request.taskId}. Its own records and anything it already `
            + 'received are untouched.',
      }
    }

    // transfer
    const task = current.getTask(request.taskId)
    if (task === undefined) {
      throw new Error(`TASK_NOT_FOUND: no managed task ${request.taskId}`)
    }
    const operations = current.listOperations({ taskId: request.taskId })
    const plan = planTransfer({
      access: record,
      operations,
      to: request.sessionId,
      describeTask: () => {
        const bound = task.currentBindingId === undefined ? undefined : current.getBinding(task.currentBindingId)
        const artifacts = current.listArtifacts({ taskId: request.taskId })
        const summary = describeArtifactFactSummary(countArtifactDisplayFacts(artifacts))
        return `task ${task.taskId} "${task.title}" is ${task.preparation}/${task.preparationPhase}`
          + `${bound === undefined ? ' with no binding' : ` on session ${bound.sessionId} at binding version ${String(bound.version)}`}; `
          + `${summary}; `
          + `${String(current.listRules({ targetTaskId: request.taskId }).length)} rule(s) and `
          + `${String(current.listSchedules({ targetTaskId: request.taskId }).length)} schedule(s) target it`
      },
    })
    const stored = await current.putAccess(applyTransfer(record, plan, now))
    const receiver = (probeContext.get('agents') as ObservableAgentsLike | undefined)?.get(plan.to)
    const delivery = snapshotDeliveryPlan(receiver, plan.to)
    let snapshotDelivered = false
    let snapshotDelivery = delivery.kind === 'not_live' || delivery.kind === 'no_channel'
      ? delivery.reason
      : delivery.kind === 'wake'
        ? 'woke the new controller with the handover snapshot'
        : 'queued the handover snapshot for the new controller'
    if (delivery.kind === 'wake' || delivery.kind === 'queue') {
      const channel = delivery.kind === 'wake' ? receiver?.steer : receiver?.followup
      if (typeof channel === 'function' && receiver !== undefined) {
        try {
          const message = createUserMessage({
            content: [{ type: 'text', text: plan.snapshot }],
            source: noticeSource(plan.snapshot.slice(0, 100)),
          })
          channel.call(receiver, message)
          snapshotDelivered = true
        } catch (error) {
          snapshotDelivered = false
          snapshotDelivery = `delivering the handover snapshot failed: ${describeError(error)}`
        }
      }
    }
    return {
      taskId: stored.taskId,
      ownerSessionId: stored.ownerSessionId,
      ownerEpoch: stored.ownerEpoch,
      observers: stored.observerSessionIds,
      uncertain: plan.uncertain,
      snapshot: plan.snapshot,
      snapshotDelivered,
      snapshotDelivery,
      changed: true,
      summary: `Write control of ${stored.taskId} moved from ${plan.from} to ${plan.to} `
        + `(epoch ${String(record.ownerEpoch)} → ${String(stored.ownerEpoch)}). `
        + `${String(plan.operations.length)} operation(s) accounted for`
        + (plan.uncertain.length === 0
          ? '; none is uncertain.'
          : `; ${String(plan.uncertain.length)} is UNCERTAIN and must be reconciled, not resent: ${plan.uncertain.join(', ')}.`)
        + ' No rule, grant, schedule or budget was reset, and no report was replayed. '
        + (snapshotDelivered
          ? `The new controller received the handover snapshot (${snapshotDelivery}).`
          : `The new controller was not sent the snapshot: ${snapshotDelivery}`),
    }
  }

  /**
   * Reconcile the one terminal turn that belongs to an initial create/fork
   * instruction. This deliberately does **not** deliver a Host message to the
   * parent: the native creation card polls the durable result itself, so the
   * parent model neither wakes nor gains a new turn to act on.
   *
   * A normal Watch has a different purpose and remains opt-in. In particular,
   * this pass never uses a watch cursor, reads an entire task history for a
   * model, queues a message, or interprets a later child turn as a continuation
   * of the original delegation.
   *
   * @returns a compact account of the callbacks this pass observed.
   */
  const runCompletionReturns = async (): Promise<string> => {
    const current = store
    if (current === undefined) return 'completion returns: no durable state'
    const candidates = current.listTasks().filter(task => {
      const callback = task.completionReturn
      return callback !== undefined && callback.phase !== 'returned' && callback.phase !== 'delivery_failed'
    })
    let returned = 0
    let running = 0
    let waiting = 0
    let unknown = 0
    let unavailable = 0
    let withheld = 0

    const sameCallback = (left: CompletionReturnCallback, right: CompletionReturnCallback): boolean =>
      left.operationId === right.operationId
      && left.bindingId === right.bindingId
      && left.bindingVersion === right.bindingVersion
      && left.messageId === right.messageId

    // The identity fields fence one callback from another.  The full state is
    // also compared at the final write boundary: coordinator delivery recovery
    // can update the same callback while a cold history read is outstanding.
    const sameCallbackState = (left: CompletionReturnCallback, right: CompletionReturnCallback): boolean =>
      sameCallback(left, right)
      && left.phase === right.phase
      && left.armedAt === right.armedAt
      && left.messageSeq === right.messageSeq
      && left.turn === right.turn
      && left.startSeq === right.startSeq
      && left.endSeq === right.endSeq
      && left.outcome === right.outcome
      && left.detail === right.detail
      && left.preview === right.preview
      && left.completedAt === right.completedAt
      && left.reason === right.reason
      && left.updatedAt === right.updatedAt

    /**
     * The callback is not a general "inspect this task" permission.  It must
     * still be owned by the exact instructed create/fork operation that wrote
     * the relay id.  Invalid, old, or corrupted rows fail closed before any
     * child Agent or detached history service is touched.
     */
    const completionRelationOf = (task: TaskRecord, callback: CompletionReturnCallback) => {
      const operation = current.getOperation(callback.operationId)
      if (operation === undefined || operation.operationId !== callback.operationId
        || (operation.kind !== 'create' && operation.kind !== 'fork')
        || operation.taskId !== task.taskId || operation.messageId !== callback.messageId) return undefined
      const parameters = operation.params
      if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) return undefined
      const instruction = (parameters as { instruction?: unknown }).instruction
      if (typeof instruction !== 'string' || instruction.length === 0) return undefined
      const guard = operation.dispatchGuard
      if (guard === undefined || guard.bindingVersion !== callback.bindingVersion
        || typeof guard.ownerSessionId !== 'string' || guard.ownerSessionId.length === 0) return undefined
      return { operation, originSessionId: guard.ownerSessionId }
    }

    /** The initial binding remains authoritative even when the task later moves. */
    const exactBindingOf = (task: TaskRecord, callback: CompletionReturnCallback) => {
      const binding = current.getBinding(callback.bindingId)
      return binding === undefined || binding.taskId !== task.taskId || binding.version !== callback.bindingVersion
        ? undefined
        : binding
    }

    for (const candidate of candidates) {
      await current.withExclusive(`completion-return:${candidate.taskId}`, async () => {
        if (!lifecycle.active) return
        const task = current.getTask(candidate.taskId)
        const callback = task?.completionReturn
        if (task === undefined || callback === undefined || callback.phase === 'returned' || callback.phase === 'delivery_failed') return
        const relation = completionRelationOf(task, callback)
        if (relation === undefined) {
          unavailable += 1
          return
        }
        // Do not use the mutable task controller after a control transfer. The
        // create/fork dispatch guard owns the card in the original parent chat.
        const originSessionId = relation.originSessionId
        const access = current.getAccess(task.taskId)
        if (access === undefined || !mayRead(access, originSessionId) || !monitoringAllowed(access).allowed) {
          // Never inspect a child log merely because a former parent created it,
          // or after the management relationship that permits observation ended.
          // A future explicit grant or rejoin can make the same untouched callback
          // readable again; the route also withholds every completion field when
          // read permission itself is gone.
          withheld += 1
          return
        }
        const binding = exactBindingOf(task, callback)
        if (binding === undefined) {
          unavailable += 1
          return
        }
        const remote = binding.hostId !== 'local' && binding.hostId !== configOf().bridge?.hostId
        if (remote) {
          // Remote observation intentionally exposes a compact projection, not
          // the exact public message id required by this one-shot protocol.
          // Do not approximate it from a later remote turn.
          unavailable += 1
          return
        }

        let events: readonly SessionEventLike[]
        const live = (probeContext.get('agents') as ObservableAgentsLike | undefined)?.get(binding.sessionId)
        if (live?.session?.events !== undefined) {
          events = live.session.events
        } else {
          try {
            // This is the Host's detached public history API. It is the only
            // cold-session fallback; no private JSONL or Agent restoration is used.
            events = (await readPersistedSessionOf(binding.sessionId)).events
          } catch {
            unavailable += 1
            return
          }
        }

        // Disabling cannot cancel every Host-owned cold read, but it must fence
        // its late result before it becomes a new durable card projection.
        if (!lifecycle.active) return

        // Reads above can be asynchronous. Re-check both authority and the exact
        // initial binding before a durable card update so a transfer/revocation
        // cannot turn an old observation into a new parent's result.
        const latestTask = current.getTask(task.taskId)
        const latest = latestTask?.completionReturn
        const latestAccess = current.getAccess(task.taskId)
        const latestRelation = latestTask === undefined || latest === undefined
          ? undefined
          : completionRelationOf(latestTask, latest)
        const latestBinding = latestTask === undefined || latest === undefined
          ? undefined
          : exactBindingOf(latestTask, latest)
        if (latestTask === undefined || latest === undefined || latest.phase === 'returned' || latest.phase === 'delivery_failed'
          || !sameCallback(callback, latest) || latestRelation === undefined || latestRelation.originSessionId !== originSessionId
          || latestAccess === undefined || !mayRead(latestAccess, originSessionId)
          || !monitoringAllowed(latestAccess).allowed) {
          withheld += 1
          return
        }
        if (latestBinding === undefined) {
          unavailable += 1
          return
        }

        // Access and binding commits share this lock.  Re-read every authority
        // fact inside it, then compare the whole callback in the task write, so
        // a revocation, migration, or delivery reconciliation cannot land in
        // the gap between the cold read and the card projection.
        let accounted: CompletionReturnCallback | undefined
        await current.withExclusive(`control-commit:${task.taskId}`, async () => {
          if (!lifecycle.active) return
          const committedTask = current.getTask(task.taskId)
          const committed = committedTask?.completionReturn
          if (committedTask === undefined || committed === undefined || committed.phase === 'returned' || committed.phase === 'delivery_failed'
            || !sameCallback(callback, committed)) {
            withheld += 1
            return
          }
          const committedRelation = completionRelationOf(committedTask, committed)
          if (committedRelation === undefined || committedRelation.originSessionId !== originSessionId) {
            unavailable += 1
            return
          }
          const committedAccess = current.getAccess(committedTask.taskId)
          if (committedAccess === undefined || !mayRead(committedAccess, originSessionId)
            || !monitoringAllowed(committedAccess).allowed) {
            withheld += 1
            return
          }
          const committedBinding = exactBindingOf(committedTask, committed)
          if (committedBinding === undefined) {
            unavailable += 1
            return
          }
          const committedRemote = committedBinding.hostId !== 'local' && committedBinding.hostId !== configOf().bridge?.hostId
          if (committedRemote) {
            unavailable += 1
            return
          }

          const observation = resolveCompletionReturn(committed, events)
          const hasHostEvidence = observation.messageSeq !== undefined || observation.initialTurn !== undefined || observation.terminal !== undefined
          let next = observation.record
          if (!hasHostEvidence && observation.status === 'waiting' && committedRelation.operation.delivery === 'failed') {
            next = {
              ...next,
              phase: 'delivery_failed',
              reason: committedRelation.operation.phase ?? 'the initial instruction was refused before the Host accepted it',
            }
          } else if (!hasHostEvidence && observation.status === 'waiting' && committedRelation.operation.delivery === 'unknown') {
            next = {
              ...next,
              phase: 'delivery_unknown',
              reason: committedRelation.operation.phase ?? 'the initial instruction delivery could not be confirmed',
            }
          }
          const deliveryChanged = next.phase !== committed.phase || next.reason !== committed.reason
          if (observation.changed || deliveryChanged) {
            const expected = { ...next, updatedAt: new Date().toISOString() }
            const stored = await current.updateTask(task.taskId, row => {
              const actual = row.completionReturn
              if (actual === undefined || actual.phase === 'returned' || actual.phase === 'delivery_failed'
                || !sameCallbackState(committed, actual)) return row
              return { ...row, completionReturn: expected }
            })
            if (stored.completionReturn === undefined || !sameCallbackState(stored.completionReturn, expected)) return
            accounted = stored.completionReturn
            return
          }
          accounted = committed
        })
        if (accounted === undefined) return
        if (accounted.phase === 'returned') {
          returned += 1
        } else if (accounted.phase === 'running') {
          running += 1
        } else if (accounted.phase === 'delivery_unknown') {
          unknown += 1
        } else if (accounted.phase === 'delivery_failed') {
          unavailable += 1
        } else {
          waiting += 1
        }
      })
    }
    if (candidates.length === 0) return 'completion returns: none armed'
    return `completion returns: ${String(returned)} returned, ${String(running)} running, ${String(waiting)} waiting, `
      + `${String(unknown)} delivery-unknown, ${String(unavailable)} unavailable, ${String(withheld)} withheld`
  }

  /**
   * Run the conductor's own scheduling and reporting pass (PRD §二.8.1, §二.11).
   *
   * Automatic reporting and scheduled checks cannot happen on demand, so this is what
   * makes both of them real rather than features that only run when a tool happens to
   * ask. It is deliberately quiet: a pass that has nothing to say reports that it had
   * nothing to say. Every failure is returned as text rather than thrown, because the
   * loop above it must survive a bad pass.
   *
   * The two halves are independent on purpose — a schedule tick that fails must not
   * stop the reports, and the reverse — so each is caught separately.
   *
   * @returns a one-line account of what the pass did.
   */
  const runPass = async (): Promise<string> => {
    if (!lifecycle.active) return PLUGIN_DISABLED_ACCOUNT
    const current = store
    if (current === undefined) return 'no durable state, so nothing to schedule or report'
    const parts: string[] = []

    try {
      if (!lifecycle.active) {
        parts.push(PLUGIN_DISABLED_ACCOUNT)
        return parts.join('; ')
      }
      const ticked = await scheduleOf({ action: 'tick' })
      parts.push(`schedules: ${String(ticked.runs.length)} occurrence(s), ${String(ticked.refusals.length)} refusal(s)`)
    } catch (error) {
      parts.push(`schedules failed: ${describeError(error)}`)
    }

    try {
      if (!lifecycle.active) {
        parts.push(PLUGIN_DISABLED_ACCOUNT)
        return parts.join('; ')
      }
      parts.push(await runCompletionReturns())
      if (store !== undefined) parts.push(await reconcileFollowupReturns({
        store, active: () => lifecycle.active, localHostId: configOf().bridge?.hostId ?? 'local',
        readEvents: async sessionId => {
          const live = (probeContext.get('agents') as ObservableAgentsLike | undefined)?.get(sessionId)
          return live?.session?.events ?? (await readPersistedSessionOf(sessionId)).events
        },
      }))
    } catch (error) {
      parts.push(`completion returns failed: ${describeError(error)}`)
    }

    try {
      if (!lifecycle.active) {
        parts.push(PLUGIN_DISABLED_ACCOUNT)
        return parts.join('; ')
      }
      // Every controller that watches anything, not one caller's watches: the pass has
      // no caller, and a watch it skipped would be a watch that never reports.
      const controllers = [...new Set(current.listEveryWatch().map(record => record.controllerSessionId))]
      let delivered = 0
      let refusals = 0
      for (const controllerSessionId of controllers) {
        const reported = await watchOf({ action: 'report', controllerSessionId })
        delivered += reported.delivered.length
        refusals += reported.refusals.length
      }
      parts.push(
        controllers.length === 0
          ? 'reports: nobody is watching anything'
          : `reports: ${String(delivered)} delivered to ${String(controllers.length)} watcher(s), ${String(refusals)} refusal(s)`,
      )
    } catch (error) {
      parts.push(`reports failed: ${describeError(error)}`)
    }

    try {
      if (!lifecycle.active) {
        parts.push(PLUGIN_DISABLED_ACCOUNT)
        return parts.join('; ')
      }
      // The rule executor, on its own. PRD §二.8.2 requires a saved one-time rule to be executed by an
      // **independent executor** when its trigger happens — "规则由独立执行器执行，不依赖回报模型自行决定下一步"
      // — and until this half existed the executor was only ever reached by `conductor_rule evaluate`, so a
      // rule fired only if somebody asked. The comment on `dispatchRulesFor` claimed "the same executor an
      // automatic watcher will use"; this is that watcher.
      //
      // It goes through the **same** `dispatchRulesFor` as the tool action and the acceptance path rather
      // than a fourth implementation: the firing identity, the execution count and §四.2's attribution all
      // live there, and a second dispatch path is a second place for them to be got wrong.
      const rules = current.listRules({ active: true })
      const sources = [...new Set(rules.map(rule => rule.sourceTaskId))]
      let fired = 0
      let unreachable = 0
      const refused: string[] = []
      for (const sourceTaskId of sources) {
        const own = rules.filter(rule => rule.sourceTaskId === sourceTaskId)
        const outcome = await dispatchRulesFor(current, sourceTaskId, own, new Date().toISOString(), [])
        fired += outcome.dispatches.length
        for (const refusal of outcome.refusals) {
          // A source whose session is not live is counted rather than listed every pass: it is a fact about
          // the environment that does not change between passes, and a pass account that grew without bound
          // would bury the refusals that are new.
          if (/is not live, so its events cannot be read/.test(refusal)) unreachable += 1
          else refused.push(refusal)
        }
      }
      parts.push(
        sources.length === 0
          ? 'rules: none are saved'
          : `rules: ${String(fired)} fired of ${String(sources.length)} source(s)`
            + (unreachable === 0 ? '' : `, ${String(unreachable)} source(s) not live`)
            + (refused.length === 0 ? '' : `, ${String(refused.length)} refusal(s): ${refused.slice(0, 3).join('; ')}`),
      )
    } catch (error) {
      parts.push(`rules failed: ${describeError(error)}`)
    }

    try {
      if (!lifecycle.active) {
        parts.push(PLUGIN_DISABLED_ACCOUNT)
        return parts.join('; ')
      }
      const enforced = await enforceReachedBudgetCancels(current, new Date().toISOString())
      parts.push(
        enforced.notes.length === 0
          ? 'budget cancels: none'
          : `budget cancels: ${enforced.notes.join('; ')}`,
      )
    } catch (error) {
      parts.push(`budget cancels failed: ${describeError(error)}`)
    }

    try {
      if (!lifecycle.active) {
        parts.push(PLUGIN_DISABLED_ACCOUNT)
        return parts.join('; ')
      }
      const flushed = await coordinatorOf()?.flushPendingDispatches() ?? 0
      parts.push(
        flushed === 0
          ? 'pending sends: none dispatched'
          : `pending sends: ${String(flushed)} dispatched`,
      )
    } catch (error) {
      parts.push(`pending sends failed: ${describeError(error)}`)
    }

    return parts.join('; ')
  }

  /**
   * The workflow surface (PRD §二.12).
   *
   * The decisions all live in `service/workflow.ts`; this is the part that touches the
   * store and the Host. Two things are deliberate:
   *
   * - **A run freezes a definition version.** `start` records `version`. `drive` compares
   *   the live definition's version against that number and stops rather than dispatching
   *   a later body — the store overwrites the definition, so the frozen body is not
   *   retrievable after a save. An approval is bound to the node's instruction, inputs,
   *   acceptance rule and that version; expanding any of them cannot reuse it.
   * - **`drive` dispatches through the ordinary send path.** A node's instruction goes
   *   out with a deterministic operation id (`workflow-<runId>-<nodeId>-<attempt>`), so
   *   a repeated drive is a replay rather than a second instruction — the same
   *   mechanism the rule executor and the scheduler use, rather than a third one.
   *
   * @param request - what the caller asked for.
   * @returns the definitions and runs as they stand, with what the call did.
   */
  const workflowOf = async (request: WorkflowToolRequest): Promise<WorkflowToolResult> => {
    const current = store
    if (current === undefined) throw new Error('NO_DURABLE_STATE: the conductor has no durable state')
    const now = new Date().toISOString()
    const actions: string[] = []
    const problems: string[] = []

    const describeDefinitions = (workflowId?: string): WorkflowToolResult['workflows'] =>
      (workflowId === undefined
        ? current.listWorkflows()
        : [current.getWorkflow(workflowId)].filter(entry => entry !== undefined))
        .map(record => definitionViewOf(definitionOf(record), record.status))
    const describeRuns = (runId?: string): WorkflowToolResult['runs'] =>
      (runId === undefined ? current.listWorkflowRuns() : [current.getWorkflowRun(runId)].filter(entry => entry !== undefined))
        .map(record => {
          const saved = current.getWorkflow(record.workflowId)
          const frozen = record.fixed?.graph !== undefined
          const executed = saved === undefined ? undefined : definitionForRun(record, saved)
          return runViewOf(runShapeOf(record), executed, {
            frozen,
            ...record.sourceRunId === undefined ? {} : { sourceRunId: record.sourceRunId },
          })
        })

    /**
     * Resolve a stored definition as a pure `WorkflowDefinition`.
     *
     * Copied field by field rather than passed through: the stored record is mutable
     * data validated by zod, while the pure type is readonly, and a spread would let a
     * decision read a record that something else is still holding a reference to.
     */
    const definitionOf = (record: WorkflowRecord): WorkflowDefinition => ({
      workflowId: record.workflowId,
      title: record.title,
      version: record.version,
      nodes: record.nodes.map(node => ({
        nodeId: node.nodeId,
        taskId: node.taskId,
        ...node.dependsOn === undefined ? {} : { dependsOn: [...node.dependsOn] },
        ...node.inputArtifacts === undefined ? {} : { inputArtifacts: [...node.inputArtifacts] },
        ...node.instruction === undefined ? {} : { instruction: node.instruction },
        ...node.acceptance === undefined ? {} : { acceptance: node.acceptance },
        ...node.failure === undefined ? {} : { failure: { ...node.failure } },
        ...node.requiresApproval === undefined ? {} : { requiresApproval: node.requiresApproval },
      })),
      ...record.rework === undefined ? {} : { rework: { ...record.rework } },
      ...record.budget === undefined ? {} : { budget: { ...record.budget } },
    })

    /** Resolve a stored freeze into the pure shape the decisions work on. */
    const fixedShapeOf = (fixed: NonNullable<WorkflowRunRecord['fixed']>): RunFixed => ({
      definitionVersion: fixed.definitionVersion,
      authorisations: fixed.authorisations.map(entry => ({ ...entry })),
      constraints: fixed.constraints.map(entry => ({ ...entry })),
      artifacts: fixed.artifacts.map(entry => ({ ...entry })),
      acceptance: fixed.acceptance.map(entry => ({ ...entry })),
      ...fixed.budget === undefined ? {} : { budget: fixed.budget },
      ...fixed.failure === undefined ? {} : {
        failure: fixed.failure.map(entry => ({
          nodeId: entry.nodeId,
          onFail: entry.onFail,
          ...entry.retries === undefined ? {} : { retries: entry.retries },
        })),
      },
      ...fixed.graph === undefined ? {} : {
        graph: fixed.graph.map(node => ({
          nodeId: node.nodeId,
          taskId: node.taskId,
          ...node.dependsOn === undefined ? {} : { dependsOn: [...node.dependsOn] },
          ...node.inputArtifacts === undefined ? {} : { inputArtifacts: [...node.inputArtifacts] },
          ...node.instruction === undefined ? {} : { instruction: node.instruction },
          ...node.acceptance === undefined ? {} : { acceptance: node.acceptance },
          ...node.failure === undefined ? {} : { failure: { ...node.failure } },
          ...node.requiresApproval === undefined ? {} : { requiresApproval: node.requiresApproval },
        })),
      },
      ...fixed.title === undefined ? {} : { title: fixed.title },
      ...fixed.rework === undefined ? {} : { rework: { ...fixed.rework } },
      ...fixed.budgetLimit === undefined ? {} : { budgetLimit: { ...fixed.budgetLimit } },
    })

    /**
     * The definition a run executes: the graph it snapshotted at start when
     * present, otherwise the live saved body (PRD §三.3).
     */
    const definitionForRun = (
      run: WorkflowRunRecord,
      saved: WorkflowRecord,
    ): WorkflowDefinition => (
      run.fixed === undefined
        ? definitionOf(saved)
        : (definitionFromFixed(run.workflowId, fixedShapeOf(run.fixed), saved.title) ?? definitionOf(saved))
    )

    /** Resolve a stored run into the pure shape the decisions work on. */
    const runShapeOf = (record: WorkflowRunRecord): WorkflowRun => ({
      runId: record.runId,
      workflowId: record.workflowId,
      definitionVersion: record.definitionVersion,
      status: record.status,
      reworkRoundsUsed: record.reworkRoundsUsed,
      reworkHistory: record.reworkHistory.map(round => [...round]),
      nodes: record.nodes.map(node => ({
        nodeId: node.nodeId,
        state: canonicalNodeState(node.state),
        attempts: node.attempts,
        ...node.turnsUsed === undefined ? {} : { turnsUsed: node.turnsUsed },
        // Carried through, because this projection is what the start gate reads: dropping them here
        // made a recorded approval invisible to `drive`, so the node it permitted could never start
        // and a second approval looked like a first one.
        ...node.approvedBy === undefined ? {} : { approvedBy: node.approvedBy },
        ...node.approvedAt === undefined ? {} : { approvedAt: node.approvedAt },
        ...node.approvedBinding === undefined ? {} : { approvedBinding: node.approvedBinding },
        ...node.verdict === undefined ? {} : {
          verdict: {
            result: node.verdict.result,
            by: node.verdict.by,
            at: node.verdict.at,
            ...node.verdict.command === undefined ? {} : { command: node.verdict.command },
            ...node.verdict.output === undefined ? {} : { output: node.verdict.output },
            ...node.verdict.evidence === undefined ? {} : { evidence: [...node.verdict.evidence] },
          },
        },
      })),
    })

    const finish = (
      summary: string,
      listing?: {
        readonly workflows?: WorkflowToolResult['workflows']
        readonly runs?: WorkflowToolResult['runs']
      },
    ): WorkflowToolResult => ({
      workflows: listing?.workflows ?? describeDefinitions(),
      runs: listing?.runs ?? describeRuns(),
      actions,
      problems,
      summary,
    })

    if (request.action === 'read') {
      if (request.runId !== undefined) {
        const record = current.getWorkflowRun(request.runId)
        if (record === undefined) throw new Error(`NOT_FOUND: no workflow run ${request.runId}`)
        const saved = current.getWorkflow(record.workflowId)
        const frozen = record.fixed?.graph !== undefined
        return finish(
          `Run ${record.runId} of ${record.workflowId} is ${record.status} at definition version `
            + `${String(record.definitionVersion)}`
            + (frozen
              ? ', executing the graph snapshotted at start'
              : ', with no snapshotted graph (a later save would stop this run rather than rewrite it)')
            + '. Runtime model configuration: '
            + (record.fixed?.modelConfigurations === undefined ? 'not frozen; this legacy run cannot start new nodes.'
              : record.fixed.modelConfigurations.map(pin => `${pin.nodeId}=${pin.selection.provider}/${pin.selection.model}${pin.selection.reasoningEffort === undefined ? '' : ` (${pin.selection.reasoningEffort})`}`).join(', ')),
          {
            workflows: saved === undefined ? [] : describeDefinitions(record.workflowId),
            runs: describeRuns(record.runId),
          },
        )
      }
      if (request.workflowId !== undefined) {
        const record = current.getWorkflow(request.workflowId)
        if (record === undefined) throw new Error(`NOT_FOUND: no workflow ${request.workflowId} is saved`)
        const runs = current.listWorkflowRuns({ workflowId: record.workflowId })
        return finish(
          `Workflow ${record.workflowId} is ${record.status} at version ${String(record.version)}, `
            + `with ${String(record.nodes.length)} node(s) and ${String(runs.length)} run(s).`,
          {
            workflows: describeDefinitions(record.workflowId),
            runs: runs.map(entry => describeRuns(entry.runId)[0]).filter(entry => entry !== undefined),
          },
        )
      }
      const workflows = describeDefinitions()
      const runs = describeRuns()
      return finish(
        workflows.length === 0
          ? 'No workflows are saved.'
          : `${String(workflows.length)} workflow(s) and ${String(runs.length)} run(s).`,
        { workflows, runs },
      )
    }

    if (request.action === 'validate' || request.action === 'save') {
      const input = request.definition
      if (input === undefined) throw new Error(`BAD_REQUEST: ${request.action} needs the definition`)
      const candidate: WorkflowDefinition = {
        workflowId: request.workflowId ?? input.workflowId ?? `workflow-${randomUUID()}`,
        title: input.title ?? 'untitled workflow',
        version: (current.getWorkflow(request.workflowId ?? input.workflowId ?? '')?.version ?? -1) + 1,
        nodes: (input.nodes ?? []).map(node => ({
          nodeId: node.nodeId,
          taskId: node.taskId,
          ...node.dependsOn === undefined ? {} : { dependsOn: node.dependsOn },
          ...node.inputArtifacts === undefined ? {} : { inputArtifacts: node.inputArtifacts },
          ...node.instruction === undefined ? {} : { instruction: node.instruction },
          ...node.acceptance === undefined ? {} : { acceptance: node.acceptance },
          // PRD §二.12 lists 失败处理 as one of the seven things a definition contains, so it is
          // carried instead of dropped: a definition that silently loses the failure policy it was
          // saved with is a definition nobody can rely on.
          ...node.failure === undefined || node.failure.onFail === undefined
            ? {}
            : {
                failure: {
                  onFail: node.failure.onFail,
                  ...node.failure.retries === undefined ? {} : { retries: node.failure.retries },
                },
              },
          ...node.requiresApproval === undefined ? {} : { requiresApproval: node.requiresApproval },
        })),
        // The published default is two rounds, but it is the live setting rather than a
        // literal so changing `reworkRounds` is what later readers see.
        ...input.rework === undefined || input.rework.maxRounds === undefined
          ? { rework: { maxRounds: configOf().reworkRounds } }
          : { rework: { maxRounds: input.rework.maxRounds } },
        // And 预算 is the seventh: it is what condition 5 ("并发及预算允许") reads. Dropping it here
        // left that condition permanently open, because the fact it consults was always undefined.
        ...input.budget === undefined ? {} : {
          budget: {
            ...input.budget.maxTurns === undefined ? {} : { maxTurns: input.budget.maxTurns },
            ...input.budget.maxTokens === undefined ? {} : { maxTokens: input.budget.maxTokens },
            ...input.budget.maxConcurrent === undefined ? {} : { maxConcurrent: input.budget.maxConcurrent },
          },
        },
      }
      const checked = validateDefinition(candidate)
      if (!checked.ok) {
        for (const problem of checked.problems) problems.push(`${problem.code}: ${problem.message}`)
        return finish(`${String(checked.problems.length)} problem(s); the definition was not saved.`)
      }
      if (request.action === 'validate') {
        return finish(`The definition is valid: ${String(checked.order.length)} node(s) in order ${checked.order.join(' → ')}. Nothing was saved.`)
      }
      for (const node of candidate.nodes) {
        const refusal = writeControlRefusal(current.getAccess(node.taskId), node.taskId, request.authorizedBy)
        if (refusal !== undefined) problems.push(`${refusal.code}: ${refusal.reason} (node ${node.nodeId})`)
      }
      if (problems.length > 0) {
        return finish(`${String(problems.length)} control problem(s); the definition was not saved.`)
      }
      const saved = await current.putWorkflow({
        workflowId: candidate.workflowId,
        title: candidate.title,
        version: candidate.version,
        nodes: candidate.nodes.map(node => ({
          nodeId: node.nodeId,
          taskId: node.taskId,
          // The pure definition type is readonly; the stored record is not. Copied
          // element by element rather than spread, so a caller's later mutation of the
          // array it passed cannot reach into what was saved.
          ...node.dependsOn === undefined ? {} : { dependsOn: [...node.dependsOn] },
          ...node.inputArtifacts === undefined ? {} : { inputArtifacts: [...node.inputArtifacts] },
          ...node.instruction === undefined ? {} : { instruction: node.instruction },
          ...node.acceptance === undefined ? {} : { acceptance: node.acceptance },
          ...node.failure === undefined ? {} : { failure: { ...node.failure } },
          ...node.requiresApproval === undefined ? {} : { requiresApproval: node.requiresApproval },
        })),
        ...candidate.rework === undefined ? {} : { rework: candidate.rework },
        ...candidate.budget === undefined ? {} : { budget: candidate.budget },
        status: 'active',
        authorizedBy: request.authorizedBy,
        createdAt: now,
        updatedAt: now,
      })
      actions.push(`saved ${saved.workflowId} version ${String(saved.version)}`)
      return finish(`Saved ${saved.workflowId} as version ${String(saved.version)}. A run started now fixes that version.`)
    }

    if (request.action === 'start') {
      if (request.workflowId === undefined) throw new Error('BAD_REQUEST: starting a workflow needs its workflowId')
      const record = current.getWorkflow(request.workflowId)
      if (record === undefined) throw new Error(`NOT_FOUND: no workflow ${request.workflowId} is saved`)
      if (record.status !== 'active') throw new Error(`NOT_READY: workflow ${record.workflowId} is ${record.status}`)
      const checked = validateDefinition(definitionOf(record))
      if (!checked.ok) {
        for (const problem of checked.problems) problems.push(`${problem.code}: ${problem.message}`)
        return finish('The saved definition is no longer valid, so no run was started.')
      }
      for (const node of record.nodes) {
        const refusal = writeControlRefusal(current.getAccess(node.taskId), node.taskId, request.authorizedBy)
        if (refusal !== undefined) problems.push(`${refusal.code}: ${refusal.reason} (node ${node.nodeId})`)
      }
      if (problems.length > 0) {
        return finish(`${String(problems.length)} control problem(s); no run was started.`)
      }
      let fixedModels: NonNullable<NonNullable<WorkflowRunRecord['fixed']>['modelConfigurations']>
      try {
        fixedModels = await freezeWorkflowModels(current, record.nodes, modelSelectionReaderOf(probeContext.get(MODEL_SELECTION_WRITER_SERVICE)))
      } catch (error) {
        problems.push(describeError(error))
        return finish('No run started: its runtime configuration could not be frozen.')
      }
      for (const node of record.nodes) throwUnlessController(node.taskId, request.authorizedBy)
      const runId = `run-${randomUUID()}`
      // PRD §三.3's six fixed things, captured **here** rather than read as the run goes: a run that
      // read them live would silently adopt a later edit — a constraint rewritten mid-flight, an
      // input artifact replaced, control of a task transferred, a budget tightened.
      const fixedAuthorisations = record.nodes.flatMap(node => {
        const access = current.getAccess(node.taskId)
        return access === undefined
          ? []
          : [{ taskId: node.taskId, ownerSessionId: access.ownerSessionId, ownerEpoch: access.ownerEpoch }]
      })
      const fixedConstraints = current.listConstraints({}).map(constraint => ({
        constraintId: constraint.constraintId,
        version: constraint.version,
      }))
      const fixedArtifacts = record.nodes.flatMap(node => (node.inputArtifacts ?? []).flatMap(artifactId => {
        const artifact = current.getArtifact(artifactId)
        return artifact === undefined ? [] : [{ artifactId, contentVersion: artifact.contentVersion }]
      }))
      const fixedAcceptance = record.nodes.map(node => ({ nodeId: node.nodeId, rule: node.acceptance ?? '' }))
      const fixedBudget = budgetPolicyText(record.budget)
      const fixedFailure = record.nodes.flatMap(node => {
        if (node.failure?.onFail === undefined) return []
        return [{
          nodeId: node.nodeId,
          onFail: node.failure.onFail,
          ...node.failure.retries === undefined ? {} : { retries: node.failure.retries },
        }]
      })
      const started = await current.putWorkflowRun({
        runId,
        workflowId: record.workflowId,
        definitionVersion: record.version,
        status: 'running',
        reworkRoundsUsed: 0,
        reworkHistory: [],
        // Every node is created `blocked` from the definition's own node list, so a
        // node added to the definition later is not silently part of this run.
        nodes: record.nodes.map(node => ({ nodeId: node.nodeId, state: 'blocked' as const, attempts: 0 })),
        fixed: {
          definitionVersion: record.version,
          modelConfigurations: fixedModels,
          authorisations: fixedAuthorisations,
          constraints: fixedConstraints,
          artifacts: fixedArtifacts,
          acceptance: fixedAcceptance,
          ...fixedBudget === undefined ? {} : { budget: fixedBudget },
          ...fixedFailure.length === 0 ? {} : { failure: fixedFailure },
          graph: record.nodes.map(node => ({
            nodeId: node.nodeId,
            taskId: node.taskId,
            ...node.dependsOn === undefined ? {} : { dependsOn: [...node.dependsOn] },
            ...node.inputArtifacts === undefined ? {} : { inputArtifacts: [...node.inputArtifacts] },
            ...node.instruction === undefined ? {} : { instruction: node.instruction },
            ...node.acceptance === undefined ? {} : { acceptance: node.acceptance },
            ...node.failure === undefined ? {} : { failure: { ...node.failure } },
            ...node.requiresApproval === undefined ? {} : { requiresApproval: node.requiresApproval },
          })),
          title: record.title,
          ...record.rework === undefined ? {} : { rework: { ...record.rework } },
          ...record.budget === undefined ? {} : { budgetLimit: { ...record.budget } },
        },
        startedAt: now,
        updatedAt: now,
      })
      actions.push(`started ${started.runId} at definition version ${String(started.definitionVersion)}`)
      return finish(`Started ${started.runId} on ${record.workflowId} version ${String(record.version)}, with ${String(started.nodes.length)} node(s) pending.`)
    }

    if (request.action === 'rerun') {
      if (request.runId === undefined) throw new Error('BAD_REQUEST: a partial rerun needs the runId')
      const record = current.getWorkflowRun(request.runId)
      if (record === undefined) throw new Error(`NOT_FOUND: no workflow run ${request.runId}`)
      const selected = [
        ...(request.nodeIds ?? []),
        ...request.nodeId === undefined || (request.nodeIds ?? []).includes(request.nodeId) ? [] : [request.nodeId],
      ]
      const definitionRecord = current.getWorkflow(record.workflowId)
      if (definitionRecord === undefined) {
        throw new Error(`NOT_FOUND: run ${record.runId} names workflow ${record.workflowId}, which is not saved`)
      }
      const definition = definitionForRun(record, definitionRecord)
      for (const node of definition.nodes) {
        const refusal = writeControlRefusal(current.getAccess(node.taskId), node.taskId, request.authorizedBy)
        if (refusal !== undefined) problems.push(`${refusal.code}: ${refusal.reason} (node ${node.nodeId})`)
      }
      if (problems.length > 0) {
        return finish(`${String(problems.length)} control problem(s); no partial rerun was opened.`)
      }
      const plan = planPartialRerun(definition, runShapeOf(record), selected)
      if (!plan.ok) {
        problems.push(plan.reason)
        return finish(`No partial rerun was opened: ${plan.reason}`)
      }
      const runId = `run-${randomUUID()}`
      const rerun = await current.putWorkflowRun({
        runId,
        workflowId: record.workflowId,
        definitionVersion: record.definitionVersion,
        status: 'running',
        reworkRoundsUsed: 0,
        reworkHistory: [],
        nodes: nodesForPartialRerun(runShapeOf(record).nodes, plan.reset).map(entry => ({
          nodeId: entry.nodeId,
          state: entry.state,
          attempts: entry.attempts,
          ...entry.turnsUsed === undefined ? {} : { turnsUsed: entry.turnsUsed },
          ...entry.approvedBy === undefined ? {} : { approvedBy: entry.approvedBy },
          ...entry.approvedAt === undefined ? {} : { approvedAt: entry.approvedAt },
          ...entry.approvedBinding === undefined ? {} : { approvedBinding: entry.approvedBinding },
          ...entry.verdict === undefined ? {} : {
            verdict: {
              result: entry.verdict.result,
              by: entry.verdict.by,
              at: entry.verdict.at,
              ...entry.verdict.command === undefined ? {} : { command: entry.verdict.command },
              ...entry.verdict.output === undefined ? {} : { output: entry.verdict.output },
              ...entry.verdict.evidence === undefined ? {} : { evidence: [...entry.verdict.evidence] },
            },
          },
        })),
        ...record.fixed === undefined ? {} : {
          fixed: {
            definitionVersion: record.fixed.definitionVersion,
            ...record.fixed.modelConfigurations === undefined ? {} : { modelConfigurations: record.fixed.modelConfigurations.map(entry => ({ ...entry, selection: { ...entry.selection } })) },
            authorisations: record.fixed.authorisations.map(item => ({ ...item })),
            constraints: record.fixed.constraints.map(item => ({ ...item })),
            artifacts: record.fixed.artifacts.map(item => ({ ...item })),
            acceptance: record.fixed.acceptance.map(item => ({ ...item })),
            ...record.fixed.budget === undefined ? {} : { budget: record.fixed.budget },
            ...record.fixed.failure === undefined ? {} : {
              failure: record.fixed.failure.map(item => ({
                nodeId: item.nodeId,
                onFail: item.onFail,
                ...item.retries === undefined ? {} : { retries: item.retries },
              })),
            },
            ...record.fixed.graph === undefined ? {} : {
              graph: record.fixed.graph.map(node => ({
                nodeId: node.nodeId,
                taskId: node.taskId,
                ...node.dependsOn === undefined ? {} : { dependsOn: [...node.dependsOn] },
                ...node.inputArtifacts === undefined ? {} : { inputArtifacts: [...node.inputArtifacts] },
                ...node.instruction === undefined ? {} : { instruction: node.instruction },
                ...node.acceptance === undefined ? {} : { acceptance: node.acceptance },
                ...node.failure === undefined ? {} : { failure: { ...node.failure } },
                ...node.requiresApproval === undefined ? {} : { requiresApproval: node.requiresApproval },
              })),
            },
            ...record.fixed.title === undefined ? {} : { title: record.fixed.title },
            ...record.fixed.rework === undefined ? {} : { rework: { ...record.fixed.rework } },
            ...record.fixed.budgetLimit === undefined ? {} : { budgetLimit: { ...record.fixed.budgetLimit } },
          },
        },
        sourceRunId: record.runId,
        rerunOf: [...plan.selected],
        startedAt: now,
        updatedAt: now,
      })
      actions.push(
        `reran ${record.runId} → ${rerun.runId}, resetting ${plan.reset.join(', ')}`
        + (plan.kept.length === 0 ? '' : `; kept ${plan.kept.join(', ')}`),
      )
      return finish(
        `Opened ${rerun.runId} as a partial rerun of ${record.runId}, resetting ${plan.reset.join(', ')} `
        + `(selected ${plan.selected.join(', ')} and affected successors). The source run is kept. `
        + 'Existing files and external actions from that run are not treated as undone. '
        + 'Old approvals on reset nodes are not reused.',
      )
    }

    if (request.action === 'pause' || request.action === 'resume' || request.action === 'cancel') {
      if (request.runId === undefined) throw new Error(`BAD_REQUEST: ${request.action} needs the runId`)
      const record = current.getWorkflowRun(request.runId)
      if (record === undefined) throw new Error(`NOT_FOUND: no workflow run ${request.runId}`)
      const definitionRecord = current.getWorkflow(record.workflowId)
      const definition = definitionRecord === undefined ? undefined : definitionForRun(record, definitionRecord)
      for (const node of definition?.nodes ?? []) {
        const refusal = writeControlRefusal(current.getAccess(node.taskId), node.taskId, request.authorizedBy)
        if (refusal !== undefined) problems.push(`${refusal.code}: ${refusal.reason} (node ${node.nodeId})`)
      }
      if (problems.length > 0) {
        return finish(`${String(problems.length)} control problem(s); ${request.action} was not applied.`)
      }
      const status = request.action === 'pause' ? 'paused' as const
        : request.action === 'resume' ? 'running' as const : 'cancelled' as const
      const updated = await current.updateWorkflowRun(request.runId, entry => {
        if (request.action !== 'cancel') return { ...entry, status }
        const cancelled = cancelUnfinishedNodes(runShapeOf(entry))
        return {
          ...entry,
          status: 'cancelled',
          nodes: entry.nodes.map(node => {
            const next = cancelled.nodes.find(candidate => candidate.nodeId === node.nodeId)
            return next === undefined ? node : { ...node, state: next.state }
          }),
        }
      })
      actions.push(`${request.action}d ${updated.runId}`)
      const note = request.action === 'pause'
        ? ' No new node will be dispatched; nodes already running are left to finish, because pausing is not a stop and cannot roll back what a node already did.'
        : request.action === 'cancel'
          ? ' No new node will be dispatched. Associated running turns were asked to stop. Cancelling cannot roll back files or external actions a node already performed.'
          : ''
      let stopAccount = ''
      if (request.action === 'cancel') {
        const coordinator = coordinatorOf()
        const stops = turnsToStopOnWorkflowCancel(record.nodes, definition?.nodes ?? [])
        const reports: string[] = []
        for (const taskId of stops) {
          if (coordinator === undefined) {
            reports.push(`${taskId}: no coordinator is mounted, so no turn was asked to stop`)
            continue
          }
          try {
            const stopped = coordinator.requestTurnCancel({
              taskId,
              callerSessionId: request.authorizedBy,
              cause: `workflow run ${request.runId} was cancelled`,
            })
            reports.push(`${taskId}: ${stopped.outcome}${stopped.reason === undefined ? '' : ` (${stopped.reason})`}`)
          } catch (error) {
            reports.push(`${taskId}: ${describeError(error)}`)
          }
        }
        stopAccount = reports.length === 0
          ? ' No node was running, so no turn was asked to stop.'
          : ` Turn stops: ${reports.join('; ')}.`
      }
      return finish(`${updated.runId} is now ${status}.${note}${stopAccount}`)
    }

    if (request.action === 'approve') {
      if (request.runId === undefined || request.nodeId === undefined) {
        throw new Error('BAD_REQUEST: an approval needs the runId and the nodeId it approves')
      }
      const record = current.getWorkflowRun(request.runId)
      if (record === undefined) throw new Error(`NOT_FOUND: no workflow run ${request.runId}`)
      const definitionRecord = current.getWorkflow(record.workflowId)
      if (definitionRecord === undefined) throw new Error(`NOT_FOUND: no workflow ${record.workflowId}`)
      const definition = definitionForRun(record, definitionRecord)
      const node = definition.nodes.find(entry => entry.nodeId === request.nodeId)
      if (node === undefined) throw new Error(`NOT_FOUND: workflow ${record.workflowId} has no node ${request.nodeId}`)
      const refusal = writeControlRefusal(current.getAccess(node.taskId), node.taskId, request.authorizedBy)
      if (refusal !== undefined) {
        throw new Error(`${refusal.code}: ${refusal.reason}`)
      }
      const decision = approveNode(definition, runShapeOf(record), request.nodeId, request.authorizedBy, now)
      if (!decision.ok) throw new Error(`BAD_REQUEST: ${decision.reason}`)
      const approvedNode = decision.run.nodes.find(node => node.nodeId === request.nodeId)
      await current.updateWorkflowRun(request.runId, entry => ({
        ...entry,
        nodes: entry.nodes.map(node => node.nodeId === request.nodeId
          ? {
              ...node,
              approvedBy: approvedNode?.approvedBy,
              approvedAt: approvedNode?.approvedAt,
              ...approvedNode?.approvedBinding === undefined ? {} : { approvedBinding: approvedNode.approvedBinding },
            }
          : node),
      }))
      actions.push(`${request.nodeId} approved by ${request.authorizedBy}`)
      return finish(
        `Node ${request.nodeId} of run ${request.runId} is approved. The node may now start once the other five `
        + 'conditions hold; an approval permits the work rather than recording that it happened.',
      )
    }

    if (request.action === 'verdict') {
      if (request.runId === undefined || request.nodeId === undefined || request.result === undefined || request.by === undefined) {
        throw new Error('BAD_REQUEST: a verdict needs runId, nodeId, result and by')
      }
      const record = current.getWorkflowRun(request.runId)
      if (record === undefined) throw new Error(`NOT_FOUND: no workflow run ${request.runId}`)
      const definitionRecord = current.getWorkflow(record.workflowId)
      const definition = definitionRecord === undefined ? undefined : definitionForRun(record, definitionRecord)
      const judgedNode = definition?.nodes.find(entry => entry.nodeId === request.nodeId)
      if (judgedNode !== undefined) {
        const refusal = writeControlRefusal(current.getAccess(judgedNode.taskId), judgedNode.taskId, request.authorizedBy)
        if (refusal !== undefined) throw new Error(`${refusal.code}: ${refusal.reason}`)
      }
      const run = record
      // PRD §二.12's two halves, both enforced here rather than described: a deterministic check
      // must record the command it ran **and** what it returned, and a model review is recorded as
      // a review — never as acceptance.
      const verdict = {
        result: request.result,
        by: request.by,
        at: now,
        ...request.command === undefined ? {} : { command: request.command },
        ...request.output === undefined ? {} : { output: request.output },
        ...request.evidence === undefined ? {} : { evidence: [...request.evidence] },
      }
      const malformed = verdictRefusal(verdict)
      if (malformed !== undefined) throw new Error(`BAD_REQUEST: ${malformed}`)
      // The run's fixed acceptance configuration, enforced: the node's rule was captured at `start`,
      // so a verdict must be judged against that rule rather than against whatever the definition
      // says now. Without this the stored rule was display-only (audit R5) and an edited definition
      // silently redefined what passing meant for a run already in flight.
      const fixedRule = record.fixed?.acceptance.find(entry => entry.nodeId === request.nodeId)?.rule
      const wrongRule = verdictRuleRefusal(fixedRule ?? '', request.rule)
      if (wrongRule !== undefined) throw new Error(`BAD_REQUEST: ${wrongRule}`)
      const judged = recordVerdict(runShapeOf(run), request.nodeId, verdict)
      const nodeRecord = judged.nodes.find(node => node.nodeId === request.nodeId)
      const updated = await current.updateWorkflowRun(request.runId, entry => ({
        ...entry,
        status: judged.status,
        nodes: entry.nodes.map(node => node.nodeId === request.nodeId
          ? {
              ...node,
              state: nodeRecord?.state ?? node.state,
              verdict,
            }
          : node),
      }))
      actions.push(`${request.nodeId} judged ${request.result} by ${request.by}`)
      // A failed node opens a rework round, or hands the run to the user — that decision
      // belongs to the tested core, not here.
      if (request.result !== 'pass') {
        const saved = current.getWorkflow(run.workflowId)
        const frozen = saved === undefined ? undefined : definitionForRun(record, saved)
        const limit = frozen?.rework?.maxRounds ?? configOf().reworkRounds
        const handling = frozenFailureOf(
          record.fixed === undefined ? undefined : fixedShapeOf(record.fixed),
          request.nodeId,
        )
          ?? frozen?.nodes.find(entry => entry.nodeId === request.nodeId)?.failure
        const failure = afterNodeFailure(judged, request.nodeId, limit, handling)
        if (failure.run.status === 'needs_user') {
          await current.updateWorkflowRun(request.runId, entry => ({ ...entry, status: 'needs_user' }))
          problems.push(failure.reason)
        } else {
          const failed = failure.run.nodes.find(entry => entry.nodeId === request.nodeId)
          const retryOrRework = failed !== undefined && isStartable(failed.state)
          if (retryOrRework) {
            await current.updateWorkflowRun(request.runId, entry => ({
              ...entry,
              reworkRoundsUsed: failure.run.reworkRoundsUsed,
              reworkHistory: failure.run.reworkHistory.map(round => [...round]),
              // The redo clears the node's state and verdict: keeping the old verdict
              // would let a stale pass satisfy a node that has not seen the rework.
              nodes: entry.nodes.map(node => {
                const redone = failure.run.nodes.find(candidate => candidate.nodeId === node.nodeId)
                if (redone === undefined) return node
                return { nodeId: redone.nodeId, state: redone.state, attempts: redone.attempts }
              }),
            }))
            actions.push(failure.reason)
            // PRD §二.13.2: 返工 counts into the run ledger. Counted when a round actually
            // opens, against the node that failed, so every governing scope (task, group,
            // workflow) sees it the way a dispatch does.
            if (judgedNode !== undefined && failure.run.reworkRoundsUsed > run.reworkRoundsUsed) {
              await countReworkRound(current, judgedNode.taskId, now, run.workflowId)
            }
          } else {
            actions.push(failure.reason)
            if (frozen !== undefined && runHasSettled(frozen, failure.run)) {
              await current.updateWorkflowRun(request.runId, entry => ({ ...entry, status: 'completed' }))
              actions.push('the remaining nodes are blocked behind the failure, so the run is complete')
            }
          }
        }
      }
      void updated
      return finish(`${request.nodeId} was recorded as ${request.result} by ${request.by}.`)
    }

    // drive: advance every node whose six conditions hold.
    if (request.runId === undefined) throw new Error('BAD_REQUEST: driving a workflow needs the runId')
    const disabledDrive = lifecycle.refusal('a workflow drive')
    if (disabledDrive !== undefined) {
      problems.push(disabledDrive)
      return finish(disabledDrive)
    }
    const record = current.getWorkflowRun(request.runId)
    if (record === undefined) throw new Error(`NOT_FOUND: no workflow run ${request.runId}`)
    if (record.status !== 'running') {
      return finish(`${record.runId} is ${record.status}, so no node was dispatched.${record.status === 'needs_user' ? ' It needs the user.' : ''}`)
    }
    const definitionRecord = current.getWorkflow(record.workflowId)
    if (definitionRecord === undefined) throw new Error(`NOT_FOUND: run ${record.runId} names workflow ${record.workflowId}, which is not saved`)
    const liveDefinition = definitionOf(definitionRecord)
    const definition = definitionForRun(record, definitionRecord)
    for (const node of definition.nodes) {
      const refusal = writeControlRefusal(current.getAccess(node.taskId), node.taskId, request.authorizedBy)
      if (refusal !== undefined) problems.push(`${refusal.code}: ${refusal.reason} (node ${node.nodeId})`)
    }
    if (problems.length > 0) {
      return finish(`${String(problems.length)} control problem(s); nothing was dispatched.`)
    }
    // PRD §三.3 / §四.3: the run fixed its definition version, its authority, its constraints,
    // its inputs and its budget policy when it started. Those are the facts someone else can
    // change while it is in flight, so they are compared before anything is dispatched —
    // continuing would run the work under terms nobody agreed to. This is also where the
    // constraint compatibility check finally has a caller. A snapshotted graph *is* the
    // definition the run executes, so a later save is not itself a reason to stop.
    const liveBudget = budgetPolicyText(liveDefinition.budget)
    const drift = record.fixed === undefined
      ? (definitionRecord.version !== record.definitionVersion
          ? `the workflow definition moved from version ${String(record.definitionVersion)} to `
            + `${String(definitionRecord.version)} after this run started, so in-flight nodes would run under a `
            + 'definition they never fixed'
          : undefined)
      : fixedDrift(
          fixedShapeOf(record.fixed),
          {
            definitionVersion: definitionRecord.version,
            authorisations: record.fixed.authorisations.map(entry => {
              const access = current.getAccess(entry.taskId)
              return access === undefined
                ? { ...entry, ownerSessionId: '', ownerEpoch: -1 }
                : { taskId: entry.taskId, ownerSessionId: access.ownerSessionId, ownerEpoch: access.ownerEpoch }
            }),
            constraints: record.fixed.constraints.map(entry => ({
              constraintId: entry.constraintId,
              version: current.getConstraint(entry.constraintId)?.version ?? -1,
            })),
            artifacts: record.fixed.artifacts.map(entry => ({
              artifactId: entry.artifactId,
              contentVersion: current.getArtifact(entry.artifactId)?.contentVersion ?? -1,
            })),
            ...liveBudget === undefined ? {} : { budget: liveBudget },
          },
        )
    if (drift !== undefined) {
      // Recorded on the run as well as reported: a run that keeps being driven must not look healthy
      // to the next reader, and `needs_user` is what §二.12 already uses for "a person must decide".
      await current.updateWorkflowRun(request.runId, entry => ({ ...entry, status: 'needs_user' }))
      problems.push(`the run's fixed terms changed: ${drift}`)
      return finish(
        `Nothing was dispatched on ${record.runId}, and the run is now needs_user. ${drift} The run is kept with the `
        + 'terms it fixed; a run that read them live would silently adopt someone else\'s later edit.',
      )
    }
    const budget = definition.budget
    const spent = record.nodes.reduce((total, node) => total + (node.turnsUsed ?? 0), 0)
    let advanced = 0
    // Condition 5's budget half, from the definition the run fixed. It is combined with any stored
    // policy that governs the node's task (checked per node below), because a limit set on the task
    // or its group is not excused by the workflow having no limit of its own.
    let budgetLeft = budget?.maxTurns === undefined ? true : spent < budget.maxTurns

    for (const node of definition.nodes) {
      const currentRun = runShapeOf(current.getWorkflowRun(request.runId) ?? record)
      const entry = currentRun.nodes.find(candidate => candidate.nodeId === node.nodeId)
      if (entry === undefined || (entry.state !== 'running' && entry.state !== 'waiting')) continue
      const live = observerOf()?.snapshot(node.taskId)
      const overlaid = overlayNodeFromTarget(entry.state, {
        ...live?.state.interaction === undefined ? {} : { interaction: live.state.interaction },
        ...live?.state.execution === undefined ? {} : { execution: live.state.execution },
        ...live?.state.lastTurn === undefined ? {} : { lastTurn: live.state.lastTurn },
      })
      if (overlaid === entry.state) continue
      await current.updateWorkflowRun(request.runId, item => ({
        ...item,
        nodes: item.nodes.map(candidate => candidate.nodeId === node.nodeId
          ? { ...candidate, state: overlaid }
          : candidate),
      }))
      actions.push(`${node.nodeId}: ${entry.state} → ${overlaid}`)
    }

    for (const node of definition.nodes) {
      if (request.maxNodes !== undefined && advanced >= request.maxNodes) break
      const currentRun = runShapeOf(current.getWorkflowRun(request.runId) ?? record)
      const entry = currentRun.nodes.find(candidate => candidate.nodeId === node.nodeId)
      const readiness = nodeReadiness(definition, currentRun, node.nodeId, {
        // Input artifacts must be present, verified and unchanged — the same bar the
        // dependency rule in PRD §二.9.1 sets for a fixed input.
        artifactReady: (artifactId) => {
          const artifact = current.getArtifact(artifactId)
          if (artifact === undefined || artifact.existence !== 'present' || !isPinnedForDependency(artifact).pinned) {
            return false
          }
          // PRD §二.13.1: an artifact produced under a different constraint version
          // than this run fixed is not a fixed input, even when the file itself is
          // still pinned. Runs recorded before `fixed` was captured skip this.
          if (record.fixed !== undefined
            && !artifactConstraintCompatibleWithRun(artifact, record.fixed.constraints).compatible) {
            return false
          }
          return true
        },
        authorized: current.getAccess(node.taskId) === undefined
          || current.getAccess(node.taskId)?.ownerSessionId === request.authorizedBy
          || current.getAccess(node.taskId)?.ownerSessionId === definitionRecord.authorizedBy,
        environmentReady: current.getTask(node.taskId)?.preparation === 'ready',
        capacityAvailable: budgetLeft,
        // Condition 6 is read from the run, not assumed: a node that declares `requiresApproval`
        // starts only after someone recorded an approval for it. Passing a constant `true` here —
        // which is what this code did before — made the condition unfalsifiable, so the gate
        // reported "all six hold" while the sixth could never fail.
        approved: entry?.approvedBy !== undefined,
      })
      if (entry === undefined || !isStartable(entry.state)) continue
      if (!readiness.ready) {
        // Reported, not silently skipped: a node that never starts is the outcome a
        // caller most needs explained, and which of the six conditions blocked it is
        // the explanation.
        const unmet = readiness.conditions.filter(condition => !condition.satisfied)
        problems.push(`${node.nodeId}: ${unmet.map(condition => `${condition.condition} — ${condition.reason}`).join('; ')}`)
        if (entry.state !== 'blocked') {
          await current.updateWorkflowRun(request.runId, item => ({
            ...item,
            nodes: item.nodes.map(candidate => candidate.nodeId === node.nodeId
              ? { ...candidate, state: 'blocked' }
              : candidate),
          }))
        }
        continue
      }
      const modelRefusal = workflowModelRefusal(current, record.fixed?.modelConfigurations, node.nodeId, modelSelectionReaderOf(probeContext.get(MODEL_SELECTION_WRITER_SERVICE)))
      if (modelRefusal !== undefined) {
        await current.updateWorkflowRun(request.runId, item => ({ ...item, status: 'needs_user' }))
        problems.push(`${node.nodeId}: ${modelRefusal}`)
        return finish(`Run ${record.runId} needs the user because its fixed runtime configuration cannot be used.`)
      }
      const attempt = entry.attempts + 1
      const operationId = `workflow-${record.runId}-${node.nodeId}-${String(attempt)}`
      // §二.13.2's first action, per node: a reached limit stops new automatic scheduling, and a
      // workflow node is automatic. The gate is asked with the workflow id so a workflow-scope policy
      // applies too.
      const permitted = budgetPermits(current, node.taskId, now, record.workflowId)
      if (!permitted.allowed) {
        problems.push(`${node.nodeId}: not dispatched — ${permitted.reason}`)
        continue
      }
      if (entry.state !== 'ready') {
        await current.updateWorkflowRun(request.runId, item => ({
          ...item,
          nodes: item.nodes.map(candidate => candidate.nodeId === node.nodeId
            ? { ...candidate, state: 'ready' }
            : candidate),
        }))
      }
      if (node.instruction !== undefined) {
        try {
          const outcome = await coordinatorOf()?.send({
            operationId,
            taskId: node.taskId,
            text: node.instruction,
            mode: 'steer',
            callerSessionId: definitionRecord.authorizedBy,
            attribution: { kind: 'relay', sourceEventId: operationId },
          })
          if (outcome === undefined || (outcome.delivery !== 'accepted' && outcome.delivery !== 'replayed')) {
            problems.push(`${node.nodeId}: kept ready — ${outcome?.reason ?? 'no coordinator'}`)
            continue
          }
        } catch (error) {
          problems.push(`${node.nodeId}: dispatching its instruction failed: ${describeError(error)}`)
          continue
        }
      }
      await current.updateWorkflowRun(request.runId, item => ({
        ...item,
        nodes: item.nodes.map(candidate => candidate.nodeId === node.nodeId
          // `turnsUsed` is what the definition's `maxTurns` counts. It was declared and read but
          // written by nothing, so `spent` was always 0 and the budget half of condition 5 could
          // never close; a dispatch opens a turn, which is the count the budget is about.
          ? { ...candidate, state: 'running', attempts: attempt, turnsUsed: (candidate.turnsUsed ?? 0) + 1 }
          : candidate),
      }))
      await countDispatch(current, node.taskId, now, record.workflowId, operationId)
      advanced += 1
      budgetLeft = budget?.maxTurns === undefined ? true : spent + advanced < budget.maxTurns
      actions.push(`${node.nodeId}: dispatched${node.instruction === undefined ? ' (no instruction; marked running)' : ` as ${operationId}`}`)
    }

    const latest = current.getWorkflowRun(request.runId)
    const settled = latest !== undefined && runHasSettled(definition, runShapeOf(latest))
    if (latest !== undefined && settled) {
      await current.updateWorkflowRun(request.runId, entry => ({ ...entry, status: 'completed' }))
      const allPassed = latest.nodes.every(node => canonicalNodeState(node.state) === 'passed')
      actions.push(allPassed
        ? 'every node is passed, so the run is complete'
        : 'the run has settled, so it is complete')
    }
    if (advanced === 0 && problems.length === 0) {
      return finish(settled
        ? `Nothing to advance: ${record.runId} has settled, so the run is complete.`
        : `Nothing to advance: no node of ${record.runId} is ready, and none is blocked by a condition that could be reported.`)
    }
    return finish(`${String(advanced)} node(s) advanced on ${record.runId}.`)
  }

  /**
   * The constraints surface (PRD §二.13.1).
   *
   * Two things are deliberate. A change **versions** the constraint rather than editing
   * it, because a run fixes the version it started under and an edit that reached work
   * in flight would be the silent change PRD §一.5 forbids. And a delivery is recorded
   * one stage at a time through the tested core, so "acknowledged" can never be written
   * where "verified" was meant.
   *
   * @param request - what the caller asked for.
   * @returns the constraints and deliveries as they stand.
   */
  /** Read a stored budget record as the pure policy shape. */
  const policyOf = policyFromRecord

  const constraintsOf = async (request: ConstraintsToolRequest): Promise<ConstraintsToolResult> => {
    const current = store
    if (current === undefined) throw new Error('NO_DURABLE_STATE: the conductor has no durable state')
    const now = new Date().toISOString()
    const problems: string[] = []

    const describeConstraints = (): ConstraintsToolResult['constraints'] =>
      current.listConstraints().map(record => ({
        constraintId: record.constraintId,
        kind: record.kind,
        text: record.text,
        version: record.version,
      }))
    const describeDeliveries = (): ConstraintsToolResult['deliveries'] =>
      current.listConstraintDeliveries().map(record => ({
        constraintId: record.constraintId,
        version: record.version,
        targetId: record.targetId,
        stage: record.stage,
        detail: describeDelivery(record),
      }))

    if (request.action === 'read' || request.action === 'list') {
      const constraints = current.listConstraints(request.kind === undefined ? {} : { kind: request.kind })
      return {
        constraints: constraints.map(record => ({
          constraintId: record.constraintId,
          kind: record.kind,
          text: record.text,
          version: record.version,
        })),
        deliveries: describeDeliveries(),
        problems,
        summary: constraints.length === 0
          ? 'No shared constraints are saved.'
          : `${String(constraints.length)} constraint(s):\n`
            + constraints.map(record => `- ${record.constraintId} [${record.kind}] v${String(record.version)}: ${record.text}`).join('\n'),
      }
    }

    if (request.action === 'set') {
      if (request.kind === undefined || request.text === undefined) {
        throw new Error('BAD_REQUEST: setting a constraint needs both its kind and its text')
      }
      const existing = request.constraintId === undefined ? undefined : current.getConstraint(request.constraintId)
      const planned = planConstraintChange(existing, { kind: request.kind, text: request.text }, now)
      if (!planned.ok) {
        problems.push(planned.reason)
        return { constraints: describeConstraints(), deliveries: describeDeliveries(), problems, summary: planned.reason }
      }
      const saved = await current.putConstraint(planned.record)
      return {
        constraints: describeConstraints(),
        deliveries: describeDeliveries(),
        problems,
        summary: `Constraint ${saved.constraintId} is now version ${String(saved.version)} (${saved.kind}): ${saved.text}. `
          + 'Work already in flight keeps the version it started under.',
      }
    }

    if (request.action === 'apply') {
      if (request.constraintId === undefined) throw new Error('BAD_REQUEST: applying a constraint needs its constraintId')
      const record = current.getConstraint(request.constraintId)
      if (record === undefined) throw new Error(`NOT_FOUND: no constraint ${request.constraintId} is saved`)
      const scope = request.scope ?? 'future'
      // The artifacts a change can invalidate are the ones the work it governs produced. This used
      // to list **every** accepted artifact in the store with the reason "its acceptance was given
      // under constraint version N-1" simply asserted — so an unrelated task's artifact was reported
      // as invalidated, and nothing was actually marked.
      const affectedNodes = request.affectedNodes ?? []
      // A node id names a node **in a workflow definition**, and the definition is what says which
      // task that node drives — so that is how the scope is resolved. (Resolving by task title would
      // treat a display name as an identifier, and two tasks may share one.)
      const targetTaskIds = new Set(affectedNodes.flatMap(nodeId =>
        current.listWorkflows().flatMap(workflow =>
          workflow.nodes.filter(node => node.nodeId === nodeId).map(node => node.taskId))))
      const invalidated = current.listArtifacts({})
        // Only artifacts that were accepted — one nobody accepted has nothing to re-judge — and, when
        // the caller named nodes, only those belonging to the tasks those nodes address.
        .filter(artifact => acceptanceCounts(artifact).counts)
        .filter(artifact => targetTaskIds.size === 0 || targetTaskIds.has(artifact.taskId))
        .map(artifact => ({
          artifactId: artifact.artifactId,
          reason: `it was accepted under constraint version ${String(Math.max(0, record.version - 1))}, and the `
            + `statement changed at version ${String(record.version)}`,
          accepted: true,
        }))
      const impact = planConstraintImpact({
        constraintId: record.constraintId,
        fromVersion: Math.max(0, record.version - 1),
        toVersion: record.version,
        scope,
        ...request.affectedNodes === undefined ? {} : { affectedNodes: request.affectedNodes },
        invalidatedArtifacts: invalidated,
      })
      // Applying to current work **marks** what must be re-judged. The impact used to be computed and
      // returned with nothing written, so an artifact reported as "needs re-acceptance" kept
      // `acceptance: pass` and a later reader saw a clean state.
      const marked: string[] = []
      if (scope === 'current') {
        for (const entry of impact.affectedArtifacts.filter(candidate => candidate.needsReacceptance)) {
          const existing = current.getArtifact(entry.artifactId)
          if (existing === undefined) continue
          await current.putArtifact({
            ...existing,
            acceptance: 'pending',
            acceptedBy: undefined,
            acceptedAt: undefined,
            evidence: [...existing.evidence, `needs re-acceptance: ${entry.reason}`].slice(-20),
            updatedAt: now,
          })
          marked.push(entry.artifactId)
        }
      }
      return {
        constraints: describeConstraints(),
        deliveries: describeDeliveries(),
        impact: {
          affectedNodes: impact.affectedNodes,
          affectedArtifacts: impact.affectedArtifacts,
          caveat: impact.caveat,
        },
        problems,
        summary: scope === 'future'
          ? `Constraint ${record.constraintId} v${String(record.version)} applies to future runs only. ${impact.caveat}`
          : `Constraint ${record.constraintId} v${String(record.version)} reaches current work: `
            + `${String(impact.affectedNodes.length)} node(s) and ${String(marked.length)} accepted artifact(s) were `
            + `marked for re-judgement (acceptance returned to "pending", with the reason recorded). ${impact.caveat}`,
      }
    }

    // deliver
    if (request.constraintId === undefined || request.targetId === undefined || request.stage === undefined) {
      throw new Error('BAD_REQUEST: recording a delivery needs the constraintId, the targetId and the stage')
    }
    const record = current.getConstraint(request.constraintId)
    if (record === undefined) throw new Error(`NOT_FOUND: no constraint ${request.constraintId} is saved`)
    const key = `${record.constraintId}@${String(record.version)}::${request.targetId}`
    const existing = current.getConstraintDelivery(key)
    const shaped = existing ?? {
      deliveryKey: key,
      constraintId: record.constraintId,
      version: record.version,
      targetId: request.targetId,
      // A delivery starts at `sent`, which is the fact implied by recording it at all.
      stage: 'sent' as const,
      updatedAt: now,
    }
    // PRD §二.13.1: a new constraint is **delivered** at the next processable boundary, and the
    // delivery must not claim to change an in-flight request. This recorded the caller's chosen
    // stage and sent nothing — so `sent` was a stage name nobody had earned, and `in_context` could
    // be asserted with no message in existence. The first delivery is now an actual dispatch: the
    // steer mode is what "the next processable boundary" means on this Host, and the deterministic
    // operation id makes a repeated delivery a replay rather than a second message.
    if (existing === undefined && request.stage === 'sent') {
      // The target may be named as a workflow node id or as a task; a node resolves through the
      // definition that contains it, because a definition is what says which task it drives.
      const asNode = current.listWorkflows().flatMap(workflow =>
        workflow.nodes.filter(node => node.nodeId === request.targetId).map(node => node.taskId))
      const targetTaskId = current.getTask(request.targetId) === undefined
        ? asNode[0]
        : request.targetId
      if (targetTaskId === undefined) {
        throw new Error(
          `NOT_FOUND: ${request.targetId} is neither a managed task nor a node of a saved workflow, so the constraint `
          + 'has nowhere to be delivered',
        )
      }
      const operationId = `constraint-${record.constraintId}-v${String(record.version)}-${request.targetId}`
      try {
        const outcome = await coordinatorOf()?.send({
          operationId,
          taskId: targetTaskId,
          text: `[constraint ${record.constraintId} v${String(record.version)}] ${record.text}`,
          mode: 'steer',
          callerSessionId: request.authorizedBy,
          attribution: { kind: 'relay', sourceEventId: operationId },
        })
        if (outcome === undefined || (outcome.delivery !== 'accepted' && outcome.delivery !== 'replayed')) {
          const reason = `the constraint is kept pending for ${request.targetId}: ${outcome?.reason ?? 'no coordinator'}`
          problems.push(reason)
          return { constraints: describeConstraints(), deliveries: describeDeliveries(), problems, summary: reason }
        }
      } catch (error) {
        const reason = `the constraint was not delivered to ${request.targetId}: ${describeError(error)}`
        problems.push(reason)
        return { constraints: describeConstraints(), deliveries: describeDeliveries(), problems, summary: reason }
      }
      await current.putConstraintDelivery({ ...shaped, stage: 'sent', updatedAt: now })
      return {
        constraints: describeConstraints(),
        deliveries: describeDeliveries(),
        problems,
        summary: `Constraint ${record.constraintId} v${String(record.version)} was sent to ${request.targetId} at its `
          + `next step boundary, as ${operationId}. Being acceptable as a step is not consumption and not compliance: `
          + 'the target reports those separately. An in-flight request is not altered — steering reaches the nearest '
          + 'boundary, it does not rewrite what the Host has already assembled.',
      }
    }
    if (existing === undefined) await current.putConstraintDelivery(shaped)
    const advanced = advanceDelivery(
      shaped,
      request.stage,
      request.command === undefined || request.output === undefined
        ? undefined
        : { command: request.command, output: request.output },
      now,
    )
    if (!advanced.ok) {
      problems.push(advanced.reason)
      return { constraints: describeConstraints(), deliveries: describeDeliveries(), problems, summary: advanced.reason }
    }
    // The core works on the delivery's facts; the key is the store's business, so it is
    // added here rather than threaded through a decision that has no use for it.
    const saved = await current.putConstraintDelivery({ ...advanced.delivery, deliveryKey: key })
    return {
      constraints: describeConstraints(),
      deliveries: describeDeliveries(),
      problems,
      summary: `${describeDelivery(saved)}.`,
    }
  }

  /**
   * The budget surface (PRD §二.13.2).
   *
   * The ledger is written through the tested core, which only ever counts up. That is
   * the whole reason there is no "reset" here: a transfer, a restart or a retry cannot
   * zero the ledger because no operation exists that could, and a budget that could be
   * reset by retrying is not a budget.
   *
   * @param request - what the caller asked for.
   * @returns the policies, the ledgers and, on `check`, the decision.
   */
  const budgetOf = async (request: BudgetToolRequest): Promise<BudgetToolResult> => {
    const current = store
    if (current === undefined) throw new Error('NO_DURABLE_STATE: the conductor has no durable state')
    const now = new Date().toISOString()
    const problems: string[] = []
    const keyOf = (scope: BudgetScope, targetId: string): string => `${scope}::${targetId}`

    /**
     * Read a persisted ledger as the pure shape, defaulting to an empty one.
     *
     * Delegates to the plugin-wide reader rather than mapping the record a second time: the two shapes were
     * written out twice, and adding the acceptance counter to one of them immediately left the other stale —
     * which is exactly how a reader shows one number and the gate decides on another.
     */
    const ledgerOf = (targetId: string): RunLedger => ledgerOfRecord(current, targetId)

    const policies = (): BudgetToolResult['policies'] => current.listBudgets().map(record => ({
      scope: record.scope,
      targetId: record.targetId,
      strict: record.strict,
      // Rendered by the one function that knows the limit vocabulary, so the panel's description of a
      // task's configuration and this tool's policy list cannot drift apart.
      limits: [...budgetLimitsOf(policyOf(record))],
    }))

    const ledgers = (): BudgetToolResult['ledgers'] => current.listBudgets().length === 0
      ? []
      : current.listBudgets().map(record => {
          const ledger = ledgerOf(record.targetId)
          return {
            targetId: record.targetId,
            dispatches: ledger.dispatches,
            attempts: ledger.attempts,
            reworkRounds: ledger.reworkRounds,
            turns: ledger.turns,
            reportTurns: ledger.reportTurns,
            // §二.13.2 names acceptances beside nodes, reports and rework. A counter a reader cannot see is a
            // counter that may as well not exist, which is how this one stayed missing.
            acceptances: ledger.acceptances,
            // The wall-clock deadline is measured from this instant (PRD §二.13.2), so a reader that
            // cannot see it cannot check the one limit whose meaning depends on when it started.
            ...ledger.firstDispatchedAt === undefined ? {} : { firstDispatchedAt: ledger.firstDispatchedAt },
            // Rendered through the one function that knows an unavailable figure is not
            // a zero, so this can never disagree with the tool's own wording.
            tokens: describeUsage(ledger.tokens, 'tokens'),
            cost: describeUsage(ledger.cost, 'cost'),
          }
        })

    if (request.action === 'list') {
      return {
        policies: policies(),
        ledgers: ledgers(),
        problems,
        summary: current.listBudgets().length === 0 ? 'No budgets are set.' : `${String(policies().length)} budget(s) set.`,
      }
    }

    if (request.action === 'set') {
      if (request.scope === undefined || request.targetId === undefined) {
        throw new Error('BAD_REQUEST: setting a budget needs its scope and targetId')
      }
      const existing = current.getBudget(keyOf(request.scope, request.targetId))
      const saved = await current.putBudget({
        policyKey: keyOf(request.scope, request.targetId),
        scope: request.scope,
        targetId: request.targetId,
        strict: request.strict ?? false,
        ...request.deadlineAt === undefined ? {} : { deadlineAt: request.deadlineAt },
        ...request.maxDispatches === undefined ? {} : { maxDispatches: request.maxDispatches },
        ...request.maxAttempts === undefined ? {} : { maxAttempts: request.maxAttempts },
        ...request.maxReworkRounds === undefined ? {} : { maxReworkRounds: request.maxReworkRounds },
        // Condition 5's concurrency half: stored and, since this round, actually examined before
        // every automatic dispatch (see `budgetPermits`).
        ...request.maxConcurrent === undefined ? {} : { maxConcurrent: request.maxConcurrent },
        ...request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens },
        ...request.maxCost === undefined ? {} : { maxCost: request.maxCost },
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      })
      const policy = policyOf(saved)
      const decision = budgetDecision(policy, ledgerOf(saved.targetId), now)
      if (!decision.within && decision.limit !== undefined) problems.push(decision.reason)
      // `hardBudgetAllowed` finally has a caller. A strict budget is a **claim** that the limit
      // cannot be exceeded, and PRD §二.13.2 allows that claim only with full metering, a reliable
      // single-request upper bound and a concurrency reservation. The function existed, was tested,
      // and was called by nothing — so a strict token ceiling was stored and displayed as though it
      // were hard while nothing checked whether the deployment could honour it.
      const capabilities: MeteringCapabilities = {
        // What this deployment actually reports, read from the ledger rather than assumed: a ceiling
        // can only bind on a fully metered figure.
        fullMetering: ledgerOf(saved.targetId).tokens?.quality === 'actual_full'
          && (saved.maxCost === undefined || ledgerOf(saved.targetId).cost?.quality === 'actual_full'),
        // Neither of these exists anywhere in this build, and claiming otherwise would be the
        // fabrication the rule is about.
        singleRequestUpperBound: false,
        concurrencyReservation: false,
      }
      const hardness = saved.strict ? hardBudgetAllowed(capabilities) : undefined
      if (hardness !== undefined && !hardness.allowed) problems.push(hardness.reason)
      const enforced = await enforceReachedBudgetCancels(current, now, [saved.policyKey])
      return {
        policies: policies(),
        ledgers: ledgers(),
        decision: {
          within: decision.within,
          limit: decision.limit ?? 'none',
          reason: decision.reason,
          actions: decision.actions,
        },
        ...enforced.cancels.length === 0 ? {} : { cancels: enforced.cancels },
        problems,
        summary: `Budget ${saved.policyKey} set${saved.strict ? ' (strict)' : ''}: `
          + `${policies().find(entry => entry.targetId === saved.targetId)?.limits.join(', ') ?? 'no limits'}. `
          + `${decision.reason}`
          + (hardness === undefined
            ? ''
            : hardness.allowed
              ? ' It is claimed as a hard budget: the deployment reports everything the claim requires.'
              : ` It is NOT claimed as a hard budget. ${hardness.reason}`)
          + (enforced.notes.length === 0
            ? ''
            : ` Cancel: ${enforced.notes.join('; ')}.`),
      }
    }

    if (request.action === 'record') {
      if (request.targetId === undefined || request.event === undefined) {
        throw new Error('BAD_REQUEST: recording into the ledger needs the targetId and the event')
      }
      // A `usage` figure is not a counter: it carries the value **and** how good it is, because
      // PRD §二.13.2 requires actual, partial, estimated and unavailable to be told apart — and a
      // ceiling may only bind on a fully metered figure. Until this member existed the ledger's
      // `usage` event was unreachable, so tokens and cost rendered "unavailable" forever no matter
      // what the caller knew.
      const usageFact = (
        value: number | undefined,
        quality: 'actual_full' | 'partial' | 'estimated' | 'unavailable' | undefined,
      ): UsageFact | undefined => (value === undefined || quality === undefined ? undefined : { value, quality })
      const usage = request.event === 'usage'
        ? {
            kind: 'usage' as const,
            ...usageFact(request.tokensValue, request.tokensQuality) === undefined
              ? {}
              : { tokens: usageFact(request.tokensValue, request.tokensQuality) as UsageFact },
            ...usageFact(request.costValue, request.costQuality) === undefined
              ? {}
              : { cost: usageFact(request.costValue, request.costQuality) as UsageFact },
          }
        : undefined
      if (request.event === 'usage' && usage?.tokens === undefined && usage?.cost === undefined) {
        throw new Error(
          'BAD_REQUEST: recording usage needs a figure with its quality — tokensValue and tokensQuality, or '
          + 'costValue and costQuality. A figure without a quality would have to be assumed, and assuming '
          + '"actual" is how an unmeterable deployment gets a ceiling it cannot honour.',
        )
      }
      const after = await current.recordLedgerEvent(
        request.targetId,
        usage ?? (request.event === 'turn' || request.event === 'dispatch'
          ? { kind: request.event, at: now }
          : { kind: request.event as 'attempt' | 'rework_round' | 'report_turn' }),
        now,
      )
      const enforced = await enforceReachedBudgetCancels(current, now)
      return {
        policies: policies(),
        ledgers: ledgers(),
        ...enforced.cancels.length === 0 ? {} : { cancels: enforced.cancels },
        problems,
        summary: `Counted one ${request.event} into the ledger for ${request.targetId}: `
          + `${String(after.dispatches)} dispatch(es), ${String(after.attempts)} attempt(s), `
          + `${String(after.reworkRounds)} rework round(s), ${String(after.turns)} turn(s), `
          + `${String(after.reportTurns)} report turn(s). The ledger only counts up.`
          + (enforced.notes.length === 0 ? '' : ` Cancel: ${enforced.notes.join('; ')}.`),
      }
    }

    // check
    if (request.targetId === undefined) throw new Error('BAD_REQUEST: checking a budget needs the targetId')
    const policyRecord = current.listBudgets().find(entry => entry.targetId === request.targetId)
    if (policyRecord === undefined) throw new Error(`NOT_FOUND: no budget governs ${request.targetId}`)
    const decision = budgetDecision(policyOf(policyRecord), ledgerOf(request.targetId), now)
    if (!decision.within) problems.push(...decision.actions)
    return {
      policies: policies(),
      ledgers: ledgers(),
      decision: {
        within: decision.within,
        limit: decision.limit ?? 'none',
        reason: decision.reason,
        actions: decision.actions,
      },
      problems,
      summary: `${decision.within ? 'Within budget' : 'A limit has been reached'}: ${decision.reason}`
        + (decision.actions.length === 0 ? '' : ` Actions: ${decision.actions.join(', ')}.`)
        + ` ${budgetBoundary()}`,
    }
  }

  /**
   * The export surface (PRD §二.14.2).
   *
   * The snapshot is assembled from the store's own records through the export core, which
   * builds the document from an explicit allow-list rather than stripping a deny-list.
   * That direction matters here more than anywhere else in the plugin: an export is a
   * file that leaves the Host, so a field nobody chose to include must not ride along.
   *
   * @param request - what the caller asked for.
   * @returns the rendered document, what it excluded, and the share surface's state.
   */
  const exportOf = async (request: ExportToolRequest): Promise<ExportToolResult> => {
    const current = store
    if (current === undefined) throw new Error('NO_DURABLE_STATE: the conductor has no durable state')
    const now = new Date().toISOString()
    let share = shareAvailability(configOf().shareEnabled)
    try { share = shareAvailability(configOf().shareEnabled, await shareServiceOf() !== undefined) }
    catch { share = { available: false, reason: 'the configured HTTPS snapshot client could not be initialized; local export remains available' } }

    if (request.action === 'share' || request.action === 'rules') {
      return {
        format: 'none',
        cutoffAt: now,
        document: request.action === 'rules' ? SHARE_RULES.map(rule => `- ${rule}`).join('\n') : '',
        excluded: [],
        share,
        problems: [],
        summary: request.action === 'rules'
          ? `A published snapshot would have to meet all ${String(SHARE_RULES.length)} conditions:\n`
            + SHARE_RULES.map(rule => `- ${rule}`).join('\n')
          : share.reason,
      }
    }

    if (request.taskId === undefined) throw new Error('BAD_REQUEST: exporting needs its taskId')
    throwUnlessReader(request.taskId, request.authorizedBy)
    const task = current.getTask(request.taskId)
    if (task === undefined) throw new Error(`TASK_NOT_FOUND: no managed task ${request.taskId}`)
    const bindings = current.listBindings(request.taskId)
    const artifacts = current.listArtifacts({ taskId: request.taskId })
    for (const artifactId of request.attachmentIds ?? []) {
      if (!artifacts.some(artifact => artifact.artifactId === artifactId)) {
        throw new Error(`ATTACHMENT_OUT_OF_SCOPE: ${artifactId} is not an artifact of the exported task`)
      }
    }
    if (request.bundleDirectory !== undefined && (request.attachmentIds?.length ?? 0) > 0) {
      throwUnlessController(request.taskId, request.authorizedBy)
    }
    const format = request.format ?? 'markdown'

    // The run status comes from the same projection every other reader uses, so an export
    // cannot say something the panel and conductor_read would contradict.
    const lastBinding = bindings[bindings.length - 1]
    const live = lastBinding === undefined
      ? undefined
      : (probeContext.get('agents') as ObservableAgentsLike | undefined)?.get(lastBinding.sessionId)
    const events = live?.session.events as readonly SessionEventLike[] | undefined
    const folded = events === undefined ? initialProjection() : projectEvents(initialProjection(), events).state
    const projection = lastBinding === undefined || events === undefined
      ? folded
      : overlayTaskState(request.taskId, lastBinding.sessionId, folded, events)
    const storedPending = pendingInterventionFromWatches(current.listEveryWatch(), request.taskId)
    const pending = live === undefined
      ? storedPending
      : pendingInterventionOf(projection.interaction)

    const snapshot = buildExport({
      format,
      // The cutoff is taken now and recorded: the snapshot is exact at it and does not
      // track anything that happens afterwards.
      cutoffAt: now,
      task: {
        taskId: task.taskId,
        title: task.title,
        preparation: task.preparation,
        ...task.groupId === undefined ? {} : { groupId: task.groupId },
        pinned: task.pinned,
        archived: task.archived,
      },
      sessionChain: bindings.map(binding => ({
        bindingId: binding.bindingId,
        sessionId: binding.sessionId,
        version: binding.version,
        retired: binding.retiredAt !== undefined,
      })),
      runStatus: {
        execution: projection.execution,
        ...lastTurnFieldsOf(projection),
        ...pending === undefined ? {} : { pendingInteraction: pending },
      },
      artifacts: artifacts.map(artifact => ({
        artifactId: artifact.artifactId,
        kind: artifact.kind,
        // The artifact's contentVersion is what moves when its content is re-verified, so
        // it is the version an export must record; the record has no other version.
        version: artifact.contentVersion,
        existence: artifact.existence,
        acceptance: artifact.acceptance,
      })),
      ...request.attachmentIds === undefined ? {} : { attachmentIds: request.attachmentIds },
    })

    // PRD §二.14.2: a local export supports Markdown, JSON **and a selected attachment bundle**. The
    // bundle was only ever *named*: the document listed ids and a note, no file was produced, and an
    // id that named no artifact was passed through unvalidated — so an export could promise a bundle
    // that did not exist and name attachments that did not either.
    const bundleProblems: string[] = []
    const bundle: { artifactId: string; path: string; bytes: number }[] = []
    if (request.attachmentIds !== undefined && request.attachmentIds.length > 0) {
      if (request.bundleDirectory === undefined) {
        bundleProblems.push(
          `${String(request.attachmentIds.length)} attachment(s) were named but no bundleDirectory was given, so no `
          + 'files were written. The document names them and says so; naming a bundle is not producing one.',
        )
      } else {
        const fs = transferFsOf(probeContext)
        const nativeFs = probeContext.get('fs') as { contains?(root: unknown, target: unknown): boolean } | undefined
        if (fs === undefined || typeof nativeFs?.contains !== 'function') {
          bundleProblems.push(
            'this Host composition mounts no filesystem service with canonical containment, so the attachment bundle could not be written',
          )
        } else {
          for (const artifactId of request.attachmentIds) {
            const artifact = current.getArtifact(artifactId)
            if (artifact === undefined) {
              // Refused by name rather than listed: an export that names an artifact it cannot find
              // promises a bundle entry that does not exist.
              bundleProblems.push(`${artifactId} is not a recorded artifact, so nothing was written for it`)
              continue
            }
            if (artifact.path === undefined) {
              bundleProblems.push(
                `${artifactId} has no recorded path or URL, so there is nothing to copy into the bundle`,
              )
              continue
            }
            const name = `${artifact.artifactId.replace(/[^A-Za-z0-9._-]/g, '_')}-${artifact.name.replace(/[^A-Za-z0-9._-]/g, '_')}`
            const destination = `${request.bundleDirectory.replace(/[\\/]+$/, '')}/${name}`
            try {
              const root = await fs.resolve(request.bundleDirectory)
              const ownerEpoch = current.getAccess(request.taskId)?.ownerEpoch
              const assertWrite = async (target: unknown): Promise<void> => {
                const freshRoot = await fs.resolve(request.bundleDirectory!)
                const freshTarget = await fs.resolve(destination)
                if (!nativeFs.contains!(root, freshRoot) || !nativeFs.contains!(freshRoot, root)
                  || !nativeFs.contains!(freshRoot, target) || !nativeFs.contains!(freshRoot, freshTarget)
                  || !nativeFs.contains!(target, freshTarget) || !nativeFs.contains!(freshTarget, target)) {
                  throw new Error('BUNDLE_OUTSIDE_DIRECTORY: canonical destination changed during export')
                }
                throwUnlessController(request.taskId!, request.authorizedBy)
                if (current.getAccess(request.taskId!)?.ownerEpoch !== ownerEpoch) {
                  throw new Error('STALE_OWNER_EPOCH: control changed during attachment export')
                }
              }
              const guarded: TransferFsPort = {
                ...fs,
                writeText: async (target, text, expected, signal) => {
                  await assertWrite(target)
                  return await fs.writeText(target, text, expected, signal)
                },
                ...fs.writeBytes === undefined ? {} : {
                  writeBytes: async (target, bytes, expected, signal) => {
                    await assertWrite(target)
                    return await fs.writeBytes!(target, bytes, expected, signal)
                  },
                },
              }
              const outcome = await snapshotCopy({
                transferId: `export:${randomUUID()}`, artifact, toTaskId: request.taskId, destination, now,
              }, guarded)
              if (!outcome.record.verified) throw new Error(outcome.record.conflicts.join('; ') || 'attachment copy was not verified')
              const copied = await fs.stat(await fs.resolve(destination))
              bundle.push({ artifactId, path: destination, bytes: copied?.size ?? 0 })
            } catch (error) {
              // Missing byte capability, stale artifacts and incomplete writes remain named failures.
              bundleProblems.push(`${artifactId} could not be copied into the bundle: ${describeError(error)}`)
            }
          }
        }
      }
    }

    const document = format === 'json' ? renderJson(snapshot) : renderMarkdown(snapshot)
    return {
      format,
      cutoffAt: snapshot.cutoffAt,
      document,
      excluded: snapshot.redactions.map(redaction => `${redaction.what} — ${redaction.why}`),
      share,
      problems: bundleProblems,
      summary: `Exported task ${task.taskId} as ${format}, exact at ${snapshot.cutoffAt}: `
        + `${String(snapshot.sessionChain.length)} session binding(s), ${String(snapshot.artifacts.length)} artifact(s), `
        + (bundle.length > 0
          ? `${String(bundle.length)} attachment(s) written to ${String(request.bundleDirectory)} `
            + `(${bundle.map(entry => entry.path).join(', ')})`
          : snapshot.attachments.included ? 'an attachment bundle was named but no file was written' : 'no attachment bundle')
        + `. Excluded: ${snapshot.redactions.map(redaction => redaction.what).join(', ')}. `
        + snapshot.notRestorableNote
        + (bundleProblems.length === 0 ? '' : `\n${bundleProblems.map(problem => `- ${problem}`).join('\n')}`),
    }
  }

  /**
   * The model-configuration surface (PRD §二.3).
   *
   * The catalogue comes from `ctx.llm` — the Host's own registry — so this plugin has no
   * private list of providers or models to drift from it. And "most recently actually
   * used" is read from the session's own log rather than maintained here: the Host records
   * the provider and model on every assistant message, which makes it evidence rather than
   * a claim this plugin makes about itself.
   *
   * @param request - what the caller asked for.
   * @returns the catalogue, the configuration facts, and what changed.
   */
  /**
   * Read, cancel or continue a preparation (PRD §三.3 `operation`, §二.2.1).
   *
   * The three actions share one implementation because they share one record: `status` and `list`
   * read it, `cancel` moves it, and `resume` continues from where it stopped. Reading a task's
   * preparation *through its operation* is what §二.2.1 asks for — creation returns an operation id
   * and the caller asks about progress through it — so the two facts are reported together rather
   * than making the caller join them.
   *
   * @param request - the action, the operation or task it addresses, and the caller.
   * @returns the status, the cancellation or the resumed preparation.
   */
  const operationOf = async (request: OperationToolRequest): Promise<OperationToolResult> => {
    const current = store
    if (current === undefined) throw new Error('NO_DURABLE_STATE: the conductor has no durable state')
    const coordinator = coordinatorOf()
    if (coordinator === undefined) throw new Error('NO_DURABLE_STATE: the conductor cannot be built')

    if (request.action === 'status') {
      if (request.operationId === undefined) {
        throw new Error('BAD_REQUEST: the `status` action needs the operationId a create or fork handed back')
      }
      const status = coordinator.operationStatus(request.operationId)
      const operationTaskId = current.getOperation(request.operationId)?.taskId
      if (operationTaskId !== undefined) throwUnlessReader(operationTaskId, request.callerSessionId)
      return {
        action: 'status',
        found: status.found,
        operationId: status.operationId,
        ...status.kind === undefined ? {} : { delivery: status.delivery },
        ...status.task?.preparation === undefined ? {} : { preparation: status.task.preparation },
        ...status.task?.preparationPhase === undefined ? {} : { preparationPhase: status.task.preparationPhase },
        ...status.cancellable === undefined ? {} : { cancellable: status.cancellable },
        ...status.cancellationRefusal === undefined ? {} : { cancellationRefusal: status.cancellationRefusal },
        // §四.2's association, surfaced: the grant, the rule and the event behind this operation.
        ...status.attribution === undefined ? {} : { attributedBy: status.attribution.kind },
        ...status.attribution?.grantId === undefined ? {} : { attributedGrantId: status.attribution.grantId },
        ...status.attribution?.ruleId === undefined ? {} : { attributedRuleId: status.attribution.ruleId },
        ...status.attribution?.sourceEventId === undefined ? {} : { attributedSourceEventId: status.attribution.sourceEventId },
        ...status.reason === undefined ? {} : { error: status.reason },
        summary: status.found
          ? `Operation ${status.operationId} (${status.kind ?? 'unknown kind'}) is ${status.delivery ?? 'in an unknown state'}`
            + `${status.task === undefined
              ? '; it names no readable task'
              : `; task ${status.task.taskId} is ${status.task.preparation}/${status.task.preparationPhase}`}`
            + `${status.cancellable === true
              ? '. Its preparation can still be cancelled.'
              : `. It cannot be cancelled: ${status.cancellationRefusal ?? 'no reason recorded'}`}`
          : `Operation ${status.operationId} is not recorded: ${status.reason ?? 'no reason recorded'}`,
      }
    }

    if (request.action === 'list') {
      if (request.taskId === undefined) throw new Error('BAD_REQUEST: the `list` action needs a taskId')
      throwUnlessReader(request.taskId, request.callerSessionId)
      const listed = coordinator.operationList(request.taskId)
      if (!listed.found) {
        return {
          action: 'list',
          found: false,
          total: 0,
          error: listed.reason ?? 'unknown task',
          summary: `No operations were listed: ${listed.reason ?? 'unknown task'}`,
        }
      }
      return {
        action: 'list',
        found: true,
        total: listed.operations.length,
        operations: listed.operations.map(status => ({
          operationId: status.operationId,
          ...status.kind === undefined ? {} : { kind: status.kind },
          ...status.delivery === undefined ? {} : { delivery: status.delivery },
          ...status.phase === undefined ? {} : { phase: status.phase },
          ...status.withdrawn === undefined ? {} : { withdrawn: status.withdrawn },
          ...status.cancellable === undefined ? {} : { cancellable: status.cancellable },
        })),
        summary: `Task ${request.taskId} has ${String(listed.operations.length)} recorded operation(s): `
          + listed.operations
            .map(status => `${status.operationId} (${status.kind ?? 'unknown'}, ${status.delivery ?? 'unknown'})`)
            .join(', '),
      }
    }

    if (request.action === 'cancel') {
      if (request.operationId === undefined) {
        throw new Error('BAD_REQUEST: the `cancel` action needs the operationId of the preparation to cancel')
      }
      const cancelled = await coordinator.cancelPreparation({
        operationId: request.operationId,
        callerSessionId: request.callerSessionId,
      })
      return {
        action: 'cancel',
        found: true,
        operationId: cancelled.operationId,
        preparation: cancelled.preparation,
        preparationPhase: cancelled.preparationPhase,
        cancellable: false,
        alreadyCancelled: cancelled.alreadyCancelled,
        instructionWithdrawn: cancelled.instructionWithdrawn,
        ...cancelled.kept.sessionId === undefined ? {} : { keptSessionId: cancelled.kept.sessionId },
        ...cancelled.kept.cwd === undefined ? {} : { keptCwd: cancelled.kept.cwd },
        summary: cancelled.summary,
      }
    }

    if (request.taskId === undefined) throw new Error('BAD_REQUEST: the `resume` action needs a taskId')
    const resumed = await coordinator.resumePreparation({
      taskId: request.taskId,
      callerSessionId: request.callerSessionId,
    })
    return {
      action: 'resume',
      found: true,
      operationId: resumed.operationId,
      preparation: resumed.preparation,
      preparationPhase: resumed.preparationPhase,
      ...resumed.failureReason === undefined ? {} : { error: resumed.failureReason },
      summary: resumed.preparation === 'ready'
        ? `Task ${request.taskId} finished preparing on session ${resumed.sessionId ?? 'unknown'}; it reuses what the `
          + 'earlier attempt created rather than making a second session or worktree.'
        : `Resuming task ${request.taskId} did not finish: ${resumed.failureReason ?? 'no reason recorded'}. `
          + `It is ${resumed.preparation} at ${resumed.preparationPhase}, and nothing created earlier was removed.`,
    }
  }

  /**
   * The configuration the Host logged for a session's most recent assembled request, if any.
   *
   * Wrapped here rather than inline at each call site because **the same fact appears in two places** —
   * the model tool and the panel card — and a card that disagreed with the tool about what a task last
   * used would be worse than a card that said nothing.
   *
   * @param session - the live session view, when the task has a live binding.
   * @returns the logged selection, or undefined when the Host logged none.
   */
  const loggedSelectionOf = (session: SessionViewLike | undefined): ModelSelection | undefined => {
    if (typeof session?.requestHeader !== 'function') return undefined
    try {
      return selectionFromHeader(session.requestHeader())
    } catch (error) {
      // A Host whose `requestHeader` throws must not take the whole read down with it: the caller is
      // asking what a *task* is doing, and "the Host could not say" is reported as no selection.
      void error
      return undefined
    }
  }

  /**
   * Format the Host's last logged selection the way the card already shows it.
   *
   * One helper because the same sentence appears on the card, the detail and
   * the model-facing list: three copies of the template would be three ways
   * to disagree about what "last used" looks like.
   *
   * @param used - the logged selection, when the Host recorded one.
   * @returns the card's last-used sentence, or undefined when none was logged.
   */
  const describeLoggedModel = (used: ModelSelection | undefined): string | undefined => {
    if (used === undefined) return undefined
    return `${used.provider}/${used.model}`
      + (used.reasoningEffort === undefined ? '' : ` at ${used.reasoningEffort} reasoning`)
  }

  const modelConfigOf = async (request: ModelConfigToolRequest): Promise<ModelConfigToolResult> => {
    const current = store
    if (current === undefined) throw new Error('NO_DURABLE_STATE: the conductor has no durable state')
    const task = current.getTask(request.taskId)
    if (task === undefined) throw new Error(`TASK_NOT_FOUND: no managed task ${request.taskId}`)
    throwUnlessReader(request.taskId, request.callerSessionId)
    const ownerEpoch = current.getAccess(request.taskId)?.ownerEpoch
    // Reading is open to anyone who can see the task; **changing** is not. PRD §一.3 puts the
    // caller's identity in the Host's trusted context and §二.10.1 makes the writing controller the
    // only session allowed to change a task, and this surface previously accepted a caller id and
    // never checked it — so an observer, or any unrelated session, could ask to reconfigure a task
    // it does not control. The gate is the same one every other mutating surface uses.
    if (request.action !== 'show') {
      const coordinator = coordinatorOf()
      if (coordinator === undefined) throw new Error('NO_DURABLE_STATE: the conductor cannot be built')
      coordinator.requireController(request.taskId, request.callerSessionId)
    }

    const llm = probeContext.get('llm') as
      | { listProviders?(): readonly { id: string }[]; listModels?(provider: string): Promise<readonly { id: string }[]> }
      | undefined
    const providers = llm?.listProviders?.() ?? []
    const catalog: ModelCatalogPort = {
      listProviders: () => providers,
      listModels: async (provider) => {
        const models = await llm?.listModels?.(provider) ?? []
        return models.map(model => ({ provider, id: model.id, name: model.id }))
      },
    }

    // What the last assembled request actually used, from the Host's own record of it. The
    // `request/header` is the Host's statement; the assistant message's source is the weaker evidence a
    // Host that logs no header leaves, and is kept as a fallback so a session is not reported as
    // "none recorded" merely because this composition does not write headers.
    const binding = task.currentBindingId === undefined ? undefined : current.getBinding(task.currentBindingId)
    const live = binding === undefined
      ? undefined
      : (probeContext.get('agents') as ObservableAgentsLike | undefined)?.get(binding.sessionId)
    const events = (live?.session.events ?? []) as readonly SessionEventLike[]
    let lastActuallyUsed = loggedSelectionOf(live?.session)
    if (lastActuallyUsed === undefined) {
      for (const event of events) {
        if (event.type !== 'assistant/message') continue
        const message = (event.data as { message?: { source?: { provider?: unknown; model?: unknown } } } | undefined)?.message
        const provider = message?.source?.provider
        const model = message?.source?.model
        if (typeof provider === 'string' && typeof model === 'string') lastActuallyUsed = { provider, model }
      }
    }

    const reader = modelSelectionReaderOf(probeContext.get(MODEL_SELECTION_WRITER_SERVICE))
    let nextSelection: ModelSelection | undefined
    let nextSelectionSource: string | undefined
    let nextSelectionPersisted: boolean | undefined
    let nextSelectionNote: string | undefined
    if (reader !== undefined && binding !== undefined) {
      try {
        const observed = await readSessionSelection(reader, binding.sessionId)
        nextSelection = observed.next
        lastActuallyUsed = observed.lastUsed ?? lastActuallyUsed
        nextSelectionSource = observed.source
        nextSelectionPersisted = observed.persisted
      } catch (error) { nextSelectionNote = describeError(error) }
      throwUnlessReader(request.taskId, request.callerSessionId)
      if (current.getTask(request.taskId)?.currentBindingId !== task.currentBindingId) throw new Error('STALE_BINDING: session changed while reading model configuration')
    }
    const stateInput = { ...lastActuallyUsed === undefined ? {} : { lastActuallyUsed }, ...nextSelection === undefined ? {} : { forNextRequest: nextSelection } }
    const state = describeConfigState(stateInput)
    // PRD §二.3's "模型支持的推理强度", read from the Host for the model **in question** rather than from a
    // bulk list. The model in question is the one the task actually ran with, when the Host logged one;
    // otherwise the first route this Host advertises, so a reader configuring a fresh task still sees what
    // its levels would be.
    const firstProvider = providers[0]?.id
    const sampleProvider = nextSelection?.provider ?? lastActuallyUsed?.provider ?? firstProvider
    const sampleModel = nextSelection?.model ?? lastActuallyUsed?.model
      ?? (sampleProvider === undefined ? undefined : (await catalog.listModels(sampleProvider))[0]?.id)
    const reasoning = sampleProvider === undefined || sampleModel === undefined
      ? undefined
      : await publishedReasoningOf(
          llm as { resolveModelInfo?(provider: string, model: string): Promise<unknown> } | undefined,
          sampleProvider,
          sampleModel,
        )
    const catalogue = {
      providers: providers.map(provider => provider.id),
      // The field used to be a flat `reasoningEfforts: []` that was always empty because no Host supplied the
      // bulk port it read. It now names the model the levels belong to, because levels are per model: a list
      // that did not say which model it described would be the fabrication C165 recorded.
      ...reasoning === undefined || reasoning.levels === undefined
        ? {}
        : { reasoning: { model: `${reasoning.provider}/${reasoning.model}`, efforts: [...reasoning.levels] } },
      ...reasoning?.note === undefined ? {} : { reasoningNote: reasoning.note },
    }

    if (request.action === 'show') {
      const first = providers[0]?.id
      const models = first === undefined ? [] : await catalog.listModels(first)
      return {
        state,
        ...nextSelection === undefined ? {} : { nextSelection },
        ...lastActuallyUsed === undefined ? {} : { lastUsed: lastActuallyUsed },
        ...nextSelectionSource === undefined ? {} : { nextSelectionSource },
        ...nextSelectionPersisted === undefined ? {} : { nextSelectionPersisted },
        ...catalogue,
        models: models.map(model => model.id),
        notes: [...reasoning?.levels === undefined || reasoning.note === undefined ? [] : [reasoning.note], ...nextSelectionNote === undefined ? [] : [nextSelectionNote]],
        changed: false,
        summary: `Model configuration for ${task.taskId}:\n${state}\n`
          + `Providers this Host registers: ${providers.length === 0 ? '(none)' : catalogue.providers.join(', ')}.\n`
          + (reasoning === undefined
            ? 'No reasoning levels were read: this Host advertises no provider or no model to read them for.\n'
            : reasoning.levels === undefined
              ? `Reasoning levels: none published for ${reasoning.provider}/${reasoning.model}. ${reasoning.note ?? ''}\n`
              : `Reasoning levels for ${reasoning.provider}/${reasoning.model}: ${reasoning.levels.join(', ')}.\n`)
          + 'These come from the Host\'s own catalogue, not from a list held by the conductor.',
      }
    }

    if (request.provider === undefined || request.model === undefined) {
      throw new Error('BAD_REQUEST: changing the model needs both the provider and the model')
    }
    const resolved = resolveSelection(
      {
        provider: request.provider,
        model: request.model,
        ...request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort },
      },
      catalog,
      // Checked against the levels the Host publishes **for this model**, which is the only thing that can
      // answer it: a bulk list would be the wrong question, since two models of one provider differ.
      request.reasoningEffort === undefined
        ? undefined
        : await publishedReasoningOf(
            llm as { resolveModelInfo?(provider: string, model: string): Promise<unknown> } | undefined,
            request.provider,
            request.model,
          ),
    )
    if (!resolved.ok) {
      return {
        state, ...catalogue, models: [], notes: [resolved.reason], changed: false,
        summary: `The model configuration was not changed: ${resolved.reason}`,
      }
    }
    const listing = await modelListingNotes(resolved.selection, catalog)
    // Catalogue reads yield to control transfer and environment handoff. Recheck the original
    // authorization and binding immediately before calling the Host writer.
    throwUnlessController(request.taskId, request.callerSessionId)
    const latestTask = current.getTask(request.taskId)
    const latestBinding = latestTask?.currentBindingId === undefined
      ? undefined : current.getBinding(latestTask.currentBindingId)
    if (current.getAccess(request.taskId)?.ownerEpoch !== ownerEpoch) {
      throw new Error('STALE_OWNER_EPOCH: control changed while resolving the model selection')
    }
    if (latestTask?.currentBindingId !== task.currentBindingId || latestBinding?.version !== binding?.version) {
      throw new Error('STALE_BINDING: the target session changed while resolving the model selection')
    }
    const applied = await applySelection(resolved.selection, {
      // The Host extension is what makes `rememberAsDefault: false` a declared parameter;
      // without it the conductor refuses rather than changing the global default.
      rememberAsDefaultSupported: config.hostExtensions.selectModelRememberAsDefault,
    }, modelSelectionWriterOf(probeContext.get(MODEL_SELECTION_WRITER_SERVICE)), binding?.sessionId)
    if (!applied.ok) {
      return {
        state, ...catalogue, models: [], notes: [...resolved.notes, ...listing, applied.reason], changed: false,
        summary: `The model configuration change was not confirmed: ${applied.reason}`,
      }
    }
    // The writer has confirmed the selection for the next request, so the response must not carry the
    // pre-write state above. The durable panel projection remains deliberately partial (C166): it has no
    // reader for this optional companion service and therefore cannot assert this fact after a restart.
    const stateAfterApply = describeConfigState({ ...stateInput, forNextRequest: applied.selection })
    return {
      state: stateAfterApply, ...catalogue, models: [], notes: [...resolved.notes, ...listing], changed: true,
      nextSelection: applied.selection,
      ...lastActuallyUsed === undefined ? {} : { lastUsed: lastActuallyUsed },
      summary: `${task.taskId} will use ${applied.selection.provider}/${applied.selection.model} from the next request `
        + 'the Host assembles; a request already in flight is not altered. The Host\'s global model default was NOT '
        + 'changed, because the conductor always passes rememberAsDefault: false.'
        + (resolved.notes.length + listing.length === 0
          ? ''
          : `\n${[...resolved.notes, ...listing].map(note => `- ${note}`).join('\n')}`),
    }
  }

  /**
   * Derive the state facts of one task, once, for every surface that shows them (PRD §二.1, §二.5).
   *
   * The panel's card, the task detail and `conductor_list`'s status filter all need the same things: the
   * binding and its session, the projection read from the Host's own log, the control/observer record, the
   * budgets that govern the task, and the **status badge** §二.1 filters and groups by. Deriving them in
   * three places is how a card and a tool end up disagreeing about whether a task is budget-limited or
   * released — and a list that filters on a badge the card does not show is worse than a list with no
   * filter, because both look authoritative. So there is one derivation, and every caller reads it.
   *
   * @param current - the open store.
   * @param task - the task to describe.
   * @param now - the instant the caller is answering as of; one instant per payload, so two cards in the
   * same answer cannot disagree about an expiring deadline.
   * @returns the facts, including the derived badge.
   */
  const panelFactsOf = (current: ConductorStore, task: TaskRecord, now: string) => {
    const binding = task.currentBindingId === undefined ? undefined : current.getBinding(task.currentBindingId)
    const remote = binding !== undefined && binding.hostId !== 'local' && binding.hostId !== configOf().bridge?.hostId
      ? remotePanelFacts.read(binding, Date.parse(now)) : undefined
    const live = binding === undefined || remote !== undefined
      ? undefined
      : (probeContext.get('agents') as ObservableAgentsLike | undefined)?.get(binding.sessionId)
    const events = live?.session.events as readonly SessionEventLike[] | undefined
    const folded = events === undefined ? initialProjection() : projectEvents(initialProjection(), events).state
    const projection = remote?.projection ?? (binding === undefined || events === undefined
      ? folded
      : overlayTaskState(task.taskId, binding.sessionId, folded, events))
    const access = current.getAccess(task.taskId)
    const monitoring = access?.detachedAt === undefined ? undefined : monitoringAllowed(access)
    const governing = budgetsGoverning(current, task.taskId)
    const budgetRefusal = governing.length === 0 ? undefined : budgetPermits(current, task.taskId, now)
    // §二.1's "状态筛选" and "分组" need a stable key, and the card's "创建中…预算受限等特殊状态" needs to be
    // derived from something that is actually checked. The special states come from three facts the
    // projection does not carry — the persisted preparation, the **release** record, and the budget gate
    // that really refuses dispatches — and the ordinary ones from the projection beside them. The budget
    // half is read from `budgetPermits` rather than re-derived, so a card cannot say "budget limited"
    // while the dispatcher is still dispatching (or the reverse).
    const storedPending = pendingInterventionFromWatches(current.listEveryWatch(), task.taskId)
    const pending = live === undefined && remote === undefined
      ? storedPending
      : pendingInterventionOf(projection.interaction)
    const badge = panelStatusOf({
      preparation: task.preparation,
      execution: projection.execution,
      interaction: pending ?? 'none',
      ...monitoring === undefined || monitoring.allowed ? {} : { releasedReason: monitoring.reason },
      ...budgetRefusal === undefined || budgetRefusal.allowed ? {} : { budgetRefusal: budgetRefusal.reason },
    })
    const reach = remote?.reach ?? (binding === undefined
      ? undefined
      : connectionOf({ live: live !== undefined }))
    return { binding, live, projection, pending, access, monitoring, governing, budgetRefusal, badge, reach }
  }

  /**
   * The status badge for one task, derived by the same code the panel uses (PRD §二.1, §二.5).
   *
   * Handed to the tools so `conductor_list` can filter by the badge a reader sees. It answers `undefined`
   * when there is no open store or no such task, which the tool reports as "no such task" rather than as a
   * badge that happens not to match.
   *
   * @param taskId - the task whose badge is wanted.
   * @returns the badge and its reason, or undefined when the task cannot be read.
   */
  const taskStatusOf = (taskId: string): TaskStatusReading | undefined => {
    const current = store
    if (current === undefined) return undefined
    const task = current.getTask(taskId)
    if (task === undefined) return undefined
    const facts = panelFactsOf(current, task, new Date().toISOString())
    const unread = unreadCountOf(current.listNotifications({ taskId: task.taskId }))
    const modelLastUsed = describeLoggedModel(loggedSelectionOf(facts.live?.session))
    const archiveRead = archivedSessionsOf(probeContext)?.()
    const archived = archiveRead?.state === 'published' ? archiveRead.sessionIds : undefined
    const sessionArchivedExternally = facts.binding === undefined || archived === undefined
      ? undefined
      : archived.includes(facts.binding.sessionId)
    return {
      ...facts.badge,
      execution: facts.projection.execution,
      ...connectionListFields(facts.reach),
      ...lastTurnFieldsOf(facts.projection),
      ...facts.pending === undefined ? {} : { pendingInteraction: facts.pending },
      ...modelLastUsed === undefined ? {} : { modelLastUsed },
      ...unread === 0 ? {} : { unread },
      ...sessionArchivedExternally === undefined ? {} : { sessionArchivedExternally },
    }
  }

  /**
   * Build the panel's read-only view of the tasks.
   *
   * The fields are the card fields of PRD §二.1 and nothing else: identity, state,
   * configuration and counts. No message content, no artifact contents, no operation
   * payloads — a panel that showed more would be a second, unaudited read path beside
   * `conductor_read`, which is the one with cursors, truncation and per-reader semantics.
   *
   * @param current - the open store.
   * @returns the payload the route serves.
   */
  const panelPayloadOf = (current: ConductorStore): PanelPayload => {
    const tasks = current.listTasks()
    // One instant for the whole payload rather than one per task: a deadline that expires while the
    // list is being built must not make two cards in the same answer disagree about it.
    const now = new Date().toISOString()
    // §二.5's externally-archived fact, read **once** for the whole payload through the same reader
    // discovery uses — a per-task read could answer differently inside one list, and the Host replaces
    // the set on every change. `undefined` state means the set could not be read, which is reported in
    // the notes rather than rendered as "not archived".
    const archivedRead = archivedSessionsOf(probeContext)?.()
    const archived = archivedRead?.state === 'published' ? archivedRead.sessionIds : undefined
    const views: PanelTaskView[] = []
    for (const task of tasks) {
      const { binding, live, projection, pending, badge, reach } = panelFactsOf(current, task, now)
      // Unread reports are counted from the durable records rather than from the
      // projection: "how many facts were reported to me" is a conductor fact, not a
      // session one, and the panel is for a reader rather than for a session.
      const unread = unreadCountOf(current.listNotifications({ taskId: task.taskId }))
      // §二.1's card shows "实际模型配置及待生效配置", and §二.3 requires the two to be shown **separately**.
      // The actually-used half is the Host's own logged request header, read through the same helper the
      // model tool uses so the card and the tool cannot disagree. The next-request half is NOT produced:
      // it is the plugin's own pending selection, and this build stores none (the only writer would be a
      // model change, which is refused without a Host extension — C164). A card that filled it in with
      // the last-used value would assert that nothing is pending, which nothing here has established.
      const modelLastUsed = describeLoggedModel(loggedSelectionOf(live?.session))
      views.push({
        taskId: task.taskId,
        title: task.title,
        preparation: task.preparation,
        execution: projection.execution,
        status: badge.status,
        ...badge.reason === undefined ? {} : { statusReason: badge.reason },
        ...lastTurnFieldsOf(projection),
        ...pending === undefined ? {} : { pendingInteraction: pending },
        ...binding === undefined ? {} : { cwd: binding.cwd },
        // §二.1's card shows the project and the Host, and both were declared on the view with
        // nothing producing them — so the card could not show either.
        ...task.originRepoPath === undefined ? {} : { project: task.originRepoPath },
        ...binding === undefined ? {} : { hostId: binding.hostId },
        // §二.1's 打开原会话 needs the session to open, and the card carried every other identity but
        // that one — so the panel had nothing to navigate to.
        ...binding === undefined ? {} : { sessionId: binding.sessionId },
        ...sessionContinuationFields(current.listBindings(task.taskId), task.currentBindingId),
        // §二.5's 外部归档, for the same reason the tool reports it: a managed task's session can be
        // archived in the Host's own sidebar, and a reader who cannot see that would read the panel's
        // own archive flag as the whole story.
        ...binding === undefined || archived === undefined
          ? {}
          : { sessionArchivedExternally: archived.includes(binding.sessionId) },
        ...reach === undefined ? {} : {
          connection: reach.connection,
          unrecoverable: reach.unrecoverable,
          connectionReason: reach.reason,
        },
        ...modelLastUsed === undefined ? {} : { modelLastUsed },
        ...unread === 0 ? {} : { unread },
        pinned: task.pinned,
        updatedAt: task.updatedAt,
      })
    }
    return {
      generatedAt: new Date().toISOString(),
      total: views.length,
      tasks: sortTaskList(views),
      refreshMergeMs: configOf().panelRefreshMergeMs,
      notes: [
        'Selection metadata only: this route serves task identity, state and counts. Message content is read '
        + 'through conductor_read, which keeps per-reader cursors and marks truncation.',
        // Measured: `unread` is unacknowledged reports for the task. Opening this route
        // or a detail view does not acknowledge them (PRD §二.7: a detail view does not
        // consume another reader's unread). `conductor_watch ack` is the step that marks
        // a controller's reports read; withdrawn reports never count.
        'unread is the count of reports about the task that have not been acknowledged. '
        + 'Opening the panel or a detail view does not decrease it. conductor_watch ack marks '
        + 'that controller\'s reports read and does not move a wait or snapshot cursor.',
        'status is a derived badge for the list\'s filter and grouping, not the state model. Preparation, '
        + 'execution, interaction and the last turn stay separate on every card, and are the fields to read '
        + 'when they disagree with the badge. lastTurn is 最近结果; lastTurnDetail is 最近进展 (PRD §二.1), '
        + 'the Host\'s own reason for that turn, and is omitted before the first turn ends.',
        'The list is pinned first, then newest by updatedAt (PRD §二.5 置顶及排序). pinned is the conductor-side '
        + 'flag conductor_update sets; it is not the Host sidebar pin. updatedAt is rendered on the card (PRD §二.1).',
        'continuation is PRD §二.10.2\'s 任务继续于新会话 sentence, with sessionChain the predecessor/successor '
        + 'ids. Both are omitted when the task has only ever had one session. Identities only — no message content.',
        'connection is the reachability of the bound session (PRD §三.4, §二.5): online, or unavailable for 失联. '
        + 'unrecoverable (不可恢复) is only claimed when persistence was read and said the session is gone; '
        + 'this route does not query persistence, so a missing live agent is 失联 rather than 不可恢复. '
        + 'reconnecting is in the vocabulary and is not produced: this Host publishes no per-session signal for it.',
        // §二.3 requires "最近实际使用" and "下次请求配置" to be shown separately, and only the first is
        // readable from a plugin in this build. Saying which one is missing — and why — is the difference
        // between a card a reader can trust and a card with an oddly empty field.
        'modelLastUsed is the configuration the Host logged for the task\'s last assembled request. '
        + 'modelForNextRequest is not produced: it is the conductor\'s own pending selection, and this build '
        + 'stores none because a model change is refused without a companion Host extension (C164). An empty '
        + 'modelForNextRequest means "nothing pending is known", not "no change is pending".',
        // §二.5 requires the interface to show the scope of the conductor's own archive, and two things can be
        // archived: the conductor's task (a plugin record) and the Host session (the user's, in the Host's own
        // list). This route reports the second and **not** the first, which is the fact a reader has to be told
        // rather than left to infer from an absent field.
        'This route reports one of the two archives and not the other. sessionArchivedExternally is the Host\'s '
        + `own registry-global archive of the task's session — ${describeArchiveForPanel(archivedRead)}. The `
        + 'conductor\'s own archive of a task is a plugin record this route does not report: it is set and read '
        + 'through the conductor tools (conductor_update, and conductor_list\'s archived filter), and it never '
        + 'touches the Host\'s set, so archiving or restoring a task here cannot change what the Harness sidebar '
        + 'shows.',
        'This route is read-only and is not an authorization boundary. The Host documents its own /api fence as a '
        + 'DNS-rebinding fence rather than an auth layer, and a browser caller\'s identity is not established by the '
        + 'Host; every mutation goes through the conductor tools, where it is.',
        `refreshMergeMs is ${String(configOf().panelRefreshMergeMs)}: overlapping panel refreshes inside that window share one `
          + 'Host round-trip (PRD §四.7). It is not a poll interval.',
      ],
    }
  }

  /**
   * Build one task's detail view (PRD §二.1's 任务详情: 聊天、成果、操作记录、配置与权限).
   *
   * Three of the four are served, and the fourth is refused **by name** rather than left blank:
   * conversation history belongs to `conductor_read`, which keeps a per-reader cursor, marks truncation
   * and decides what a reader may see. A second read path here would have none of those, and a view that
   * rendered nothing for chat would read as "there was no conversation" — the one misreading this field
   * exists to prevent.
   *
   * Everything else is the stored fact: artifacts with their acceptance and existence kept apart,
   * operations with the delivery stage and their §四.2 attribution, the configuration the task actually
   * got, and the control relationship. Nothing here is content — artifact evidence is reduced to a count
   * because evidence strings can quote file contents, and this route serves none.
   *
   * @param current - the open store.
   * @param taskId - the task to describe.
   * @returns the detail, or undefined when no such task is recorded.
   */
  const panelDetailOf = (current: ConductorStore, taskId: string): PanelTaskDetail | undefined => {
    const task = current.getTask(taskId)
    if (task === undefined) return undefined
    const now = new Date().toISOString()
    // The same derivation the card and the list filter use, so the detail cannot disagree with either.
    const { binding, live, projection, pending, access, governing, badge, reach } = panelFactsOf(current, task, now)
    const modelLastUsed = describeLoggedModel(loggedSelectionOf(live?.session))
    // §二.5's externally-archived fact, read through the same adapter discovery uses, and once per request
    // for the same reason: the Host installs a new array on every change, and a cached copy would report the
    // archive set as it was when the panel first loaded.
    const archiveRead = archivedSessionsOf(probeContext)?.()
    const archived = archiveRead?.state === 'published' ? archiveRead.sessionIds : undefined

    // Artifacts the task produced, newest first — the same order the store lists them in, so the panel
    // and `conductor_artifact_list` do not disagree about what "most recent" means.
    const artifacts: PanelArtifactFact[] = current.listArtifacts({ taskId: task.taskId }).map(record => {
      const provenance = describeArtifactProvenance(record)
      return {
        artifactId: record.artifactId,
        kind: record.kind,
        name: record.name,
        acceptance: record.acceptance,
        existence: record.existence,
        facts: describeArtifactFacts(record),
        contentVersion: record.contentVersion,
        ...record.acceptedBy === undefined ? {} : { acceptedBy: record.acceptedBy },
        ...record.acceptedAt === undefined ? {} : { acceptedAt: record.acceptedAt },
        evidenceCount: record.evidence.length,
        ...record.verifiedAt === undefined ? {} : { verifiedAt: record.verifiedAt },
        ...record.path === undefined && record.url === undefined && record.gitRef === undefined
          ? {}
          : { location: record.path ?? record.url ?? record.gitRef },
        ...record.sessionId === undefined ? {} : { sourceSessionId: record.sessionId },
        ...record.turn === undefined ? {} : { sourceTurn: record.turn },
        ...provenance === undefined ? {} : { constraints: provenance },
      }
    })

    const operations: PanelOperationFact[] = current.listOperations({ taskId: task.taskId }).map(record => ({
      operationId: record.operationId,
      kind: record.kind,
      delivery: record.delivery,
      withdrawn: record.withdrawn,
      ...record.phase === undefined ? {} : { phase: record.phase },
      ...record.messageId === undefined ? {} : { messageId: record.messageId },
      ...record.attribution === undefined ? {} : { source: record.attribution.kind },
      ...record.attribution?.grantId === undefined ? {} : { grantId: record.attribution.grantId },
      ...record.attribution?.ruleId === undefined ? {} : { ruleId: record.attribution.ruleId },
      createdAt: record.createdAt,
    }))

    const notices = current.listNotifications({ taskId: task.taskId })
    const unreadCount = unreadCountOf(notices)
    const unreadItems = unreadItemsOf(notices)

    const budgets: PanelBudgetFact[] = governing.map(entry => {
      const ledger = ledgerOfRecord(current, entry.ledgerTargetId)
      return {
        policyKey: entry.label,
        scope: entry.policy.scope,
        // The policy shape keeps `strict` optional, so it is read as a question rather than passed
        // through: a policy that says nothing about strictness is not a strict one.
        strict: entry.policy.strict === true,
        limits: [...budgetLimitsOf(entry.policy)],
        dispatches: ledger.dispatches,
        attempts: ledger.attempts,
        reworkRounds: ledger.reworkRounds,
        // Through `describeUsage`, so a figure this deployment cannot meter never reads as zero.
        tokens: describeUsage(ledger.tokens, 'tokens'),
        cost: describeUsage(ledger.cost, 'cost'),
        ...ledger.firstDispatchedAt === undefined ? {} : { firstDispatchedAt: ledger.firstDispatchedAt },
      }
    })

    return {
      taskId: task.taskId,
      title: task.title,
      status: badge.status,
      ...badge.reason === undefined ? {} : { statusReason: badge.reason },
      preparation: task.preparation,
      preparationPhase: task.preparationPhase,
      execution: projection.execution,
      ...pending === undefined ? {} : { pendingInteraction: pending },
      ...lastTurnFieldsOf(projection),
      ...binding?.cwd === undefined ? {} : { cwd: binding.cwd },
      ...task.originRepoPath === undefined ? {} : { project: task.originRepoPath },
      ...binding === undefined ? {} : { hostId: binding.hostId },
      ...binding === undefined ? {} : { sessionId: binding.sessionId },
      ...sessionContinuationFields(current.listBindings(task.taskId), task.currentBindingId),
      ...binding === undefined || archived === undefined
        ? {}
        : { sessionArchivedExternally: archived.includes(binding.sessionId) },
      ...reach === undefined ? {} : {
        connection: reach.connection,
        unrecoverable: reach.unrecoverable,
        connectionReason: reach.reason,
      },
      artifacts,
      operations,
      ...unreadCount === 0 ? {} : { unreadCount, unreadItems },
      configuration: {
        contextMode: task.contextMode,
        // What the task actually got, which can differ from what was asked for — the whole reason both
        // fields exist (PRD §二.2.2).
        ...task.context === undefined ? {} : { contextReceived: task.context.mode },
        ...task.start === undefined ? {} : {
          start: { strategy: task.start.strategy, commit: task.start.commit, created: task.start.created },
        },
        ...task.workspaceId === undefined ? {} : { workspaceId: task.workspaceId },
        ...task.preset === undefined ? {} : { preset: task.preset },
        ...(() => {
          const origin = forkOriginOf(current.getContext(`fork-${task.taskId}`))
          if (origin === undefined) return {}
          return {
            ...origin.sourceTaskId === undefined ? {} : { forkSourceTaskId: origin.sourceTaskId },
            forkSourceSessionId: origin.sourceSessionId,
            forkCutoffSeq: origin.cutoffSeq,
          }
        })(),
        budgets,
        // The Host's own record of what the last assembled request used (PRD §二.3's 最近实际使用).
        ...modelLastUsed === undefined ? {} : { modelLastUsed },
      },
      ...access === undefined ? {} : {
        access: {
          ownerSessionId: access.ownerSessionId,
          ownerEpoch: access.ownerEpoch,
          observerSessionIds: [...access.observerSessionIds],
          ...access.detachedAt === undefined ? {} : { detachedAt: access.detachedAt },
          updatedAt: access.updatedAt,
        },
      },
      refusals: [
        'Message history is available in the authorized task chat through the shared conductor_read service. '
        + 'Select a controller in this panel to read its permitted history; cursors and truncation remain explicit.',
        // §二.5 requires the interface to show the scope of the conductor's own archive: two archives exist,
        // and this route can report only one of them.
        'Two archives exist and this route reports one. sessionArchivedExternally is the Host\'s '
        + `registry-global session archive — the user's, read-only here and one-way in this build — ${describeArchiveForPanel(archiveRead)}. `
        + 'The conductor\'s own archive of a task (PRD §二.5\'s 插件任务归档) is not reported by this route: it '
        + 'is a plugin record, written and read through conductor_update and conductor_list\'s archived filter, and '
        + 'it never calls the Host\'s interface — which is the scope §二.5 requires to be stated. Archiving or '
        + 'restoring a task therefore cannot change what the Harness sidebar shows.',
        // Corrected rather than softened: the previous wording said the conductor "does not store" a
        // selection, which is true but is not the whole answer — the Host's own logged configuration *is*
        // reported above, and what is missing is the *pending* half of §二.3's pair.
        'The configuration the NEXT request will use is not reported. §二.3 asks for it separately from the one '
        + 'the last request actually used, and the next-request half is the conductor\'s own pending selection: '
        + 'this build stores none, because the only writer would be a model change and conductor_model refuses '
        + 'one without a companion Host extension (C164). The line above is the Host\'s own record of the last '
        + 'assembled request, not a claim about the next one.',
        'Unread items listed here are observations that have not been acknowledged. Opening this view '
        + 'does not mark them read (PRD §二.7). conductor_watch ack is the step that does, and it does '
        + 'not move a wait or snapshot cursor.',
        ...governing.length === 0
          ? ['No budget governs this task, so nothing limits its automatic dispatches. That is an absence of a '
            + 'policy, not a policy of no limits.']
          : [],
      ],
    }
  }

  /**
   * Calibrate the operations a restart found unresolved (PRD §四.5, §四.1).
   *
   * One state change, decided by {@link calibrateOperation}: an operation that was mid-dispatch when the
   * process stopped becomes `unknown`, because whether the Host received it cannot be confirmed from here and
   * §四.1 says an unconfirmable delivery is reconciled rather than resent. Everything else is **reported** as
   * it stands — a claimed-but-undispatched request is not finished automatically, and a preparation is not
   * resumed, because creating a session or a worktree is the controller's decision.
   *
   * The transition is checked against the same table every other delivery move uses, so a state the model does
   * not allow is refused here rather than written because this caller believed it was fine.
   *
   * @param current - the store that has just opened.
   * @returns a one-line account for the mount log.
   */
  const recoverOperations = async (current: ConductorStore): Promise<string> => {
    const unresolved = current.listRecoverableOperations()
    if (unresolved.length === 0) return 'no operation was left unresolved'

    let marked = 0
    const refused: string[] = []
    for (const entry of unresolved) {
      const outcome = calibrateOperation({ kind: entry.record.kind, delivery: entry.record.delivery })
      if (outcome.action !== 'mark_unknown') continue
      if (!canTransition('delivery', entry.record.delivery, 'unknown')) {
        // Reported instead of written: the table says this move is illegal, and a calibration that overrode it
        // would be inventing a transition the state model does not have.
        refused.push(`${entry.record.operationId}: ${entry.record.delivery} cannot move to unknown in one step`)
        continue
      }
      await current.markDelivery(entry.record.operationId, 'unknown', 'calibrated_after_restart')
      marked += 1
    }

    const kinds = [...new Set(unresolved.map(entry => entry.record.kind))].join(', ')
    return `${String(unresolved.length)} operation(s) were unresolved after restart (${kinds}): `
      + `${String(marked)} moved dispatching → unknown and left for reconciliation, never resent; `
      + `${String(unresolved.length - marked)} reported as they stand.`
      + (refused.length === 0 ? '' : ` ${String(refused.length)} could not be calibrated: ${refused.join('; ')}`)
  }

  /**
   * The cross-Host surface (PRD §二.14.1).
   *
   * Registration and the four compatibility checks are real; `migrate` is refused with the
   * reason, because the transport the specification describes does not exist in this build.
   * That split is the honest one: the decision rules are implemented and tested, and saying
   * so while refusing the transfer beats an action that looks available and fails at the
   * first attempt.
   *
   * @param request - what the caller asked for.
   * @returns the registrations, the checks and any refusal.
   */
  const remoteOf = async (request: RemoteToolRequest): Promise<RemoteToolResult> => {
    if(!store)throw Error('NO_DURABLE_STATE')
    const current=store
    return await remoteAction({store:current,config:configOf(),runtime:remoteRuntime,pluginVersion,
      reconcileReceipt:async(operationId,hostId,result)=>{await reconcileRemoteSource({store:current,operationId,hostId,result,
        counted:async(taskId,id,at)=>await countDispatch(current,taskId,at,undefined,id)})},
    },request)
  }

  const remoteObservationOf=async(taskId:string,readerSessionId:string,afterCursor:string,signal?:AbortSignal):Promise<TaskObservation|undefined>=>{
    const current=store
    if(!current)throw Error('NO_DURABLE_STATE')
    throwUnlessReader(taskId,readerSessionId)
    const binding=current.getBinding(current.getTask(taskId)?.currentBindingId??'')
    if(!binding || binding.hostId==='local' || binding.hostId===configOf().bridge?.hostId)return undefined
    signal?.throwIfAborted()
    const generation=remotePanelFacts.begin(binding)
    try{
      if(!remoteRuntime || !configOf().crossHostEnabled)throw Error('REMOTE_OBSERVATION_UNAVAILABLE')
      const afterSeq=observationAfterCursor(afterCursor,binding.sessionId)
      const result=taskObservationSchema.parse(await remoteRuntime.router.request(binding.hostId,'task.observe',{taskId,afterSeq,limit:1000},undefined,undefined,signal))
      signal?.throwIfAborted()
      throwUnlessReader(taskId,readerSessionId)
      const latest=current.getBinding(current.getTask(taskId)?.currentBindingId??'')
      if(latest?.bindingId!==binding.bindingId || latest.version!==binding.version || result.taskId!==taskId || result.sessionId!==binding.sessionId
        || result.notable.some(entry=>entry.seq<=afterSeq))throw Error('REMOTE_OBSERVATION_STALE_OR_INVALID')
      remotePanelFacts.accept(binding,generation,{execution:result.state.execution,cursor:String(result.position),
        ...result.state.interaction==='none'?{}:{pendingIntervention:result.state.interaction},
        ...result.state.lastTurn===undefined?{}:{lastTurn:result.state.lastTurn},...result.state.lastTurnDetail===undefined?{}:{lastTurnDetail:result.state.lastTurnDetail},
        ...result.state.openTurn===undefined?{}:{expectedTurn:result.state.openTurn},...result.state.openTurnStartSeq===undefined?{}:{expectedStartSeq:result.state.openTurnStartSeq}},Date.now())
      return {...result,bindingVersion:binding.version,ownerEpoch:current.getAccess(taskId)!.ownerEpoch}
    }catch(error){remotePanelFacts.fail(binding,generation);throw error}
  }

  const remoteReadOf = async (request:RemoteReadToolRequest):Promise<RemoteReadToolResult|undefined> => {
    if(!store)throw Error('NO_DURABLE_STATE')
    throwUnlessReader(request.taskId,request.callerSessionId)
    const binding=store.getBinding(store.getTask(request.taskId)?.currentBindingId??'')
    if(!binding || binding.hostId==='local' || binding.hostId===configOf().bridge?.hostId)return undefined
    const generation = remotePanelFacts.begin(binding)
    try {
      if(!remoteRuntime || !configOf().crossHostEnabled)throw Error('REMOTE_UNAVAILABLE: read requires the configured remote bridge')
      const result=await remoteRuntime.router.request(binding.hostId,'task.read',{taskId:request.taskId,view:request.view,
        afterCursor:request.afterCursor??String(remoteHistoryCursor(store,binding,request.callerSessionId)),
        ...request.limit===undefined?{}:{limit:request.limit}}) as RemoteReadToolResult
      const schema = panelDefinitions.get('conductor_read')?.output.schema
      if (schema === undefined || validateJsonSchemaValue(schema, result).length !== 0 || result.taskId !== request.taskId
        || (result.error === undefined && result.sessionId !== binding.sessionId)) throw Error('REMOTE_INVALID_READ_RECEIPT')
      throwUnlessReader(request.taskId, request.callerSessionId)
      const latest = store.getBinding(store.getTask(request.taskId)?.currentBindingId ?? '')
      if (latest?.bindingId !== binding.bindingId || latest.version !== binding.version) throw Error('STALE_BINDING')
      if (result.error !== undefined) remotePanelFacts.fail(binding, generation)
      else {
        if(request.view==='history')await persistRemoteHistoryCursor(store,binding,request.callerSessionId,result.cursor)
        throwUnlessReader(request.taskId,request.callerSessionId)
        const finalBinding=store.getBinding(store.getTask(request.taskId)?.currentBindingId??'')
        if(finalBinding?.bindingId!==binding.bindingId || finalBinding.version!==binding.version)throw Error('STALE_BINDING')
        remotePanelFacts.accept(binding, generation, result, Date.now())
      }
      return { ...result, bindingVersion: binding.version,
        ...store.getAccess(request.taskId) === undefined ? {} : { ownerEpoch: store.getAccess(request.taskId)!.ownerEpoch } }
    } catch (error) { remotePanelFacts.fail(binding, generation); throw error }
  }

  /** Resolve the operator-configured client without making a network request. */
  const shareServiceOf = async (): Promise<ShareServicePort | undefined> => {
    const config = configOf()
    if (!config.shareEnabled) return undefined
    let service = probeContext.get('conductorShareService') as ShareServicePort | undefined
    if (!service && config.shareEnabled && config.shareServiceUrl && config.shareTokenEnv) {
      const token = process.env[config.shareTokenEnv]
      if (token) service = createShareClient({baseUrl:config.shareServiceUrl,bearerToken:token,
        ...config.shareCaFile ? {ca:await readFile(config.shareCaFile)} : {}})
    }
    if (service && (typeof service.publish !== 'function' || typeof service.status !== 'function' || typeof service.revoke !== 'function')) {
      throw new Error('SHARE_SERVICE_INVALID: the configured service does not expose the finite snapshot protocol')
    }
    return service
  }

  /** Fixed preview, explicitly confirmed publication and acknowledged revocation. */
  const shareOf = async (request: ShareToolRequest): Promise<ShareToolResult> => {
    const current = store
    if (!current) throw new Error('NO_DURABLE_STATE')
    const config = configOf()
    const service = await shareServiceOf()
    return await createShareCoordinator({store:current,service,enabled:config.shareEnabled,lifetimeDays:config.shareLifetimeDays,
      build: async input => {
        const exported = await exportOf({action:'export',taskId:input.taskId!,format:input.format??'markdown',authorizedBy:input.authorizedBy})
        const attachments: ShareAttachment[] = []
        const fs = probeContext.get('fs') as ArtifactFsPort | undefined
        let total = Buffer.byteLength(exported.document,'utf8')
        for (const artifactId of input.attachmentIds ?? []) {
          const artifact = current.getArtifact(artifactId)
          if (!artifact || artifact.taskId!==input.taskId || !artifact.path || !fs) throw new Error('ATTACHMENT_UNAVAILABLE: selected artifact cannot be bundled')
          const target = await fs.resolve(artifact.path)
          const stat = await fs.stat(target)
          if (!stat || stat.type!=='file' || stat.size===undefined || stat.size>MAX_SHARE_BYTES-total) throw new Error('ATTACHMENT_UNAVAILABLE: selected artifact is not a bounded regular file')
          const bytes = Buffer.from(await fs.readBytes(target,undefined,stat.size+1))
          if (bytes.length!==stat.size) throw new Error('ATTACHMENT_CHANGED: preview again after the file settles')
          const hash = createHash('sha256').update(bytes).digest('hex')
          if (artifact.contentHash && artifact.contentHash!==hash) throw new Error('ATTACHMENT_CHANGED: verify the new artifact version before sharing')
          total += bytes.length
          attachments.push({artifactId,name:basename(artifact.path),base64:bytes.toString('base64'),sha256:hash})
        }
        const document = exported.document
        return {document,attachments,preview:{snapshotId:'pending',taskId:input.taskId!,cutoffAt:exported.cutoffAt,
          format:input.format??'markdown',byteSize:total,includes:['Fixed task state, session chain, and artifact metadata',...attachments.map(a=>'Attachment '+a.artifactId+' SHA-256 '+a.sha256)],
          excludes:exported.excluded,warnings:['Future task changes are excluded.','Revocation cannot recall downloaded copies.',...exported.problems]}}
      },
    })(request)
  }

  /**
   * Preview and clean plugin-owned resources (PRD §三.6, T32).
   *
   * Stop, archive, unmanage, migrate and uninstall never delete these. The
   * registry is populated when a Git starting state creates a worktree —
   * including a worktree that preparation then refused, because that leftover
   * is exactly what cleanup exists to name. Execute requires a confirmed
   * selection; referenced, modified and unknown directories are refused rather
   * than forced, and `git worktree remove` is never passed `--force`.
   *
   * @param request - preview, or a confirmed execute of named ids.
   * @returns the preview rows, what was cleaned, and any refusal.
   */
  const cleanupOf = async (request: CleanupToolRequest): Promise<CleanupToolResult> => {
    const current = store
    if (current === undefined) throw new Error('NO_DURABLE_STATE: the conductor has no durable state')
    const git = hostGitRunner(probeContext)
    const io = snapshotIoOf(probeContext)

    const referencesOf = (path: string): string[] => {
      const refs: string[] = []
      for (const task of current.listTasks()) {
        if (task.currentBindingId === undefined) continue
        const binding = current.getBinding(task.currentBindingId)
        if (binding?.cwd !== undefined && samePath(binding.cwd, path)) {
          refs.push(`task ${task.taskId} (current working directory)`)
        }
      }
      for (const artifact of current.listArtifacts()) {
        if (artifact.path !== undefined && underPath(artifact.path, path)) {
          refs.push(`artifact ${artifact.artifactId}`)
        }
      }
      return refs
    }

    const treeOf = async (path: string): Promise<TreeState> => {
      if (io !== undefined && !(await io.exists(path))) return 'missing'
      if (git === undefined) return 'unknown'
      const state = await readRepoState(git, path)
      if (state === undefined) return 'unknown'
      return state.dirty ? 'modified' : 'clean'
    }

    const itemOf = async (record: ResourceStoreRecord): Promise<CleanupPreviewItem> => {
      const referencedBy = record.status === 'cleaned' ? [] : referencesOf(record.path)
      const tree = record.status === 'cleaned' ? 'missing' : await treeOf(record.path)
      const decision = cleanupDecision({
        owned: record.owned,
        alreadyCleaned: record.status === 'cleaned',
        referencedBy,
        tree,
      })
      return {
        resourceId: record.resourceId,
        kind: record.kind,
        path: record.path,
        taskId: record.taskId,
        createdReason: record.createdReason,
        status: record.status,
        owned: record.owned,
        referenced: referencedBy.length > 0,
        referencedBy,
        retention: record.path,
        tree,
        eligible: decision.allowed,
        condition: decision.reason,
      }
    }

    const listed = (): ResourceStoreRecord[] => {
      const registered = current.listResources()
      const known = new Set(registered.map(record => record.taskId))
      const synthesized: ResourceStoreRecord[] = []
      for (const task of current.listTasks()) {
        if (task.start?.created !== true || known.has(task.taskId)) continue
        const binding = task.currentBindingId === undefined ? undefined : current.getBinding(task.currentBindingId)
        const path = binding?.cwd
        if (path === undefined) continue
        synthesized.push({
          resourceId: worktreeResourceId(task.taskId),
          kind: 'worktree',
          path,
          ...task.originRepoPath === undefined ? {} : { originRepoPath: task.originRepoPath },
          taskId: task.taskId,
          createdReason: `Git starting state ${task.start.strategy} created an independent worktree from ${task.start.commit}`,
          owned: true,
          status: 'active',
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
        })
      }
      return [...registered, ...synthesized]
    }

    const visible = async (): Promise<CleanupPreviewItem[]> => {
      const items: CleanupPreviewItem[] = []
      for (const record of listed()) {
        const refusal = writeControlRefusal(current.getAccess(record.taskId), record.taskId, request.authorizedBy)
        if (refusal !== undefined) continue
        items.push(await itemOf(record))
      }
      return items
    }

    if (request.action === 'preview') {
      const resources = await visible()
      return {
        resources,
        cleaned: [],
        refusals: [],
        summary: describeCleanupPreview(resources),
      }
    }

    const gate = planCleanupExecute({
      confirmed: request.confirmed === true,
      selectedIds: request.resourceIds ?? [],
    })
    if (!gate.ok) {
      const resources = await visible()
      return {
        resources,
        cleaned: [],
        refusals: [gate.reason],
        summary: `${gate.reason}\n${describeCleanupPreview(resources)}`,
      }
    }

    const operationId = request.operationId ?? `cleanup-${randomUUID()}`
    const claim = await current.beginOperation({
      operationId,
      kind: 'cleanup',
      params: {
        action: 'execute',
        resourceIds: [...(request.resourceIds ?? [])],
        confirmed: true,
      },
    })
    if (claim.kind === 'conflict') {
      throw new Error(`OPERATION_CONFLICT: ${claim.reason}`)
    }

    const resources = await visible()
    const byId = new Map(resources.map(item => [item.resourceId, item]))
    const refusals: string[] = []
    const cleaned: string[] = []

    if (claim.kind === 'replay') {
      for (const id of request.resourceIds ?? []) {
        const item = byId.get(id)
        if (item?.status === 'cleaned') cleaned.push(id)
      }
      return {
        resources,
        cleaned,
        refusals,
        summary: `Cleanup ${operationId} already ran; a retry is a replay, so nothing was deleted again. `
          + describeCleanupPreview(resources),
      }
    }

    for (const id of request.resourceIds ?? []) {
      const item = byId.get(id)
      if (item === undefined) {
        refusals.push(`${id}: not in this caller's preview (unknown, already cleaned by someone else, or not controlled here)`)
        continue
      }
      if (!item.eligible) {
        refusals.push(`${id}: ${item.condition}`)
        continue
      }

      const record = current.getResource(id) ?? listed().find(entry => entry.resourceId === id)
      if (record === undefined) {
        refusals.push(`${id}: the registry no longer has this resource`)
        continue
      }

      if (item.tree !== 'missing') {
        const origin = record.originRepoPath
        if (origin === undefined || git === undefined) {
          refusals.push(
            `${id}: the directory is still on disk and this Host cannot run git worktree remove`
            + `${git === undefined ? ' (no subprocess service)' : ' (no origin repository was recorded)'}. `
            + 'Nothing was forced.',
          )
          continue
        }
        const removed = await removeWorktree(git, origin, record.path)
        if (!removed.ok) {
          refusals.push(`${id}: ${removed.reason}`)
          continue
        }
      }

      const stamp = new Date().toISOString()
      const next = {
        ...record,
        status: 'cleaned' as const,
        updatedAt: stamp,
        cleanedAt: stamp,
        cleanedBy: operationId,
      }
      await current.putResource(next)
      cleaned.push(id)
    }

    const after = await visible()
    const summary = cleaned.length === 0
      ? `Nothing was cleaned. ${refusals.join(' ')}\n${describeCleanupPreview(after)}`
      : `Cleaned ${String(cleaned.length)} resource(s): ${cleaned.join(', ')}.`
        + `${refusals.length === 0 ? '' : ` Refused: ${refusals.join(' ')}`}\n${describeCleanupPreview(after)}`
    return { resources: after, cleaned, refusals, summary }
  }

  /**
   * Read the calling session's own event log.
   *
   * This is the evidence behind the report-triggered write barrier: the Host records
   * every message's `source` in the durable log, so a turn opened by a plugin
   * `notice` is identifiable from facts no tool argument can forge (PRD §二.8.1).
   * Returning `undefined` rather than throwing is deliberate — an unreadable log
   * must not make every write fail, and the barrier documents that consequence
   * instead of hiding it.
   *
   * @param sessionId - the caller's session, taken from the Host context.
   * @returns the events, or undefined when that session is not live.
   */
  const callerEventsOf = (sessionId: string): readonly SessionEventLike[] | undefined => {
    const live = (probeContext.get('agents') as ObservableAgentsLike | undefined)?.get(sessionId)
    return live?.session.events as readonly SessionEventLike[] | undefined
  }

  /**
   * Watch a session's log for a **person** speaking, for PRD §二.7's "用户新输入可结束等待".
   *
   * The evidence is the Host's own `source` on each message, which no tool argument can forge: a person is
   * `{kind:'user'}`, while a conductor `notice`, a forwarded `relay` and the Host's own injected context
   * (`snapshot`, `catalog`, `instructions`, `recall`) are not. Counting *person* messages rather than
   * "messages" is the whole point — a report arriving mid-wait must not be mistaken for the user taking
   * over, or a wait would end the moment the conductor reported anything.
   *
   * A session that cannot be read returns `undefined`, which the caller treats as "cannot tell" rather
   * than as "no input": ending a wait on an unreadable log would be inventing the user's words.
   *
   * @param sessionId - the waiting session.
   * @returns a marker and a predicate, or undefined when the session cannot be read.
   */
  const userInputWatchOf = (
    sessionId: string,
  ): { readonly marker: unknown; readonly spokenSince: (marker: unknown) => boolean } | undefined => {
    const live = (probeContext.get('agents') as ObservableAgentsLike | undefined)?.get(sessionId)
    if (live?.session === undefined) return undefined
    /** Sequence of every person-authored message, so the marker is a position rather than a count. */
    const personSeqs = (): number[] => {
      const events = (live.session.events ?? []) as readonly SessionEventLike[]
      return events
        .filter(event => event.type === 'user/message')
        .filter((event) => {
          const source = (event.data as { source?: { kind?: unknown } } | undefined)?.source
          return typeof source === 'object' && source !== null && source.kind === 'user'
        })
        .map(event => event.seq)
    }
    return {
      marker: personSeqs(),
      spokenSince: (marker) => {
        const then = Array.isArray(marker) ? (marker as number[]) : []
        const highest = then.length === 0 ? -1 : Math.max(...then)
        // A position, not a count: a log that grew and *lost* entries would still be compared correctly,
        // and a person's message that arrived before the wait began can never end a wait that started after.
        return personSeqs().some(seq => seq > highest)
      },
    }
  }

  /**
   * Read a task's current position in its session's log.
   *
   * Used when a watch starts, so a new watch reports from now rather than replaying
   * a history the controller can already read.
   *
   * @param taskId - the task to locate.
   * @returns the last sequence, or -1 before the first event or when the log is unavailable.
   */
  const currentPositionOf = (taskId: string): number => {
    const current = store
    if (current === undefined) return -1
    const task = current.getTask(taskId)
    const binding = task?.currentBindingId === undefined ? undefined : current.getBinding(task.currentBindingId)
    const live = binding === undefined
      ? undefined
      : (probeContext.get('agents') as ObservableAgentsLike | undefined)?.get(binding.sessionId)
    const events = live?.session.events as readonly SessionEventLike[] | undefined
    if (events === undefined) return -1
    return events.reduce((max, event) => Math.max(max, event.seq), -1)
  }

  /**
   * List Host sessions that could be managed.
   *
   * The managed-session index is derived from the conductor's own bindings on
   * every call rather than cached, so a task joined or released a moment ago is
   * reflected immediately.
   *
   * The Host's registry-global archive set (PRD §二.5) rides along, read at call time for the same
   * reason: the Host replaces it on every change. It is read, never written — the conductor does not
   * archive anything, and §二.5 forbids its own archiving from using the Host's interface.
   *
   * @param filter - narrowing for the candidate list.
   * @param signal - cancellation forwarded to the Host query.
   * @returns the candidates, with the archive read attached, or the reason no list could be built.
   */
  const candidatesOf = async (filter: CandidateFilter, signal?: AbortSignal): Promise<CandidateList> => {
    const query = probeContext.get('sessionQuery') as SessionQueryLike | undefined
    if (query === undefined) {
      // Reported as a capability gap rather than as an empty search result: "this Host cannot list
      // sessions" and "nothing matched" are different answers, and only one of them is true here.
      return {
        candidates: [],
        unavailable: 'this Host composition mounts no ctx.sessionQuery, so the conductor cannot list sessions to '
          + 'join; create a task instead',
      }
    }
    const current = store
    // Read at call time, like every other service on this builder: the registry may be published by a
    // sibling entry after this plugin mounts, and the archive set itself is replaced as it changes.
    const archivedSessions = archivedSessionsOf(probeContext)
    return await listCandidates({
      sessionQuery: query,
      managed: {
        managedBy: (sessionId: string) => {
          if (current === undefined) return undefined
          for (const task of current.listTasks()) {
            if (task.currentBindingId === undefined) continue
            if (current.getBinding(task.currentBindingId)?.sessionId === sessionId) return task.taskId
          }
          return undefined
        },
      },
      ...archivedSessions === undefined ? {} : { archivedSessions },
    }, filter, signal)
  }

  if (storageFacility !== undefined) {
    openStore(ctx, storageFacility, async (opened, status) => {
      if (!lifecycle.active) return
      store = opened
      storeStatus = status
      if (opened === undefined) return
      // The restart calibration of PRD §二.11 belongs here: the store has just
      // opened, so this is the first instant at which the conductor can tell what
      // came due while the Host was not running. It is a one-off read of the run
      // logs, never a replay, and it announces what it decided.

      // PRD §四.5's other half: 先校准历史、队列和操作. Schedules were calibrated here from the beginning and
      // **operations were not**, so an operation left mid-dispatch by a crash stayed in `dispatching` for ever.
      // The calibration makes one state change on its own — `dispatching → unknown`, which §四.1 names as the
      // destination for an unconfirmable delivery — and reports the rest as it stands rather than resuming or
      // retrying anything.
      await recoverOperations(opened).then(
        account => announce(ctx, `[dsh-session-conductor] operation recovery: ${account}`),
        (error: unknown) => announce(ctx, `[dsh-session-conductor] operation recovery failed: ${describeError(error)}`),
      )
      if (!lifecycle.active) return
      await recoverSchedules().then(
        account => announce(ctx, `[dsh-session-conductor] schedule recovery: ${account}`),
        (error: unknown) => announce(ctx, `[dsh-session-conductor] schedule recovery failed: ${describeError(error)}`),
      )
      if (!lifecycle.active) return

      // And the pass starts here rather than at mount: before the store opens there is
      // nothing to tick and nobody to report to, and a pass that ran anyway would only
      // log failures during the Host's own startup.
      //
      // The interval is validated rather than trusted. The schema supplies the default, but a
      // caller that bypasses the schema — a test harness, an embedder, a hand-written patch —
      // would otherwise hand `setTimeout` an `undefined` delay, and this loop re-arms itself: a
      // missing value would become a hot loop against the live store instead of a reported gap.
      const passIntervalMs = Number.isFinite(configOf().passIntervalMs) && configOf().passIntervalMs > 0
        ? configOf().passIntervalMs
        : IMPLEMENTATION_DEFAULTS.passIntervalMs
      const pass = new BackgroundPass({ run: runPass, intervalMs: passIntervalMs })
      pass.start()
      // PRD §四.5: stopping the plugin stops new scheduling and reporting, and keeps
      // tasks, artifacts and data. Disable first so an in-flight pass cannot start
      // another schedule, report, rule or pending send on its way out.
      ctx.effect(() => () => {
        lifecycle.disable()
        pass.stop()
        announce(ctx, `[dsh-session-conductor] background pass stopped after ${String(pass.passes)} pass(es)`)
      })
      announce(
        ctx,
        `[dsh-session-conductor] background pass every ${String(passIntervalMs)} ms`
        + (passIntervalMs === configOf().passIntervalMs
          ? ''
          : ` (the configured interval ${String(configOf().passIntervalMs)} is not a positive number)`),
      )

      // The panel's read-only data route. Registered here, not at mount, because it reads
      // the store — and only when this composition actually has a web server, so a headless
      // or Electron composition is not told a panel route exists when it does not.
      const webServer = probeContext.get('webServer') as WebRoutePort | undefined
      const unregister = registerPanelRoute(webServer, () => panelPayloadOf(opened))
      const unregisterLinks = registerSessionLinksRoute(webServer, (sessionId, sessionLinkCapability) =>
        sessionLinksOf(opened, sessionId, configOf().bridge?.hostId ?? 'local', sessionLinkCapability))
      if (unregisterLinks !== undefined) ctx.effect(() => unregisterLinks)
      if (configOf().crossHostEnabled && configOf().bridge) {
        const bridge=configOf().bridge!
        const agents=probeContext.get('agents') as AgentRegistryLike|undefined
        const fs=probeContext.get('fs') as RemoteHostAdapterOptions['fs']|undefined
        const binaryFiles=probeContext.get('conductorBinaryFiles') as RemoteHostAdapterOptions['binaryFiles']
        const workspaces=workspacePortOf(probeContext)
        const sessions=probeContext.get('sessions') as {flush?(session:unknown):Promise<boolean>}|undefined
        if (agents && fs && workspaces && sessions?.flush) {
          try {
            const host=createRemoteHostAdapter({hostId:bridge.hostId,pluginVersion,store:opened,agents,fs,workspaces,workspaceRoots:bridge.workspaceRoots,
              ...binaryFiles === undefined ? {} : { binaryFiles },
              dispatchGuardReady:()=>remoteDispatchGuardReady && lifecycle.active,
              controllerSessionId:()=>configOf().bridge?.controllerSessionId,
              coordinator:{
                send:async request=>{const coordinator=coordinatorOf();if(!coordinator)throw Error('COORDINATOR_UNAVAILABLE');return await coordinator.send(request)},
                stop:async request=>{const coordinator=coordinatorOf();if(!coordinator)throw Error('COORDINATOR_UNAVAILABLE');return await coordinator.stop(request)},
                queue:async request=>{const coordinator=coordinatorOf();if(!coordinator)throw Error('COORDINATOR_UNAVAILABLE');return await coordinator.queue(request)},
              },
              capabilities:async()=>{
                const llm=probeContext.get('llm') as {listProviders?():readonly{id:string}[];listModels?(provider:string):Promise<readonly{id:string}[]>}|undefined
                const models:string[]=[]
                for(const provider of llm?.listProviders?.()??[])for(const model of await llm?.listModels?.(provider.id)??[])models.push(`${provider.id}/${model.id}`)
                return {models,workspaceCapable:true}
              },
              readTask:async(payload,controllerSessionId)=>{
                const definition=panelDefinitions.get('conductor_read')
                const agent=agents.get(controllerSessionId as never)
                if(!definition || !agent)throw Error('REMOTE_READER_UNAVAILABLE')
                return await definition.execute(payload as never,{agent,callId:`remote-read-${randomUUID()}`} as never)
              },
              observeTask:async(payload,controllerSessionId)=>{
                throwUnlessReader(payload.taskId,controllerSessionId)
                const observer=observerOf()
                if(!observer)throw Error('REMOTE_OBSERVER_UNAVAILABLE')
                const observation=observer.observe(payload.taskId,payload.afterSeq,payload.limit)
                throwUnlessReader(payload.taskId,controllerSessionId)
                return observation
              },
              createMessage:(text,source)=>createUserMessage({content:[{type:'text',text}],source}) as unknown as {id:string},
              flushSession:async agent=>{if(!agent.session || await sessions.flush!(agent.session)!==true)throw Error('SESSION_DURABILITY_UNCONFIRMED')},
              stopTimeoutMs:configOf().interruptConfirmLimitMs,
            })
            remoteRuntime=await startRemoteRuntime({store:opened,config:configOf,pluginVersion,host})
            const runtime=remoteRuntime
            ctx.effect(()=>()=>{remoteRuntime=undefined;return runtime.close()})
            announce(ctx,`[dsh-session-conductor] private bridge descriptor: ${runtime.descriptorPath}`)
          } catch(error) {announce(ctx,`[dsh-session-conductor] remote bridge unavailable: ${describeError(error)}`)}
        } else announce(ctx,'[dsh-session-conductor] remote bridge requires Host agents, filesystem, workspace registry and durable sessions')
      }
      const unregisterDetail = registerPanelDetailRoute(webServer, taskId => panelDetailOf(opened, taskId))
      const panelSessionMetadata = (sessionId: string) => readPanelSessionMetadata(probeContext.get('sessionQuery'), sessionId)
      const panelController = createPanelController({
        agents: () => probeContext.get('agents') as PanelAgents | undefined,
        sessionMetadata: panelSessionMetadata,
        definitions: panelDefinitions, active: () => lifecycle.active,
        markUserInvocation: explicitLocalUserInvocation,
      })
      const unregisterActions = registerPanelActionRoutes(webServer, panelController)
      const unregisterOverview = registerOverviewRoute(webServer, panelController, opened, sessionId =>
        overviewOf(opened, sessionId, panelPayloadOf(opened).tasks, configOf().bridge?.hostId ?? 'local'))
      if (unregisterOverview !== undefined) ctx.effect(() => unregisterOverview)
      const unregisterOverviewResult = registerOverviewResultRoute(webServer, panelController,
        sessionId => overviewOf(opened, sessionId, panelPayloadOf(opened).tasks, configOf().bridge?.hostId ?? 'local'),
        async sessionId => {
          const live = (probeContext.get('agents') as ObservableAgentsLike | undefined)?.get(sessionId)
          return live?.session?.events ?? (await readPersistedSessionOf(sessionId)).events
        })
      if (unregisterOverviewResult !== undefined) ctx.effect(() => unregisterOverviewResult)
      ctx.inject(['fs'], previewScope => {
        // Cordis creates tracing proxies on each lookup. Pin one proxy to this
        // provider lifetime, and invalidate in-flight reads when it is replaced.
        const fs = previewScope.fs as PreviewContext['fs']
        let active = true
        const previewServices = {
          async context(readerSessionId: string, targetSessionId: string) {
            if (!active || typeof fs.resolve !== 'function' || typeof fs.contains !== 'function' || typeof fs.readBytes !== 'function') return undefined
            const targetAgent = () => (probeContext.get('agents') as { get(id: string): { session: { header: { cwd?: string; createdAt?: number } } } | undefined } | undefined)?.get(targetSessionId)
            const initialAgent = targetAgent()
            if (readerSessionId === targetSessionId) {
              const metadata = initialAgent === undefined ? await panelSessionMetadata(targetSessionId) : undefined
              const cwd = initialAgent?.session.header.cwd ?? metadata?.cwd
              const createdAt = initialAgent?.session.header.createdAt ?? metadata?.createdAt
              const isCurrent = () => {
                if (!active) return false
                const current = targetAgent()
                return initialAgent !== undefined ? current === initialAgent && current.session.header.cwd === cwd
                  : current === undefined || current.session.header.cwd === cwd && current.session.header.createdAt === createdAt
              }
              return cwd && isCurrent() ? { cwd, fs, identity: JSON.stringify([targetSessionId, createdAt, cwd]), isCurrent } : undefined
            }
            for (const task of opened.listTasks()) {
              const access = opened.getAccess(task.taskId)
              if (!access || !mayRead(access, readerSessionId)) continue
              const binding = task.currentBindingId ? opened.getBinding(task.currentBindingId) : undefined
              if (binding?.sessionId !== targetSessionId || !['local', configOf().bridge?.hostId ?? 'local'].includes(binding.hostId)) continue
              const metadata = initialAgent === undefined ? await panelSessionMetadata(targetSessionId) : undefined
              if (initialAgent === undefined && metadata === undefined) return undefined
              const cwd = initialAgent?.session.header.cwd ?? metadata?.cwd ?? binding.cwd
              const createdAt = initialAgent?.session.header.createdAt ?? metadata?.createdAt
              const isCurrent = () => {
                if (!active) return false
                const currentAccess = opened.getAccess(task.taskId)
                const currentTask = opened.getTask(task.taskId)
                const currentBinding = currentTask?.currentBindingId ? opened.getBinding(currentTask.currentBindingId) : undefined
                const currentAgent = targetAgent()
                return currentAccess !== undefined && mayRead(currentAccess, readerSessionId)
                  && currentBinding?.bindingId === binding.bindingId && currentBinding.version === binding.version
                  && currentBinding.sessionId === targetSessionId && currentBinding.cwd === binding.cwd
                  && ['local', configOf().bridge?.hostId ?? 'local'].includes(currentBinding.hostId)
                  && (initialAgent === undefined ? currentAgent === undefined || currentAgent.session.header.cwd === cwd && currentAgent.session.header.createdAt === createdAt
                    : currentAgent === initialAgent && currentAgent.session.header.cwd === cwd)
              }
              return cwd && isCurrent() ? { cwd, fs, identity: JSON.stringify([binding.bindingId, binding.version, targetSessionId, createdAt, cwd]), isCurrent } : undefined
            }
            return undefined
          },
        }
        const unregisterPreview = registerPreviewRoute(webServer, panelController, previewServices)
        const unregisterTerminal = registerTerminalRoutes(webServer, panelController, {
          context: (readerSessionId, targetSessionId) => previewServices.context(readerSessionId, targetSessionId),
          subprocess() {
            const value = probeContext.get('subprocess') as TerminalSubprocess | undefined
            return typeof value?.spawnTerminal === 'function' && typeof value.resolveExecutable === 'function' ? value : undefined
          },
        })
        previewScope.effect(() => () => { active = false; unregisterPreview?.(); unregisterTerminal?.() })
      })
      ctx.effect(() => () => { panelController.dispose(); unregisterActions?.() })
      if (unregister === undefined) {
        announce(ctx, '[dsh-session-conductor] no web server in this composition, so the panel route is not registered')
      } else {
        ctx.effect(() => unregister)
        announce(ctx, `[dsh-session-conductor] panel data route at ${PANEL_ROUTE}`)
      }
      if (unregisterDetail !== undefined) {
        ctx.effect(() => unregisterDetail)
        announce(ctx, `[dsh-session-conductor] panel detail route at ${PANEL_DETAIL_ROUTE}`)
      }
    })
  } else {
    storeStatus = {
      available: false,
      reason: 'this Host composition mounts no storage domain facility (ctx.storageDomain)',
    }
  }

  const registry = probeContext.get('tools') as ToolRegistryLike | undefined
  if (registry !== undefined && typeof registry.register === 'function') {
    registerInto(ctx, capturePanelDefinitions(registry), snapshot, pluginVersion, {
      store: () => store,
      coordinator: coordinatorOf,
      observer: observerOf,
      remoteRead: remoteReadOf,
      assertReader: throwUnlessReader,
      candidates: candidatesOf,
      taskStatusOf,
      brief: briefOf,
      registerArtifact: registerArtifactOf,
      verifyArtifact: verifyArtifactOf,
      acceptArtifact: acceptArtifactOf,
      listArtifacts: (filter) => store?.listArtifacts(filter) ?? [],
      readArtifact: readArtifactOf,
      openArtifact: openArtifactOf,
      transferArtifact: transferArtifactOf,
      handoff: handoffOf,
      rule: ruleOf,
      schedule: scheduleOf,
      watch: watchOf,
      workflow: workflowOf,
      constraints: constraintsOf,
      budget: budgetOf,
      exportSnapshot: exportOf,
      modelConfig: modelConfigOf,
      remote: remoteOf,
      share: shareOf,
      cleanup: cleanupOf,
      operation: operationOf,
      callerEvents: callerEventsOf,
      userInputWatch: userInputWatchOf,
      access: accessOf,
      textLimit: () => configOf().toolTextLimit,
      waitLimitMs: () => configOf().waitLimitMs,
      interruptLimitMs: () => configOf().interruptConfirmLimitMs,
      defaultReadLimit: () => configOf().defaultReadLimit,
    })
    return
  }

  // The tool registry is published by a *different* entry, and cordis mounts
  // entries concurrently: probing once during `apply` races with that
  // publication and would report "no tool registry" for a Host that has one.
  // `ctx.inject` is the documented way to wait for a service without making it
  // a hard dependency — the entry still mounts, and this block activates when
  // the registry appears.
  announce(ctx, `[dsh-session-conductor] ${pluginVersion} loaded; waiting for the Host tool registry`)
  ctx.inject(['tools'], (scoped: Context) => {
    const scopedRegistry = (scoped as unknown as { tools?: ToolRegistryLike }).tools
    if (scopedRegistry === undefined || typeof scopedRegistry.register !== 'function') {
      announce(ctx, '[dsh-session-conductor] the Host tool registry never became usable')
      return
    }
    registerInto(ctx, capturePanelDefinitions(scopedRegistry), snapshot, pluginVersion, {
      store: () => store,
      coordinator: coordinatorOf,
      observer: observerOf,
      remoteRead: remoteReadOf,
      assertReader: throwUnlessReader,
      candidates: candidatesOf,
      taskStatusOf,
      brief: briefOf,
      registerArtifact: registerArtifactOf,
      verifyArtifact: verifyArtifactOf,
      acceptArtifact: acceptArtifactOf,
      listArtifacts: (filter) => store?.listArtifacts(filter) ?? [],
      readArtifact: readArtifactOf,
      openArtifact: openArtifactOf,
      transferArtifact: transferArtifactOf,
      handoff: handoffOf,
      rule: ruleOf,
      schedule: scheduleOf,
      watch: watchOf,
      workflow: workflowOf,
      constraints: constraintsOf,
      budget: budgetOf,
      exportSnapshot: exportOf,
      modelConfig: modelConfigOf,
      remote: remoteOf,
      share: shareOf,
      cleanup: cleanupOf,
      operation: operationOf,
      callerEvents: callerEventsOf,
      userInputWatch: userInputWatchOf,
      access: accessOf,
      textLimit: () => configOf().toolTextLimit,
      waitLimitMs: () => configOf().waitLimitMs,
      interruptLimitMs: () => configOf().interruptConfirmLimitMs,
      defaultReadLimit: () => configOf().defaultReadLimit,
    })
  })
}

/**
 * State, in one clause, which of the three cases the Host's archive read is in (PRD §二.5).
 *
 * The panel reports `sessionArchivedExternally` only when the set was actually read, so a reader who sees
 * no such field needs a sentence telling them whether this Host publishes no set at all or the set exists
 * and could not be read. Both are "cannot tell"; they have different fixes, so they are not merged into one
 * empty answer.
 *
 * @param read - the result of the adapter's read, or undefined when no registry was reachable.
 * @returns the clause, for embedding in a note or a refusal.
 */
function describeArchiveForPanel(read: ArchiveSetRead | undefined): string {
  if (read === undefined) {
    return 'not reported at all, because this composition mounts no workspace registry to read it from'
  }
  if (read.state === 'published') {
    return `read from the Host (${String(read.sessionIds.length)} session(s) archived there)`
  }
  return `not readable right now: ${read.reason}`
}

/**
 * Register the conductor tools and report the resulting capability state.
 *
 * The report waits briefly for the Loader to settle, because the features
 * depend on services published by *other* entries that mount concurrently with
 * this one. Reporting at the instant the tool registry appears would state
 * "durable state disabled" for a Host that mounts storage a moment later —
 * a misleading line about the one thing an operator most needs to trust. The
 * wait is therefore bounded and raced against the Loader's own settle promise,
 * so a Host that never settles delays the report rather than suppressing it.
 *
 * @param ctx - the plugin context that owns the registrations.
 * @param registry - the Host tool registry.
 * @param snapshot - returns the current capability snapshot.
 * @param pluginVersion - the version to name in the report.
 */
function registerInto(
  ctx: Context,
  registry: ToolRegistryLike,
  snapshot: () => CapabilitySnapshot,
  pluginVersion: string,
  accessors: {
    store: () => ConductorStore | undefined
    coordinator: () => Coordinator | undefined
    remoteRead: (request:RemoteReadToolRequest)=>Promise<RemoteReadToolResult|undefined>
    observer: () => TaskObserver | undefined
    assertReader: (taskId: string, callerSessionId: string) => void
    candidates: (filter: CandidateFilter, signal?: AbortSignal) => Promise<CandidateList>
    taskStatusOf: (taskId: string) => TaskStatusReading | undefined
    brief: (taskId: string, operationId?: string, callerSessionId?: string) => Promise<BriefOutcome>
    registerArtifact: (request: RegisterArtifactRequest) => Promise<ArtifactRecord>
    verifyArtifact: (artifactId: string, callerSessionId: string) => Promise<ArtifactRecord>
    acceptArtifact: (request: ArtifactAcceptanceRequest) => Promise<ArtifactAcceptanceResult>
    listArtifacts: (filter: { taskId?: string; acceptance?: ArtifactRecord['acceptance'] }) => ArtifactRecord[]
    readArtifact: (artifactId: string, callerSessionId: string, maxChars: number) => Promise<ArtifactReadResult>
    openArtifact: (artifactId: string, callerSessionId: string) => Promise<ArtifactOpenResult>
    transferArtifact: (request: TransferToolRequest) => Promise<{ record: TransferRecord; reference?: string }>
    handoff: (request: HandoffRequest) => Promise<HandoffOutcome>
    rule: (request: RuleToolRequest) => Promise<RuleToolResult>
    schedule: (request: ScheduleToolRequest) => Promise<ScheduleToolResult>
    watch: (request: WatchToolRequest) => Promise<WatchToolResult>
    workflow: (request: WorkflowToolRequest) => Promise<WorkflowToolResult>
    constraints: (request: ConstraintsToolRequest) => Promise<ConstraintsToolResult>
    budget: (request: BudgetToolRequest) => Promise<BudgetToolResult>
    exportSnapshot: (request: ExportToolRequest) => Promise<ExportToolResult>
    modelConfig: (request: ModelConfigToolRequest) => Promise<ModelConfigToolResult>
    remote: (request: RemoteToolRequest) => Promise<RemoteToolResult>
    share: (request: ShareToolRequest) => Promise<ShareToolResult>
    cleanup: (request: CleanupToolRequest) => Promise<CleanupToolResult>
    operation: (request: OperationToolRequest) => Promise<OperationToolResult>
    callerEvents: (sessionId: string) => readonly SessionEventLike[] | undefined
    userInputWatch: (sessionId: string) =>
      { readonly marker: unknown; readonly spokenSince: (marker: unknown) => boolean } | undefined
    access: (request: AccessToolRequest) => Promise<AccessToolResult>
    textLimit: () => number
    waitLimitMs: () => number
    interruptLimitMs: () => number
    defaultReadLimit: () => number
  },
): void {
  for (const dispose of registerConductorTools(registry, {
    snapshot,
    store: accessors.store,
    coordinator: accessors.coordinator,
    observer: accessors.observer,
    remoteRead: accessors.remoteRead,
    assertReader: accessors.assertReader,
    candidates: accessors.candidates,
    taskStatusOf: accessors.taskStatusOf,
    brief: accessors.brief,
    registerArtifact: accessors.registerArtifact,
    verifyArtifact: accessors.verifyArtifact,
    acceptArtifact: accessors.acceptArtifact,
    listArtifacts: accessors.listArtifacts,
    readArtifact: accessors.readArtifact,
    openArtifact: accessors.openArtifact,
    transferArtifact: accessors.transferArtifact,
    handoff: accessors.handoff,
    rule: accessors.rule,
    schedule: accessors.schedule,
    watch: accessors.watch,
    workflow: accessors.workflow,
    constraints: accessors.constraints,
    budget: accessors.budget,
    exportSnapshot: accessors.exportSnapshot,
    modelConfig: accessors.modelConfig,
    remote: accessors.remote,
    share: accessors.share,
    cleanup: accessors.cleanup,
    operation: accessors.operation,
    callerEvents: accessors.callerEvents,
    userInputWatch: accessors.userInputWatch,
    access: accessors.access,
    textLimit: accessors.textLimit,
    waitLimitMs: accessors.waitLimitMs,
    interruptLimitMs: accessors.interruptLimitMs,
    defaultReadLimit: accessors.defaultReadLimit,
  })) {
    ctx.effect(() => dispose)
  }
  const report = (): void => { announce(ctx, summarize(snapshot())) }
  const loader = (ctx as unknown as { get(name: string): unknown }).get('loader') as LoaderLike | undefined
  const settle = loader?.await
  if (typeof settle !== 'function') {
    report()
    return
  }
  const bounded = new Promise<void>((resolve) => { setTimeout(resolve, SETTLE_WAIT_MS) })
  void Promise.race([Promise.resolve(settle.call(loader)).then(() => undefined, () => undefined), bounded])
    .then(report, report)
}

/**
 * Open the conductor's storage domain without blocking the mount.
 *
 * The open is asynchronous and must not delay the tool registration, so the
 * outcome is delivered through a callback the caller uses to update the
 * capability status. A close disposer is registered only on success.
 *
 * @param ctx - the plugin context owning the disposer.
 * @param facility - the Host storage domain facility.
 * @param settle - receives the opened store, or `undefined` plus the reason.
 */
function openStore(
  ctx: Context,
  facility: DomainFacilityLike,
  settle: (store: ConductorStore | undefined, status: StoreStatus) => void | Promise<void>,
): void {
  let disposed = false
  let close: (() => Promise<void>) | undefined
  ctx.effect(() => () => {
    disposed = true
    return close?.()
  })
  void (async () => {
    const first = await openConductorStore(facility)
    if (disposed) {
      if (first.ok) await first.close()
      return
    }
    if (first.ok) {
      close = first.close
      await settle(first.store, { available: true })
      return
    }
    const home = process.env.DSH_HOME
    const mediumPath = typeof home === 'string' && home.length > 0
      ? join(home, 'storages', `${DOMAIN_NAME}.json`)
      : undefined
    if (first.code !== 'version-mismatch' || mediumPath === undefined) {
      settle(undefined, { available: false, reason: first.reason })
      announce(ctx, `[dsh-session-conductor] durable state unavailable: ${first.reason}`)
      return
    }
    const prepared = await prepareStoredMedium({
      mediumPath,
      backupDir: dirname(mediumPath),
      now: new Date().toISOString(),
      files: nodeMediumFiles,
    })
    if (prepared.action === 'refused' || prepared.action === 'fresh' || prepared.action === 'open') {
      const reason = prepared.reason ?? first.reason
      settle(undefined, { available: false, reason })
      announce(ctx, `[dsh-session-conductor] durable state unavailable: ${reason}`)
      return
    }
    const second = await openConductorStore(facility)
    if (disposed) {
      if (second.ok) await second.close()
      return
    }
    if (!second.ok) {
      if (prepared.backupPath !== undefined) {
        try {
          await restoreMediumBackup(nodeMediumFiles, mediumPath, prepared.backupPath)
        } catch (restoreError) {
          const reason = `${second.reason}; restoring the pre-migration backup also failed: ${describeError(restoreError)}`
          settle(undefined, { available: false, reason })
          announce(ctx, `[dsh-session-conductor] durable state unavailable: ${reason}`)
          return
        }
      }
      const reason = `${second.reason}; the pre-migration backup was restored, so the schema version did not advance`
      settle(undefined, { available: false, reason })
      announce(ctx, `[dsh-session-conductor] durable state unavailable: ${reason}`)
      return
    }
    close = second.close
    await settle(second.store, { available: true })
  })().catch((error: unknown) => {
    const reason = `opening the conductor storage domain failed unexpectedly: ${describeError(error)}`
    settle(undefined, { available: false, reason })
    announce(ctx, `[dsh-session-conductor] durable state unavailable: ${reason}`)
  })
}

/** Node `fs` as the schema-upgrade file surface. */
const nodeMediumFiles: MediumFiles = {
  read: async (path) => {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  },
  write: async (path, contents) => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, contents, 'utf8')
  },
}

/**
 * How long the mount report waits for the Loader to settle before reporting the
 * capability view it has. Long enough for sibling entries to publish, short
 * enough that a stalled composition still says something.
 */
const SETTLE_WAIT_MS = 3_000

/** The slice of the Host Loader this plugin uses to know the tree has settled. */
interface LoaderLike {
  await?(): Promise<unknown>
}

/**
 * Render the one-line mount report.
 * @param current - the capability snapshot to summarize.
 * @returns the report line.
 */
function summarize(current: CapabilitySnapshot): string {
  const features = Object.keys(current.features)
  const disabled = Object.entries(current.features)
    .filter(([, state]) => !state.available)
    .map(([feature]) => feature)
  return `[dsh-session-conductor] ${current.pluginVersion} mounted; `
    + `${String(disabled.length)} of ${String(features.length)} features disabled`
    + (disabled.length === 0 ? '' : `: ${disabled.join(', ')}`)
}

/**
 * Report one operational line.
 *
 * Written to stderr rather than through the Host logger on purpose: the mount
 * line is how an operator confirms that an install took effect, and a logger
 * that is absent, filtered, or silently unconnected turns "the plugin mounted"
 * and "the plugin never loaded" into the same empty output. The authoritative
 * in-product report remains the `conductor_capabilities` tool, which carries
 * far more detail than this line.
 *
 * @param _ctx - reserved for a future Host-native log sink.
 * @param message - the line to report.
 */
function announce(_ctx: Context, message: string): void {
  process.stderr.write(`${message}\n`)
}

/**
 * Render an unknown thrown value for a one-line report.
 * @param error - the thrown value.
 * @returns a short description.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}
