/**
 * Model and runtime configuration (PRD §二.3).
 *
 * Four rules here are each easy to get subtly wrong, and each is a function:
 *
 * 1. **The options come from the Host's actual catalogue**, never from a private
 *    hardcoded list. {@link ModelCatalogPort} is that catalogue, and nothing in this
 *    module names a provider or a model of its own.
 * 2. **A change takes effect from the next not-yet-assembled request**, and never alters
 *    one in flight. So "what the next request will use" and "what the last request
 *    actually used" are two different facts, and {@link describeConfigState} reports
 *    both, separately, with whether a change is still pending.
 * 3. **A preset is chosen at create or fork time only**, because it takes part in runtime
 *    assembly. An existing task changes it by moving to a successor session, which is why
 *    {@link presetChangeAllowed} refuses rather than performing a partial change.
 * 4. **The catalogue is advisory.** Measured from the Host's own contract: "an adapter
 *    may accept unlisted model ids, and consumers must not turn absence into request
 *    rejection". A model that is not listed is therefore accepted *with a note*, not
 *    refused — while a provider that is not registered genuinely cannot route and is
 *    refused. Those two cases look alike and are not.
 *
 * @module dsh-session-conductor/service/modelconfig
 */

/** One provider the Host can route to. */
export interface ProviderInfo {
  readonly id: string
  readonly name?: string | undefined
}

/** One model a provider advertises. */
export interface ModelInfo {
  readonly provider: string
  readonly id: string
  readonly name: string
  readonly description?: string | undefined
}

/** The Host's catalogue, as this plugin uses it. */
export interface ModelCatalogPort {
  /** Registered provider routes. */
  listProviders(): readonly ProviderInfo[]
  /**
   * Models one provider advertises.
   *
   * Advisory by the Host's own contract: the result "does not validate request routing",
   * so an empty or incomplete answer is not evidence that a model id is wrong.
   */
  listModels(provider: string): Promise<readonly ModelInfo[]>
}

/**
 * The reasoning levels one **model** publishes, as the Host reports them.
 *
 * This replaced a `listReasoningEfforts?()` port that no Host ever supplied, so `reasoningEfforts` was
 * always `[]` and C115 measured a missing port rather than the Host. Reading the installed Harness settled
 * what the real source is: `ctx.llm.resolveModelInfo(provider, model)` "resolves and validates the exact
 * model identity, the available context, the output default and the **reasoning metadata**" from the adapter
 * that owns the route, and the Host's own model catalogue is built from it
 * (`const resolved = await ctx.llm.resolveModelInfo(provider.id, model.id)` → `resolved.reasoning.efforts`).
 *
 * The distinction this type exists to preserve is the Host's own: a model **with** reasoning metadata
 * publishes its ordered levels, and a model **without** it publishes none at all — "not available" rather
 * than "off", because choosing `off` sends the same request as naming nothing while a provider that thinks
 * by default carries on thinking. So `levels: undefined` means *the Host publishes none for this model*, and
 * `levels: []` would mean *it publishes metadata and offers no levels*. Collapsing those two into one empty
 * list is exactly the misreading C165 recorded.
 */
export interface PublishedReasoning {
  /** The provider/model pair this answers for. */
  readonly provider: string
  readonly model: string
  /** The ordered levels the Host publishes, or undefined when it publishes none for this model. */
  readonly levels: readonly string[] | undefined
  /** Why there are none, in the Host's or the caller's words, when there are none. */
  readonly note?: string | undefined
}

/**
 * Read the reasoning levels the Host publishes for one model.
 *
 * A **model** the Host cannot resolve is not an error here: PRD §二.3 and the Host's own contract both treat
 * the catalogue as advisory, and a model that is not listed may still be accepted by its adapter. An
 * unresolvable model therefore publishes no levels — with the reason — rather than making the model
 * unusable, which is what refusing here would do.
 *
 * @param port - the Host's model-info lookup, when this composition exposes one.
 * @param provider - the provider id.
 * @param model - the model id.
 * @returns what the Host publishes, or a note saying it published nothing checkable.
 */
