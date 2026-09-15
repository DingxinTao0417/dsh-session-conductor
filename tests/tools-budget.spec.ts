import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { DEFAULTS } from '../src/domain/defaults.ts'
import {
  budgetToolContent,
  withOutputBudget,
  withinBudget,
  type ConductorToolContext,
} from '../src/tools.ts'

/** A context that only answers the output-budget question. */
function contextOf(limit: number): ConductorToolContext {
  return { textLimit: () => limit } as ConductorToolContext
}

/** A definition whose render always returns the given blocks. */
function stubTool(name: string, blocks: ContentBlock[]): ToolDefinition {
  return {
    name,
    output: {
      schema: { type: 'object' },
      render: () => blocks,
    },
    execute: () => Promise.resolve({}),
  } as unknown as ToolDefinition
}

describe('tool text budget (PRD §四.7, §二.7)', () => {
  it('leaves short text unchanged', () => {
    expect(withinBudget('short', 100, 'conductor_read')).toBe('short')
    const blocks: ContentBlock[] = [{ type: 'text', text: 'short' }]
    expect(budgetToolContent(blocks, 100, 'conductor_read')).toEqual(blocks)
  })

  it('marks concatenated text and names the tool, staying inside the budget', () => {
    const out = budgetToolContent(
      [{ type: 'text', text: 'aaaa' }, { type: 'text', text: 'bbbb'.repeat(50) }],
      80,
      'conductor_list',
    )
    const text = out.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text.length).toBeLessThanOrEqual(80)
    expect(text).toContain('truncated')
    expect(text).toContain('conductor_list')
  })

  it('does not invent a cap for a result that has no model-facing text', () => {
    expect(budgetToolContent([], 10, 'conductor_export')).toEqual([])
    const reasoning: ContentBlock[] = [{ type: 'reasoning', text: 'x'.repeat(100) }]
    expect(budgetToolContent(reasoning, 10, 'conductor_export')).toEqual(reasoning)
  })

  it('wraps render so a registered tool cannot return unmarked overflow', () => {
    const wrapped = withOutputBudget(
      contextOf(80),
      stubTool('conductor_read', [{ type: 'text', text: 'h'.repeat(500) }]),
    )
    const rendered = wrapped.output.render({}, {})
    const text = rendered.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text.length).toBeLessThanOrEqual(80)
    expect(text).toContain('truncated')
    expect(text).toContain('conductor_read')
  })

  it('wraps last-mile content, including when finalizeContent replaces the render', () => {
    const wrapped = withOutputBudget(
      contextOf(120),
      {
        ...stubTool('conductor_export', [{ type: 'text', text: 'from-render' }]),
        finalizeContent: () => [{ type: 'text', text: 'z'.repeat(400) }],
      },
    )
    const finalized = wrapped.finalizeContent?.(
      {} as never,
      { isError: false, content: [{ type: 'text', text: 'from-render' }] } as never,
    )
    const text = (finalized ?? []).map(block => block.type === 'text' ? block.text : '').join('')
    expect(text.length).toBeLessThanOrEqual(120)
    expect(text).toContain('truncated')
    expect(text).toContain('conductor_export')
  })

  it('ships the published 12,000-character default', () => {
    expect(DEFAULTS.toolTextLimit).toBe(12_000)
    const unlimited = 'x'.repeat(12_000)
    expect(withinBudget(unlimited, DEFAULTS.toolTextLimit, 'conductor_read')).toBe(unlimited)
    expect(withinBudget(unlimited + 'y', DEFAULTS.toolTextLimit, 'conductor_read')).toContain('truncated')
  })
})
