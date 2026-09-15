import { describe, expect, it } from 'vitest'
import {
  artifactDisplayFacts,
  countArtifactDisplayFacts,
  describeArtifactFactSummary,
  describeArtifactFacts,
} from '../src/domain/artifact-facts.ts'

describe('artifact display facts (PRD §二.9.1)', () => {
  it('treats registration as 模型声称生成 and nothing else', () => {
    const record = { existence: 'claimed', acceptance: 'pending' }
    expect(artifactDisplayFacts(record)).toEqual({
      claimed: true,
      verifiedPresent: false,
      checkPassed: false,
      userAccepted: false,
    })
    expect(describeArtifactFacts(record)).toBe('模型声称生成')
  })

  it('adds 已验证存在 without implying a check or user acceptance', () => {
    const record = { existence: 'present', acceptance: 'pending' }
    expect(artifactDisplayFacts(record).verifiedPresent).toBe(true)
    expect(describeArtifactFacts(record)).toBe('模型声称生成 · 已验证存在')
  })

  it('names 检查通过 only for a deterministic-check pass', () => {
    const record = {
      existence: 'present',
      acceptance: 'pass',
      acceptedBy: 'deterministic_check',
    }
    expect(artifactDisplayFacts(record)).toMatchObject({ checkPassed: true, userAccepted: false })
    expect(describeArtifactFacts(record)).toBe('模型声称生成 · 已验证存在 · 检查通过')
  })

  it('names 用户验收 only for a user pass', () => {
    const record = { existence: 'present', acceptance: 'pass', acceptedBy: 'user' }
    expect(artifactDisplayFacts(record)).toMatchObject({ checkPassed: false, userAccepted: true })
    expect(describeArtifactFacts(record)).toBe('模型声称生成 · 已验证存在 · 用户验收')
  })

  it('names a model review as not acceptance, even when the verdict is pass', () => {
    const record = { existence: 'present', acceptance: 'pass', acceptedBy: 'model_review' }
    expect(artifactDisplayFacts(record)).toEqual({
      claimed: true,
      verifiedPresent: true,
      checkPassed: false,
      userAccepted: false,
    })
    expect(describeArtifactFacts(record)).toBe('模型声称生成 · 已验证存在 · 模型审阅（不是验收）')
  })

  it('does not count an unattributed pass as 检查通过 or 用户验收', () => {
    const records = [
      { existence: 'present', acceptance: 'pass' },
      { existence: 'changed', acceptance: 'pending' },
      { existence: 'present', acceptance: 'pass', acceptedBy: 'user' },
      { existence: 'present', acceptance: 'pass', acceptedBy: 'model_review' },
    ]
    expect(countArtifactDisplayFacts(records)).toEqual({
      total: 4,
      present: 3,
      checkPassed: 0,
      userAccepted: 1,
      changed: 1,
    })
    expect(describeArtifactFactSummary(countArtifactDisplayFacts(records)))
      .toBe('4 artifact(s), 3 verified present, 1 changed, 0 检查通过 and 1 用户验收')
  })
})