export async function publishedReasoningOf(
  port: { resolveModelInfo?(provider: string, model: string): Promise<unknown> } | undefined,
  provider: string,
  model: string,
): Promise<PublishedReasoning> {
  if (port === undefined || typeof port.resolveModelInfo !== 'function') {
    return {
      provider, model, levels: undefined,
      note: 'this Host mounts no model-info lookup, so no reasoning levels can be read for this model; an '
        + 'effort named by the caller is passed through unchecked',
    }
  }
  let resolved: unknown
  try {
    resolved = await port.resolveModelInfo(provider, model)
  } catch (error) {
    return {
      provider, model, levels: undefined,
      // Not a refusal: the catalogue is advisory, and a model the resolver cannot describe may still route.
      note: `the Host could not describe ${provider}/${model} (${error instanceof Error ? error.message : String(error)}), `
        + 'so no reasoning levels could be read for it',
    }
  }
  const reasoning = (resolved as { reasoning?: unknown } | undefined)?.reasoning
  const efforts = (reasoning as { efforts?: unknown } | undefined)?.efforts
  if (!Array.isArray(efforts)) {
    return {
      provider, model, levels: undefined,
      // The Host's own distinction, quoted: a model without this metadata "exposes no `reasoning` at all",
      // because pi-ai reports it as supporting only `off`, and `off` is translated into *omitting* the
      // reasoning option — which is the same request as naming nothing.
      note: `${provider}/${model} publishes no reasoning levels, so this model offers the provider default `
        + 'only. That is not "off": a model with no reasoning metadata cannot be switched off, and reporting '
        + 'one level here would be a control that does nothing.',
    }
  }
  return {
    provider,
    model,
    levels: efforts.map((effort) => String((effort as { id?: unknown })?.id ?? effort)),
  }
}

/** A chosen model configuration. */
export interface ModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string | undefined
}

/**
 * The small companion-Host seam used to change one Session's selection.
 *
 * This is deliberately a callable service rather than a configuration flag. A flag
 * can say that an operator installed an extension, but it cannot prove that this
 * process has a writer or that a change reached the Host. The companion extension
 * owns the Host-internal selection cache and exposes this narrow operation; the
 * conductor always supplies `rememberAsDefault: false`.
 */
export interface ModelSelectionWriter {
  selectForSession(request: {
    readonly sessionId: string
    readonly selection: ModelSelection
    readonly rememberAsDefault: false
  }): Promise<{ readonly selected: ModelSelection }>
}

/** Optional verified Host reader for the next unassembled request. */
export interface ModelSelectionReader {
  /** Live synchronous read used immediately before dispatch; optional on older companions. */
  peekForSession?(request: { readonly sessionId: string }): Awaited<ReturnType<ModelSelectionReader['readForSession']>> | undefined
  readForSession(request: { readonly sessionId: string }): Promise<{
    readonly sessionId: string
    readonly next: ModelSelection
    readonly lastUsed?: ModelSelection
    readonly source: 'session_override' | 'request_header' | 'global_default'
    readonly persisted: boolean
    readonly effectiveAt: 'next_request'
  }>
}

/** A reader must be callable; declarations alone do not establish a value. */
export function modelSelectionReaderOf(value: unknown): ModelSelectionReader | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  return typeof (value as { readForSession?: unknown }).readForSession === 'function'
    ? value as ModelSelectionReader : undefined
}

/** Validate the reader response at the optional third-party service boundary. */
export async function readSessionSelection(reader: ModelSelectionReader, sessionId: string): Promise<Awaited<ReturnType<ModelSelectionReader['readForSession']>>> {
  const value = await reader.readForSession({ sessionId })
  const next = selectionFromHeader({ config: value?.next })
  if (value?.sessionId !== sessionId || value.effectiveAt !== 'next_request' || next === undefined
    || typeof value.persisted !== 'boolean' || !['session_override', 'request_header', 'global_default'].includes(value.source)) {
    throw new Error('MODEL_STATE_UNCONFIRMED: companion returned an invalid next-request configuration')
  }
  const lastUsed = selectionFromHeader({ config: value.lastUsed })
  if (value.lastUsed !== undefined && lastUsed === undefined) throw new Error('MODEL_STATE_UNCONFIRMED: companion returned an invalid last-used configuration')
  return { ...value, next, ...lastUsed === undefined ? {} : { lastUsed } }
}

