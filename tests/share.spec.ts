import { describe, expect, it } from 'vitest'
import {
  SHARE_SURFACE,
  describeRevocation,
  planPublish,
  retrievalAllowed,
  revokeShare,
  shareServiceAvailable,
  shareState,
  type PublishRequest,
  type SharePreview,
  type ShareRecord,
} from '../src/service/share.ts'

const AT = '2026-09-13T12:00:00.000Z'
const DAY = 24 * 60 * 60 * 1000

/** A preview. */
function preview(over: Partial<SharePreview> = {}): SharePreview {
  return {
    snapshotId: 'snapshot-1',
    taskId: 'task-1',
    cutoffAt: AT,
    format: 'markdown',
    byteSize: 4096,
    includes: ['task identity and state', 'the session chain', 'artifact versions'],
    excludes: ['credentials and tokens', 'environment variable values', 'full raw tool output'],
    warnings: [],
    ...over,
  }
}

/** A publish request. */
function request(over: Partial<PublishRequest> = {}): PublishRequest {
  return {
    preview: preview(),
    confirmed: true,
    now: AT,
    lifetimeDays: 7,
    baseUrl: 'https://share.example',
    newShareId: () => 'share-1',
    // 32 hex characters: the shape a cryptographic source produces.
    newToken: () => 'a'.repeat(32),
    ...over,
  }
}

/** A share record. */
function share(over: Partial<ShareRecord> = {}): ShareRecord {
  return {
    shareId: 'share-1',
    snapshotId: 'snapshot-1',
    taskId: 'task-1',
    token: 'a'.repeat(32),
    cutoffAt: AT,
    publishedAt: AT,
    expiresAt: new Date(Date.parse(AT) + 7 * DAY).toISOString(),
    ...over,
  }
}

describe('whether sharing is available at all (PRD §二.14.2)', () => {
  it('is unavailable when disabled, and says nothing has been shared', () => {
    const availability = shareServiceAvailable(false, false)
    expect(availability.available).toBe(false)
    expect(availability.reason).toMatch(/disabled by default/)
    expect(availability.reason).toMatch(/nothing has been uploaded and nothing has been shared/)
  })

  it('is unavailable when enabled but no service exists, so a caller cannot plan around it', () => {
    // Returning true on the config flag alone would let a caller plan around a capability
    // that is not there.
    const availability = shareServiceAvailable(true, false)
    expect(availability.available).toBe(false)
    expect(availability.reason).toMatch(/no snapshot service is registered/)
    expect(availability.reason).toMatch(/configure the separately started HTTPS service/i)
  })

  it('is available only when both conditions hold', () => {
    expect(shareServiceAvailable(true, true).available).toBe(true)
  })
})

