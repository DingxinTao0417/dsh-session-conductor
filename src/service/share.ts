/**
 * The online share lifecycle (PRD §二.14.2).
 *
 * Sharing is a **separate self-hosted HTTPS snapshot service** that is unconfigured and
 * disabled by default, and this build does not have one. What it does have, and what this
 * module is, is the set of rules the specification fixes for the lifecycle — the part that
 * decides *whether* something may be published and *what happens afterwards*. Those rules
 * are worth implementing before the service exists, because several of them are ones a
 * service is likely to get wrong when it is written in a hurry:
 *
 * 1. **A preview comes first, and publishing must be explicit.** {@link planPublish}
 *    refuses a publish that does not carry the preview the user was shown, so "publish"
 *    cannot mean "publish whatever the current state is".
 * 2. **The snapshot is fixed at publish.** The record carries the cutoff it was taken at,
 *    and nothing in this module can move it; a share that tracked the session afterwards
 *    would be a live view with a URL, which is a different and much larger exposure.
 * 3. **The identifier is unguessable and the lifetime defaults to seven days.** The token
 *    is supplied by an injected generator so the entropy source is a decision rather than
 *    an accident, and expiry is computed rather than stored as a flag.
 * 4. **Revoking stops future access and cannot recall copies already downloaded.** This is
 *    the rule most likely to be softened into "the link no longer works", which reads as
 *    though the data is gone. {@link describeRevocation} says what actually happened.
 * 5. **The service serves snapshots only.** There is no action here that dispatches,
 *    sends, or executes anything, and `SHARE_SURFACE` states that so the absence is
 *    deliberate rather than an oversight waiting to be filled in.
 *
 * @module dsh-session-conductor/service/share
 */

/** A preview of exactly what a share would contain. */
export interface SharePreview {
  readonly snapshotId: string
  readonly taskId: string
  /** The instant the snapshot was taken at, which publishing will fix. */
  readonly cutoffAt: string
  readonly format: 'markdown' | 'json'
  readonly byteSize: number
  /** What the document contains, in the user's terms. */
  readonly includes: readonly string[]
  /** What it excludes, carried from the export so the preview cannot understate it. */
  readonly excludes: readonly string[]
  /** Warnings that must be seen before publishing, not after. */
  readonly warnings: readonly string[]
}

/** One published share. */
export interface ShareRecord {
  readonly shareId: string
  readonly snapshotId: string
  readonly taskId: string
  /**
   * The unguessable path component.
   *
   * Stored so the owner can find and revoke the share. It is the whole of the access
   * control — there is no login on the other end — which is why it is generated from a
   * cryptographic source and why the lifetime is short.
   */
  readonly token: string
  /** The cutoff the snapshot was fixed at. Nothing may move it. */
  readonly cutoffAt: string
  readonly publishedAt: string
  readonly expiresAt: string
  readonly revokedAt?: string | undefined
}

/** Where a share stands. */
export type ShareState = 'active' | 'expired' | 'revoked'

/** Whether a publish may proceed. */
export type PublishResult =
  | { readonly ok: true; readonly record: ShareRecord; readonly url: string }
  | { readonly ok: false; readonly reason: string }

/** What a publish is asked to do. */
export interface PublishRequest {
  /** The preview the user was actually shown. */
  readonly preview: SharePreview
  /** Confirmation that the user saw that preview and asked for this. */
  readonly confirmed: boolean
  /** The instant of publishing. */
  readonly now: string
  /** How long the share lives, in days. */
  readonly lifetimeDays: number
  /** Where the service is, once one exists. */
  readonly baseUrl?: string | undefined
  /** Builds the share identity; injected so the entropy source is a decision. */
  readonly newShareId: () => string
  readonly newToken: () => string
}

/**
 * Whether online sharing is available in this build.
 *
 * Two conditions, and the second is the one that matters: configuration can turn sharing
 * on, but nothing has been uploaded until a service exists to receive it. A function that
 * returned `true` on the config flag alone would let a caller plan around a capability
 * that is not there.
 *
 * @param enabled - whether configuration turns sharing on.
 * @param serviceRegistered - whether a snapshot service is registered in this Host.
 * @returns whether sharing is available, and why not when it is not.
 */
export function shareServiceAvailable(
  enabled: boolean,
  serviceRegistered: boolean,
): { readonly available: boolean; readonly reason: string } {
  if (!enabled) {
    return {
      available: false,
      reason: 'online sharing is disabled by default, and this build registers no snapshot service. Publishing needs '
        + 'a self-hosted HTTPS service to receive the snapshot; nothing has been uploaded and nothing has been shared.',
    }
  }
  if (!serviceRegistered) {
    return {
      available: false,
      reason: 'online sharing is switched on in configuration, but no snapshot service is registered in this Host, so '
        + 'there is no address to publish to and nothing has been shared. Configure the separately started HTTPS service first.',
    }
  }
  return {
    available: true,
    reason: 'a snapshot service is registered and sharing is enabled',
  }
}

/**
 * Decide whether a preview may be published.
 *
 * @param request - the publish request.
 * @returns the share record and its address, or the reason nothing was published.
 */