/** Only a compatible Host can freeze and apply a per-session model selection. */
export interface CreationModelPort {
  defaultSelection(): Promise<ModelSelection>
  resolve(selection: ModelSelection): Promise<ModelSelection>
  stateForSession(sessionId: string): Promise<{ readonly selection: ModelSelection; readonly persisted: boolean }>
  apply(sessionId: string, selection: ModelSelection): Promise<ModelSelection>
}

/** Context key supplied by the optional companion Host extension. */
export const MODEL_SELECTION_WRITER_SERVICE = 'conductorSessionModelSelection'

/**
 * Narrow an untyped Host service to the writer contract.
 *
 * The context is intentionally untyped for third-party plugin keys. Checking the
 * callable boundary here keeps a declaration or an unrelated service object from
 * being treated as evidence that a model change can be made.
 */
export function modelSelectionWriterOf(value: unknown): ModelSelectionWriter | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  return typeof (value as { selectForSession?: unknown }).selectForSession === 'function'
    ? value as ModelSelectionWriter
    : undefined
}

/** What resolving a requested selection produced. */
export type SelectionResolution =
  | {
      readonly ok: true
      readonly selection: ModelSelection
      /** Things the caller should know: an unlisted model, an unknown effort. */
      readonly notes: readonly string[]
    }
  | { readonly ok: false; readonly reason: string }

/**
 * Resolve a requested selection against the Host's catalogue.
 *
 * The asymmetry is deliberate and comes from the Host's contract. A **provider** that is
 * not registered has no adapter and cannot route, so requesting it is refused. A
 * **model** that is not listed may still be accepted by its adapter, and the contract
 * explicitly forbids treating absence as a rejection, so it is accepted with a note.
 *
 * @param request - what the caller asked for.
 * @param catalog - the Host's catalogue.
 * @returns the resolved selection, or the reason it cannot be used.
 */
export function resolveSelection(
  request: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string | undefined },
  catalog: ModelCatalogPort,
  published?: PublishedReasoning | undefined,
): SelectionResolution {
  if (request.provider.length === 0 || request.model.length === 0) {
    return { ok: false, reason: 'a model configuration needs both a provider and a model' }
  }
  const providers = catalog.listProviders()
  if (!providers.some(provider => provider.id === request.provider)) {
    return {
      ok: false,
      reason: `this Host has no registered route for provider "${request.provider}". Registered providers are: `
        + `${providers.length === 0 ? '(none)' : providers.map(provider => provider.id).join(', ')}. `
        + 'A model cannot be selected on a provider that cannot route, so nothing was changed.',
    }
  }

  const notes: string[] = []
  if (request.reasoningEffort !== undefined) {
    const levels = published?.levels
    if (levels === undefined) {
      // Two different absences, and the note says which: no levels were read at all, or the model publishes
      // none. Both pass the effort through — the catalogue is advisory and refusal on absence would refuse
      // configurations that work — but a reader has to be able to tell them apart.
      notes.push(`${published?.note ?? 'the Host publishes no reasoning levels for this model'}; `
        + `"${request.reasoningEffort}" was passed through unchanged`)
    } else if (!levels.includes(request.reasoningEffort)) {
      // Not refused, for the same reason an unlisted model is not: the Host's catalogue is
      // advisory, and a plugin that rejected on absence would refuse configurations that
      // work.
      notes.push(`"${request.reasoningEffort}" is not a level ${request.provider}/${request.model} publishes `
        + `(${levels.length === 0 ? 'it publishes none' : levels.join(', ')}); it was passed through, because the `
        + 'catalogue is advisory and absence is not evidence that an option is rejected')
    }
  }

  return {
    ok: true,
    selection: {
      provider: request.provider,
      model: request.model,
      ...request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort },
    },
    notes,
  }
}

/**
 * Whether a listed model is worth confirming with the Host.
 *
 * Used to attach a note when a model is not advertised, without turning that into a
 * refusal. The query is async because the Host's model listing is.
 *
 * @param selection - the chosen configuration.
 * @param catalog - the Host's catalogue.
 * @returns the notes to show, which may be empty.
 */
