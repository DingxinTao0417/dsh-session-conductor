import { describe, expect, it } from 'vitest'
import {
  applySelection,
  describeConfigState,
  modelListingNotes,
  presetChangeAllowed,
  publishedReasoningOf,
  resolveSelection,
  type ModelCatalogPort,
  type ModelSelection,
} from '../src/service/modelconfig.ts'

/** A catalogue with the members a test cares about overridden. */
function catalog(over: Partial<ModelCatalogPort> = {}): ModelCatalogPort {
  return {
    listProviders: () => [{ id: 'deepseek' }, { id: 'local' }],
    listModels: async (provider) => provider === 'deepseek'
      ? [
          { provider: 'deepseek', id: 'deepseek-chat', name: 'Chat' },
          { provider: 'deepseek', id: 'deepseek-reasoner', name: 'Reasoner' },
        ]
      : [],
    ...over,
  }
}

/** A selection. */
function selection(over: Partial<ModelSelection> = {}): ModelSelection {
  return { provider: 'deepseek', model: 'deepseek-chat', ...over }
}

describe('resolving a selection against the Host catalogue (PRD §二.3)', () => {
  it('accepts a registered provider and model', () => {
    const resolved = resolveSelection({ provider: 'deepseek', model: 'deepseek-chat' }, catalog())
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.notes).toEqual([])
  })

  it('refuses a provider with no registered route, and names the ones there are', () => {
    // A provider with no adapter genuinely cannot route, so this is a real refusal.
    const resolved = resolveSelection({ provider: 'nope', model: 'x' }, catalog())
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.reason).toMatch(/no registered route/)
    expect(resolved.reason).toMatch(/deepseek, local/)
    expect(resolved.reason).toMatch(/nothing was changed/)
  })

  it('says so plainly when there are no providers at all', () => {
    const resolved = resolveSelection({ provider: 'x', model: 'y' }, catalog({ listProviders: () => [] }))
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.reason).toMatch(/\(none\)/)
  })

  it('requires both a provider and a model', () => {
    expect(resolveSelection({ provider: '', model: 'm' }, catalog()).ok).toBe(false)
    expect(resolveSelection({ provider: 'deepseek', model: '' }, catalog()).ok).toBe(false)
  })

  it('passes an unlisted reasoning effort through rather than rejecting it', () => {
    // The catalogue is advisory: rejecting on absence would refuse configurations that work.
    const resolved = resolveSelection(
      { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'xhigh' },
      catalog(),
      { provider: 'deepseek', model: 'deepseek-chat', levels: ['low', 'high'] },
    )
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.selection.reasoningEffort).toBe('xhigh')
    expect(resolved.notes.join(' ')).toMatch(/is not a level deepseek\/deepseek-chat publishes/)
    expect(resolved.notes.join(' ')).toMatch(/absence is not evidence that an option is rejected/)
  })

  it('notes that no levels could be read rather than implying a check happened', () => {
    const resolved = resolveSelection(
      { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
      catalog(),
      { provider: 'deepseek', model: 'deepseek-chat', levels: undefined, note: 'this Host mounts no model-info lookup' },
    )
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.notes.join(' ')).toMatch(/this Host mounts no model-info lookup/)
    expect(resolved.notes.join(' ')).toMatch(/passed through unchanged/)
  })

  it('keeps "the model publishes none" apart from "no catalogue was read"', () => {
    // C165's whole misreading: a model with no reasoning metadata offers the provider default only, and its
    // absence is not a list of levels. The note has to say which of the two happened.
    const resolved = resolveSelection(
      { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
      catalog(),
      {
        provider: 'deepseek', model: 'deepseek-chat', levels: undefined,
        note: 'deepseek/deepseek-chat publishes no reasoning levels, so this model offers the provider default only',
      },
    )
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.notes.join(' ')).toMatch(/publishes no reasoning levels/)
    expect(resolved.notes.join(' ')).not.toMatch(/mounts no model-info lookup/)
  })

  it('accepts a published level without a note', () => {
    const resolved = resolveSelection(
      { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
      catalog(),
      { provider: 'deepseek', model: 'deepseek-chat', levels: ['low', 'high'] },
    )
    expect(resolved.ok && resolved.notes).toEqual([])
  })

  it('says nothing about reasoning when the caller names no effort', () => {
    const resolved = resolveSelection({ provider: 'deepseek', model: 'deepseek-chat' }, catalog())
    expect(resolved.ok && resolved.notes).toEqual([])
  })
})