describe('publishing requires a confirmed preview (PRD §二.14.2)', () => {
  it('refuses unsafe endpoints, dates and non-finite preview sizes without throwing', () => {
    for (const baseUrl of [undefined, 'http://share.example', 'https://user:secret@share.example', 'https://share.example/?token=secret']) {
      expect(planPublish(request({ baseUrl })).ok).toBe(false)
    }
    for (const invalid of [{ now: 'invalid' }, { lifetimeDays: Number.MAX_VALUE }, { preview: preview({ byteSize: Number.NaN }) }]) {
      expect(planPublish(request(invalid)).ok).toBe(false)
    }
  })
  it('publishes a confirmed preview and fixes the cutoff the user was shown', () => {
    const result = planPublish(request())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Fixed from the preview, not re-read from the task, so the record and what the user
    // approved cannot drift apart.
    expect(result.record.cutoffAt).toBe(AT)
    expect(result.record.snapshotId).toBe('snapshot-1')
    expect(result.url).toContain(result.record.token)
  })

  it('refuses an unconfirmed publish', () => {
    const result = planPublish(request({ confirmed: false }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/confirm the preview/)
    expect(result.reason).toMatch(/whatever the state happens to be/)
  })

  it('refuses an empty document', () => {
    expect(planPublish(request({ preview: preview({ byteSize: 0 }) })).ok).toBe(false)
  })

  it('refuses a lifetime that is not a positive number of days', () => {
    for (const lifetimeDays of [0, -1, Number.NaN]) {
      const result = planPublish(request({ lifetimeDays }))
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toMatch(/permanent public copy/)
    }
  })

  it('defaults to seven days when asked for seven', () => {
    const result = planPublish(request({ lifetimeDays: 7 }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Date.parse(result.record.expiresAt) - Date.parse(AT)).toBe(7 * DAY)
  })

  it('refuses a token too short to be unguessable', () => {
    // The token is the only access control on the far end, so a short one is refused
    // rather than accepted with a warning.
    const result = planPublish(request({ newToken: () => 'short' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/too short to be unguessable/)
    expect(result.reason).toMatch(/only thing standing between the snapshot and anyone/)
  })

  it('builds the address from the token and the base URL when one is given', () => {
    const result = planPublish(request({ baseUrl: 'https://share.example' }))
    expect(result.ok && result.url).toBe(`https://share.example/s/${'a'.repeat(32)}`)
  })
})

describe('where a share stands (PRD §二.14.2)', () => {
  it('is active before its expiry', () => {
    expect(shareState(share(), AT)).toBe('active')
    expect(shareState(share(), new Date(Date.parse(AT) + 6 * DAY).toISOString())).toBe('active')
  })

  it('is expired at and after its expiry, computed rather than stored', () => {
    // There is only one answer, so "active in the record, expired in reality" cannot happen.
    const expires = new Date(Date.parse(AT) + 7 * DAY).toISOString()
    expect(shareState(share(), expires)).toBe('expired')
    expect(shareState(share(), new Date(Date.parse(AT) + 30 * DAY).toISOString())).toBe('expired')
  })

  it('is revoked as soon as it is revoked, even before it expires', () => {
    const revoked = revokeShare(share(), new Date(Date.parse(AT) + DAY).toISOString())
    expect(shareState(revoked, new Date(Date.parse(AT) + 2 * DAY).toISOString())).toBe('revoked')
  })

  it('allows retrieval only while active', () => {
    expect(retrievalAllowed(share(), AT).allowed).toBe(true)
    const late = new Date(Date.parse(AT) + 30 * DAY).toISOString()
    expect(retrievalAllowed(share(), late).allowed).toBe(false)
    expect(retrievalAllowed(share(), late).reason).toMatch(/expired at/)
    expect(retrievalAllowed(share(), late).reason).toMatch(/was not renewed/)
  })

  it('fails closed when expiration metadata or current time cannot be interpreted', () => {
    expect(retrievalAllowed(share({ expiresAt: 'invalid' }), AT).allowed).toBe(false)
    expect(retrievalAllowed(share(), 'invalid').allowed).toBe(false)
  })
})

describe('revoking, and what it cannot do (PRD §二.14.2)', () => {
  it('records the instant rather than deleting the record', () => {
    // A deleted record cannot answer "was this ever shared, and when did it stop?" — the
    // question asked after a leak, not before.
    const revoked = revokeShare(share(), AT)
    expect(revoked.revokedAt).toBe(AT)
    expect(revoked.shareId).toBe('share-1')
    expect(revoked.publishedAt).toBe(AT)
  })

  it('is one-way: revoking twice keeps the first instant', () => {
    const once = revokeShare(share(), AT)
    const twice = revokeShare(once, new Date(Date.parse(AT) + DAY).toISOString())
    expect(twice.revokedAt).toBe(AT)
    expect(twice).toBe(once)
  })

  it('refuses retrieval and states that downloaded copies cannot be recalled', () => {
    // The half that gets softened: "the link no longer works" reads as though the data is
    // gone, which is not what happened.
    const revoked = revokeShare(share(), AT)
    const decision = retrievalAllowed(revoked, new Date(Date.parse(AT) + DAY).toISOString())
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/Future access stops here/)
    expect(decision.reason).toMatch(/copies that were already downloaded cannot be recalled/)
    expect(decision.reason).toMatch(/no mechanism exists that could recall them/)
  })

  it('says the same thing in its account of the revocation', () => {
    const text = describeRevocation(revokeShare(share(), AT))
    expect(text).toMatch(/Future requests for it are refused/)
    expect(text).toMatch(/cannot be recalled/)
    expect(text).toMatch(/the snapshot left this machine/)
  })
})

describe('the surface is snapshots only (PRD §二.14.2)', () => {
  it('states that no execution interface is exposed', () => {
    expect(SHARE_SURFACE).toMatch(/serves snapshots and nothing else/)
    expect(SHARE_SURFACE).toMatch(/no way to execute anything/)
    expect(SHARE_SURFACE).toMatch(/read-only document at an address/)
  })

  it('offers no function that dispatches or executes', () => {
    // The absence is the requirement, so it is asserted rather than left to review.
    const surface = Object.keys({
      SHARE_SURFACE, describeRevocation, planPublish, retrievalAllowed, revokeShare,
      shareServiceAvailable, shareState,
    })
    expect(surface.some(name => /send|dispatch|execute|run/i.test(name))).toBe(false)
  })
})