export async function modelListingNotes(
  selection: ModelSelection,
  catalog: ModelCatalogPort,
): Promise<string[]> {
  const models = await catalog.listModels(selection.provider)
  if (models.some(model => model.id === selection.model)) return []
  return [
    `${selection.model} is not advertised by provider "${selection.provider}" `
    + `(${models.length === 0 ? 'it advertises none' : `it advertises ${models.map(model => model.id).join(', ')}`}). `
    + 'It was kept: the Host documents its model catalogue as advisory, and an adapter may accept ids it does not '
    + 'list — so this is a note, not a rejection.',
  ]
}

/**
 * Read the configuration the Host logged for the most recent assembled request.
 *
 * This is the "most recently actually used" fact of PRD §二.3, and it is read from the **Host's own**
 * record rather than inferred. The installed Host answers the same question the same way — its model
 * selection resolves as "a selection made in this process, else the session's own latest logged
 * `request/header`, else the live Agent default", and it reads that middle tier as
 * `agent.session.requestHeader()?.config` — so this cannot disagree with what the Host itself believes
 * the session last used.
 *
 * A `request/header` is logged when the Host **assembles** a request. A session whose turn never got that
 * far has none, and this returns `undefined` for it: "no request has been assembled" is a different fact
 * from "the configuration is unknown", and neither is a model name.
 *
 * @param header - whatever `requestHeader()` returned; not trusted to have any shape.
 * @returns the logged selection, or undefined when the Host logged none.
 */
export function selectionFromHeader(header: unknown): ModelSelection | undefined {
  if (typeof header !== 'object' || header === null) return undefined
  const config = (header as { config?: unknown }).config
  if (typeof config !== 'object' || config === null) return undefined
  const { provider, model, reasoningEffort } = config as {
    provider?: unknown
    model?: unknown
    reasoningEffort?: unknown
  }
  if (typeof provider !== 'string' || provider.length === 0) return undefined
  if (typeof model !== 'string' || model.length === 0) return undefined
  return {
    provider,
    model,
    ...typeof reasoningEffort !== 'string' || reasoningEffort.length === 0 ? {} : { reasoningEffort },
  }
}

/** What a task's configuration state looks like from outside. */
export interface ConfigState {
  /** What the next not-yet-assembled request will use, when one is set. */
  readonly forNextRequest?: ModelSelection | undefined
  /** What the most recent request actually used, when one has been assembled. */
  readonly lastActuallyUsed?: ModelSelection | undefined
}

/**
 * Describe a task's configuration, keeping the two facts apart.
 *
 * PRD §二.3 requires the interface to show "most recently actually used" and "next
 * request configuration" separately. Collapsing them into one "current model" would hide
 * the only thing that matters to a caller who just changed it: whether the change has
 * taken effect yet.
 *
 * @param state - the two recorded facts.
 * @returns the description, one line per fact.
 */
export function describeConfigState(state: ConfigState): string {
  const render = (selection: ModelSelection | undefined): string =>
    selection === undefined
      ? '(none recorded)'
      : `${selection.provider}/${selection.model}`
        + (selection.reasoningEffort === undefined ? '' : ` at ${selection.reasoningEffort} reasoning`)

  const pending = state.forNextRequest !== undefined
    && (state.lastActuallyUsed === undefined
      || state.forNextRequest.provider !== state.lastActuallyUsed.provider
      || state.forNextRequest.model !== state.lastActuallyUsed.model
      || state.forNextRequest.reasoningEffort !== state.lastActuallyUsed.reasoningEffort)

  return [
    `Next request will use: ${render(state.forNextRequest)}`,
    `Most recently actually used: ${render(state.lastActuallyUsed)}`,
    state.forNextRequest === undefined
      ? 'The next request configuration is unknown; whether a change is pending cannot be confirmed.'
      : pending
      ? 'A change is PENDING: it applies from the next request the Host assembles, and a request already in flight '
        + 'is not altered.'
      : 'No change is pending: the next request will use what the last one used.',
  ].join('\n')
}

/** Where a preset may be chosen. */
export type PresetChangePoint = 'create' | 'fork' | 'update'