describe('reading the reasoning levels the Host publishes for one model (PRD §二.3)', () => {
  it('reads them from the resolver, naming the model they belong to', async () => {
    // The installed Host builds its own catalogue exactly this way:
    // `const resolved = await ctx.llm.resolveModelInfo(provider.id, model.id)` → `resolved.reasoning.efforts`.
    const published = await publishedReasoningOf({
      resolveModelInfo: async (provider, model) => ({
        provider, model,
        reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }] },
      }),
    }, 'deepseek', 'deepseek-reasoner')
    expect(published.provider).toBe('deepseek')
    expect(published.model).toBe('deepseek-reasoner')
    expect(published.levels).toEqual(['off', 'high', 'max'])
    expect(published.note).toBeUndefined()
  })

  it('reports a model that publishes none as publishing none, not as offering "off"', async () => {
    // The Host's own distinction: a model without this metadata "exposes no `reasoning` at all", because pi-ai
    // reports it as supporting only `off` — and `off` is translated into *omitting* the option, which is the
    // same request as naming nothing. Calling that a level would be a control that does nothing.
    const published = await publishedReasoningOf({ resolveModelInfo: async () => ({ context: 8192 }) }, 'p', 'm')
    expect(published.levels).toBeUndefined()
    expect(published.note).toMatch(/publishes no reasoning levels/)
    expect(published.note).toMatch(/cannot be switched off/)
  })

  it('reports an undescribable model as unknown rather than making it unusable', async () => {
    // The catalogue is advisory: a model the resolver cannot describe may still route, so this must not turn
    // into a refusal. It reports why nothing could be read.
    const published = await publishedReasoningOf({
      resolveModelInfo: async () => { throw new Error('UNKNOWN_MODEL: no route serves it') },
    }, 'p', 'unlisted')
    expect(published.levels).toBeUndefined()
    expect(published.note).toMatch(/could not describe p\/unlisted/)
    expect(published.note).toMatch(/UNKNOWN_MODEL/)
  })

  it('reports the absence of a lookup rather than an empty list', async () => {
    const published = await publishedReasoningOf(undefined, 'p', 'm')
    expect(published.levels).toBeUndefined()
    expect(published.note).toMatch(/mounts no model-info lookup/)
    // A shape that is neither an array nor absent is treated as absent, not iterated.
    const odd = await publishedReasoningOf({ resolveModelInfo: async () => ({ reasoning: { efforts: 'high' } }) }, 'p', 'm')
    expect(odd.levels).toBeUndefined()
  })

  it('keeps an empty published list distinct from nothing published', async () => {
    const published = await publishedReasoningOf({ resolveModelInfo: async () => ({ reasoning: { efforts: [] } }) }, 'p', 'm')
    expect(published.levels).toEqual([])
    expect(published.note).toBeUndefined()
  })
})

describe('an advisory model catalogue is not a rejection list (PRD §二.3)', () => {  it('keeps an unlisted model and explains why it was not refused', async () => {
    // Measured from the Host's own contract: "an adapter may accept unlisted model ids,
    // and consumers must not turn absence into request rejection".
    const notes = await modelListingNotes(selection({ model: 'deepseek-preview' }), catalog())
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatch(/is not advertised by provider "deepseek"/)
    expect(notes[0]).toMatch(/deepseek-chat, deepseek-reasoner/)
    expect(notes[0]).toMatch(/advisory/)
    expect(notes[0]).toMatch(/this is a note, not a rejection/)
  })

  it('says an empty listing advertises none rather than implying the model is missing', async () => {
    const notes = await modelListingNotes(selection({ provider: 'local', model: 'x' }), catalog())
    expect(notes[0]).toMatch(/it advertises none/)
  })

  it('says nothing for a model the provider does advertise', async () => {
    expect(await modelListingNotes(selection(), catalog())).toEqual([])
  })
})