export function planPublish(request: PublishRequest): PublishResult {
  if (!request.confirmed) {
    return {
      ok: false,
      reason: 'publishing needs the user to confirm the preview they were shown. An unconfirmed publish would put '
        + 'whatever the state happens to be at the moment of the call on a public address.',
    }
  }
  if (!Number.isSafeInteger(request.preview.byteSize) || request.preview.byteSize <= 0) {
    return { ok: false, reason: 'the preview describes an empty document, so there is nothing to publish' }
  }
  if (!Number.isFinite(request.lifetimeDays) || request.lifetimeDays <= 0) {
    return {
      ok: false,
      reason: `the lifetime ${String(request.lifetimeDays)} day(s) is not a positive number of days. A share with no `
        + 'expiry would be a permanent public copy, which the specification does not permit.',
    }
  }
  let endpoint: URL
  try {
    endpoint = new URL(request.baseUrl ?? '')
    if (endpoint.protocol !== 'https:' || endpoint.username.length > 0 || endpoint.password.length > 0
      || endpoint.search.length > 0 || endpoint.hash.length > 0) throw new Error('unsafe endpoint')
  } catch {
    return { ok: false, reason: 'publishing requires a configured HTTPS snapshot service URL without embedded credentials, query parameters or fragments' }
  }
  const publishedAt = Date.parse(request.now)
  const expiry = publishedAt + request.lifetimeDays * 24 * 60 * 60 * 1000
  if (!Number.isFinite(publishedAt) || !Number.isFinite(Date.parse(request.preview.cutoffAt))
    || !Number.isFinite(expiry) || Math.abs(expiry) > 8.64e15 || expiry <= publishedAt) {
    return { ok: false, reason: 'the publish time, snapshot cutoff or expiry is invalid; no share can be created' }
  }
  const expiresAt = new Date(expiry).toISOString()
  const token = request.newToken()
  if (token.length < 32) {
    // Refused rather than accepted with a warning: the token is the only access control on
    // the far end, and a short one is guessable.
    return {
      ok: false,
      reason: `the generated identifier is ${String(token.length)} characters, which is too short to be unguessable. `
        + 'It is the only thing standing between the snapshot and anyone who finds the address.',
    }
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(token)) {
    return { ok: false, reason: 'the generated access token is not a safe opaque URL component' }
  }
  const shareId = request.newShareId()
  return {
    ok: true,
    record: {
      shareId,
      snapshotId: request.preview.snapshotId,
      taskId: request.preview.taskId,
      token,
      // Fixed at publish, from the preview: not re-read from the task, so the record and
      // what the user approved cannot drift apart.
      cutoffAt: request.preview.cutoffAt,
      publishedAt: request.now,
      expiresAt,
    },
    url: `${endpoint.href.replace(/\/+$/, '')}/s/${token}`,
  }
}

/**
 * Where a share stands now.
 *
 * Expiry is computed rather than stored, so a share cannot be "active" in the record and
 * expired in reality — the two answers cannot disagree because there is only one.
 *
 * @param record - the share.
 * @param now - the current instant.
 * @returns the state.
 */
export function shareState(record: ShareRecord, now: string): ShareState {
  if (record.revokedAt !== undefined) return 'revoked'
  const current = Date.parse(now)
  const expiry = Date.parse(record.expiresAt)
  return !Number.isFinite(current) || !Number.isFinite(expiry) || current >= expiry ? 'expired' : 'active'
}

/**
 * Whether a snapshot may still be retrieved.
 *
 * @param record - the share.
 * @param now - the current instant.
 * @returns whether retrieval is allowed, and why not when it is not.
 */
export function retrievalAllowed(record: ShareRecord, now: string): { readonly allowed: boolean; readonly reason: string } {
  const state = shareState(record, now)
  if (state === 'active') {
    return { allowed: true, reason: `the share is active until ${record.expiresAt}` }
  }
  if (state === 'revoked') {
    return {
      allowed: false,
      reason: `the share was revoked at ${String(record.revokedAt)}. Future access stops here; copies that were `
        + 'already downloaded cannot be recalled, and no mechanism exists that could recall them.',
    }
  }
  return {
    allowed: false,
    reason: `the share expired at ${record.expiresAt}. It was not renewed and its snapshot was not re-published.`,
  }
}

/**
 * Revoke a share.
 *
 * One-way. The revocation records the instant rather than deleting the record, because a
 * deleted record cannot answer "was this ever shared, and when did it stop?" — which is
 * the question asked after a leak, not before.
 *
 * @param record - the share.
 * @param at - the instant of revocation.
 * @returns the revoked record.
 */
export function revokeShare(record: ShareRecord, at: string): ShareRecord {
  if (record.revokedAt !== undefined) return record
  return { ...record, revokedAt: at }
}

/**
 * Describe what revoking did, and what it did not do.
 *
 * PRD §二.14.2 requires both halves to be stated. The second half is the one that gets
 * softened: "the link no longer works" is true and reads as though the data is gone.
 *
 * @param record - the revoked share.
 * @returns the account.
 */
export function describeRevocation(record: ShareRecord): string {
  return `Share ${record.shareId} was revoked at ${String(record.revokedAt)}. Future requests for it are refused. `
    + 'Copies that were already downloaded are unaffected and cannot be recalled: the snapshot left this machine, and '
    + 'no revocation can reach a copy someone else holds.'
}

/** What the share surface is, stated so its limits are deliberate. */
export const SHARE_SURFACE =
  'The share service serves snapshots and nothing else. It exposes no way to execute anything, send anything, or '
  + 'reach the Host that produced the snapshot: a published share is a read-only document at an address, and the '
  + 'conductor adds no action here that would make it more than that.'