/**
 * Whether a preset may be chosen at this point.
 *
 * PRD §二.3: changing a preset involves runtime assembly, so it is allowed only when the
 * session is being built. An existing task changes it by moving to a successor session —
 * which is a real answer, not a workaround, because the successor is a new session.
 *
 * @param point - when the change is being attempted.
 * @returns whether it is allowed, and why not when it is not.
 */
export function presetChangeAllowed(point: PresetChangePoint): { readonly allowed: boolean; readonly reason: string } {
  if (point === 'create' || point === 'fork') {
    return { allowed: true, reason: `a preset may be chosen when a session is assembled (${point})` }
  }
  return {
    allowed: false,
    reason: 'a preset takes part in runtime assembly, so it cannot be changed on a session that already exists. '
      + 'This is not a limitation being worked around: move the task to a successor session (conductor_handoff), '
      + 'where the new session is assembled with the preset you want, and the task keeps its identity.',
  }
}

/** The result of trying to write a model configuration. */
export type ApplySelectionResult =
  | { readonly ok: true; readonly selection: ModelSelection; readonly rememberedAsDefault: false }
  | { readonly ok: false; readonly reason: string }

/**
 * Apply a model selection through the Host's own surface.
 *
 * Two things are fixed here. The write goes through {@link ApplySelectionResult}'s
 * caller with `rememberAsDefault: false` **always**, because the Host's native default is
 * `true` and a plugin call that changed the user's global model default would be exactly
 * the silent side effect PRD §一.5 forbids. And the capability is checked first: without
 * the companion Host extension there is no machine-readable declaration for the
 * parameter, so the write is refused with that reason rather than attempted and hoped for.
 *
 * @param selection - the configuration to apply.
 * @param capabilities - whether the Host extension is declared.
 * @param writer - callable seam exported by that extension in this process.
 * @param sessionId - target Session identity.
 * @returns the applied selection, or the reason nothing was changed.
 */
export async function applySelection(
  selection: ModelSelection,
  capabilities: { readonly rememberAsDefaultSupported: boolean },
  writer?: ModelSelectionWriter | undefined,
  sessionId?: string | undefined,
): Promise<ApplySelectionResult> {
  if (!capabilities.rememberAsDefaultSupported) {
    return {
      ok: false,
      reason: 'the installed Host exposes no machine-readable declaration for `selectModel.rememberAsDefault`, so a '
        + 'model change cannot be applied without also setting the Host\'s global model default. The conductor will '
        + 'not do that as a side effect of configuring one task. Install the companion Host extension for the pinned '
        + 'baseline (see docs/host-extension.md), or choose the model when the task is created, where the Host\'s '
        + 'creation path supplies it without touching the global default.',
    }
  }
  if (writer === undefined) {
    return {
      ok: false,
      reason: 'the companion Host extension is declared, but this process exposes no callable session-model writer. '
        + 'A declaration alone cannot apply a model change, so nothing was changed.',
    }
  }
  if (sessionId === undefined || sessionId.length === 0) {
    return {
      ok: false,
      reason: 'this task has no current Session binding, so there is no Host session on which to apply the model change. '
        + 'Nothing was changed.',
    }
  }
  try {
    const result = await writer.selectForSession({ sessionId, selection, rememberAsDefault: false })
    const selected = result?.selected
    if (typeof selected?.provider !== 'string' || selected.provider.length === 0
      || typeof selected.model !== 'string' || selected.model.length === 0) {
      return {
        ok: false,
        reason: 'the companion Host writer returned no normalized provider/model selection, so the conductor cannot '
          + 'prove what the Host applied. Nothing was reported as changed.',
      }
    }
    return {
      ok: true,
      selection: {
        provider: selected.provider,
        model: selected.model,
        ...typeof selected.reasoningEffort === 'string' && selected.reasoningEffort.length > 0
          ? { reasoningEffort: selected.reasoningEffort }
          : {},
      },
      rememberedAsDefault: false,
    }
  } catch (error) {
    return {
      ok: false,
      reason: 'the companion Host writer did not confirm the model change ('
        + `${error instanceof Error ? error.message : String(error)}); nothing was reported as changed.`,
    }
  }
}