describe('the next request and the last one are separate facts (PRD §二.3)', () => {
  it('reports both, and that no change is pending when they agree', () => {
    const text = describeConfigState({ forNextRequest: selection(), lastActuallyUsed: selection() })
    expect(text).toContain('Next request will use: deepseek/deepseek-chat')
    expect(text).toContain('Most recently actually used: deepseek/deepseek-chat')
    expect(text).toContain('No change is pending')
  })

  it('reports a pending change when they differ, and says an in-flight request is untouched', () => {
    // The only thing that matters to a caller who just changed it is whether it has taken
    // effect yet, which is exactly what one collapsed "current model" would hide.
    const text = describeConfigState({
      forNextRequest: selection({ model: 'deepseek-reasoner' }),
      lastActuallyUsed: selection(),
    })
    expect(text).toContain('Next request will use: deepseek/deepseek-reasoner')
    expect(text).toContain('Most recently actually used: deepseek/deepseek-chat')
    expect(text).toContain('A change is PENDING')
    expect(text).toContain('a request already in flight is not altered')
  })

  it('treats a reasoning-effort change as a pending change', () => {
    const text = describeConfigState({
      forNextRequest: selection({ reasoningEffort: 'high' }),
      lastActuallyUsed: selection(),
    })
    expect(text).toContain('A change is PENDING')
  })

  it('reports an unset configuration as unset rather than guessing', () => {
    const text = describeConfigState({})
    expect(text).toContain('(none recorded)')
    expect(text).toContain('unknown')
    expect(text).not.toContain('No change is pending')
  })

  it('does not infer the next model from the last actual request', () => {
    const text = describeConfigState({ lastActuallyUsed: selection() })
    expect(text).toContain('unknown')
    expect(text).not.toContain('No change is pending')
  })

  it('reports a pending change when nothing has been used yet', () => {
    const text = describeConfigState({ forNextRequest: selection() })
    expect(text).toContain('A change is PENDING')
  })

  it('names the reasoning effort when one is set', () => {
    const text = describeConfigState({ forNextRequest: selection({ reasoningEffort: 'high' }) })
    expect(text).toContain('at high reasoning')
  })
})

describe('a preset is chosen when a session is assembled (PRD §二.3)', () => {
  it('allows it at create and at fork', () => {
    expect(presetChangeAllowed('create').allowed).toBe(true)
    expect(presetChangeAllowed('fork').allowed).toBe(true)
  })

  it('refuses it on an existing task and names the real answer', () => {
    const verdict = presetChangeAllowed('update')
    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toMatch(/takes part in runtime assembly/)
    expect(verdict.reason).toMatch(/successor session/)
    expect(verdict.reason).toMatch(/not a limitation being worked around/)
  })
})

describe('applying a model configuration (PRD §二.3, §一.5)', () => {
  it('refuses without the Host extension, rather than changing the global default', async () => {
    // The Host's native default for rememberAsDefault is true, so a plugin call that did
    // not pass false would silently change the user's global model default.
    const applied = await applySelection(selection(), { rememberAsDefaultSupported: false })
    expect(applied.ok).toBe(false)
    if (applied.ok) return
    expect(applied.reason).toMatch(/rememberAsDefault/)
    expect(applied.reason).toMatch(/will not do that as a side effect/)
    expect(applied.reason).toMatch(/docs\/host-extension\.md/)
  })

  it('refuses a declared extension with no callable writer, instead of claiming a change happened', async () => {
    const applied = await applySelection(selection(), { rememberAsDefaultSupported: true })
    expect(applied.ok).toBe(false)
    if (applied.ok) return
    expect(applied.reason).toMatch(/callable session-model writer/)
    expect(applied.reason).toMatch(/nothing was changed/)
  })

  it('calls the companion writer with rememberAsDefault false and reports its normalized selection', async () => {
    const calls: unknown[] = []
    const applied = await applySelection(
      selection(),
      { rememberAsDefaultSupported: true },
      {
        selectForSession: async (request) => {
          calls.push(request)
          return { selected: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' } }
        },
      },
      'session-target',
    )
    expect(applied.ok).toBe(true)
    if (!applied.ok) return
    expect(calls).toEqual([{
      sessionId: 'session-target',
      selection: selection(),
      rememberAsDefault: false,
    }])
    expect(applied.rememberedAsDefault).toBe(false)
    expect(applied.selection).toEqual({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' })
  })

  it('does not report a change when the companion writer rejects', async () => {
    const applied = await applySelection(
      selection(),
      { rememberAsDefaultSupported: true },
      { selectForSession: async () => { throw new Error('Host rejected selection') } },
      'session-target',
    )
    expect(applied).toEqual({
      ok: false,
      reason: 'the companion Host writer did not confirm the model change (Host rejected selection); nothing was reported as changed.',
    })
  })

  it('does not report a change when the companion writer returns no normalized selection', async () => {
    const applied = await applySelection(
      selection(),
      { rememberAsDefaultSupported: true },
      { selectForSession: async () => ({ selected: { provider: '', model: '' } }) },
      'session-target',
    )
    expect(applied.ok).toBe(false)
    if (applied.ok) return
    expect(applied.reason).toMatch(/no normalized provider\/model selection/)
    expect(applied.reason).toMatch(/Nothing was reported as changed/)
  })
})
